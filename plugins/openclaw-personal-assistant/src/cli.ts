#!/usr/bin/env node
/// <reference types="node" />

import { chmod, lstat, mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  BackupError, BackupPublicationUnknownError, createBackup, restoreBackup, verifyBackup,
} from './ops/backup.js';
import { openRepository } from './workspace/repository.js';
import { SubsystemHealthStore } from './state/health.js';
import {
  NaverOAuth, validateNaverOAuthClientCredentials, validateStoredToken,
  type NaverOAuthClientCredentials, type NaverTokenSet, type SecretStore,
} from './calendar/oauth.js';
import { SecretFileStore } from './secrets/file-store.js';
import { runMaintenanceFromConfig, validateMaintenanceConfigFromFile } from './ops/maintenance.js';
import {
  GoogleOAuth,
  parseGoogleDesktopCredentials,
  validateGoogleOAuthClientCredentials,
  validateGoogleTokenSet,
  type GoogleTokenSet,
} from './calendar/google-oauth.js';
import {
  GoogleCalendarApi,
  validateGoogleCalendarBinding,
  type GoogleCalendarBinding,
} from './calendar/google-api.js';

export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
  readStdin?(): Promise<string>;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export interface CliDependencies {
  credentialStore?: (path: string) => SecretStore<unknown>;
  tokenStore?: (path: string) => SecretStore<NaverTokenSet>;
  oauthFetch?: FetchLike;
  googleCredentialStore?: (path: string) => SecretStore<unknown>;
  googleTokenStore?: (path: string) => SecretStore<GoogleTokenSet>;
  googleBindingStore?: (path: string) => SecretStore<GoogleCalendarBinding>;
  googleBindingExists?: (path: string) => boolean | Promise<boolean>;
  googleFetch?: FetchLike;
  now?: () => number;
  maintenanceRunner?: typeof runMaintenanceFromConfig;
  maintenanceConfigChecker?: typeof validateMaintenanceConfigFromFile;
}

type GateStatus = 'open' | 'closed' | 'unknown' | 'expired';
interface GateEvidence {
  status: GateStatus;
  observedChecks: string[];
  redactedErrorCode: string | null;
  timestamp: string;
}

const GATES = ['openai', 'naver-oauth', 'naver-create', 'caldav'] as const;
const EXIT = Object.freeze({ ok: 0, gateClosed: 1, gateUnknown: 2, publicationUnknown: 3, operation: 70, usage: 64 });
const defaultIo: CliIo = {
  stdout: value => process.stdout.write(`${value}\n`),
  stderr: value => process.stderr.write(`${value}\n`),
  readStdin: readBoundedStdin,
};

export async function runCli(
  args: readonly string[], io: CliIo = defaultIo, dependencies: CliDependencies = {},
): Promise<number> {
  try {
    rejectSensitiveArguments(args);
    const [command, ...rest] = args;
    if (command === 'init') return await init(rest, io);
    if (command === 'poc') return await poc(rest, io);
    if (command === 'doctor') return await doctor(rest, io, dependencies);
    if (command === 'oauth') return await oauth(rest, io, dependencies);
    if (command === 'google') return await google(rest, io, dependencies);
    if (command === 'backup') return await backup(rest, io);
    if (command === 'restore') return await restore(rest, io);
    if (command === 'maintenance') return await maintenance(rest, io, dependencies);
    throw usageError('expected init, poc, doctor, oauth, google, backup, restore, or maintenance');
  } catch (error) {
    const code = safeErrorCode(error);
    io.stderr(JSON.stringify({ status: 'error', redactedErrorCode: code }));
    if (error instanceof BackupPublicationUnknownError || code === 'publication_unknown') return EXIT.publicationUnknown;
    return code === 'cli_usage' || code.startsWith('path_') ? EXIT.usage : EXIT.operation;
  }
}

async function google(args: readonly string[], io: CliIo, dependencies: CliDependencies): Promise<number> {
  const [group, action, ...optionArgs] = args;
  if (group === 'oauth') return googleOAuth(String(action), optionArgs, io, dependencies);
  if (group === 'calendar') return googleCalendar(String(action), optionArgs, io, dependencies);
  throw usageError('expected google oauth or google calendar');
}

async function googleOAuth(
  action: string,
  args: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  if (action === 'configure') {
    const options = parseOptions(args, ['client-file']);
    const clientFile = requiredAbsolute(options, 'client-file');
    let parsed: unknown;
    try { parsed = JSON.parse(await readPrivateInput(io)); }
    catch { throw usageError('invalid Google OAuth credential input'); }
    const credentials = parseGoogleDesktopCredentials(parsed);
    await googleCredentialStore(clientFile, dependencies).write(credentials);
    io.stdout(JSON.stringify({ status: 'configured', redactedErrorCode: null }));
    return EXIT.ok;
  }
  if (action === 'status') {
    const options = parseOptions(args, ['client-file', 'token-file', 'state']);
    const clientFile = requiredAbsolute(options, 'client-file');
    const tokenFile = requiredAbsolute(options, 'token-file');
    requiredAbsolute(options, 'state');
    try {
      validateGoogleOAuthClientCredentials(await googleCredentialStore(clientFile, dependencies).read());
      const tokens = validateGoogleTokenSet(await googleTokenStore(tokenFile, dependencies).read());
      const now = dependencies.now?.() ?? Date.now();
      const status = Date.parse(tokens.expiresAt) - now > 5 * 60_000 ? 'fresh' : 'refreshable';
      io.stdout(JSON.stringify({ status, expiresAt: tokens.expiresAt, redactedErrorCode: null }));
      return EXIT.ok;
    } catch (error) {
      io.stdout(JSON.stringify({ status: 'unusable', expiresAt: null, redactedErrorCode: safeErrorCode(error) }));
      return EXIT.gateClosed;
    }
  }
  if (action === 'authorize') {
    const options = parseOptions(args, ['client-file', 'token-file', 'state']);
    const clientFile = requiredAbsolute(options, 'client-file');
    const tokenFile = requiredAbsolute(options, 'token-file');
    const stateDir = requiredAbsolute(options, 'state');
    await preparePrivateStateDirectory(stateDir);
    const credentials = validateGoogleOAuthClientCredentials(
      await googleCredentialStore(clientFile, dependencies).read(),
    );
    const tokenStore = googleTokenStore(tokenFile, dependencies);
    const oauth = new GoogleOAuth({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      expectedAccount: 'yangisu12@gmail.com',
      stateDbPath: join(stateDir, 'google-oauth-state.sqlite3'),
      tokenStore,
      ...(dependencies.googleFetch === undefined ? {} : { fetch: dependencies.googleFetch }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
    await authorizeWithLoopback(oauth, io);
    return EXIT.ok;
  }
  if (action === 'revoke') {
    const options = parseOptions(args, ['client-file', 'token-file', 'state']);
    const clientFile = requiredAbsolute(options, 'client-file');
    const tokenFile = requiredAbsolute(options, 'token-file');
    const stateDir = requiredAbsolute(options, 'state');
    const credentials = validateGoogleOAuthClientCredentials(
      await googleCredentialStore(clientFile, dependencies).read(),
    );
    const oauth = new GoogleOAuth({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      expectedAccount: 'yangisu12@gmail.com',
      stateDbPath: join(stateDir, 'google-oauth-state.sqlite3'),
      tokenStore: googleTokenStore(tokenFile, dependencies),
      ...(dependencies.googleFetch === undefined ? {} : { fetch: dependencies.googleFetch }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
    await oauth.revoke();
    io.stdout(JSON.stringify({ status: 'revoked', redactedErrorCode: null }));
    return EXIT.ok;
  }
  throw usageError('unsupported Google OAuth action');
}

async function googleCalendar(
  action: string,
  args: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  if (!['bootstrap', 'poc'].includes(action)) throw usageError('unsupported Google Calendar action');
  const options = parseOptions(args, ['client-file', 'token-file', 'binding-file', 'state']);
  const clientFile = requiredAbsolute(options, 'client-file');
  const tokenFile = requiredAbsolute(options, 'token-file');
  const bindingFile = requiredAbsolute(options, 'binding-file');
  const stateDir = requiredAbsolute(options, 'state');
  await preparePrivateStateDirectory(stateDir);
  const credentials = validateGoogleOAuthClientCredentials(
    await googleCredentialStore(clientFile, dependencies).read(),
  );
  const oauth = new GoogleOAuth({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    expectedAccount: 'yangisu12@gmail.com',
    stateDbPath: join(stateDir, 'google-oauth-state.sqlite3'),
    tokenStore: googleTokenStore(tokenFile, dependencies),
    ...(dependencies.googleFetch === undefined ? {} : { fetch: dependencies.googleFetch }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  const bindingStore = googleBindingStore(bindingFile, dependencies);
  const exists = dependencies.googleBindingExists
    ? await dependencies.googleBindingExists(bindingFile)
    : await lstat(bindingFile).then(info => info.isFile() && !info.isSymbolicLink()).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    });
  const existingBinding = exists ? validateGoogleCalendarBinding(await bindingStore.read()) : undefined;
  const api = await GoogleCalendarApi.bootstrap({
    accessToken: () => oauth.getValidAccessToken(),
    bindingStore,
    ...(existingBinding === undefined ? {} : { existingBinding }),
    ...(dependencies.googleFetch === undefined ? {} : { fetch: dependencies.googleFetch }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  if (action === 'bootstrap') {
    io.stdout(JSON.stringify({
      status: 'ready', calendarSummary: api.binding.summary,
      timeZone: api.binding.timeZone, redactedErrorCode: null,
    }));
    return EXIT.ok;
  }
  return googleCalendarPoc(api, io, dependencies.now?.() ?? Date.now());
}

function googleCredentialStore(path: string, dependencies: CliDependencies): SecretStore<unknown> {
  return dependencies.googleCredentialStore?.(path) ?? new SecretFileStore<unknown>(path, 16_384);
}

function googleTokenStore(path: string, dependencies: CliDependencies): SecretStore<GoogleTokenSet> {
  return dependencies.googleTokenStore?.(path) ?? new SecretFileStore<GoogleTokenSet>(path, 32_768);
}

function googleBindingStore(path: string, dependencies: CliDependencies): SecretStore<GoogleCalendarBinding> {
  return dependencies.googleBindingStore?.(path) ?? new SecretFileStore<GoogleCalendarBinding>(path, 16_384);
}

async function authorizeWithLoopback(oauth: GoogleOAuth, io: CliIo): Promise<void> {
  let settle: (() => void) | undefined;
  let fail: ((error: unknown) => void) | undefined;
  const completed = new Promise<void>((resolvePromise, reject) => { settle = resolvePromise; fail = reject; });
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'GET' || !request.url) throw usageError('invalid Google OAuth callback');
      const address = server.address();
      if (!address || typeof address === 'string') throw usageError('invalid Google OAuth listener');
      const callbackUrl = new URL(request.url, `http://127.0.0.1:${address.port}`).href;
      await oauth.handleCallback(callbackUrl);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><meta charset="utf-8"><title>OpenClaw</title><p>Google Calendar authorization completed. You may close this tab.</p>');
      settle?.();
    } catch (error) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><meta charset="utf-8"><title>OpenClaw</title><p>Authorization failed. Return to the terminal.</p>');
      fail?.(error);
    }
  });
  try {
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolvePromise);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw usageError('invalid Google OAuth listener');
    const authorization = oauth.begin(`http://127.0.0.1:${address.port}/google/callback`);
    io.stdout(JSON.stringify({
      status: 'authorization_required',
      authorizationUrl: authorization.authorizationUrl,
      expiresAt: authorization.expiresAt,
      redactedErrorCode: null,
    }));
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        completed,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(Object.assign(new Error('Google OAuth authorization timed out'), { code: 'google_oauth_timeout' })),
            10 * 60_000,
          );
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    io.stdout(JSON.stringify({ status: 'authorized', redactedErrorCode: null }));
  } finally {
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
  }
}

async function googleCalendarPoc(api: GoogleCalendarApi, io: CliIo, now: number): Promise<number> {
  const exactSecond = Math.floor(now / 1_000) * 1_000;
  const suffix = Math.floor(exactSecond / 1_000).toString(16).padStart(16, '0');
  const eventId = `oc${suffix}${suffix}`.slice(0, 34);
  const start = new Date(exactSecond + 60 * 60_000).toISOString();
  const end = new Date(exactSecond + 2 * 60 * 60_000).toISOString();
  const created = await api.createEvent({ eventId, summary: '[OpenClaw PoC]', dtstart: start, dtend: end });
  const updated = await api.updateEvent(eventId, created.etag, { summary: '[OpenClaw PoC updated]' });
  await api.deleteEvent(eventId, updated.etag);
  const remaining = (await api.listEvents({
    start: new Date(exactSecond).toISOString(), end: new Date(exactSecond + 24 * 60 * 60_000).toISOString(),
  })).filter(event => event.eventId === eventId).length;
  if (remaining !== 0) {
    throw Object.assign(new Error('Google Calendar PoC residue remains'), { code: 'calendar_poc_residue' });
  }
  io.stdout(JSON.stringify({
    status: 'PASS', created: true, updated: true, deleted: true, remaining: 0, redactedErrorCode: null,
  }));
  return EXIT.ok;
}


async function oauth(args: readonly string[], io: CliIo, dependencies: CliDependencies): Promise<number> {
  const [action, ...optionArgs] = args;
  if (action === 'configure') {
    const options = parseOptions(optionArgs, ['client-file']);
    const clientFile = requiredAbsolute(options, 'client-file');
    const input = await readPrivateInput(io);
    let parsed: unknown;
    try { parsed = JSON.parse(input); } catch { throw usageError('invalid OAuth credential input'); }
    const credentials = validateNaverOAuthClientCredentials(parsed);
    await (dependencies.credentialStore?.(clientFile) ?? new SecretFileStore<unknown>(clientFile, 16_384))
      .write(credentials);
    io.stdout(JSON.stringify({ status: 'configured', redactedErrorCode: null }));
    return EXIT.ok;
  }
  if (action === 'status') {
    const options = parseOptions(optionArgs, ['client-file', 'token-file', 'state']);
    const tokenFile = requiredAbsolute(options, 'token-file');
    const clientFile = requiredAbsolute(options, 'client-file');
    requiredAbsolute(options, 'state');
    try {
      validateNaverOAuthClientCredentials(await (
        dependencies.credentialStore?.(clientFile) ?? new SecretFileStore<unknown>(clientFile, 16_384)
      ).read());
      const tokens = validateStoredToken(await openTokenStore(tokenFile, dependencies).read());
      const now = dependencies.now?.() ?? Date.now();
      const status = Date.parse(tokens.expiresAt) - now > 60_000 ? 'fresh' : 'refreshable';
      io.stdout(JSON.stringify({ status, expiresAt: tokens.expiresAt, redactedErrorCode: null }));
      return EXIT.ok;
    } catch (error) {
      io.stdout(JSON.stringify({ status: 'unusable', expiresAt: null, redactedErrorCode: safeErrorCode(error) }));
      return EXIT.gateClosed;
    }
  }
  const allowed = action === 'begin' ? ['client-file', 'state'] : ['client-file', 'token-file', 'state'];
  if (!['begin', 'callback', 'refresh', 'revoke'].includes(String(action))) throw usageError('unsupported OAuth action');
  const options = parseOptions(optionArgs, allowed);
  const clientFile = requiredAbsolute(options, 'client-file');
  const stateDir = requiredAbsolute(options, 'state');
  const tokenFile = action === 'begin' ? undefined : requiredAbsolute(options, 'token-file');
  await preparePrivateStateDirectory(stateDir);
  const credentialStore = dependencies.credentialStore?.(clientFile) ?? new SecretFileStore<unknown>(clientFile, 16_384);
  const credentials = validateNaverOAuthClientCredentials(await credentialStore.read());
  const tokenStore = tokenFile === undefined
    ? new UnusedTokenStore()
    : openTokenStore(tokenFile, dependencies);
  const client = new NaverOAuth({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri: credentials.redirectUri,
    stateDbPath: join(stateDir, 'naver-oauth-state.sqlite3'),
    tokenStore,
    ...(dependencies.oauthFetch === undefined ? {} : { fetch: dependencies.oauthFetch }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    healthStateDir: stateDir,
  });
  if (action === 'begin') {
    const authorization = client.authorize();
    io.stdout(JSON.stringify({
      status: 'authorization_required', authorizationUrl: authorization.authorizationUrl,
      stateGuidance: 'Use only the matching local callback once within 10 minutes.', redactedErrorCode: null,
    }));
    return EXIT.ok;
  }
  if (action === 'callback') {
    const callbackUrl = parseCallbackInput(await readPrivateInput(io), credentials);
    await client.handleCallback({
      state: requiredCallbackValue(callbackUrl, 'state'),
      ...(callbackUrl.searchParams.has('code') ? { code: requiredCallbackValue(callbackUrl, 'code') } : {}),
      ...(callbackUrl.searchParams.has('error') ? { error: requiredCallbackValue(callbackUrl, 'error') } : {}),
      ...(callbackUrl.searchParams.has('error_description')
        ? { errorDescription: requiredCallbackValue(callbackUrl, 'error_description') } : {}),
    });
    io.stdout(JSON.stringify({ status: 'authorized', redactedErrorCode: null }));
    return EXIT.ok;
  }
  if (action === 'refresh') {
    const refreshed = await client.refresh();
    io.stdout(JSON.stringify({ status: 'open', expiresAt: refreshed.expiresAt, redactedErrorCode: null }));
    return EXIT.ok;
  }
  await client.revoke();
  io.stdout(JSON.stringify({ status: 'revoked', redactedErrorCode: null }));
  return EXIT.ok;
}

function openTokenStore(path: string, dependencies: CliDependencies): SecretStore<NaverTokenSet> {
  return dependencies.tokenStore?.(path) ?? new SecretFileStore<NaverTokenSet>(path, 32_768);
}

class UnusedTokenStore implements SecretStore<NaverTokenSet> {
  async read(): Promise<NaverTokenSet> { throw usageError('token store is unavailable'); }
  async write(): Promise<void> { throw usageError('token store is unavailable'); }
  async delete(): Promise<void> { throw usageError('token store is unavailable'); }
}

function parseCallbackInput(input: string, credentials: NaverOAuthClientCredentials): URL {
  let value: unknown;
  try { value = JSON.parse(input); } catch { throw usageError('invalid OAuth callback input'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).join('\0') !== 'callbackUrl'
    || typeof (value as { callbackUrl?: unknown }).callbackUrl !== 'string') {
    throw usageError('invalid OAuth callback input');
  }
  let callback: URL;
  try { callback = new URL((value as { callbackUrl: string }).callbackUrl); } catch {
    throw usageError('invalid OAuth callback input');
  }
  const expected = new URL(credentials.redirectUri);
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname
    || callback.username || callback.password || callback.hash) throw usageError('OAuth redirect does not match');
  const keys = [...callback.searchParams.keys()];
  const hasCode = callback.searchParams.has('code');
  const hasError = callback.searchParams.has('error');
  const allowed = new Set(hasError ? ['state', 'error', 'error_description'] : ['state', 'code']);
  if (hasCode === hasError || keys.some(key => !allowed.has(key)) || new Set(keys).size !== keys.length) {
    throw usageError('invalid OAuth callback input');
  }
  return callback;
}

function requiredCallbackValue(url: URL, name: string): string {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || !values[0] || values[0].length > 8_192) throw usageError('invalid OAuth callback input');
  return values[0];
}

async function readPrivateInput(io: CliIo): Promise<string> {
  const input = await (io.readStdin?.() ?? Promise.reject(usageError('private stdin is required')));
  if (Buffer.byteLength(input, 'utf8') > 16_384) throw usageError('private stdin is too large');
  return input;
}

async function readBoundedStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += bytes.length;
    if (total > 16_384) throw usageError('private stdin is too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function init(args: readonly string[], io: CliIo): Promise<number> {
  const options = parseOptions(args, ['root']);
  const root = requiredAbsolute(options, 'root');
  await assertDirectPath(root, true);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertDirectPath(root, false);
  const directories = ['workspace', 'workspace/memory', 'workspace/archive', 'state', 'state/gates', 'secrets', 'config'];
  for (const name of directories) {
    const path = join(root, name);
    await assertWithin(root, path);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await assertDirectPath(path, false, false);
  }
  for (const path of [root, ...directories.map(name => join(root, name))]) await enforcePrivateDirectory(path);
  const templates = new Map([
    ['workspace/INBOX.md', '# Inbox\n'], ['workspace/TASKS.md', '# Tasks\n'],
    ['workspace/NOTES.md', '# Notes\n'], ['workspace/STUDY.md', '# Study\n'],
    ['workspace/USER.md', '# User\n'], ['workspace/MEMORY.md', '# Memory\n'],
    ['config/personal-assistant.json5', nonSecretConfigTemplate(root)],
  ]);
  const created: string[] = [];
  for (const [name, content] of templates) {
    const path = join(root, name);
    await assertWithin(root, path);
    await assertStablePath(path, 'file', true);
    const handle = await open(path, 'wx', 0o600).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
      throw error;
    });
    if (handle) {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      created.push(name.replaceAll('\\', '/'));
    }
    await assertStablePath(path, 'file', false);
    await enforcePrivateFile(path);
  }
  io.stdout(JSON.stringify({ status: 'open', observedChecks: ['owner-private directories', 'non-secret templates'], created, redactedErrorCode: null, timestamp: now() }));
  return EXIT.ok;
}

async function poc(args: readonly string[], io: CliIo): Promise<number> {
  const [gate, ...optionArgs] = args;
  if (!GATES.includes(gate as never)) throw usageError('unsupported PoC gate');
  const options = parseOptions(optionArgs, ['state', 'evidence']);
  const state = requiredAbsolute(options, 'state');
  const evidencePath = requiredAbsolute(options, 'evidence');
  await assertDirectPath(evidencePath, false);
  const safe = parseEvidence(await readFile(evidencePath, 'utf8'), true);
  await assertDirectPath(state, true);
  await mkdir(join(state, 'gates'), { recursive: true, mode: 0o700 });
  await assertDirectPath(join(state, 'gates'), false);
  await writeExclusiveOrReplaceTemplate(join(state, 'gates', `${gate}.json`), `${JSON.stringify(safe)}\n`);
  io.stdout(JSON.stringify(safe));
  return gateExit(safe.status);
}

async function doctor(args: readonly string[], io: CliIo, dependencies: CliDependencies): Promise<number> {
  const options = parseOptions(args, ['state', 'max-age-hours', 'naver-client-file', 'naver-token-file']);
  const state = requiredAbsolute(options, 'state');
  await assertDirectPath(state, false);
  const maxAgeHours = Number(options.get('max-age-hours') ?? '24');
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) throw usageError('invalid max age');
  const observed: Array<{ gate: string; status: GateStatus }> = [];
  for (const gate of GATES) {
    let status: GateStatus = 'unknown';
    if (gate === 'naver-oauth') {
      const clientFile = options.get('naver-client-file');
      const tokenFile = options.get('naver-token-file');
      if (clientFile && tokenFile) {
        if (!isAbsolute(clientFile) || resolve(clientFile) !== clientFile
          || !isAbsolute(tokenFile) || resolve(tokenFile) !== tokenFile) throw pathError();
        try {
          validateNaverOAuthClientCredentials(await (
            dependencies.credentialStore?.(clientFile) ?? new SecretFileStore<unknown>(clientFile, 16_384)
          ).read());
          const token = validateStoredToken(await openTokenStore(tokenFile, dependencies).read());
          const age = Date.parse(token.expiresAt) - (dependencies.now?.() ?? Date.now());
          status = age > 60_000 ? 'open' : 'expired';
        } catch { status = 'closed'; }
      }
    }
    observed.push({ gate, status });
  }
  const status: GateStatus = observed.every(item => item.status === 'open') ? 'open'
    : observed.some(item => item.status === 'closed') ? 'closed'
      : observed.some(item => item.status === 'expired') ? 'expired' : 'unknown';
  io.stdout(observed.map(item => `${item.gate}: ${item.status}`).join('\n'));
  io.stdout(JSON.stringify({ status, observedChecks: observed.map(item => `${item.gate}: ${item.status}`), redactedErrorCode: status === 'open' ? null : 'GATE_NOT_OPEN', timestamp: now() }));
  return gateExit(status);
}

async function backup(args: readonly string[], io: CliIo): Promise<number> {
  const reconcile = args[0] === 'reconcile';
  const optionArgs = reconcile ? args.slice(1) : args;
  const allowed = reconcile ? ['archive', 'identity', 'state'] : ['workspace', 'state', 'backup-dir', 'identity', 'recipient'];
  const options = parseOptions(optionArgs, allowed);
  if (reconcile) {
    const archivePath = requiredAbsolute(options, 'archive');
    const identityFile = requiredAbsolute(options, 'identity');
    const stateDir = requiredAbsolute(options, 'state');
    await Promise.all([
      assertStablePath(archivePath, 'file', false),
      assertStablePath(identityFile, 'file', false),
      assertStablePath(stateDir, 'directory', true),
    ]);
    await preparePrivateStateDirectory(stateDir);
    const health = new SubsystemHealthStore(stateDir);
    try {
      const result = await verifyBackup({
        archivePath, identityFile, health,
      });
      io.stdout(JSON.stringify({ status: 'open', observedChecks: ['exact archive publication reconciled'], archive: result.archivePath, redactedErrorCode: null, timestamp: now() }));
      return EXIT.ok;
    } finally { health.close(); }
  }
  const workspaceDir = requiredAbsolute(options, 'workspace');
  const stateDir = requiredAbsolute(options, 'state');
  const backupDir = requiredAbsolute(options, 'backup-dir');
  const identityFile = requiredAbsolute(options, 'identity');
  const recipient = required(options, 'recipient');
  if (!/^age1[0-9a-z]{10,}$/.test(recipient)) throw usageError('invalid age recipient');
  await Promise.all([
    assertStablePath(workspaceDir, 'directory', false),
    assertStablePath(stateDir, 'directory', true),
    assertStablePath(backupDir, 'directory', true),
    assertStablePath(identityFile, 'file', false),
  ]);
  await preparePrivateStateDirectory(stateDir);
  const health = new SubsystemHealthStore(stateDir);
  let repository: Awaited<ReturnType<typeof openRepository>> | undefined;
  try {
    repository = await openRepository({ workspaceDir, stateDir, backupDir, telegramUserId: '123456789', timezone: 'Asia/Seoul' });
    const result = await createBackup({ repository, workspaceDir, stateDir, backupDir, identityFile, recipient, health });
    io.stdout(JSON.stringify({ status: 'open', observedChecks: ['encrypted archive verified and durably committed'], archive: result.archivePath, redactedErrorCode: null, timestamp: now() }));
    return EXIT.ok;
  } finally { repository?.close(); health.close(); }
}

async function restore(args: readonly string[], io: CliIo): Promise<number> {
  const options = parseOptions(args, ['archive', 'restore-root', 'identity']);
  const archivePath = requiredAbsolute(options, 'archive');
  const restoreRoot = requiredAbsolute(options, 'restore-root');
  const identityFile = requiredAbsolute(options, 'identity');
  if (resolve(restoreRoot) === resolve(join(archivePath, '..'))) throw usageError('restore root must be isolated');
  const result = await restoreBackup({ archivePath, restoreRoot, identityFile });
  io.stdout(JSON.stringify({ status: 'open', observedChecks: ['isolated restore verified'], restorePath: result.restorePath, redactedErrorCode: null, timestamp: now() }));
  return EXIT.ok;
}

async function maintenance(
  args: readonly string[], io: CliIo, dependencies: CliDependencies,
): Promise<number> {
  const [kind, ...optionArgs] = args;
  if (kind !== 'daily' && kind !== 'monthly' && kind !== 'check') {
    throw usageError('expected daily, monthly, or check maintenance');
  }
  const options = parseOptions(optionArgs, ['config']);
  const configPath = requiredAbsolute(options, 'config');
  if (kind === 'check') {
    await (dependencies.maintenanceConfigChecker ?? validateMaintenanceConfigFromFile)(configPath);
    io.stdout(JSON.stringify({ status: 'open', redactedErrorCode: null }));
    return EXIT.ok;
  }
  const result = await (dependencies.maintenanceRunner ?? runMaintenanceFromConfig)(kind, configPath);
  io.stdout(JSON.stringify({
    status: result.status, kind: result.kind, archive: basename(result.archive),
    deletedCount: result.deletedCount, redactedErrorCode: null,
  }));
  return EXIT.ok;
}

function parseOptions(args: readonly string[], allowed: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) throw usageError('options require values');
    const name = key.slice(2);
    if (!allowed.includes(name) || result.has(name)) throw usageError('unknown or duplicate option');
    result.set(name, value);
  }
  return result;
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw usageError(`missing ${name}`);
  return value;
}

function requiredAbsolute(options: Map<string, string>, name: string): string {
  const value = required(options, name);
  if (!isAbsolute(value) || resolve(value) !== value) throw pathError();
  return value;
}

async function assertWithin(root: string, path: string): Promise<void> {
  const rel = relative(resolve(root), resolve(path));
  if (rel.startsWith('..') || isAbsolute(rel)) throw pathError();
}

async function assertDirectPath(path: string, allowMissing: boolean, checkWindowsReparse = true): Promise<void> {
  const target = resolve(path);
  if (checkWindowsReparse && hasWindowsReparseInChain(target)) throw pathError();
  let cursor = target;
  let targetMissing = false;
  for (;;) {
    const info = await lstat(cursor).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info) {
      if (cursor === target) targetMissing = true;
    } else {
      if (info.isSymbolicLink() || (!info.isDirectory() && cursor !== target)
        || (cursor === target && !info.isDirectory() && !info.isFile())) throw pathError();
      if (!samePath(resolve(await realpath(cursor)), cursor)) throw pathError();
    }
    const parent = resolve(cursor, '..');
    if (parent === cursor) break;
    cursor = parent;
  }
  if (targetMissing && !allowMissing) throw Object.assign(new Error('path missing'), { code: 'path_missing' });
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function hasWindowsReparseInChain(path: string): boolean {
  if (process.platform !== 'win32') return false;
  try {
    return execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "$p=[IO.Path]::GetFullPath($env:OCPA_PATH_CHECK); $found=$false; while($p){ if(Test-Path -LiteralPath $p){ if((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){$found=$true;break} }; $n=Split-Path -Parent $p; if(!$n -or $n -eq $p){break}; $p=$n }; $found",
    ], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
      env: windowsPowerShellEnv('OCPA_PATH_CHECK', path),
    }).trim().toLowerCase() === 'true';
  } catch { return true; }
}

function setWindowsPrivateAcl(path: string): void {
  if (process.platform !== 'win32') return;
  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "$p=$env:OCPA_PRIVATE_ROOT; $i=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'); $acl=Get-Acl -LiteralPath $p; if($acl.Owner -and ([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value -ne $i.Value){throw 'owner mismatch'}; $r=@($acl.Access); $s=@($r|ForEach-Object{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}); if($acl.AreAccessRulesProtected -and @($r|Where-Object IsInherited).Count -eq 0 -and @($r|Where-Object AccessControlType -ne Allow).Count -eq 0 -and @($s|Where-Object{$_ -ne $i.Value -and $_ -ne $a.Value}).Count -eq 0 -and $s -contains $i.Value -and $s -contains $a.Value){return}; $acl.SetAccessRuleProtection($true,$false); @($acl.Access)|ForEach-Object{$acl.RemoveAccessRuleSpecific($_)}; $f=[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'; $n=[Security.AccessControl.PropagationFlags]::None; $y=[Security.AccessControl.AccessControlType]::Allow; $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($i,[Security.AccessControl.FileSystemRights]::FullControl,$f,$n,$y)); $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($a,[Security.AccessControl.FileSystemRights]::FullControl,$f,$n,$y)); Set-Acl -LiteralPath $p -AclObject $acl",
    ], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
      env: windowsPowerShellEnv('OCPA_PRIVATE_ROOT', path),
    });
  } catch { throw pathError(); }
}

function setWindowsPrivateFileAcl(path: string): void {
  if (process.platform !== 'win32') return;
  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "$p=$env:OCPA_PRIVATE_FILE; $i=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'); & icacls.exe $p '/inheritance:r' '/grant:r' ('*'+$i.Value+':(F)') ('*'+$a.Value+':(F)') | Out-Null; if($LASTEXITCODE -ne 0){exit 1}; $v=Get-Acl -LiteralPath $p; $r=@($v.Access); $s=@($r|ForEach-Object{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}); if(!$v.AreAccessRulesProtected -or @($r|Where-Object IsInherited).Count -ne 0 -or @($r|Where-Object AccessControlType -ne Allow).Count -ne 0 -or @($s|Where-Object{$_ -ne $i.Value -and $_ -ne $a.Value}).Count -ne 0 -or $s -notcontains $i.Value){exit 1}",
    ], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
      env: windowsPowerShellEnv('OCPA_PRIVATE_FILE', path),
    });
  } catch { throw pathError(); }
}

async function enforcePrivateDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') {
    setWindowsPrivateAcl(path);
    return;
  }
  await chmod(path, 0o700);
  const info = await stat(path);
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw pathError();
}

async function enforcePrivateFile(path: string): Promise<void> {
  if (process.platform === 'win32') {
    setWindowsPrivateFileAcl(path);
    return;
  }
  await chmod(path, 0o600);
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o777) !== 0o600
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw pathError();
}

async function assertStablePath(path: string, kind: 'file' | 'directory', allowMissing: boolean): Promise<void> {
  await assertDirectPath(path, allowMissing);
  const before = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) return undefined;
    throw error;
  });
  if (!before) return;
  if (before.isSymbolicLink() || (kind === 'file' ? !before.isFile() : !before.isDirectory())) throw pathError();
  const after = await lstat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode) throw pathError();
}

async function preparePrivateStateDirectory(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await assertStablePath(stateDir, 'directory', false);
  await enforcePrivateDirectory(stateDir);
}

function windowsPowerShellEnv(name: string, value: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  env[name] = value;
  return env;
}

async function writeExclusiveOrReplaceTemplate(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  const { rename } = await import('node:fs/promises');
  await rename(temporary, path);
}

function parseEvidence(source: string, requireFresh = false): GateEvidence {
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw usageError('invalid evidence'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw usageError('invalid evidence');
  const item = value as Record<string, unknown>;
  const exactKeys = ['observedChecks', 'redactedErrorCode', 'status', 'timestamp'];
  if (Object.keys(item).sort().join('\0') !== exactKeys.join('\0')
    || !['open', 'closed', 'unknown', 'expired'].includes(String(item.status))
    || !Array.isArray(item.observedChecks) || item.observedChecks.length < 1 || item.observedChecks.length > 32
    || item.observedChecks.some(check => typeof check !== 'string' || !safeObservedCheck(check))
    || !(item.redactedErrorCode === null || /^[A-Z][A-Z0-9_]{1,63}$/.test(String(item.redactedErrorCode)))
    || typeof item.timestamp !== 'string') throw usageError('invalid evidence');
  const observedAt = new Date(item.timestamp).valueOf();
  if (!Number.isFinite(observedAt) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(item.timestamp)
    || (requireFresh && (Date.now() - observedAt > 24 * 3_600_000 || observedAt - Date.now() > 5 * 60_000))) {
    throw usageError('invalid evidence');
  }
  return {
    status: item.status as GateStatus,
    observedChecks: [...item.observedChecks] as string[],
    redactedErrorCode: item.redactedErrorCode as string | null,
    timestamp: item.timestamp,
  };
}

function safeObservedCheck(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(value)
    && !/https?:\/\//iu.test(value)
    && !/(?:^|[?&])(?:token|code|secret|key|api[_-]?key|refresh[_-]?token)=/iu.test(value)
    && !/\b(?:token|code|secret|key|api[_-]?key|apiKey|refresh[_-]?token|refreshToken)\s*[:=]\s*\S+/iu.test(value)
    && !/\b(?:Bearer\s+|sk-)[A-Za-z0-9_.-]{16,}\b/iu.test(value)
    && !/\b[A-Za-z0-9_-]{32,}\b/u.test(value);
}

function rejectSensitiveArguments(args: readonly string[]): void {
  if (args.some(arg => /^(?:--)?(?:token|secret|password|client-secret|code)$/i.test(arg)
    || /https?:\/\/[^\s/@]+:[^\s/@]+@/iu.test(arg))) throw usageError('credentials are accepted only through owner-private files or interactive local input');
}

function nonSecretConfigTemplate(root: string): string {
  const path = (name: string) => join(root, name).replaceAll('\\', '/');
  return `{\n  workspaceDir: ${JSON.stringify(path('workspace'))},\n  stateDir: ${JSON.stringify(path('state'))},\n  backupDir: "/absolute/owner-selected/backup",\n  telegramUserId: "123456789",\n  timezone: "Asia/Seoul",\n}\n`;
}

function gateExit(status: GateStatus): number {
  return status === 'open' ? EXIT.ok : EXIT.gateClosed;
}

function usageError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'cli_usage' });
}
function pathError(): Error & { code: string } { return Object.assign(new Error('unsafe path'), { code: 'path_unsafe' }); }
function safeErrorCode(error: unknown): string {
  if (error instanceof BackupError) return /^[a-z0-9_]+$/.test(error.code) ? error.code : 'backup_failed';
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    && /^[a-z0-9_]+$/.test(error.code)) return error.code;
  return 'operation_failed';
}
function now(): string { return new Date().toISOString().replace('.000Z', 'Z'); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
