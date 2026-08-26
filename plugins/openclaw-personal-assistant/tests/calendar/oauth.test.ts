import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NaverOAuth, validateNaverOAuthClientCredentials, type NaverTokenSet,
} from '../../src/calendar/oauth.js';
import { SubsystemHealthStore } from '../../src/state/health.js';

const temporaryDirectories: string[] = [];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'naver-oauth-test-'));
  temporaryDirectories.push(directory);
  const tokenStore = new MemorySecretStore<NaverTokenSet>();
  return { directory, tokenStore, stateDbPath: join(directory, 'oauth-state.sqlite3') };
}

class MemorySecretStore<T> {
  value: T | undefined;
  async read(): Promise<T> {
    if (this.value === undefined) throw Object.assign(new Error('Secret file is missing'), { code: 'secret_file_invalid' });
    return this.value;
  }
  async write(value: T): Promise<void> { this.value = value; }
  async delete(): Promise<void> { this.value = undefined; }
}

function tokenResponse(accessToken = 'access-new', refreshToken: string | undefined = 'refresh-new') {
  return new Response(JSON.stringify({
    access_token: accessToken,
    ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
    token_type: 'bearer',
    expires_in: '3600',
  }), { status: 200 });
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('NaverOAuth one-time callback state', () => {
  it('accepts only the exact versioned OAuth app credential schema', () => {
    expect(validateNaverOAuthClientCredentials({
      version: 1, clientId: 'owner-client', clientSecret: 'owner-secret',
      redirectUri: 'http://127.0.0.1:1456/naver/callback',
    })).toEqual({
      version: 1, clientId: 'owner-client', clientSecret: 'owner-secret',
      redirectUri: 'http://127.0.0.1:1456/naver/callback',
    });
    for (const invalid of [
      { version: 2, clientId: 'id', clientSecret: 'secret', redirectUri: 'http://127.0.0.1/callback' },
      { version: 1, clientId: 'id', clientSecret: 'secret', redirectUri: 'http://example.com/callback' },
      { version: 1, clientId: 'id', clientSecret: 'secret', redirectUri: 'https://example.com/callback', extra: true },
    ]) expect(() => validateNaverOAuthClientCredentials(invalid)).toThrowError(expect.objectContaining({
      code: 'oauth_credentials_invalid',
    }));
  });

  it('durably reports invalid or expired callback state without exposing state data', async () => {
    const files = await fixture();
    const report = vi.fn();
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch: vi.fn(), health: { report, recover: vi.fn() },
    });

    await expect(oauth.handleCallback({ code: 'code', state: 'private-invalid-state' }))
      .rejects.toMatchObject({ code: 'oauth_state_invalid' });
    expect(report).toHaveBeenCalledWith({
      errorCode: 'oauth_state_invalid', target: 'naver-oauth', message: 'Naver OAuth is unavailable',
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain('private-invalid-state');
  });

  it.each([
    ['authorization denial', { error: 'access_denied', errorDescription: 'private denial' }],
    ['missing code', {}],
  ])('durably reports %s after consuming valid state', async (_label, callback) => {
    const files = await fixture();
    const report = vi.fn();
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch: vi.fn(), health: { report, recover: vi.fn() },
    });
    const { state } = oauth.authorize();

    await expect(oauth.handleCallback({ state, ...callback })).rejects.toMatchObject({ code: 'oauth_callback_error' });
    expect(report).toHaveBeenCalledWith({
      errorCode: 'oauth_callback_error', target: 'naver-oauth', message: 'Naver OAuth is unavailable',
    });
  });

  it('stores only the SHA-256 of 32 random state bytes and omits scope', async () => {
    const { stateDbPath, tokenStore } = await fixture();
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      stateDbPath, tokenStore,
    });

    const authorization = oauth.authorize();
    const url = new URL(authorization.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://nid.naver.com/oauth2.0/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe(authorization.state);
    expect(url.searchParams.has('scope')).toBe(false);
    expect(Buffer.from(authorization.state, 'base64url')).toHaveLength(32);

    const database = new DatabaseSync(stateDbPath);
    const row = database.prepare('SELECT state_hash, expires_at, consumed FROM oauth_states').get() as {
      state_hash: string; expires_at: number; consumed: number;
    };
    database.close();
    expect(row.state_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.state_hash).not.toContain(authorization.state);
    expect(row.consumed).toBe(0);
    expect(row.expires_at - Date.now()).toBeGreaterThan(9 * 60_000);
  });

  it('rejects wrong state before making a token request', async () => {
    const files = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch,
    });
    oauth.authorize();

    await expect(oauth.handleCallback({ code: 'code', state: 'wrong' })).rejects.toMatchObject({ code: 'oauth_state_invalid' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects expired state before making a token request', async () => {
    const files = await fixture();
    let now = Date.parse('2030-01-01T00:00:00.000Z');
    const fetch = vi.fn<typeof globalThis.fetch>();
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch, now: () => now,
    });
    const { state } = oauth.authorize();
    now += 10 * 60_000;

    await expect(oauth.handleCallback({ code: 'code', state })).rejects.toMatchObject({ code: 'oauth_state_invalid' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('consumes accepted state exactly once, even if it is replayed', async () => {
    const files = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(tokenResponse());
    const report = vi.fn();
    const recover = vi.fn();
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch, health: { report, recover },
    });
    const { state } = oauth.authorize();
    await expect(oauth.handleCallback({ code: 'one-time-code', state })).resolves.toMatchObject({ accessToken: 'access-new' });
    await expect(oauth.handleCallback({ code: 'one-time-code', state })).rejects.toMatchObject({ code: 'oauth_state_invalid' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledWith('naver-oauth');
    expect(report).toHaveBeenCalledWith({
      errorCode: 'oauth_state_invalid', target: 'naver-oauth', message: 'Naver OAuth is unavailable',
    });
  });

  it('allows only one callback to win a concurrent state race', async () => {
    const files = await fixture();
    const firstFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(tokenResponse());
    const secondFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(tokenResponse());
    const first = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch: firstFetch,
    });
    const second = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch: secondFetch,
    });
    const { state } = first.authorize();

    const results = await Promise.allSettled([
      first.handleCallback({ code: 'first-code', state }),
      second.handleCallback({ code: 'second-code', state }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')[0]).toMatchObject({
      reason: { code: 'oauth_state_invalid' },
    });
    expect(firstFetch.mock.calls.length + secondFetch.mock.calls.length).toBe(1);
  });

  it('purges stale states and bounds active callback candidates', async () => {
    const files = await fixture();
    let now = Date.parse('2030-01-01T00:00:00.000Z');
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, now: () => now,
    });
    oauth.authorize();
    const database = new DatabaseSync(files.stateDbPath);
    const insert = database.prepare('INSERT INTO oauth_states (state_hash, expires_at, consumed, consumed_at) VALUES (?, ?, ?, ?)');
    insert.run('a'.repeat(64), now - 1, 0, null);
    insert.run('b'.repeat(64), now + 60_000, 1, now - 24 * 60 * 60_000 - 1);
    for (let index = 0; index < 150; index += 1) {
      insert.run(index.toString(16).padStart(64, '0'), now + 60_000, 0, null);
    }
    database.close();

    now += 1;
    oauth.authorize();
    const reopened = new DatabaseSync(files.stateDbPath);
    const stale = reopened.prepare('SELECT count(*) AS count FROM oauth_states WHERE expires_at <= ? OR (consumed = 1 AND consumed_at <= ?)')
      .get(now, now - 24 * 60 * 60_000) as { count: number };
    const active = reopened.prepare('SELECT count(*) AS count FROM oauth_states WHERE consumed = 0 AND expires_at > ?')
      .get(now) as { count: number };
    reopened.close();
    expect(stale.count).toBe(0);
    expect(active.count).toBeLessThanOrEqual(128);
  });

  it('consumes state when Naver returns a callback error', async () => {
    const files = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch,
    });
    const { state } = oauth.authorize();

    await expect(oauth.handleCallback({ state, error: 'access_denied', errorDescription: 'private detail' }))
      .rejects.toMatchObject({ code: 'oauth_callback_error' });
    await expect(oauth.handleCallback({ state, code: 'later-code' }))
      .rejects.toMatchObject({ code: 'oauth_state_invalid' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('NaverOAuth token lifecycle', () => {
  it('refreshes one expired token exactly once before a calendar create can run', async () => {
    const files = await fixture();
    files.tokenStore.value = {
      version: 1, accessToken: 'access-expired', refreshToken: 'refresh-old', expiresAt: '2026-08-25T00:00:00.000Z',
    };
    const fetch = vi.fn().mockResolvedValue(tokenResponse('access-current', undefined));
    const create = vi.fn().mockResolvedValue(undefined);
    const recover = vi.fn();
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch, now: () => Date.parse('2026-08-26T00:00:00.000Z'), health: { report: vi.fn(), recover },
    });

    const accessToken = await oauth.getValidAccessToken();
    await create(accessToken);

    expect(accessToken).toBe('access-current');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledExactlyOnceWith('access-current');
    expect(recover).toHaveBeenCalledWith('naver-oauth');
  });

  it('uses one cross-instance refresh lease and makes one refresh request', async () => {
    const files = await fixture();
    files.tokenStore.value = {
      version: 1, accessToken: 'access-expired', refreshToken: 'refresh-old', expiresAt: '2026-08-25T00:00:00.000Z',
    };
    const fetch = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 25));
      return tokenResponse('access-shared', undefined);
    });
    const options = {
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch, now: () => Date.parse('2026-08-26T00:00:00.000Z'),
      health: { report: vi.fn(), recover: vi.fn() },
    };

    const results = await Promise.all([
      new NaverOAuth(options).getValidAccessToken(),
      new NaverOAuth(options).getValidAccessToken(),
    ]);

    expect(results).toEqual(['access-shared', 'access-shared']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('shares one failed refresh across concurrent provider instances without a second request', async () => {
    const files = await fixture();
    files.tokenStore.value = {
      version: 1, accessToken: 'access-expired', refreshToken: 'refresh-old', expiresAt: '2026-08-25T00:00:00.000Z',
    };
    const fetch = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 25));
      return new Response('', { status: 401 });
    });
    const options = {
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch, now: () => Date.parse('2026-08-26T00:00:00.000Z'),
      health: { report: vi.fn(), recover: vi.fn() },
    };

    const results = await Promise.allSettled([
      new NaverOAuth(options).getValidAccessToken(),
      new NaverOAuth(options).getValidAccessToken(),
    ]);

    expect(results.every(result => result.status === 'rejected'
      && (result.reason as { code?: unknown }).code === 'oauth_auth')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('closes OAuth health and prevents calendar create when refresh fails', async () => {
    const files = await fixture();
    files.tokenStore.value = {
      version: 1, accessToken: 'access-expired', refreshToken: 'refresh-old', expiresAt: '2026-08-25T00:00:00.000Z',
    };
    const report = vi.fn();
    const create = vi.fn();
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch: vi.fn().mockResolvedValue(new Response('', { status: 401 })),
      now: () => Date.parse('2026-08-26T00:00:00.000Z'), health: { report, recover: vi.fn() },
    });

    await expect((async () => {
      const accessToken = await oauth.getValidAccessToken();
      await create(accessToken);
    })()).rejects.toMatchObject({ code: 'oauth_auth' });

    expect(create).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith({
      errorCode: 'oauth_auth', target: 'naver-oauth', message: 'Naver OAuth is unavailable',
    });
  });

  it('rejects malformed versioned token state before returning an access token', async () => {
    const files = await fixture();
    files.tokenStore.value = {
      version: 2, accessToken: 'access-old', refreshToken: 'refresh-old', expiresAt: 'not-a-date',
    } as unknown as NaverTokenSet;
    const report = vi.fn();
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch: vi.fn(), health: { report, recover: vi.fn() },
    });

    await expect(oauth.getValidAccessToken()).rejects.toMatchObject({ code: 'oauth_token_invalid' });
    expect(report).toHaveBeenCalledWith({
      errorCode: 'oauth_token_invalid', target: 'naver-oauth', message: 'Naver OAuth is unavailable',
    });
  });

  it('reports a durable sanitized OAuth failure and records recovery after success', async () => {
    const files = await fixture();
    await files.tokenStore.write({
      version: 1, accessToken: 'access-old', refreshToken: 'refresh-old', expiresAt: '2029-01-01T00:00:00.000Z',
    });
    const report = vi.fn();
    const recover = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('private token detail', { status: 401 }))
      .mockResolvedValueOnce(tokenResponse('access-recovered'));
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch, health: { report, recover },
    });

    await expect(oauth.refresh()).rejects.toMatchObject({ code: 'oauth_auth' });
    expect(report).toHaveBeenCalledWith({
      errorCode: 'oauth_auth', target: 'naver-oauth', message: 'Naver OAuth is unavailable',
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain('private token detail');
    await expect(oauth.refresh()).resolves.toMatchObject({ accessToken: 'access-recovered' });
    expect(recover).toHaveBeenCalledWith('naver-oauth');
  });

  it('uses the production durable health store when no health seam is injected', async () => {
    const files = await fixture();
    await files.tokenStore.write({
      version: 1, accessToken: 'access-old', refreshToken: 'refresh-old', expiresAt: '2029-01-01T00:00:00.000Z',
    });
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(tokenResponse('access-recovered'));
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch,
    });

    await expect(oauth.refresh()).rejects.toMatchObject({ code: 'oauth_server' });
    let health = new SubsystemHealthStore(files.directory);
    expect(health.listActive()).toEqual([{
      errorCode: 'oauth_server', target: 'naver-oauth', message: 'Naver OAuth is unavailable',
    }]);
    health.close();
    await expect(oauth.refresh()).resolves.toMatchObject({ accessToken: 'access-recovered' });
    health = new SubsystemHealthStore(files.directory);
    expect(health.listActive()).toEqual([]);
    health.close();
  });

  it('exchanges a callback code with the official endpoint and stores a complete token set', async () => {
    const files = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(tokenResponse());
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch, now: () => Date.parse('2030-01-01T00:00:00.000Z'),
    });
    const { state } = oauth.authorize();
    const tokens = await oauth.handleCallback({ code: 'authorization-code', state });

    expect(tokens).toEqual({
      version: 1, accessToken: 'access-new', refreshToken: 'refresh-new', expiresAt: '2030-01-01T01:00:00.000Z',
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://nid.naver.com/oauth2.0/token');
    const form = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code', client_id: 'client-id', client_secret: 'client-secret',
      redirect_uri: 'http://127.0.0.1/callback', code: 'authorization-code', state,
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    await expect(files.tokenStore.read()).resolves.toEqual(tokens);
  });

  it('refreshes through the token endpoint and preserves the refresh token when omitted', async () => {
    const files = await fixture();
    await files.tokenStore.write({ version: 1, accessToken: 'access-old', refreshToken: 'refresh-old', expiresAt: '2029-01-01T00:00:00.000Z' });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'access-refreshed', token_type: 'bearer', expires_in: '3600',
    }), { status: 200 }));
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch, now: () => Date.parse('2030-01-01T00:00:00.000Z'),
    });

    await expect(oauth.refresh()).resolves.toEqual({
      version: 1, accessToken: 'access-refreshed', refreshToken: 'refresh-old', expiresAt: '2030-01-01T01:00:00.000Z',
    });
    const form = new URLSearchParams(String(fetch.mock.calls[0]![1]?.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'refresh_token', client_id: 'client-id', client_secret: 'client-secret', refresh_token: 'refresh-old',
    });
  });

  it('retries refresh once only when the first failure is proven pre-send', async () => {
    const files = await fixture();
    await files.tokenStore.write({ version: 1, accessToken: 'access-old', refreshToken: 'refresh-old', expiresAt: '2029-01-01T00:00:00.000Z' });
    const cause = Object.assign(new Error('DNS lookup failed'), { code: 'ENOTFOUND' });
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause }))
      .mockResolvedValueOnce(tokenResponse('access-retried'));
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch,
    });

    await expect(oauth.refresh()).resolves.toMatchObject({ accessToken: 'access-retried' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('revokes the token pair through the official endpoint before deleting the local copy', async () => {
    const files = await fixture();
    await files.tokenStore.write({ version: 1, accessToken: 'access-old', refreshToken: 'refresh-old', expiresAt: '2029-01-01T00:00:00.000Z' });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const report = vi.fn();
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch, health: { report, recover: vi.fn() },
    });

    await expect(oauth.revoke()).resolves.toBeUndefined();
    expect(String(fetch.mock.calls[0]![0])).toBe('https://nid.naver.com/oauth2.0/revoke');
    expect(Object.fromEntries(new URLSearchParams(String(fetch.mock.calls[0]![1]?.body)))).toEqual({
      client_id: 'client-id', client_secret: 'client-secret', token: 'refresh-old', token_type_hint: 'refresh_token',
    });
    await expect(files.tokenStore.read()).rejects.toMatchObject({ code: 'secret_file_invalid' });
    expect(report).toHaveBeenCalledWith({
      errorCode: 'oauth_revoked', target: 'naver-oauth', message: 'Naver OAuth authorization is revoked',
    });
  });

  it.each([
    [401, 'oauth_auth'], [403, 'oauth_auth'], [429, 'oauth_rate_limited'], [500, 'oauth_server'], [503, 'oauth_server'],
  ])('classifies token HTTP %i before a failing body read as %s', async (status, code) => {
    const files = await fixture();
    const response = {
      ok: false, status,
      text: vi.fn().mockRejectedValue(new Error('Authorization: Bearer access-secret private-body')),
    } as unknown as Response;
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response),
    });
    const { state } = oauth.authorize();
    await expect(oauth.handleCallback({ code: 'code', state })).rejects.toMatchObject({ code });
    expect(response.text).not.toHaveBeenCalled();
  });

  it('maps a successful token response body failure without reading secrets into the error', async () => {
    const files = await fixture();
    const response = {
      ok: true, status: 200,
      text: vi.fn().mockRejectedValue(new Error('Authorization: Bearer access-secret private-body')),
    } as unknown as Response;
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response),
    });
    const { state } = oauth.authorize();
    const error = await oauth.handleCallback({ code: 'code', state }).catch(value => value as Error & { code: string });
    expect(error.code).toBe('oauth_request_failed');
    expect(`${error.message} ${error.stack ?? ''}`).not.toMatch(/access-secret|private-body|authorization|bearer/i);
  });

  it('retains local tokens when a successful revoke response body cannot be verified', async () => {
    const files = await fixture();
    const tokens: NaverTokenSet = { version: 1, accessToken: 'access-old', refreshToken: 'refresh-old', expiresAt: '2029-01-01T00:00:00.000Z' };
    await files.tokenStore.write(tokens);
    const response = { ok: true, status: 200, text: vi.fn().mockRejectedValue(new Error('reset')) } as unknown as Response;
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response),
    });
    await expect(oauth.revoke()).rejects.toMatchObject({ code: 'oauth_request_failed' });
    await expect(files.tokenStore.read()).resolves.toEqual(tokens);
  });

  it('retains the local token for a retry when remote revoke returns an uncertain server failure', async () => {
    const files = await fixture();
    files.tokenStore.value = {
      version: 1, accessToken: 'access-old', refreshToken: 'refresh-old', expiresAt: '2029-01-01T00:00:00.000Z',
    };
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch: vi.fn().mockResolvedValue(new Response('', { status: 500 })),
      health: { report: vi.fn(), recover: vi.fn() },
    });

    await expect(oauth.revoke()).rejects.toMatchObject({ code: 'oauth_server' });
    expect(files.tokenStore.value).toMatchObject({ accessToken: 'access-old', refreshToken: 'refresh-old' });
    await expect(oauth.getValidAccessToken()).resolves.toBe('access-old');
  });

  it.each([
    [401, 'oauth_auth'], [403, 'oauth_auth'], [429, 'oauth_rate_limited'], [500, 'oauth_server'], [503, 'oauth_server'],
  ])('classifies revoke HTTP %i before a failing body read as %s', async (status, code) => {
    const files = await fixture();
    await files.tokenStore.write({ version: 1, accessToken: 'access-old', refreshToken: 'refresh-old', expiresAt: '2029-01-01T00:00:00.000Z' });
    const response = {
      ok: false, status,
      text: vi.fn().mockRejectedValue(new Error('Authorization: Bearer access-secret private-body')),
    } as unknown as Response;
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response),
    });
    await expect(oauth.revoke()).rejects.toMatchObject({ code });
    expect(response.text).not.toHaveBeenCalled();
  });

  it('never includes credentials, tokens, authorization headers, or response bodies in errors', async () => {
    const files = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(
      'server leaked client-secret access-secret refresh-secret Authorization: Bearer access-secret', { status: 401 },
    ));
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch,
    });
    const { state } = oauth.authorize();
    const error = await oauth.handleCallback({ code: 'code', state }).catch(value => value as Error & { code: string });
    const exposed = `${error.name} ${error.message} ${error.stack ?? ''}`;
    expect(error.code).toBe('oauth_auth');
    expect(exposed).not.toMatch(/client-secret|access-secret|refresh-secret|authorization|bearer/i);
  });

  it('rejects incomplete token responses without persisting them', async () => {
    const files = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'access-secret', token_type: 'bearer', expires_in: '3600',
    }), { status: 200 }));
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch,
    });
    const { state } = oauth.authorize();

    await expect(oauth.handleCallback({ code: 'code', state })).rejects.toMatchObject({ code: 'oauth_invalid_response' });
    await expect(files.tokenStore.read()).rejects.toMatchObject({ code: 'secret_file_invalid' });
  });

  it('rejects an oversized chunked token response and overlong token fields without persistence', async () => {
    for (const body of [
      JSON.stringify({ access_token: 'x'.repeat(70_000), refresh_token: 'r', token_type: 'bearer', expires_in: 3600 }),
      JSON.stringify({ access_token: 'x'.repeat(5000), refresh_token: 'r', token_type: 'bearer', expires_in: 3600 }),
    ]) {
      const files = await fixture();
      const oauth = new NaverOAuth({
        clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
        ...files, fetch: vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
      });
      const { state } = oauth.authorize();
      await expect(oauth.handleCallback({ code: 'code', state })).rejects.toMatchObject({ code: 'oauth_invalid_response' });
      await expect(files.tokenStore.read()).rejects.toMatchObject({ code: 'secret_file_invalid' });
    }
  });

  it('maps an expires_in date overflow to oauth_invalid_response', async () => {
    const files = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'access-secret', refresh_token: 'refresh-secret', token_type: 'bearer',
      expires_in: String(Number.MAX_SAFE_INTEGER),
    }), { status: 200 }));
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch,
    });
    const { state } = oauth.authorize();

    await expect(oauth.handleCallback({ code: 'code', state })).rejects.toMatchObject({ code: 'oauth_invalid_response' });
  });
});
