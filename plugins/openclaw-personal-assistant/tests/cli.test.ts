import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { runCli, type CliDependencies, type CliIo } from '../src/cli.js';
import { buildBriefing } from '../src/briefing/build.js';
import { applyRetention } from '../src/ops/backup.js';
import { SubsystemHealthStore } from '../src/state/health.js';

function capture(stdin = ''): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: { stdout: value => stdout.push(value), stderr: value => stderr.push(value), readStdin: async () => stdin },
  };
}

describe('operational CLI', () => {
  it('runs daily and monthly maintenance from one absolute private config path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-maintenance-cli-'));
    const config = join(root, 'maintenance.json');
    const runner = vi.fn().mockImplementation(async (kind: 'daily' | 'monthly', path: string) => ({
      status: 'open', kind, archive: join(root, `${kind}.age`),
      evidencePath: join(root, `${kind}.evidence.json`), deletedCount: kind === 'daily' ? 2 : 0,
    }));
    for (const kind of ['daily', 'monthly'] as const) {
      const output = capture();
      expect(await runCli(['maintenance', kind, '--config', config], output.io, { maintenanceRunner: runner })).toBe(0);
      expect(JSON.parse(output.stdout[0]!)).toEqual({
        status: 'open', kind, archive: `${kind}.age`, deletedCount: kind === 'daily' ? 2 : 0,
        redactedErrorCode: null,
      });
      expect(output.stderr).toEqual([]);
    }
    expect(runner.mock.calls).toEqual([['daily', config], ['monthly', config]]);
  });

  it('rejects malformed maintenance argv before opening any config or secret', async () => {
    const runner = vi.fn();
    for (const args of [
      ['maintenance', 'daily', '--config', 'relative.json'],
      ['maintenance', 'weekly', '--config', '/absolute/config.json'],
      ['maintenance', 'daily', '--config', '/absolute/config.json', '--identity', 'secret'],
    ]) {
      const output = capture();
      expect(await runCli(args, output.io, { maintenanceRunner: runner })).toBe(64);
      expect(output.stdout).toEqual([]);
    }
    expect(runner).not.toHaveBeenCalled();
  });

  it('checks the private maintenance config and offline identity without running maintenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-maintenance-check-'));
    const config = join(root, 'maintenance.json');
    const checker = vi.fn().mockResolvedValue(undefined);
    const runner = vi.fn();
    const output = capture();
    expect(await runCli(['maintenance', 'check', '--config', config], output.io, {
      maintenanceConfigChecker: checker, maintenanceRunner: runner,
    })).toBe(0);
    expect(checker).toHaveBeenCalledWith(config);
    expect(runner).not.toHaveBeenCalled();
    expect(JSON.parse(output.stdout[0]!)).toEqual({ status: 'open', redactedErrorCode: null });
  });

  it('runs the Naver OAuth lifecycle with sensitive values only on private stdin and secret stores', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-oauth-cli-'));
    const clientFile = join(root, 'naver-client.json');
    const tokenFile = join(root, 'naver-token.json');
    const state = join(root, 'state');
    const credentials = {
      version: 1 as const, clientId: 'owner-client', clientSecret: 'client-secret-canary',
      redirectUri: 'http://127.0.0.1:1456/naver/callback',
    };
    const credentialStore = new CliMemoryStore<unknown>();
    const tokenStore = new CliMemoryStore<unknown>();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access-token-canary', refresh_token: 'refresh-token-canary',
        token_type: 'bearer', expires_in: 3600,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access-token-refreshed', token_type: 'bearer', expires_in: 7200,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    const dependencies: CliDependencies = {
      credentialStore: () => credentialStore,
      tokenStore: () => tokenStore as never,
      oauthFetch: fetch,
      now: () => Date.parse('2030-01-01T00:00:00.000Z'),
    };
    const common = ['--client-file', clientFile, '--token-file', tokenFile, '--state', state];

    const configured = capture(JSON.stringify(credentials));
    expect(await runCli(['oauth', 'configure', '--client-file', clientFile], configured.io, dependencies)).toBe(0);
    const begun = capture();
    expect(await runCli(['oauth', 'begin', '--client-file', clientFile, '--state', state], begun.io, dependencies)).toBe(0);
    const authorization = JSON.parse(begun.stdout[0]!);
    const authorizationUrl = new URL(authorization.authorizationUrl);
    const stateValue = authorizationUrl.searchParams.get('state')!;
    const completed = capture(JSON.stringify({
      callbackUrl: `${credentials.redirectUri}?code=authorization-code-canary&state=${encodeURIComponent(stateValue)}`,
    }));
    expect(await runCli(['oauth', 'callback', ...common], completed.io, dependencies)).toBe(0);
    expect(await runCli(['oauth', 'refresh', ...common], capture().io, dependencies)).toBe(0);
    expect(await runCli(['oauth', 'status', ...common], capture().io, dependencies)).toBe(0);
    const revoked = capture();
    expect(await runCli(['oauth', 'revoke', ...common], revoked.io, dependencies)).toBe(0);

    const exposed = [configured, begun, completed, revoked].flatMap(item => [...item.stdout, ...item.stderr]).join('\n');
    expect(exposed).not.toMatch(/client-secret-canary|authorization-code-canary|access-token-canary|refresh-token-canary|access-token-refreshed/);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(tokenStore.value).toBeUndefined();
    expect(common.join(' ')).not.toMatch(/canary|code|secret/i);
  });

  it('classifies an expired token as refreshable without network or any store, lease, health, or tree mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-oauth-status-'));
    const state = join(root, 'state'); await mkdir(state);
    const sentinel = join(state, 'owner-sentinel');
    await writeFile(sentinel, 'unchanged\n');
    const clientFile = join(root, 'client.json'); const tokenFile = join(root, 'token.json');
    const credentials = new CliMemoryStore<unknown>({
      version: 1, clientId: 'client', clientSecret: 'private-client-secret',
      redirectUri: 'http://127.0.0.1:1456/naver/callback',
    });
    const tokens = new CliMemoryStore<unknown>({
      version: 1, accessToken: 'expired-access', refreshToken: 'private-refresh',
      expiresAt: '2029-12-31T23:00:00.000Z',
    });
    const fetch = vi.fn();
    const beforeToken = JSON.stringify(tokens.value);
    const beforeEntries = await readdir(state);
    const beforeSentinel = { bytes: await readFile(sentinel, 'utf8'), mtimeMs: (await stat(sentinel)).mtimeMs };
    const output = capture();
    expect(await runCli([
      'oauth', 'status', '--client-file', clientFile, '--token-file', tokenFile, '--state', state,
    ], output.io, {
      credentialStore: () => credentials, tokenStore: () => tokens as never, oauthFetch: fetch,
      now: () => Date.parse('2030-01-01T00:00:00.000Z'),
    })).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(tokens.value)).toBe(beforeToken);
    expect(await readdir(state)).toEqual(beforeEntries);
    expect({ bytes: await readFile(sentinel, 'utf8'), mtimeMs: (await stat(sentinel)).mtimeMs }).toEqual(beforeSentinel);
    expect(output.stdout.join('\n')).not.toMatch(/private-client-secret|expired-access|private-refresh/);
    expect(JSON.parse(output.stdout[0]!)).toEqual({
      status: 'refreshable', expiresAt: '2029-12-31T23:00:00.000Z', redactedErrorCode: null,
    });
  });

  it('reports fresh and unusable OAuth stores deterministically without network', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-oauth-status-state-'));
    const state = join(root, 'state');
    const credentials = new CliMemoryStore<unknown>({
      version: 1, clientId: 'client', clientSecret: 'private-client-secret',
      redirectUri: 'http://127.0.0.1:1456/naver/callback',
    });
    const tokens = new CliMemoryStore<unknown>({
      version: 1, accessToken: 'private-access', refreshToken: 'private-refresh',
      expiresAt: '2030-01-01T01:00:00.000Z',
    });
    const fetch = vi.fn();
    const dependencies = {
      credentialStore: () => credentials, tokenStore: () => tokens as never, oauthFetch: fetch,
      now: () => Date.parse('2030-01-01T00:00:00.000Z'),
    };
    const args = ['oauth', 'status', '--client-file', join(root, 'client'), '--token-file', join(root, 'token'), '--state', state];
    const fresh = capture();
    expect(await runCli(args, fresh.io, dependencies)).toBe(0);
    expect(JSON.parse(fresh.stdout[0]!)).toEqual({
      status: 'fresh', expiresAt: '2030-01-01T01:00:00.000Z', redactedErrorCode: null,
    });
    tokens.value = { version: 1, accessToken: 'private-access', refreshToken: '', expiresAt: '2030-01-01T01:00:00.000Z' };
    const unusable = capture();
    expect(await runCli(args, unusable.io, dependencies)).toBe(1);
    expect(JSON.parse(unusable.stdout[0]!)).toEqual({
      status: 'unusable', expiresAt: null, redactedErrorCode: 'oauth_token_invalid',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(unusable.stdout.join('\n')).not.toMatch(/private-client-secret|private-access|private-refresh/);
  });

  it('rejects a callback whose exact redirect query contains an unapproved field before exchange', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-oauth-redirect-'));
    const clientFile = join(root, 'client.json');
    const tokenFile = join(root, 'token.json');
    const state = join(root, 'state');
    const credentials = new CliMemoryStore<unknown>({
      version: 1, clientId: 'client', clientSecret: 'secret',
      redirectUri: 'http://127.0.0.1:1456/naver/callback',
    });
    const fetch = vi.fn();
    const dependencies: CliDependencies = {
      credentialStore: () => credentials,
      tokenStore: () => new CliMemoryStore() as never,
      oauthFetch: fetch,
    };
    const begun = capture();
    expect(await runCli([
      'oauth', 'begin', '--client-file', clientFile, '--state', state,
    ], begun.io, dependencies)).toBe(0);
    const stateValue = new URL(JSON.parse(begun.stdout[0]!).authorizationUrl).searchParams.get('state')!;
    const callback = capture(JSON.stringify({
      callbackUrl: `http://127.0.0.1:1456/naver/callback?code=private&state=${stateValue}&extra=1`,
    }));

    expect(await runCli([
      'oauth', 'callback', '--client-file', clientFile, '--token-file', tokenFile, '--state', state,
    ], callback.io, dependencies)).toBe(64);
    expect(fetch).not.toHaveBeenCalled();
    expect(callback.stdout).toEqual([]);
  });

  it('imports Google Desktop credentials and reports token status without exposing secrets or using network', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-google-oauth-cli-'));
    const clientFile = join(root, 'google-client');
    const tokenFile = join(root, 'google-token');
    const state = join(root, 'state');
    const credentials = new CliMemoryStore<unknown>();
    const tokens = new CliMemoryStore<unknown>({
      version: 1, accessToken: 'private-access', refreshToken: 'private-refresh',
      expiresAt: '2030-01-01T01:00:00.000Z',
      scope: 'https://www.googleapis.com/auth/calendar.app.created',
    });
    const fetch = vi.fn();
    const inputSecret = 'private-google-client-secret';
    const configured = capture(JSON.stringify({ installed: {
      client_id: 'client.apps.googleusercontent.com', client_secret: inputSecret,
      project_id: 'openclaw-personal', auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      redirect_uris: ['http://localhost'],
    } }));
    const dependencies: CliDependencies = {
      googleCredentialStore: () => credentials,
      googleTokenStore: () => tokens as never,
      googleFetch: fetch,
      now: () => Date.parse('2030-01-01T00:00:00.000Z'),
    };

    expect(await runCli(['google', 'oauth', 'configure', '--client-file', clientFile], configured.io, dependencies)).toBe(0);
    expect(credentials.value).toEqual({
      version: 1, clientId: 'client.apps.googleusercontent.com', clientSecret: inputSecret,
    });
    const status = capture();
    expect(await runCli([
      'google', 'oauth', 'status', '--client-file', clientFile, '--token-file', tokenFile, '--state', state,
    ], status.io, dependencies)).toBe(0);
    expect(JSON.parse(status.stdout[0]!)).toEqual({
      status: 'fresh', expiresAt: '2030-01-01T01:00:00.000Z', redactedErrorCode: null,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect([...configured.stdout, ...status.stdout, ...configured.stderr, ...status.stderr].join('\n'))
      .not.toMatch(/private-google-client-secret|private-access|private-refresh/);
  });

  it('creates the dedicated Google calendar once and verifies the stored binding on rerun', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-google-calendar-cli-'));
    const clientFile = join(root, 'google-client');
    const tokenFile = join(root, 'google-token');
    const bindingFile = join(root, 'google-binding');
    const state = join(root, 'state');
    const credentials = new CliMemoryStore<unknown>({
      version: 1, clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-secret',
    });
    const tokens = new CliMemoryStore<unknown>({
      version: 1, accessToken: 'private-access', refreshToken: 'private-refresh',
      expiresAt: '2030-01-01T01:00:00.000Z',
      scope: 'https://www.googleapis.com/auth/calendar.app.created',
    });
    const binding = new CliMemoryStore<unknown>();
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({
        id: 'created@group.calendar.google.com', summary: 'openclaw_cal', timeZone: 'Asia/Seoul',
      }), { status: 200 });
      expect(decodeURIComponent(String(input))).toContain('/calendars/created@group.calendar.google.com');
      return new Response(JSON.stringify({
        id: 'created@group.calendar.google.com', summary: 'openclaw_cal', timeZone: 'Asia/Seoul',
      }), { status: 200 });
    });
    const dependencies: CliDependencies = {
      googleCredentialStore: () => credentials,
      googleTokenStore: () => tokens as never,
      googleBindingStore: () => binding as never,
      googleBindingExists: () => binding.value !== undefined,
      googleFetch: fetch,
      now: () => Date.parse('2030-01-01T00:00:00.000Z'),
    };
    const args = [
      'google', 'calendar', 'bootstrap', '--client-file', clientFile, '--token-file', tokenFile,
      '--binding-file', bindingFile, '--state', state,
    ];

    expect(await runCli(args, capture().io, dependencies)).toBe(0);
    expect(binding.value).toEqual({
      version: 1, calendarId: 'created@group.calendar.google.com', summary: 'openclaw_cal',
      timeZone: 'Asia/Seoul', createdAt: '2030-01-01T00:00:00.000Z',
    });
    expect(await runCli(args, capture().io, dependencies)).toBe(0);
    expect(fetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);
  });

  it('runs a zero-residue Google Calendar create-update-delete PoC', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-google-poc-cli-'));
    const bindingValue = {
      version: 1 as const, calendarId: 'created@group.calendar.google.com', summary: 'openclaw_cal' as const,
      timeZone: 'Asia/Seoul' as const, createdAt: '2030-01-01T00:00:00.000Z',
    };
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = decodeURIComponent(String(input));
      if (!url.includes('/events')) return new Response(JSON.stringify({
        id: bindingValue.calendarId, summary: bindingValue.summary, timeZone: bindingValue.timeZone,
      }), { status: 200 });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (init?.method === 'GET') return new Response(JSON.stringify({ items: [] }), { status: 200 });
      const body = JSON.parse(String(init?.body));
      const eventId = url.split('/events/')[1] ?? body.id;
      return new Response(JSON.stringify({
        id: eventId, etag: init?.method === 'PATCH' ? '"etag-2"' : '"etag-1"',
        status: 'confirmed', summary: body.summary,
        start: body.start ?? { dateTime: '2030-01-01T01:00:00.000Z' },
        end: body.end ?? { dateTime: '2030-01-01T02:00:00.000Z' },
      }), { status: 200 });
    });
    const dependencies: CliDependencies = {
      googleCredentialStore: () => new CliMemoryStore({
        version: 1 as const, clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-secret',
      }),
      googleTokenStore: () => new CliMemoryStore({
        version: 1 as const, accessToken: 'private-access', refreshToken: 'private-refresh',
        expiresAt: '2030-01-01T01:00:00.000Z',
        scope: 'https://www.googleapis.com/auth/calendar.app.created' as const,
      }),
      googleBindingStore: () => new CliMemoryStore(bindingValue),
      googleBindingExists: () => true,
      googleFetch: fetch,
      now: () => Date.parse('2030-01-01T00:00:00.123Z'),
    };
    const output = capture();
    expect(await runCli([
      'google', 'calendar', 'poc', '--client-file', join(root, 'client'), '--token-file', join(root, 'token'),
      '--binding-file', join(root, 'binding'), '--state', join(root, 'state'),
    ], output.io, dependencies)).toBe(0);
    expect(JSON.parse(output.stdout[0]!)).toEqual({
      status: 'PASS', created: true, updated: true, deleted: true, remaining: 0, redactedErrorCode: null,
    });
    expect(fetch.mock.calls.map(call => call[1]?.method)).toEqual(['GET', 'POST', 'PATCH', 'DELETE', 'GET']);
    expect(output.stdout.join('\n')).not.toMatch(/private-secret|private-access|private-refresh/);
  });
  it('initializes only private directories and non-secret templates without overwriting data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-cli-'));
    const out = capture();
    expect(await runCli(['init', '--root', root], out.io)).toBe(0);
    const tasks = join(root, 'workspace', 'TASKS.md');
    expect(await readFile(tasks, 'utf8')).toContain('# Tasks\n');
    await writeFile(tasks, 'owner data\n', 'utf8');
    expect(await runCli(['init', '--root', root], out.io)).toBe(0);
    expect(await readFile(tasks, 'utf8')).toBe('owner data\n');
    expect(out.stdout.at(-1)).toContain('"status":"open"');
  }, 15_000);

  it('refuses relative roots and indirect roots', async () => {
    const out = capture();
    expect(await runCli(['init', '--root', 'relative'], out.io)).toBe(64);
    const parent = await mkdtemp(join(tmpdir(), 'ocpa-link-'));
    const target = join(parent, 'target');
    await mkdir(target);
    const link = join(parent, 'link');
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await runCli(['init', '--root', link], out.io)).toBe(64);
    const indirectChild = join(link, 'new-root');
    expect(await runCli(['init', '--root', indirectChild], out.io)).toBe(64);
    await expect(lstat(join(target, 'new-root'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('records a redacted PoC report while doctor keeps operator-authored gates unknown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-gate-'));
    const state = join(root, 'state');
    const evidence = join(root, 'evidence.json');
    await writeFile(evidence, JSON.stringify({
      status: 'closed',
      observedChecks: ['authentication rejected without credential disclosure'],
      redactedErrorCode: 'CALDAV_AUTH',
      timestamp: new Date().toISOString(),
    }));
    const poc = capture();
    expect(await runCli(['poc', 'caldav', '--state', state, '--evidence', evidence], poc.io)).toBe(1);
    expect(poc.stdout.join('')).toContain('authentication rejected without credential disclosure');
    const doctor = capture();
    expect(await runCli(['doctor', '--state', state], doctor.io)).toBe(1);
    expect(doctor.stdout.join('')).toContain('caldav: unknown');
  });

  it('keeps fabricated Naver PoC evidence report-only and derives OAuth readiness from fresh secret state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-oauth-doctor-'));
    const state = join(root, 'state');
    const evidence = join(root, 'evidence.json');
    const clientFile = join(root, 'client.json');
    const tokenFile = join(root, 'token.json');
    await writeFile(evidence, JSON.stringify({
      status: 'open', observedChecks: ['operator claimed Naver OAuth success'], redactedErrorCode: null,
      timestamp: new Date().toISOString(),
    }));
    expect(await runCli(['poc', 'naver-oauth', '--state', state, '--evidence', evidence], capture().io)).toBe(0);
    const fabricated = capture();
    expect(await runCli(['doctor', '--state', state], fabricated.io)).toBe(1);
    expect(fabricated.stdout.join('\n')).toContain('naver-oauth: unknown');

    const dependencies: CliDependencies = {
      credentialStore: () => new CliMemoryStore({
        version: 1 as const, clientId: 'client', clientSecret: 'secret',
        redirectUri: 'http://127.0.0.1:1456/naver/callback',
      }),
      tokenStore: () => new CliMemoryStore({
        version: 1 as const, accessToken: 'access', refreshToken: 'refresh',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    };
    const derived = capture();
    expect(await runCli([
      'doctor', '--state', state, '--naver-client-file', clientFile, '--naver-token-file', tokenFile,
    ], derived.io, dependencies)).toBe(1);
    expect(derived.stdout.join('\n')).toContain('naver-oauth: open');
    expect(derived.stdout.join('\n')).toContain('naver-create: unknown');
  });

  it('rejects extra PoC evidence fields before secrets can reach stdout or durable state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-gate-extra-'));
    const state = join(root, 'state');
    const evidence = join(root, 'evidence.json');
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    await writeFile(evidence, JSON.stringify({
      status: 'open', observedChecks: ['model response observed'], redactedErrorCode: null,
      timestamp: new Date().toISOString(), refreshToken: secret, nested: { apiKey: secret },
    }));
    const output = capture();

    expect(await runCli(['poc', 'openai', '--state', state, '--evidence', evidence], output.io)).toBe(64);
    expect(output.stdout.join('')).toBe('');
    expect(output.stderr.join('')).not.toContain(secret);
    await expect(lstat(join(state, 'gates', 'openai.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['unsafe URL', ['callback https://example.invalid/?code=secret-value'], new Date().toISOString()],
    ['control character', ['line\u0000break'], new Date().toISOString()],
    ['format character', ['hidden\u202Evalue'], new Date().toISOString()],
    ['expired timestamp', ['model response observed'], '2020-01-01T00:00:00Z'],
    ['future timestamp', ['model response observed'], new Date(Date.now() + 60 * 60_000).toISOString()],
  ])('rejects %s in PoC evidence', async (_label, observedChecks, timestamp) => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-gate-invalid-'));
    const evidence = join(root, 'evidence.json');
    await writeFile(evidence, JSON.stringify({ status: 'open', observedChecks, redactedErrorCode: null, timestamp }));
    const output = capture();
    expect(await runCli(['poc', 'openai', '--state', join(root, 'state'), '--evidence', evidence], output.io)).toBe(64);
    expect(output.stdout).toEqual([]);
  });

  it('emits and persists only the exact four PoC evidence fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-gate-fields-'));
    const state = join(root, 'state');
    const evidence = join(root, 'evidence.json');
    await writeFile(evidence, JSON.stringify({
      status: 'open', observedChecks: ['model response observed'], redactedErrorCode: null,
      timestamp: new Date().toISOString(),
    }));
    const output = capture();
    expect(await runCli(['poc', 'openai', '--state', state, '--evidence', evidence], output.io)).toBe(0);
    const printed = JSON.parse(output.stdout[0]!);
    const stored = JSON.parse(await readFile(join(state, 'gates', 'openai.json'), 'utf8'));
    expect(Object.keys(printed).sort()).toEqual(['observedChecks', 'redactedErrorCode', 'status', 'timestamp']);
    expect(stored).toEqual(printed);
  });

  it('doctor keeps missing and expired operator evidence report-only and unknown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-doctor-'));
    const state = join(root, 'state');
    await mkdir(join(state, 'gates'), { recursive: true });
    await writeFile(join(state, 'gates', 'openai.json'), JSON.stringify({
      status: 'open', observedChecks: ['model response observed'], redactedErrorCode: null,
      timestamp: '2020-01-01T00:00:00Z',
    }));
    const output = capture();
    expect(await runCli(['doctor', '--state', state, '--max-age-hours', '24'], output.io)).toBe(1);
    expect(output.stdout.join('')).toContain('openai: unknown');
    expect(output.stdout.join('')).toContain('caldav: unknown');
  });

  it('doctor fails a durable gate closed when its timestamp is in the future', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-doctor-future-'));
    const state = join(root, 'state');
    await mkdir(join(state, 'gates'), { recursive: true });
    await writeFile(join(state, 'gates', 'openai.json'), JSON.stringify({
      status: 'open', observedChecks: ['model response observed'], redactedErrorCode: null,
      timestamp: new Date(Date.now() + 60 * 60_000).toISOString(),
    }));
    const output = capture();
    expect(await runCli(['doctor', '--state', state], output.io)).toBe(1);
    expect(output.stdout.join('')).toContain('openai: unknown');
  });

  it('repairs and verifies private permissions for every existing init directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-private-tree-'));
    await mkdir(join(root, 'workspace', 'memory'), { recursive: true });
    await mkdir(join(root, 'state', 'gates'), { recursive: true });
    if (process.platform !== 'win32') {
      await chmod(root, 0o755);
      await chmod(join(root, 'workspace'), 0o755);
      await chmod(join(root, 'state', 'gates'), 0o755);
    }
    expect(await runCli(['init', '--root', root], capture().io)).toBe(0);
    const directories = [root, 'workspace', 'workspace/memory', 'workspace/archive', 'state', 'state/gates', 'secrets', 'config']
      .map(path => path === root ? root : join(root, path));
    if (process.platform === 'win32') {
      for (const directory of directories) {
        const script = `$a=Get-Acl -LiteralPath '${directory.replaceAll("'", "''")}'; if(!$a.AreAccessRulesProtected -or @($a.Access|? IsInherited).Count -ne 0){exit 1}`;
        expect((await import('node:child_process')).spawnSync('pwsh', ['-NoProfile', '-Command', script]).status).toBe(0);
      }
    } else {
      for (const directory of directories) {
        const info = await stat(directory);
        expect(info.mode & 0o777).toBe(0o700);
        expect(info.uid).toBe(process.getuid!());
      }
    }
  }, 30_000);

  it('preserves existing managed files while repairing their privacy idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-private-files-'));
    await mkdir(join(root, 'workspace'), { recursive: true });
    const tasks = join(root, 'workspace', 'TASKS.md');
    await writeFile(tasks, 'owner content must survive\n', { mode: 0o644 });
    if (process.platform === 'win32') {
      const { spawnSync } = await import('node:child_process');
      expect(spawnSync('icacls.exe', [tasks, '/inheritance:e']).status).toBe(0);
    } else await chmod(tasks, 0o644);

    expect(await runCli(['init', '--root', root], capture().io)).toBe(0);
    expect(await runCli(['init', '--root', root], capture().io)).toBe(0);
    expect(await readFile(tasks, 'utf8')).toBe('owner content must survive\n');
    if (process.platform === 'win32') {
      const { spawnSync } = await import('node:child_process');
      const script = `$a=Get-Acl -LiteralPath '${tasks.replaceAll("'", "''")}'; if(!$a.AreAccessRulesProtected -or @($a.Access|? IsInherited).Count -ne 0){exit 1}`;
      expect(spawnSync('pwsh', ['-NoProfile', '-Command', script]).status).toBe(0);
    } else {
      const info = await stat(tasks);
      expect(info.mode & 0o777).toBe(0o600);
      expect(info.uid).toBe(process.getuid!());
    }
  }, 30_000);

  it.each([
    ['backup', '--workspace', '/tmp/workspace', '--state', '/tmp/state', '--backup-dir', 'relative', '--identity', '/tmp/key', '--recipient', 'age1test'],
    ['restore', '--archive', 'relative', '--restore-root', '/tmp/restore', '--identity', '/tmp/key'],
  ])('requires absolute paths for %s', async (...args) => {
    const output = capture();
    expect(await runCli(args as string[], output.io)).toBe(64);
  });

  it('requires reconcile state and records verification failure in the real health store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-reconcile-health-'));
    const archive = join(root, '2026-08-25.age');
    const identity = join(root, 'identity.txt');
    const state = join(root, 'state');
    await writeFile(archive, 'not an archive');
    await writeFile(identity, 'not an identity');
    expect(await runCli(['backup', 'reconcile', '--archive', archive, '--identity', identity], capture().io)).toBe(64);
    expect(await runCli(['backup', 'reconcile', '--archive', archive, '--identity', identity, '--state', state], capture().io)).toBe(70);
    const health = new SubsystemHealthStore(state);
    try {
      expect(health.listActive()).toEqual([expect.objectContaining({ target: 'backup' })]);
      health.recover('backup');
      health.report({
        target: `backup-publication:${'a'.repeat(64)}`, errorCode: 'BACKUP_PUBLICATION_UNKNOWN',
        message: 'Backup commit durability is unknown; run verified reconciliation before retention',
      });
    } finally { health.close(); }
    expect(await runCli(['backup', 'reconcile', '--archive', archive, '--identity', identity, '--state', state], capture().io)).toBe(70);
    const reopened = new SubsystemHealthStore(state);
    try {
      const active = reopened.listActive();
      expect(active).toEqual([expect.objectContaining({
        target: `backup-publication:${'a'.repeat(64)}`, errorCode: 'BACKUP_PUBLICATION_UNKNOWN',
      })]);
      expect(buildBriefing({
        now: '2026-08-25T09:00:00+09:00', events: [], tasks: [], studies: [], activeErrors: active,
      }).messages.join('\n')).toContain('Backup commit durability is unknown');
      const backupDir = join(root, 'backups');
      await mkdir(backupDir);
      await expect(applyRetention({ backupDir, identityFile: identity, health: reopened }))
        .rejects.toMatchObject({ code: 'publication_unknown' });
    } finally { reopened.close(); }
  });

  it('validates every reconcile option before creating or opening health state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-reconcile-parse-'));
    const state = join(root, 'state-that-must-not-exist');
    expect(await runCli([
      'backup', 'reconcile', '--archive', 'relative', '--identity', join(root, 'identity'), '--state', state,
    ], capture().io)).toBe(64);
    await expect(lstat(state)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symlinked health state before SQLite can be created', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-backup-state-link-'));
    const target = join(root, 'target');
    const state = join(root, 'state');
    const workspace = join(root, 'workspace');
    const backupDir = join(root, 'backup');
    const identity = join(root, 'identity');
    await Promise.all([mkdir(target), mkdir(workspace), mkdir(backupDir), writeFile(identity, 'identity')]);
    await symlink(target, state, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await runCli([
      'backup', '--workspace', workspace, '--state', state, '--backup-dir', backupDir,
      '--identity', identity, '--recipient', 'age1abcdefghijklmnop',
    ], capture().io)).toBe(64);
    await expect(lstat(join(target, 'health.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects secrets and credential URLs in command-line arguments', async () => {
    const output = capture();
    expect(await runCli(['poc', 'openai', '--token', 'secret-value'], output.io)).toBe(64);
    expect(output.stderr.join('')).not.toContain('secret-value');
  });
});

class CliMemoryStore<T> {
  constructor(public value?: T) {}
  async read(): Promise<T> {
    if (this.value === undefined) throw Object.assign(new Error('missing'), { code: 'secret_file_invalid' });
    return this.value;
  }
  async write(value: T): Promise<void> { this.value = value; }
  async delete(): Promise<void> { this.value = undefined; }
}
