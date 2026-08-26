import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

import { SubsystemHealthStore, type SubsystemHealthJournal } from '../state/health.js';
import { BoundedBodyError, readBoundedBody, readBoundedJson } from './bounded-json.js';

const AUTHORIZE_ENDPOINT = 'https://nid.naver.com/oauth2.0/authorize';
const TOKEN_ENDPOINT = 'https://nid.naver.com/oauth2.0/token';
const REVOKE_ENDPOINT = 'https://nid.naver.com/oauth2.0/revoke';
const STATE_LIFETIME_MS = 10 * 60_000;
const CONSUMED_STATE_RETENTION_MS = 24 * 60 * 60_000;
const MAX_ACTIVE_STATES = 128;
const TOKEN_SAFETY_WINDOW_MS = 60_000;
const REFRESH_LEASE_MS = 45_000;
const REFRESH_WAIT_MS = 25;
const REFRESH_FAILURE_COOLDOWN_MS = 5_000;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const MAX_REVOKE_RESPONSE_BYTES = 16 * 1024;
const MAX_TOKEN_FIELD_LENGTH = 4_096;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface NaverTokenSet {
  version: 1;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export interface NaverOAuthClientCredentials {
  version: 1;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface NaverAuthorization {
  authorizationUrl: string;
  state: string;
}

export interface NaverOAuthCallback {
  state: string;
  code?: string;
  error?: string;
  errorDescription?: string;
}

export type NaverOAuthErrorCode =
  | 'oauth_state_invalid'
  | 'oauth_callback_error'
  | 'oauth_auth'
  | 'oauth_rate_limited'
  | 'oauth_server'
  | 'oauth_invalid_response'
  | 'oauth_token_invalid'
  | 'oauth_credentials_invalid'
  | 'oauth_timeout'
  | 'oauth_request_failed';

export class NaverOAuthError extends Error {
  constructor(public readonly code: NaverOAuthErrorCode, message: string) {
    super(message);
    this.name = 'NaverOAuthError';
  }
}

export interface NaverOAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  stateDbPath: string;
  tokenStore: SecretStore<NaverTokenSet>;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  health?: Pick<SubsystemHealthJournal, 'report' | 'recover'>;
  healthStateDir?: string;
}

export interface SecretStore<T> {
  read(): Promise<T>;
  write(value: T): Promise<void>;
  delete(): Promise<void>;
}

export class NaverOAuth {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #redirectUri: string;
  readonly #stateDbPath: string;
  readonly #tokenStore: SecretStore<NaverTokenSet>;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #health?: Pick<SubsystemHealthJournal, 'report' | 'recover'>;
  readonly #healthStateDir: string;

  constructor(options: NaverOAuthOptions) {
    this.#clientId = required(options.clientId, 'client ID');
    this.#clientSecret = required(options.clientSecret, 'client secret');
    this.#redirectUri = new URL(options.redirectUri).href;
    this.#stateDbPath = options.stateDbPath;
    this.#tokenStore = options.tokenStore;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#health = options.health;
    this.#healthStateDir = options.healthStateDir ?? dirname(this.#stateDbPath);
  }

  authorize(): NaverAuthorization {
    const state = randomBytes(32).toString('base64url');
    const database = this.#openStateDatabase();
    try {
      database.exec('BEGIN IMMEDIATE');
      purgeStates(database, this.#now());
      database.prepare(`
        DELETE FROM oauth_states
        WHERE consumed = 0 AND id NOT IN (
          SELECT id FROM oauth_states WHERE consumed = 0 ORDER BY id DESC LIMIT ?
        )
      `).run(MAX_ACTIVE_STATES - 1);
      database.prepare('INSERT INTO oauth_states (state_hash, expires_at, consumed) VALUES (?, ?, 0)').run(
        hashState(state).toString('hex'), this.#now() + STATE_LIFETIME_MS,
      );
      database.exec('COMMIT');
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    } finally {
      database.close();
    }

    const url = new URL(AUTHORIZE_ENDPOINT);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.#clientId);
    url.searchParams.set('redirect_uri', this.#redirectUri);
    url.searchParams.set('state', state);
    return { authorizationUrl: url.href, state };
  }

  async handleCallback(callback: NaverOAuthCallback): Promise<NaverTokenSet> {
    return this.#trackHealth(async () => {
      await this.#acceptState(callback.state);
      if (callback.error || !callback.code) {
        throw new NaverOAuthError('oauth_callback_error', 'Naver authorization was not completed');
      }
      const response = await this.#requestToken(new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
        redirect_uri: this.#redirectUri,
        code: callback.code,
        state: callback.state,
      }));
      const tokens = parseTokenResponse(response, undefined, this.#now());
      await this.#tokenStore.write(tokens);
      return tokens;
    });
  }

  async refresh(current?: NaverTokenSet): Promise<NaverTokenSet> {
    return this.#trackHealth(async () => {
      const existing = validateStoredToken(current ?? await this.#tokenStore.read());
      const response = await this.#requestToken(new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
        refresh_token: existing.refreshToken,
      }), true);
      const tokens = parseTokenResponse(response, existing.refreshToken, this.#now());
      await this.#tokenStore.write(tokens);
      return tokens;
    });
  }

  async getValidAccessToken(safetyWindowMs = TOKEN_SAFETY_WINDOW_MS): Promise<string> {
    if (!Number.isSafeInteger(safetyWindowMs) || safetyWindowMs < 0 || safetyWindowMs > 10 * 60_000) {
      throw new NaverOAuthError('oauth_token_invalid', 'Naver OAuth token state is invalid');
    }
    try {
      const current = validateStoredToken(await this.#tokenStore.read());
      if (Date.parse(current.expiresAt) - this.#now() > safetyWindowMs) {
        this.#withHealth(health => health.recover('naver-oauth'));
        return current.accessToken;
      }
      return await this.#refreshWithLease(safetyWindowMs);
    } catch (error) {
      if (error instanceof NaverOAuthError) {
        if (error.code === 'oauth_token_invalid') this.#withHealth(health => health.report({
          errorCode: error.code, target: 'naver-oauth', message: 'Naver OAuth is unavailable',
        }));
        throw error;
      }
      const mapped = new NaverOAuthError('oauth_token_invalid', 'Naver OAuth token state is invalid');
      this.#withHealth(health => health.report({
        errorCode: mapped.code, target: 'naver-oauth', message: 'Naver OAuth is unavailable',
      }));
      throw mapped;
    }
  }

  async revoke(current?: NaverTokenSet): Promise<void> {
    let existing: NaverTokenSet;
    try {
      existing = validateStoredToken(current ?? await this.#tokenStore.read());
    } catch (error) {
      this.#reportOAuthFailure(error);
      throw error;
    }
    let failure: unknown;
    try {
      const signal = AbortSignal.timeout(this.#timeoutMs);
      let response: Response;
      try {
        response = await this.#fetch(REVOKE_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: new URLSearchParams({
            client_id: this.#clientId,
            client_secret: this.#clientSecret,
            token: existing.refreshToken,
            token_type_hint: 'refresh_token',
          }),
          signal,
        });
      } catch {
        if (signal.aborted) throw new NaverOAuthError('oauth_timeout', 'Naver OAuth request timed out');
        throw new NaverOAuthError('oauth_request_failed', 'Naver OAuth request failed');
      }
      if (!response.ok) throw oauthHttpError(response.status);
      try {
        if (response.body !== null) await readBoundedBody(response, MAX_REVOKE_RESPONSE_BYTES);
      } catch {
        if (signal.aborted) throw new NaverOAuthError('oauth_timeout', 'Naver OAuth request timed out');
        throw new NaverOAuthError('oauth_request_failed', 'Naver OAuth response failed');
      }
    } catch (error) {
      failure = error;
    }
    if (failure === undefined) {
      try { await this.#tokenStore.delete(); }
      catch (error) { failure = error; }
    }
    if (failure !== undefined) {
      this.#reportOAuthFailure(failure);
      throw failure;
    }
    this.#withHealth(health => health.report({
      errorCode: 'oauth_revoked', target: 'naver-oauth', message: 'Naver OAuth authorization is revoked',
    }));
  }

  #reportOAuthFailure(error: unknown): void {
    this.#withHealth(health => health.report({
      errorCode: error instanceof NaverOAuthError ? error.code : 'oauth_request_failed',
      target: 'naver-oauth', message: 'Naver OAuth is unavailable',
    }));
  }

  async #refreshWithLease(safetyWindowMs: number): Promise<string> {
    const leaseId = randomBytes(16).toString('hex');
    const deadline = Date.now() + REFRESH_LEASE_MS + this.#timeoutMs * 2;
    while (Date.now() < deadline) {
      const lease = this.#tryAcquireRefreshLease(leaseId);
      if (lease.failureCode) throw new NaverOAuthError(lease.failureCode, 'Naver OAuth refresh is unavailable');
      if (lease.acquired) {
        let succeeded = false;
        try {
          const latest = validateStoredToken(await this.#tokenStore.read());
          if (Date.parse(latest.expiresAt) - this.#now() > safetyWindowMs) {
            this.#withHealth(health => health.recover('naver-oauth'));
            succeeded = true;
            return latest.accessToken;
          }
          const refreshed = await this.refresh(latest);
          succeeded = true;
          return refreshed.accessToken;
        } catch (error) {
          this.#markRefreshLeaseFailed(leaseId, oauthFailureCode(error));
          throw error;
        } finally {
          if (succeeded) this.#releaseRefreshLease(leaseId);
        }
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, REFRESH_WAIT_MS));
      const latest = validateStoredToken(await this.#tokenStore.read());
      if (Date.parse(latest.expiresAt) - this.#now() > safetyWindowMs) {
        this.#withHealth(health => health.recover('naver-oauth'));
        return latest.accessToken;
      }
    }
    throw new NaverOAuthError('oauth_request_failed', 'Naver OAuth refresh is unavailable');
  }

  #tryAcquireRefreshLease(leaseId: string): { acquired: boolean; failureCode?: NaverOAuthErrorCode } {
    const database = this.#openStateDatabase();
    try {
      database.exec('BEGIN IMMEDIATE');
      const now = Date.now();
      database.prepare('DELETE FROM oauth_refresh_lease WHERE expires_at <= ?').run(now);
      const existing = database.prepare(
        'SELECT status, error_code FROM oauth_refresh_lease WHERE singleton = 1',
      ).get() as { status: string; error_code: string | null } | undefined;
      if (existing?.status === 'failed' && existing.error_code) {
        database.exec('COMMIT');
        return { acquired: false, failureCode: oauthFailureCode({ code: existing.error_code }) };
      }
      const result = database.prepare(`
        INSERT INTO oauth_refresh_lease (singleton, lease_id, expires_at, status, error_code)
        VALUES (1, ?, ?, 'refreshing', NULL)
        ON CONFLICT(singleton) DO NOTHING
      `).run(leaseId, now + REFRESH_LEASE_MS);
      database.exec('COMMIT');
      return { acquired: result.changes === 1 };
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    } finally { database.close(); }
  }

  #markRefreshLeaseFailed(leaseId: string, code: NaverOAuthErrorCode): void {
    const database = this.#openStateDatabase();
    try {
      database.prepare(`
        UPDATE oauth_refresh_lease
        SET status = 'failed', error_code = ?, expires_at = ?
        WHERE singleton = 1 AND lease_id = ?
      `).run(code, Date.now() + REFRESH_FAILURE_COOLDOWN_MS, leaseId);
    } finally { database.close(); }
  }

  #releaseRefreshLease(leaseId: string): void {
    const database = this.#openStateDatabase();
    try {
      database.prepare('DELETE FROM oauth_refresh_lease WHERE singleton = 1 AND lease_id = ?').run(leaseId);
    } finally { database.close(); }
  }

  async #trackHealth<T>(operation: () => Promise<T>): Promise<T> {
    try {
      const result = await operation();
      this.#withHealth(health => health.recover('naver-oauth'));
      return result;
    } catch (error) {
      this.#withHealth(health => health.report({
        errorCode: error instanceof NaverOAuthError ? error.code : 'oauth_request_failed',
        target: 'naver-oauth',
        message: 'Naver OAuth is unavailable',
      }));
      throw error;
    }
  }

  #withHealth(operation: (health: Pick<SubsystemHealthJournal, 'report' | 'recover'>) => void): void {
    if (this.#health) {
      operation(this.#health);
      return;
    }
    const health = new SubsystemHealthStore(this.#healthStateDir);
    try {
      operation(health);
    } finally {
      health.close();
    }
  }

  async #acceptState(state: string): Promise<void> {
    let accepted: boolean;
    try {
      accepted = await consumeStateInWorker(this.#stateDbPath, state, this.#now());
    } catch {
      accepted = false;
    }
    if (!accepted) throw new NaverOAuthError('oauth_state_invalid', 'OAuth state is invalid, expired, or already used');
  }

  async #requestToken(form: URLSearchParams, retryPreSend = false): Promise<unknown> {
    const attempts = retryPreSend ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const signal = AbortSignal.timeout(this.#timeoutMs);
      let response: Response;
      try {
        response = await this.#fetch(TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: form,
          signal,
        });
      } catch (error) {
        if (retryPreSend && attempt === 0 && isProvenPreSend(error)) continue;
        if (signal.aborted) throw new NaverOAuthError('oauth_timeout', 'Naver OAuth request timed out');
        throw new NaverOAuthError('oauth_request_failed', 'Naver OAuth request failed');
      }
      if (!response.ok) throw oauthHttpError(response.status);
      try {
        return await readBoundedJson(response, MAX_TOKEN_RESPONSE_BYTES);
      } catch (error) {
        if (signal.aborted) throw new NaverOAuthError('oauth_timeout', 'Naver OAuth request timed out');
        if (error instanceof BoundedBodyError && error.code !== 'body_failed') {
          throw new NaverOAuthError('oauth_invalid_response', 'Naver OAuth returned an invalid response');
        }
        throw new NaverOAuthError('oauth_request_failed', 'Naver OAuth response failed');
      }
    }
    throw new NaverOAuthError('oauth_request_failed', 'Naver OAuth request failed');
  }

  #openStateDatabase(): DatabaseSync {
    mkdirSync(dirname(this.#stateDbPath), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(this.#stateDbPath);
    database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS oauth_states (
        id INTEGER PRIMARY KEY,
        state_hash TEXT NOT NULL UNIQUE CHECK(length(state_hash) = 64),
        expires_at INTEGER NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0, 1)),
        consumed_at INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS oauth_states_active_idx ON oauth_states (consumed, expires_at, id);
      CREATE TABLE IF NOT EXISTS oauth_refresh_lease (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        lease_id TEXT NOT NULL CHECK(length(lease_id) = 32),
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('refreshing', 'failed')),
        error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),
        CHECK((status = 'refreshing' AND error_code IS NULL) OR (status = 'failed' AND error_code IS NOT NULL))
      ) STRICT;
    `);
    return database;
  }
}

function hashState(state: string): Buffer {
  return createHash('sha256').update(state, 'utf8').digest();
}

function required(value: string, label: string): string {
  if (!value) throw new NaverOAuthError('oauth_invalid_response', `Naver OAuth ${label} is required`);
  return value;
}

function oauthHttpError(status: number): NaverOAuthError {
  if (status === 401 || status === 403) return new NaverOAuthError('oauth_auth', 'Naver OAuth authentication failed');
  if (status === 429) return new NaverOAuthError('oauth_rate_limited', 'Naver OAuth rate limit exceeded');
  if (status >= 500) return new NaverOAuthError('oauth_server', 'Naver OAuth server failed');
  return new NaverOAuthError('oauth_request_failed', `Naver OAuth request failed with HTTP ${status}`);
}

const OAUTH_ERROR_CODES = new Set<NaverOAuthErrorCode>([
  'oauth_state_invalid', 'oauth_callback_error', 'oauth_auth', 'oauth_rate_limited', 'oauth_server',
  'oauth_invalid_response', 'oauth_token_invalid', 'oauth_credentials_invalid', 'oauth_timeout', 'oauth_request_failed',
]);

function oauthFailureCode(error: unknown): NaverOAuthErrorCode {
  const code = error instanceof NaverOAuthError ? error.code
    : error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && OAUTH_ERROR_CODES.has(code as NaverOAuthErrorCode)
    ? code as NaverOAuthErrorCode : 'oauth_request_failed';
}

function parseTokenResponse(value: unknown, previousRefreshToken: string | undefined, now: number): NaverTokenSet {
  const record = objectValue(value);
  const accessToken = nonEmptyString(record.access_token);
  const refreshToken = nonEmptyString(record.refresh_token) ?? previousRefreshToken;
  const tokenType = nonEmptyString(record.token_type);
  const expiresIn = typeof record.expires_in === 'string' || typeof record.expires_in === 'number'
    ? Number(record.expires_in)
    : Number.NaN;
  const expiresAtMs = now + expiresIn * 1000;
  if (!accessToken || !refreshToken || tokenType?.toLowerCase() !== 'bearer' ||
      !Number.isSafeInteger(expiresIn) || expiresIn <= 0 || !Number.isFinite(expiresAtMs) ||
      Math.abs(expiresAtMs) > 8_640_000_000_000_000) {
    throw new NaverOAuthError('oauth_invalid_response', 'Naver OAuth returned an incomplete token response');
  }
  return {
    version: 1,
    accessToken,
    refreshToken,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export function validateStoredToken(value: unknown): NaverTokenSet {
  const record = objectValue(value);
  const keys = Object.keys(record).sort();
  if (keys.join('\0') !== ['accessToken', 'expiresAt', 'refreshToken', 'version'].join('\0')
    || record.version !== 1
    || typeof record.accessToken !== 'string' || record.accessToken.length < 1 || record.accessToken.length > 8_192
    || typeof record.refreshToken !== 'string' || record.refreshToken.length < 1 || record.refreshToken.length > 8_192
    || typeof record.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.expiresAt)
    || !Number.isFinite(Date.parse(record.expiresAt))) {
    throw new NaverOAuthError('oauth_token_invalid', 'Naver OAuth token state is invalid');
  }
  return {
    version: 1, accessToken: record.accessToken, refreshToken: record.refreshToken, expiresAt: record.expiresAt,
  };
}

export function validateNaverOAuthClientCredentials(value: unknown): NaverOAuthClientCredentials {
  const record = objectValue(value);
  const keys = Object.keys(record).sort();
  if (keys.join('\0') !== ['clientId', 'clientSecret', 'redirectUri', 'version'].join('\0')
    || record.version !== 1
    || typeof record.clientId !== 'string' || record.clientId.length < 1 || record.clientId.length > 512
    || typeof record.clientSecret !== 'string' || record.clientSecret.length < 1 || record.clientSecret.length > 8_192
    || typeof record.redirectUri !== 'string' || record.redirectUri.length > 2_048) {
    throw new NaverOAuthError('oauth_credentials_invalid', 'Naver OAuth app credentials are invalid');
  }
  let redirect: URL;
  try { redirect = new URL(record.redirectUri); } catch {
    throw new NaverOAuthError('oauth_credentials_invalid', 'Naver OAuth app credentials are invalid');
  }
  const loopbackHttp = redirect.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(redirect.hostname);
  if ((!loopbackHttp && redirect.protocol !== 'https:') || redirect.username || redirect.password
    || redirect.search || redirect.hash) {
    throw new NaverOAuthError('oauth_credentials_invalid', 'Naver OAuth app credentials are invalid');
  }
  return {
    version: 1, clientId: record.clientId, clientSecret: record.clientSecret, redirectUri: redirect.href,
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_FIELD_LENGTH ? value : undefined;
}

const PROVEN_PRE_SEND_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_DNS',
]);

function isProvenPreSend(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === 'string' && PROVEN_PRE_SEND_CODES.has(record.code)) return true;
    current = record.cause;
  }
  return false;
}

function purgeStates(database: DatabaseSync, now: number): void {
  database.prepare(`
    DELETE FROM oauth_states
    WHERE expires_at <= ? OR (consumed = 1 AND consumed_at IS NOT NULL AND consumed_at <= ?)
  `).run(now, now - CONSUMED_STATE_RETENTION_MS);
}

const STATE_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require('node:worker_threads');
  const { createHash, timingSafeEqual } = require('node:crypto');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(workerData.path);
  let inTransaction = false;
  try {
    db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;');
    inTransaction = true;
    db.prepare(
      'DELETE FROM oauth_states WHERE expires_at <= ? OR (consumed = 1 AND consumed_at IS NOT NULL AND consumed_at <= ?)'
    ).run(workerData.now, workerData.now - workerData.retentionMs);
    const rows = db.prepare(
      'SELECT id, state_hash FROM oauth_states WHERE consumed = 0 AND expires_at > ? ORDER BY id DESC LIMIT ?'
    ).all(workerData.now, workerData.maxCandidates);
    const received = createHash('sha256').update(workerData.state, 'utf8').digest();
    let matching;
    for (const row of rows) {
      const stored = Buffer.from(row.state_hash, 'hex');
      if (stored.length === received.length && timingSafeEqual(stored, received)) matching = row;
    }
    if (!matching) {
      db.exec('ROLLBACK');
      inTransaction = false;
      parentPort.postMessage({ accepted: false });
    } else {
      const result = db.prepare(
        'UPDATE oauth_states SET consumed = 1, consumed_at = ? WHERE id = ? AND consumed = 0 AND expires_at > ?'
      ).run(workerData.now, matching.id, workerData.now);
      if (result.changes !== 1) {
        db.exec('ROLLBACK');
        inTransaction = false;
        parentPort.postMessage({ accepted: false });
      } else {
        db.exec('COMMIT');
        inTransaction = false;
        parentPort.postMessage({ accepted: true });
      }
    }
  } catch {
    if (inTransaction) {
      try { db.exec('ROLLBACK'); } catch {}
    }
    parentPort.postMessage({ accepted: false });
  } finally {
    db.close();
  }
`;

function consumeStateInWorker(path: string, state: string, now: number): Promise<boolean> {
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(STATE_WORKER_SOURCE, {
      eval: true,
      workerData: {
        path,
        state,
        now,
        retentionMs: CONSUMED_STATE_RETENTION_MS,
        maxCandidates: MAX_ACTIVE_STATES,
      },
    });
    let settled = false;
    worker.once('message', (message: unknown) => {
      settled = true;
      resolvePromise(
        message !== null && typeof message === 'object' && (message as { accepted?: unknown }).accepted === true,
      );
    });
    worker.once('error', error => {
      if (!settled) reject(error);
    });
    worker.once('exit', code => {
      if (!settled && code !== 0) reject(new Error('OAuth state worker failed'));
      else if (!settled) resolvePromise(false);
    });
  });
}
