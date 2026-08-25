#!/usr/bin/env node
/// <reference types="node" />

import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  BackupError, BackupPublicationUnknownError, createBackup, restoreBackup, verifyBackup,
} from './ops/backup.js';
import { openRepository } from './workspace/repository.js';

export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
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
};

export async function runCli(args: readonly string[], io: CliIo = defaultIo): Promise<number> {
  try {
    rejectSensitiveArguments(args);
    const [command, ...rest] = args;
    if (command === 'init') return await init(rest, io);
    if (command === 'poc') return await poc(rest, io);
    if (command === 'doctor') return await doctor(rest, io);
    if (command === 'backup') return await backup(rest, io);
    if (command === 'restore') return await restore(rest, io);
    throw usageError('expected init, poc, doctor, backup, or restore');
  } catch (error) {
    const code = safeErrorCode(error);
    io.stderr(JSON.stringify({ status: 'error', redactedErrorCode: code }));
    if (error instanceof BackupPublicationUnknownError || code === 'publication_unknown') return EXIT.publicationUnknown;
    return code === 'cli_usage' || code.startsWith('path_') ? EXIT.usage : EXIT.operation;
  }
}

async function init(args: readonly string[], io: CliIo): Promise<number> {
  const options = parseOptions(args, ['root']);
  const root = requiredAbsolute(options, 'root');
  await assertDirectPath(root, true);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertDirectPath(root, false);
  setWindowsPrivateAcl(root);
  const directories = ['workspace', 'workspace/memory', 'workspace/archive', 'state', 'state/gates', 'secrets', 'config'];
  for (const name of directories) {
    const path = join(root, name);
    await assertWithin(root, path);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await assertDirectPath(path, false, false);
  }
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
  const evidence = parseEvidence(await readFile(evidencePath, 'utf8'));
  const safe = sanitizeEvidence(evidence);
  await assertDirectPath(state, true);
  await mkdir(join(state, 'gates'), { recursive: true, mode: 0o700 });
  await assertDirectPath(join(state, 'gates'), false);
  await writeExclusiveOrReplaceTemplate(join(state, 'gates', `${gate}.json`), `${JSON.stringify(safe)}\n`);
  io.stdout(JSON.stringify(safe));
  return gateExit(safe.status);
}

async function doctor(args: readonly string[], io: CliIo): Promise<number> {
  const options = parseOptions(args, ['state', 'max-age-hours']);
  const state = requiredAbsolute(options, 'state');
  await assertDirectPath(state, false);
  const maxAgeHours = Number(options.get('max-age-hours') ?? '24');
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) throw usageError('invalid max age');
  const observed: Array<{ gate: string; status: GateStatus }> = [];
  for (const gate of GATES) {
    let status: GateStatus = 'unknown';
    try {
      const evidence = parseEvidence(await readFile(join(state, 'gates', `${gate}.json`), 'utf8'));
      status = Date.now() - new Date(evidence.timestamp).valueOf() > maxAgeHours * 3_600_000 ? 'expired' : evidence.status;
    } catch { status = 'unknown'; }
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
  const allowed = reconcile ? ['archive', 'identity'] : ['workspace', 'state', 'backup-dir', 'identity', 'recipient'];
  const options = parseOptions(optionArgs, allowed);
  if (reconcile) {
    const result = await verifyBackup({ archivePath: requiredAbsolute(options, 'archive'), identityFile: requiredAbsolute(options, 'identity') });
    io.stdout(JSON.stringify({ status: 'open', observedChecks: ['exact archive publication reconciled'], archive: result.archivePath, redactedErrorCode: null, timestamp: now() }));
    return EXIT.ok;
  }
  const workspaceDir = requiredAbsolute(options, 'workspace');
  const stateDir = requiredAbsolute(options, 'state');
  const backupDir = requiredAbsolute(options, 'backup-dir');
  const identityFile = requiredAbsolute(options, 'identity');
  const recipient = required(options, 'recipient');
  if (!/^age1[0-9a-z]{10,}$/.test(recipient)) throw usageError('invalid age recipient');
  const repository = await openRepository({ workspaceDir, stateDir, backupDir, telegramUserId: '123456789', timezone: 'Asia/Seoul' });
  const result = await createBackup({ repository, workspaceDir, stateDir, backupDir, identityFile, recipient });
  io.stdout(JSON.stringify({ status: 'open', observedChecks: ['encrypted archive verified and durably committed'], archive: result.archivePath, redactedErrorCode: null, timestamp: now() }));
  return EXIT.ok;
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

function parseEvidence(source: string): GateEvidence {
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw usageError('invalid evidence'); }
  const item = value as Partial<GateEvidence>;
  if (!item || !['open', 'closed', 'unknown', 'expired'].includes(String(item.status))
    || !Array.isArray(item.observedChecks) || item.observedChecks.some(check => typeof check !== 'string')
    || !(item.redactedErrorCode === null || /^[A-Z][A-Z0-9_]{1,63}$/.test(String(item.redactedErrorCode)))
    || typeof item.timestamp !== 'string' || !Number.isFinite(new Date(item.timestamp).valueOf())) throw usageError('invalid evidence');
  return item as GateEvidence;
}

function sanitizeEvidence(value: GateEvidence): GateEvidence {
  return { ...value, observedChecks: value.observedChecks.map(redact), redactedErrorCode: value.redactedErrorCode };
}

function redact(value: string): string {
  return value
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/giu, 'https://[REDACTED]@')
    .replace(/([?&](?:token|code|secret|key)=)[^&\s]+/giu, '$1[REDACTED]')
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{32,}\b/gu, '[REDACTED]');
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
