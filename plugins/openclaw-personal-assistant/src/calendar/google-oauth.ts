import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { BoundedBodyError, readBoundedBody, readBoundedJson } from './bounded-json.js';
import type { SecretStore } from './oauth.js';

const AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const STATE_LIFETIME_MS = 10 * 60_000;
const STATE_RETENTION_MS = 24 * 60 * 60_000;
const TOKEN_SAFETY_WINDOW_MS = 5 * 60_000;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const MAX_REVOKE_RESPONSE_BYTES = 16 * 1024;
const MAX_TOKEN_LENGTH = 8_192;

export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created' as const;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface GoogleOAuthClientCredentials {
  version: 1;
  clientId: string;
  clientSecret: string;
}

export interface GoogleTokenSet {
  version: 1;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope: typeof GOOGLE_CALENDAR_SCOPE;
}

export interface GoogleAuthorization {
  authorizationUrl: string;
  redirectUri: string;
  expiresAt: string;
}

export type GoogleOAuthErrorCode =
  | 'google_oauth_state_invalid'
  | 'google_oauth_callback_invalid'
  | 'google_oauth_callback_error'
  | 'google_oauth_auth'
  | 'google_oauth_rate_limited'
  | 'google_oauth_server'
  | 'google_oauth_invalid_response'
  | 'google_oauth_token_invalid'
  | 'google_oauth_credentials_invalid'
  | 'google_oauth_timeout'
  | 'google_oauth_request_failed';

export class GoogleOAuthError extends Error {
  constructor(public readonly code: GoogleOAuthErrorCode, message: string) {
    super(message);
    this.name = 'GoogleOAuthError';
  }
}

export interface GoogleOAuthOptions {
  clientId: string;
  clientSecret: string;
  expectedAccount: string;
  stateDbPath: string;
  tokenStore: SecretStore<GoogleTokenSet>;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}

interface AcceptedState {
  redirectUri: string;
  verifier: string;
}

export class GoogleOAuth {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #expectedAccount: string;
  readonly #stateDbPath: string;
  readonly #tokenStore: SecretStore<GoogleTokenSet>;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  #refreshPromise?: Promise<GoogleTokenSet>;

  constructor(options: GoogleOAuthOptions) {
    this.#clientId = requireField(options.clientId, 'client ID');
    this.#clientSecret = requireField(options.clientSecret, 'client secret');
    this.#expectedAccount = validateExpectedAccount(options.expectedAccount);
    this.#stateDbPath = options.stateDbPath;
    this.#tokenStore = options.tokenStore;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  begin(rawRedirectUri: string): GoogleAuthorization {
    const redirectUri = validateRedirectUri(rawRedirectUri);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(64).toString('base64url');
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    const expiresAtMs = this.#now() + STATE_LIFETIME_MS;
    const database = this.#openStateDatabase();
    try {
      database.exec('BEGIN IMMEDIATE');
      purgeStates(database, this.#now());
      database.prepare(`
        INSERT INTO google_oauth_states (state_hash, verifier, redirect_uri, expires_at, consumed)
        VALUES (?, ?, ?, ?, 0)
      `).run(hashState(state), verifier, redirectUri, expiresAtMs);
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
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', GOOGLE_CALENDAR_SCOPE);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('login_hint', this.#expectedAccount);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { authorizationUrl: url.href, redirectUri, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  async handleCallback(rawCallbackUrl: string): Promise<GoogleTokenSet> {
    let callback: URL;
    try { callback = new URL(rawCallbackUrl); }
    catch { throw new GoogleOAuthError('google_oauth_callback_invalid', 'Google OAuth callback is invalid'); }
    if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1'
      || callback.pathname !== '/google/callback' || callback.username || callback.password
      || callback.hash || !callback.port) {
      throw new GoogleOAuthError('google_oauth_callback_invalid', 'Google OAuth callback is invalid');
    }
    const state = callback.searchParams.get('state');
    if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state)) {
      throw new GoogleOAuthError('google_oauth_state_invalid', 'Google OAuth state is invalid');
    }
    const accepted = this.#consumeState(state);
    if (!accepted) throw new GoogleOAuthError('google_oauth_state_invalid', 'Google OAuth state is invalid');
    if (`${callback.origin}${callback.pathname}` !== accepted.redirectUri) {
      throw new GoogleOAuthError('google_oauth_callback_invalid', 'Google OAuth callback is invalid');
    }
    const keys = [...callback.searchParams.keys()].sort();
    const code = callback.searchParams.get('code');
    const oauthError = callback.searchParams.get('error');
    const issuer = callback.searchParams.get('iss');
    const grantedScope = callback.searchParams.get('scope');
    const expectedKeys = oauthError ? ['error', 'state'] : [
      'code', ...(issuer === null ? [] : ['iss']), ...(grantedScope === null ? [] : ['scope']), 'state',
    ].sort();
    if (keys.join('\0') !== expectedKeys.join('\0')
      || (issuer !== null && issuer !== 'https://accounts.google.com')
      || (grantedScope !== null && grantedScope !== GOOGLE_CALENDAR_SCOPE)) {
      throw new GoogleOAuthError('google_oauth_callback_invalid', 'Google OAuth callback is invalid');
    }
    if (oauthError || !code || code.length > 8_192) {
      throw new GoogleOAuthError('google_oauth_callback_error', 'Google authorization was not completed');
    }
    const response = await this.#requestToken(new URLSearchParams({
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
      code,
      code_verifier: accepted.verifier,
      grant_type: 'authorization_code',
      redirect_uri: accepted.redirectUri,
    }));
    const tokens = parseTokenResponse(response, undefined, this.#now(), true);
    await this.#tokenStore.write(tokens);
    return tokens;
  }

  async getValidAccessToken(safetyWindowMs = TOKEN_SAFETY_WINDOW_MS): Promise<string> {
    if (!Number.isSafeInteger(safetyWindowMs) || safetyWindowMs < 0 || safetyWindowMs > 10 * 60_000) {
      throw new GoogleOAuthError('google_oauth_token_invalid', 'Google OAuth token state is invalid');
    }
    const current = validateGoogleTokenSet(await this.#tokenStore.read());
    if (Date.parse(current.expiresAt) - this.#now() > safetyWindowMs) return current.accessToken;
    if (!this.#refreshPromise) {
      this.#refreshPromise = this.#refresh(current).finally(() => { this.#refreshPromise = undefined; });
    }
    return (await this.#refreshPromise).accessToken;
  }

  async status(): Promise<{ status: 'fresh' | 'refreshable' | 'unusable'; expiresAt: string | null }> {
    try {
      const token = validateGoogleTokenSet(await this.#tokenStore.read());
      return {
        status: Date.parse(token.expiresAt) - this.#now() > TOKEN_SAFETY_WINDOW_MS ? 'fresh' : 'refreshable',
        expiresAt: token.expiresAt,
      };
    } catch {
      return { status: 'unusable', expiresAt: null };
    }
  }

  async revoke(): Promise<void> {
    const token = validateGoogleTokenSet(await this.#tokenStore.read());
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(REVOKE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams({ token: token.refreshToken }),
        signal,
      });
    } catch {
      if (signal.aborted) throw new GoogleOAuthError('google_oauth_timeout', 'Google OAuth request timed out');
      throw new GoogleOAuthError('google_oauth_request_failed', 'Google OAuth request failed');
    }
    if (!response.ok) throw oauthHttpError(response.status);
    if (response.body) await readBoundedBody(response, MAX_REVOKE_RESPONSE_BYTES);
    await this.#tokenStore.delete();
  }

  async #refresh(current: GoogleTokenSet): Promise<GoogleTokenSet> {
    const latest = validateGoogleTokenSet(await this.#tokenStore.read());
    if (Date.parse(latest.expiresAt) - this.#now() > TOKEN_SAFETY_WINDOW_MS) return latest;
    const response = await this.#requestToken(new URLSearchParams({
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken,
    }));
    const tokens = parseTokenResponse(response, current.refreshToken, this.#now(), false);
    await this.#tokenStore.write(tokens);
    return tokens;
  }

  async #requestToken(body: URLSearchParams): Promise<unknown> {
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body,
        signal,
      });
    } catch {
      if (signal.aborted) throw new GoogleOAuthError('google_oauth_timeout', 'Google OAuth request timed out');
      throw new GoogleOAuthError('google_oauth_request_failed', 'Google OAuth request failed');
    }
    if (!response.ok) throw oauthHttpError(response.status);
    try {
      return await readBoundedJson(response, MAX_TOKEN_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof BoundedBodyError && error.code !== 'body_failed') {
        throw new GoogleOAuthError('google_oauth_invalid_response', 'Google OAuth returned an invalid response');
      }
      throw new GoogleOAuthError('google_oauth_request_failed', 'Google OAuth response failed');
    }
  }

  #consumeState(state: string): AcceptedState | undefined {
    const database = this.#openStateDatabase();
    try {
      database.exec('BEGIN IMMEDIATE');
      purgeStates(database, this.#now());
      const candidates = database.prepare(`
        SELECT id, state_hash, verifier, redirect_uri
        FROM google_oauth_states WHERE consumed = 0 AND expires_at > ?
        ORDER BY id DESC LIMIT 128
      `).all(this.#now()) as Array<{ id: number; state_hash: string; verifier: string; redirect_uri: string }>;
      const received = Buffer.from(hashState(state), 'hex');
      const match = candidates.find(candidate => {
        const stored = Buffer.from(candidate.state_hash, 'hex');
        return stored.length === received.length && timingSafeEqual(stored, received);
      });
      if (!match) {
        database.exec('ROLLBACK');
        return undefined;
      }
      const changed = database.prepare(`
        UPDATE google_oauth_states SET consumed = 1, consumed_at = ?
        WHERE id = ? AND consumed = 0 AND expires_at > ?
      `).run(this.#now(), match.id, this.#now()).changes;
      if (changed !== 1) {
        database.exec('ROLLBACK');
        return undefined;
      }
      database.exec('COMMIT');
      return { redirectUri: match.redirect_uri, verifier: match.verifier };
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    } finally {
      database.close();
    }
  }

  #openStateDatabase(): DatabaseSync {
    mkdirSync(dirname(this.#stateDbPath), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(this.#stateDbPath);
    if (process.platform !== 'win32') chmodSync(this.#stateDbPath, 0o600);
    database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS google_oauth_states (
        id INTEGER PRIMARY KEY,
        state_hash TEXT NOT NULL UNIQUE CHECK(length(state_hash) = 64),
        verifier TEXT NOT NULL CHECK(length(verifier) BETWEEN 43 AND 128),
        redirect_uri TEXT NOT NULL CHECK(length(redirect_uri) BETWEEN 1 AND 2048),
        expires_at INTEGER NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0, 1)),
        consumed_at INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS google_oauth_states_active_idx
        ON google_oauth_states (consumed, expires_at, id);
    `);
    return database;
  }
}

export function validateGoogleOAuthClientCredentials(value: unknown): GoogleOAuthClientCredentials {
  const record = objectValue(value);
  if (Object.keys(record).sort().join('\0') !== ['clientId', 'clientSecret', 'version'].join('\0')
    || record.version !== 1
    || typeof record.clientId !== 'string' || record.clientId.length < 10 || record.clientId.length > 512
    || !record.clientId.endsWith('.apps.googleusercontent.com')
    || typeof record.clientSecret !== 'string' || record.clientSecret.length < 1
    || record.clientSecret.length > MAX_TOKEN_LENGTH) {
    throw new GoogleOAuthError('google_oauth_credentials_invalid', 'Google OAuth credentials are invalid');
  }
  return { version: 1, clientId: record.clientId, clientSecret: record.clientSecret };
}

export function validateGoogleTokenSet(value: unknown): GoogleTokenSet {
  const record = objectValue(value);
  if (Object.keys(record).sort().join('\0') !== ['accessToken', 'expiresAt', 'refreshToken', 'scope', 'version'].join('\0')
    || record.version !== 1
    || typeof record.accessToken !== 'string' || record.accessToken.length < 1 || record.accessToken.length > MAX_TOKEN_LENGTH
    || typeof record.refreshToken !== 'string' || record.refreshToken.length < 1 || record.refreshToken.length > MAX_TOKEN_LENGTH
    || typeof record.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.expiresAt)
    || !Number.isFinite(Date.parse(record.expiresAt)) || record.scope !== GOOGLE_CALENDAR_SCOPE) {
    throw new GoogleOAuthError('google_oauth_token_invalid', 'Google OAuth token state is invalid');
  }
  return {
    version: 1, accessToken: record.accessToken, refreshToken: record.refreshToken,
    expiresAt: record.expiresAt, scope: GOOGLE_CALENDAR_SCOPE,
  };
}

export function parseGoogleDesktopCredentials(value: unknown): GoogleOAuthClientCredentials {
  const root = objectValue(value);
  if (Object.keys(root).sort().join('\0') !== ['installed'].join('\0')) {
    throw new GoogleOAuthError('google_oauth_credentials_invalid', 'Google OAuth Desktop credentials are invalid');
  }
  const installed = objectValue(root.installed);
  const allowed = new Set(['auth_provider_x509_cert_url', 'auth_uri', 'client_id', 'client_secret', 'project_id', 'redirect_uris', 'token_uri']);
  if (Object.keys(installed).some(key => !allowed.has(key))) {
    throw new GoogleOAuthError('google_oauth_credentials_invalid', 'Google OAuth Desktop credentials are invalid');
  }
  return validateGoogleOAuthClientCredentials({
    version: 1, clientId: installed.client_id, clientSecret: installed.client_secret,
  });
}

function parseTokenResponse(
  value: unknown,
  previousRefreshToken: string | undefined,
  now: number,
  requireRefreshToken: boolean,
): GoogleTokenSet {
  const record = objectValue(value);
  const accessToken = boundedString(record.access_token);
  const refreshToken = boundedString(record.refresh_token) ?? previousRefreshToken;
  const tokenType = boundedString(record.token_type);
  const responseScope = boundedString(record.scope) ?? (previousRefreshToken ? GOOGLE_CALENDAR_SCOPE : undefined);
  const expiresIn = typeof record.expires_in === 'number' || typeof record.expires_in === 'string'
    ? Number(record.expires_in) : Number.NaN;
  const expiresAt = now + expiresIn * 1_000;
  if (!accessToken || !refreshToken || (requireRefreshToken && !record.refresh_token)
    || tokenType?.toLowerCase() !== 'bearer' || responseScope !== GOOGLE_CALENDAR_SCOPE
    || !Number.isSafeInteger(expiresIn) || expiresIn <= 0 || !Number.isFinite(expiresAt)
    || Math.abs(expiresAt) > 8_640_000_000_000_000) {
    throw new GoogleOAuthError('google_oauth_invalid_response', 'Google OAuth returned an incomplete token response');
  }
  return {
    version: 1, accessToken, refreshToken, expiresAt: new Date(expiresAt).toISOString(),
    scope: GOOGLE_CALENDAR_SCOPE,
  };
}

function validateRedirectUri(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new GoogleOAuthError('google_oauth_callback_invalid', 'Google OAuth redirect is invalid'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || url.pathname !== '/google/callback' || url.username || url.password || url.search || url.hash) {
    throw new GoogleOAuthError('google_oauth_callback_invalid', 'Google OAuth redirect is invalid');
  }
  return url.href;
}

function validateExpectedAccount(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized !== 'yangisu12@gmail.com') {
    throw new GoogleOAuthError('google_oauth_credentials_invalid', 'Google OAuth account is invalid');
  }
  return normalized;
}

function purgeStates(database: DatabaseSync, now: number): void {
  database.prepare(`
    DELETE FROM google_oauth_states
    WHERE expires_at <= ? OR (consumed = 1 AND consumed_at IS NOT NULL AND consumed_at <= ?)
  `).run(now, now - STATE_RETENTION_MS);
}

function hashState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

function requireField(value: string, label: string): string {
  if (!value || value.length > MAX_TOKEN_LENGTH) {
    throw new GoogleOAuthError('google_oauth_credentials_invalid', `Google OAuth ${label} is invalid`);
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function boundedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_LENGTH ? value : undefined;
}

function oauthHttpError(status: number): GoogleOAuthError {
  if (status === 400 || status === 401 || status === 403) {
    return new GoogleOAuthError('google_oauth_auth', 'Google OAuth authentication failed');
  }
  if (status === 429) return new GoogleOAuthError('google_oauth_rate_limited', 'Google OAuth rate limit exceeded');
  if (status >= 500) return new GoogleOAuthError('google_oauth_server', 'Google OAuth server failed');
  return new GoogleOAuthError('google_oauth_request_failed', `Google OAuth request failed with HTTP ${status}`);
}
