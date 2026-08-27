import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  GOOGLE_CALENDAR_SCOPE,
  GoogleOAuth,
  validateGoogleOAuthClientCredentials,
  validateGoogleTokenSet,
  type GoogleTokenSet,
} from '../../src/calendar/google-oauth.js';

class MemoryStore<T> {
  constructor(public value?: T) {}
  async read(): Promise<T> {
    if (this.value === undefined) throw new Error('missing');
    return this.value;
  }
  async write(value: T): Promise<void> { this.value = value; }
  async delete(): Promise<void> { this.value = undefined; }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Google OAuth', () => {
  it('uses exact least-privilege scope, login hint, state and S256 PKCE for a desktop callback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'google-oauth-'));
    const tokens = new MemoryStore<GoogleTokenSet>();
    const fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const form = init?.body as URLSearchParams;
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('code')).toBe('authorization-code');
      expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
      return json({
        access_token: 'access-token', refresh_token: 'refresh-token', token_type: 'Bearer',
        expires_in: 3600, scope: GOOGLE_CALENDAR_SCOPE,
      });
    });
    const oauth = new GoogleOAuth({
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'client-secret',
      expectedAccount: 'yangisu12@gmail.com', stateDbPath: join(root, 'state.sqlite3'),
      tokenStore: tokens, fetch, now: () => Date.parse('2026-08-27T00:00:00.000Z'),
    });

    const begin = oauth.begin('http://127.0.0.1:43123/google/callback');
    const url = new URL(begin.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code', client_id: 'client.apps.googleusercontent.com',
      redirect_uri: 'http://127.0.0.1:43123/google/callback',
      scope: GOOGLE_CALENDAR_SCOPE, access_type: 'offline', prompt: 'consent',
      login_hint: 'yangisu12@gmail.com', code_challenge_method: 'S256',
    });
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(begin.expiresAt).toBe('2026-08-27T00:10:00.000Z');

    const callback = `http://127.0.0.1:43123/google/callback?code=authorization-code&state=${url.searchParams.get('state')}`;
    await expect(oauth.handleCallback(callback)).resolves.toEqual({
      version: 1, accessToken: 'access-token', refreshToken: 'refresh-token',
      expiresAt: '2026-08-27T01:00:00.000Z', scope: GOOGLE_CALENDAR_SCOPE,
    });
    expect(tokens.value?.accessToken).toBe('access-token');
  });

  it('rejects extra callback fields and consumes state exactly once before token exchange', async () => {
    const root = await mkdtemp(join(tmpdir(), 'google-oauth-state-'));
    const fetch = vi.fn(async () => json({}));
    const oauth = new GoogleOAuth({
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'secret',
      expectedAccount: 'yangisu12@gmail.com', stateDbPath: join(root, 'state.sqlite3'),
      tokenStore: new MemoryStore<GoogleTokenSet>(), fetch,
      now: () => Date.parse('2026-08-27T00:00:00.000Z'),
    });
    const begin = oauth.begin('http://127.0.0.1:43124/google/callback');
    const state = new URL(begin.authorizationUrl).searchParams.get('state');
    const base = `http://127.0.0.1:43124/google/callback?code=x&state=${state}`;

    await expect(oauth.handleCallback(`${base}&extra=1`))
      .rejects.toMatchObject({ code: 'google_oauth_callback_invalid' });
    expect(fetch).not.toHaveBeenCalled();
    await expect(oauth.handleCallback(base))
      .rejects.toMatchObject({ code: 'google_oauth_state_invalid' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts the canonical Google issuer parameter in an authorization callback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'google-oauth-issuer-'));
    const fetch = vi.fn(async () => json({
      access_token: 'access-token', refresh_token: 'refresh-token', token_type: 'Bearer',
      expires_in: 3600, scope: GOOGLE_CALENDAR_SCOPE,
    }));
    const oauth = new GoogleOAuth({
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'secret',
      expectedAccount: 'yangisu12@gmail.com', stateDbPath: join(root, 'state.sqlite3'),
      tokenStore: new MemoryStore<GoogleTokenSet>(), fetch,
      now: () => Date.parse('2026-08-27T00:00:00.000Z'),
    });
    const begin = oauth.begin('http://127.0.0.1:43125/google/callback');
    const state = new URL(begin.authorizationUrl).searchParams.get('state');
    const callback = `http://127.0.0.1:43125/google/callback?state=${state}`
      + '&iss=https%3A%2F%2Faccounts.google.com&code=authorization-code';

    await expect(oauth.handleCallback(callback)).resolves.toMatchObject({
      accessToken: 'access-token', refreshToken: 'refresh-token',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refreshes inside the five-minute window and preserves the prior refresh token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'google-oauth-refresh-'));
    const tokens = new MemoryStore<GoogleTokenSet>({
      version: 1, accessToken: 'old-access', refreshToken: 'old-refresh',
      expiresAt: '2026-08-27T00:04:00.000Z', scope: GOOGLE_CALENDAR_SCOPE,
    });
    const fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const form = init?.body as URLSearchParams;
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('refresh_token')).toBe('old-refresh');
      return json({
        access_token: 'new-access', token_type: 'Bearer', expires_in: 3600,
        scope: GOOGLE_CALENDAR_SCOPE,
      });
    });
    const oauth = new GoogleOAuth({
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'secret',
      expectedAccount: 'yangisu12@gmail.com', stateDbPath: join(root, 'state.sqlite3'),
      tokenStore: tokens, fetch, now: () => Date.parse('2026-08-27T00:00:00.000Z'),
    });

    await expect(oauth.getValidAccessToken()).resolves.toBe('new-access');
    expect(tokens.value).toEqual({
      version: 1, accessToken: 'new-access', refreshToken: 'old-refresh',
      expiresAt: '2026-08-27T01:00:00.000Z', scope: GOOGLE_CALENDAR_SCOPE,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('strictly validates desktop credentials and stored tokens', () => {
    expect(validateGoogleOAuthClientCredentials({
      version: 1, clientId: 'client.apps.googleusercontent.com', clientSecret: 'secret',
    })).toEqual({ version: 1, clientId: 'client.apps.googleusercontent.com', clientSecret: 'secret' });
    expect(() => validateGoogleOAuthClientCredentials({
      version: 1, clientId: 'client.apps.googleusercontent.com', clientSecret: 'secret', extra: true,
    })).toThrowError(/credentials/i);
    expect(() => validateGoogleTokenSet({
      version: 1, accessToken: 'a', refreshToken: 'r', expiresAt: '2026-08-27T01:00:00.000Z',
      scope: 'https://www.googleapis.com/auth/calendar',
    })).toThrowError(/token/i);
  });
});
