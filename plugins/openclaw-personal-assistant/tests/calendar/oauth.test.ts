import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NaverOAuth, type NaverTokenSet } from '../../src/calendar/oauth.js';
import { SecretFileStore } from '../../src/secrets/file-store.js';

const temporaryDirectories: string[] = [];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'naver-oauth-test-'));
  temporaryDirectories.push(directory);
  const tokenFile = join(directory, 'tokens.json');
  const tokenStore = new SecretFileStore<NaverTokenSet>(tokenFile, {
    verifyOwnerOnly: async () => true,
    syncParent: async () => undefined,
  });
  return { directory, tokenFile, tokenStore, stateDbPath: join(directory, 'oauth-state.sqlite3') };
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

describe('SecretFileStore', () => {
  it('writes JSON atomically and leaves no temporary file behind', async () => {
    const { directory, tokenFile, tokenStore } = await fixture();
    await tokenStore.write({ accessToken: 'access', refreshToken: 'refresh', expiresAt: '2030-01-01T00:00:00.000Z' });

    await expect(tokenStore.read()).resolves.toEqual({
      accessToken: 'access', refreshToken: 'refresh', expiresAt: '2030-01-01T00:00:00.000Z',
    });
    expect(await readdir(directory)).toEqual(['tokens.json']);
    expect((await stat(tokenFile)).isFile()).toBe(true);
  });

  it('fails closed when owner-only permissions cannot be verified', async () => {
    const { tokenFile } = await fixture();
    const store = new SecretFileStore(tokenFile, { platform: 'win32' });
    await expect(store.write({ token: 'never-written' })).rejects.toMatchObject({
      code: 'secret_permissions_unverifiable',
    });
  });

  it('rejects a file whose permissions cease to be owner-only', async () => {
    if (process.platform === 'win32') return;
    const { tokenFile } = await fixture();
    const store = new SecretFileStore(tokenFile);
    await store.write({ token: 'secret' });
    await chmod(tokenFile, 0o644);
    await expect(store.read()).rejects.toMatchObject({ code: 'secret_permissions_invalid' });
  });
});

describe('NaverOAuth one-time callback state', () => {
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
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch,
    });
    const { state } = oauth.authorize();
    await expect(oauth.handleCallback({ code: 'one-time-code', state })).resolves.toMatchObject({ accessToken: 'access-new' });
    await expect(oauth.handleCallback({ code: 'one-time-code', state })).rejects.toMatchObject({ code: 'oauth_state_invalid' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('allows only one callback to win a concurrent state race', async () => {
    const files = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(tokenResponse());
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch,
    });
    const { state } = oauth.authorize();

    const results = await Promise.allSettled([
      oauth.handleCallback({ code: 'first-code', state }),
      oauth.handleCallback({ code: 'second-code', state }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')[0]).toMatchObject({
      reason: { code: 'oauth_state_invalid' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
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
      accessToken: 'access-new', refreshToken: 'refresh-new', expiresAt: '2030-01-01T01:00:00.000Z',
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
    await files.tokenStore.write({ accessToken: 'access-old', refreshToken: 'refresh-old', expiresAt: '2029-01-01T00:00:00.000Z' });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'access-refreshed', token_type: 'bearer', expires_in: '3600',
    }), { status: 200 }));
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch, now: () => Date.parse('2030-01-01T00:00:00.000Z'),
    });

    await expect(oauth.refresh()).resolves.toEqual({
      accessToken: 'access-refreshed', refreshToken: 'refresh-old', expiresAt: '2030-01-01T01:00:00.000Z',
    });
    const form = new URLSearchParams(String(fetch.mock.calls[0]![1]?.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'refresh_token', client_id: 'client-id', client_secret: 'client-secret', refresh_token: 'refresh-old',
    });
  });

  it('retries refresh once only when the first failure is proven pre-send', async () => {
    const files = await fixture();
    await files.tokenStore.write({ accessToken: 'access-old', refreshToken: 'refresh-old', expiresAt: '2029-01-01T00:00:00.000Z' });
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
    await files.tokenStore.write({ accessToken: 'access-old', refreshToken: 'refresh-old', expiresAt: '2029-01-01T00:00:00.000Z' });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const oauth = new NaverOAuth({
      clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback',
      ...files, fetch,
    });

    await expect(oauth.revoke()).resolves.toBeUndefined();
    expect(String(fetch.mock.calls[0]![0])).toBe('https://nid.naver.com/oauth2.0/revoke');
    expect(Object.fromEntries(new URLSearchParams(String(fetch.mock.calls[0]![1]?.body)))).toEqual({
      client_id: 'client-id', client_secret: 'client-secret', token: 'refresh-old', token_type_hint: 'refresh_token',
    });
    await expect(files.tokenStore.read()).rejects.toMatchObject({ code: 'secret_file_invalid' });
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
});
