import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SecretFileStore } from '../secrets/file-store.js';

const AUTHORIZE_ENDPOINT = 'https://nid.naver.com/oauth2.0/authorize';
const TOKEN_ENDPOINT = 'https://nid.naver.com/oauth2.0/token';
const REVOKE_ENDPOINT = 'https://nid.naver.com/oauth2.0/revoke';
const STATE_LIFETIME_MS = 10 * 60_000;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface NaverTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
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
  tokenStore: SecretFileStore<NaverTokenSet>;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}

export class NaverOAuth {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #redirectUri: string;
  readonly #stateDbPath: string;
  readonly #tokenStore: SecretFileStore<NaverTokenSet>;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #timeoutMs: number;

  constructor(options: NaverOAuthOptions) {
    this.#clientId = required(options.clientId, 'client ID');
    this.#clientSecret = required(options.clientSecret, 'client secret');
    this.#redirectUri = new URL(options.redirectUri).href;
    this.#stateDbPath = options.stateDbPath;
    this.#tokenStore = options.tokenStore;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  authorize(): NaverAuthorization {
    const state = randomBytes(32).toString('base64url');
    const database = this.#openStateDatabase();
    try {
      database.prepare('INSERT INTO oauth_states (state_hash, expires_at, consumed) VALUES (?, ?, 0)').run(
        hashState(state).toString('hex'), this.#now() + STATE_LIFETIME_MS,
      );
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
    this.#acceptState(callback.state);
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
  }

  async refresh(current?: NaverTokenSet): Promise<NaverTokenSet> {
    const existing = current ?? await this.#tokenStore.read();
    const response = await this.#requestToken(new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
      refresh_token: existing.refreshToken,
    }), true);
    const tokens = parseTokenResponse(response, existing.refreshToken, this.#now());
    await this.#tokenStore.write(tokens);
    return tokens;
  }

  async revoke(current?: NaverTokenSet): Promise<void> {
    const existing = current ?? await this.#tokenStore.read();
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
      await response.text();
    } catch {
      if (signal.aborted) throw new NaverOAuthError('oauth_timeout', 'Naver OAuth request timed out');
      throw new NaverOAuthError('oauth_request_failed', 'Naver OAuth request failed');
    }
    if (!response.ok) throw oauthHttpError(response.status);
    await this.#tokenStore.delete();
  }

  #acceptState(state: string): void {
    const receivedHash = hashState(state);
    const database = this.#openStateDatabase();
    database.exec('BEGIN IMMEDIATE');
    try {
      const candidates = database.prepare(
        'SELECT id, state_hash, expires_at, consumed FROM oauth_states',
      ).all() as Array<{ id: number; state_hash: string; expires_at: number; consumed: number }>;
      const matching = candidates.find(candidate => {
        const storedHash = Buffer.from(candidate.state_hash, 'hex');
        return storedHash.length === receivedHash.length && timingSafeEqual(storedHash, receivedHash);
      });
      if (!matching || matching.consumed !== 0 || matching.expires_at <= this.#now()) {
        throw new NaverOAuthError('oauth_state_invalid', 'OAuth state is invalid, expired, or already used');
      }
      const result = database.prepare(
        'UPDATE oauth_states SET consumed = 1, consumed_at = ? WHERE id = ? AND consumed = 0',
      ).run(this.#now(), matching.id);
      if (result.changes !== 1) {
        throw new NaverOAuthError('oauth_state_invalid', 'OAuth state is invalid, expired, or already used');
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      if (error instanceof NaverOAuthError) throw error;
      throw new NaverOAuthError('oauth_state_invalid', 'OAuth state is invalid, expired, or already used');
    } finally {
      database.close();
    }
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
      let body: string;
      try {
        body = await response.text();
      } catch {
        if (signal.aborted) throw new NaverOAuthError('oauth_timeout', 'Naver OAuth request timed out');
        throw new NaverOAuthError('oauth_request_failed', 'Naver OAuth response failed');
      }
      if (!response.ok) throw oauthHttpError(response.status);
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new NaverOAuthError('oauth_invalid_response', 'Naver OAuth returned an invalid response');
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

function parseTokenResponse(value: unknown, previousRefreshToken: string | undefined, now: number): NaverTokenSet {
  const record = objectValue(value);
  const accessToken = nonEmptyString(record.access_token);
  const refreshToken = nonEmptyString(record.refresh_token) ?? previousRefreshToken;
  const tokenType = nonEmptyString(record.token_type);
  const expiresIn = typeof record.expires_in === 'string' || typeof record.expires_in === 'number'
    ? Number(record.expires_in)
    : Number.NaN;
  if (!accessToken || !refreshToken || tokenType?.toLowerCase() !== 'bearer' ||
      !Number.isInteger(expiresIn) || expiresIn <= 0) {
    throw new NaverOAuthError('oauth_invalid_response', 'Naver OAuth returned an incomplete token response');
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(now + expiresIn * 1000).toISOString(),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
