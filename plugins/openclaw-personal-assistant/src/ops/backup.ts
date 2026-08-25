/// <reference types="node" />

import { constants as fsConstants, type BigIntStats } from 'node:fs';
import {
  chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath,
  rename, rm, stat, unlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';

import { VerifiedOutboxBackupEvidence } from '../calendar/outbox.js';
import { parseDocument, type RecordKind } from '../markdown/codec.js';
import type { SubsystemHealthJournal } from '../state/health.js';
import type { WorkspaceRepository } from '../workspace/repository.js';
import {
  BACKUP_EXCLUSIONS_VERSION, isSafeRelativePath, parseManifest, sha256,
  type BackupFileEntry, type BackupManifest, type BackupSqliteEntry,
} from './manifest.js';
import { runExecFile, runExecFileCapture } from './process.js';

const ROOT_MARKDOWN = new Map<string, RecordKind>([
  ['TASKS.md', 'task'], ['STUDY.md', 'study'], ['NOTES.md', 'note'],
  ['USER.md', 'preference'], ['MEMORY.md', 'memory'], ['INBOX.md', 'inbox'],
]);
const REQUIRED_DATABASES = ['operations.sqlite3', 'calendar-outbox.sqlite3', 'alerts.sqlite3'] as const;
const OPTIONAL_DATABASES = ['subsystem-health.sqlite3'] as const;
const ARCHIVE_NAME = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\.age$/;
const TEMP_PREFIX = 'openclaw-backup-';

export class BackupError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

export interface AgeRunner {
  encrypt(inputPath: string, outputPath: string, recipient: string, signal?: AbortSignal): Promise<void>;
  decrypt(inputPath: string, outputPath: string, identityFile: string, signal?: AbortSignal): Promise<void>;
}

export class AgeExecRunner implements AgeRunner {
  constructor(private readonly executable = 'age') {}
  encrypt(inputPath: string, outputPath: string, recipient: string, signal?: AbortSignal): Promise<void> {
    return runExecFile({ executable: this.executable, args: ['--encrypt', '--recipient', recipient, '--output', outputPath, inputPath], timeoutMs: 120_000, ...(signal ? { signal } : {}) });
  }
  decrypt(inputPath: string, outputPath: string, identityFile: string, signal?: AbortSignal): Promise<void> {
    return runExecFile({ executable: this.executable, args: ['--decrypt', '--identity', identityFile, '--output', outputPath, inputPath], timeoutMs: 120_000, ...(signal ? { signal } : {}) });
  }
}

interface BackupBase {
  identityFile: string;
  ageRunner?: AgeRunner;
  health?: SubsystemHealthJournal;
  signal?: AbortSignal;
  secretCanaries?: readonly string[];
}

export interface CreateBackupInput extends BackupBase {
  repository: Pick<WorkspaceRepository, 'quiesce'>;
  workspaceDir: string;
  stateDir: string;
  backupDir: string;
  recipient: string;
  now?: () => Date;
  snapshotCheckpoint?: (phase: 'locked' | 'staged') => void | Promise<void>;
}

export interface VerifyBackupInput extends BackupBase { archivePath: string }
export interface RestoreBackupInput extends VerifyBackupInput { restoreRoot: string }
export interface RetentionInput extends BackupBase {
  backupDir: string;
  keep?: number;
  candidatePaths?: readonly string[];
}

export interface VerifiedBackup {
  archivePath: string;
  manifest: BackupManifest;
  outboxEvidence: VerifiedOutboxBackupEvidence;
}

interface ArchiveBundle {
  version: 1;
  files: Array<{ path: string; size: number; sha256: string; data: string }>;
}

export async function createBackup(input: CreateBackupInput): Promise<VerifiedBackup> {
  const age = input.ageRunner ?? new AgeExecRunner();
  let workRoot: string | undefined;
  let temporaryArchive: string | undefined;
  try {
    assertNonSecretInputs(input);
    await mkdir(input.backupDir, { recursive: true, mode: 0o700 });
    const backupRoot = await realpath(input.backupDir);
    const date = seoulDate((input.now ?? (() => new Date()))());
    const finalArchive = join(backupRoot, `${date}.age`);
    temporaryArchive = `${finalArchive}.tmp`;
    await assertAbsent(finalArchive);
    await assertAbsent(temporaryArchive);
    workRoot = await privateTempRoot();
    const snapshotRoot = join(workRoot, 'snapshot');
    const bundlePath = join(workRoot, 'snapshot.bundle');
    await mkdir(snapshotRoot, { mode: 0o700 });
    const manifest = await input.repository.quiesce(async () => {
      await input.snapshotCheckpoint?.('locked');
      const built = await stageSnapshot(input, snapshotRoot);
      await input.snapshotCheckpoint?.('staged');
      return built;
    });
    const outboxEvidence = VerifiedOutboxBackupEvidence.verifySnapshot(snapshotRoot);
    await writeBundle(snapshotRoot, bundlePath);
    await age.encrypt(bundlePath, temporaryArchive, input.recipient, input.signal);
    const encryptedIdentity = await lstat(temporaryArchive, { bigint: true });
    if (!encryptedIdentity.isFile() || encryptedIdentity.isSymbolicLink()) {
      throw new BackupError('archive_unsafe', 'Encrypted temporary archive is unsafe');
    }
    const verified = await verifyArchiveToFreshDirectory({
      archivePath: temporaryArchive, identityFile: input.identityFile, ageRunner: age,
      ...(input.signal ? { signal: input.signal } : {}), secretCanaries: input.secretCanaries,
    });
    await cleanupPrivateRoot(verified.root);
    if (JSON.stringify(verified.manifest) !== JSON.stringify(manifest)) {
      throw new BackupError('manifest_changed', 'Verified manifest differs from staged manifest');
    }
    const beforeRename = await lstat(temporaryArchive, { bigint: true });
    if (!sameStableFile(encryptedIdentity, beforeRename)) {
      throw new BackupError('archive_changed', 'Encrypted archive changed before publication');
    }
    await rename(temporaryArchive, finalArchive);
    temporaryArchive = undefined;
    input.health?.recover('backup');
    return { archivePath: finalArchive, manifest, outboxEvidence };
  } catch (error) {
    reportFailure(input.health);
    throw asBackupError(error);
  } finally {
    if (workRoot) await cleanupPrivateRoot(workRoot).catch(() => undefined);
    if (temporaryArchive) await unlink(temporaryArchive).catch(() => undefined);
  }
}

export async function verifyBackup(input: VerifyBackupInput): Promise<VerifiedBackup> {
  try {
    const verified = await verifyArchiveToFreshDirectory(input);
    const evidence = VerifiedOutboxBackupEvidence.verifySnapshot(verified.snapshotRoot);
    await cleanupPrivateRoot(verified.root);
    input.health?.recover('backup');
    return { archivePath: input.archivePath, manifest: verified.manifest, outboxEvidence: evidence };
  } catch (error) {
    reportFailure(input.health);
    throw asBackupError(error);
  }
}

export async function restoreBackup(input: RestoreBackupInput): Promise<{ restorePath: string; manifest: BackupManifest }> {
  let verified: Awaited<ReturnType<typeof verifyArchiveToFreshDirectory>> | undefined;
  let restorePath: string | undefined;
  let restoreStaging: string | undefined;
  try {
    const root = await realpath(input.restoreRoot);
    const rootStat = await lstat(root, { bigint: true });
    assertDirectory(rootStat, 'restore root');
    verified = await verifyArchiveToFreshDirectory(input);
    const restoreId = crypto.randomUUID();
    restorePath = join(root, `restore-${restoreId}`);
    restoreStaging = join(root, `.restore-${restoreId}.tmp`);
    await mkdir(restoreStaging, { mode: 0o700 });
    await copyTreeVerified(verified.snapshotRoot, restoreStaging);
    await rename(restoreStaging, restorePath);
    restoreStaging = undefined;
    await cleanupPrivateRoot(verified.root);
    return { restorePath, manifest: verified.manifest };
  } catch (error) {
    if (verified) await cleanupPrivateRoot(verified.root).catch(() => undefined);
    if (restoreStaging) await removeRestoreStaging(input.restoreRoot, restoreStaging).catch(() => undefined);
    if (restorePath) await rm(restorePath, { recursive: true, force: true }).catch(() => undefined);
    throw asBackupError(error);
  }
}

export async function applyRetention(input: RetentionInput): Promise<{ deleted: string[]; retained: string[] }> {
  try {
    const keep = Math.max(2, input.keep ?? 30);
    if (!Number.isSafeInteger(keep)) throw new BackupError('retention_invalid', 'Retention count is invalid');
    const root = await realpath(input.backupDir);
    const rootStat = await lstat(root, { bigint: true });
    assertDirectory(rootStat, 'backup root');
    const paths = input.candidatePaths
      ? [...input.candidatePaths]
      : (await readdir(root)).map(name => join(root, name));
    const verified: Array<{ path: string; identity: BigIntStats }> = [];
    for (const path of paths) {
      const name = basename(path);
      if (!ARCHIVE_NAME.test(name) || !validArchiveDate(name)) continue;
      const resolvedPath = resolve(path);
      if (!within(root, resolvedPath)) continue;
      let before: BigIntStats;
      try { before = await lstat(resolvedPath, { bigint: true }); } catch { continue; }
      if (!before.isFile() || before.isSymbolicLink()) continue;
      let real: string;
      try { real = await realpath(resolvedPath); } catch { continue; }
      if (!within(root, real) || real !== resolvedPath) continue;
      try {
        await verifyBackup({ ...input, archivePath: real });
        verified.push({ path: real, identity: before });
      } catch { /* An unverified candidate is never eligible for deletion. */ }
    }
    verified.sort((left, right) => basename(right.path).localeCompare(basename(left.path)));
    const deleted: string[] = [];
    for (const candidate of verified.slice(keep)) {
      const current = await lstat(candidate.path, { bigint: true });
      if (!sameStableFile(candidate.identity, current) || current.isSymbolicLink() || !current.isFile()) continue;
      const real = await realpath(candidate.path);
      if (!within(root, real) || real !== candidate.path) continue;
      await unlink(candidate.path);
      deleted.push(candidate.path);
    }
    return { deleted, retained: verified.slice(0, Math.max(keep, 2)).map(item => item.path) };
  } catch (error) {
    reportFailure(input.health);
    throw asBackupError(error);
  }
}

async function stageSnapshot(input: CreateBackupInput, snapshotRoot: string): Promise<BackupManifest> {
  const files: BackupFileEntry[] = [];
  const sqlite: BackupSqliteEntry[] = [];
  const workspaceRoot = await realpath(input.workspaceDir);
  await assertGitHistoryClean(workspaceRoot, input.secretCanaries ?? []);
  await mkdir(join(snapshotRoot, 'workspace'), { recursive: true, mode: 0o700 });
  for (const name of ROOT_MARKDOWN.keys()) {
    const source = join(workspaceRoot, name);
    if (await exists(source)) await copyStable(
      source, join(snapshotRoot, 'workspace', name), input.secretCanaries ?? [],
    );
  }
  for (const directory of ['memory', 'archive']) {
    const source = join(workspaceRoot, directory);
    if (await exists(source)) await copyAllowedMarkdownTree(
      source, join(snapshotRoot, 'workspace', directory), input.secretCanaries ?? [],
    );
  }
  const gitSource = join(workspaceRoot, '.git');
  if (!(await exists(gitSource))) throw new BackupError('git_missing', 'Workspace Git metadata is missing');
  await copyGitTree(gitSource, join(snapshotRoot, 'workspace', '.git'), input.secretCanaries ?? []);

  await mkdir(join(snapshotRoot, 'state'), { recursive: true, mode: 0o700 });
  const sqlitePreflight = join(dirname(snapshotRoot), 'sqlite-preflight');
  await mkdir(sqlitePreflight, { mode: 0o700 });
  for (const name of [...REQUIRED_DATABASES, ...OPTIONAL_DATABASES]) {
    const source = join(input.stateDir, name);
    if (!(await exists(source))) {
      if ((REQUIRED_DATABASES as readonly string[]).includes(name)) {
        throw new BackupError('sqlite_missing', `Required SQLite database is missing: ${name}`);
      }
      continue;
    }
    const destination = join(snapshotRoot, 'state', name);
    const preflight = join(sqlitePreflight, name);
    const sourceDb = new DatabaseSync(source, { readOnly: true });
    try { await sqliteBackup(sourceDb, preflight); } finally { sourceDb.close(); }
    normalizeSnapshotSqlite(preflight);
    await assertFileSecretFree(preflight, `state/${name}`, input.secretCanaries ?? []);
    await rename(preflight, destination);
    const evidence = inspectSqlite(destination);
    sqlite.push({ path: `state/${name}`, ...evidence });
  }
  await rm(sqlitePreflight, { recursive: true });
  await scanSnapshot(snapshotRoot, input.secretCanaries ?? []);
  for (const relativePath of await listFiles(snapshotRoot)) {
    const bytes = await readFile(join(snapshotRoot, ...relativePath.split('/')));
    files.push({ path: relativePath, size: bytes.byteLength, sha256: sha256(bytes) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  sqlite.sort((a, b) => a.path.localeCompare(b.path));
  const gitHead = await gitOutput(join(snapshotRoot, 'workspace'), ['rev-parse', 'HEAD']);
  const schemaVersion = sqlite.map(entry => `${entry.path}=${entry.userVersion}:${entry.schemaSha256}`).join(';');
  const sourceTime = (input.now ?? (() => new Date()))();
  const createdAt = new Date(Math.floor(sourceTime.valueOf() / 1_000) * 1_000)
    .toISOString().replace('.000Z', 'Z');
  const manifest: BackupManifest = {
    version: 1, createdAt, gitHead, schemaVersion,
    exclusionsVersion: BACKUP_EXCLUSIONS_VERSION, files, sqlite,
  };
  await writeFile(join(snapshotRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return manifest;
}

async function verifyArchiveToFreshDirectory(input: VerifyBackupInput) {
  const age = input.ageRunner ?? new AgeExecRunner();
  const archivePath = resolve(input.archivePath);
  const archiveStat = await lstat(archivePath, { bigint: true });
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) throw new BackupError('archive_unsafe', 'Backup archive is not a regular file');
  const realArchive = await realpath(archivePath);
  if (realArchive !== archivePath) throw new BackupError('archive_unsafe', 'Backup archive path is indirect');
  const root = await privateTempRoot();
  try {
    const privateArchive = join(root, 'archive.age');
    const bundlePath = join(root, 'decrypted.bundle');
    const snapshotRoot = join(root, 'snapshot');
    await copyStable(realArchive, privateArchive);
    await age.decrypt(privateArchive, bundlePath, input.identityFile, input.signal);
    await unpackBundle(bundlePath, snapshotRoot);
    const manifest = await verifySnapshotLayout(snapshotRoot, input.secretCanaries ?? []);
    return { root, snapshotRoot, manifest };
  } catch (error) {
    await cleanupPrivateRoot(root).catch(() => undefined);
    throw error;
  }
}

async function verifySnapshotLayout(snapshotRoot: string, canaries: readonly string[]): Promise<BackupManifest> {
  const manifest = parseManifest(await readFile(join(snapshotRoot, 'manifest.json'), 'utf8'));
  const actual = (await listFiles(snapshotRoot)).filter(path => path !== 'manifest.json').sort();
  const expected = manifest.files.map(file => file.path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new BackupError('manifest_file_set_mismatch', 'Snapshot file set does not match manifest');
  for (const entry of manifest.files) {
    const bytes = await readFile(join(snapshotRoot, ...entry.path.split('/')));
    if (bytes.byteLength !== entry.size || sha256(bytes) !== entry.sha256) {
      throw new BackupError('manifest_hash_mismatch', `Snapshot hash mismatch: ${entry.path}`);
    }
  }
  for (const entry of manifest.sqlite) {
    const evidence = inspectSqlite(join(snapshotRoot, ...entry.path.split('/')));
    if (evidence.userVersion !== entry.userVersion || evidence.schemaSha256 !== entry.schemaSha256) {
      throw new BackupError('sqlite_schema_mismatch', `SQLite schema mismatch: ${entry.path}`);
    }
  }
  await validateMarkdown(snapshotRoot);
  const workspace = join(snapshotRoot, 'workspace');
  if (await gitOutput(workspace, ['rev-parse', 'HEAD']) !== manifest.gitHead) throw new BackupError('git_head_mismatch', 'Restored Git HEAD does not match manifest');
  await gitOutput(workspace, ['fsck', '--full']);
  await scanSnapshot(snapshotRoot, canaries);
  VerifiedOutboxBackupEvidence.verifySnapshot(snapshotRoot);
  return manifest;
}

async function validateMarkdown(snapshotRoot: string): Promise<void> {
  const workspace = join(snapshotRoot, 'workspace');
  const seen = new Map<RecordKind, Set<string>>();
  for (const path of await listFiles(workspace)) {
    if (!path.endsWith('.md')) continue;
    const name = basename(path);
    const kind = path.startsWith('memory/') ? 'daily' : ROOT_MARKDOWN.get(name);
    if (!kind) throw new BackupError('markdown_path_invalid', `Unexpected Markdown path: ${path}`);
    const ids = seen.get(kind) ?? new Set<string>();
    const document = parseDocument(kind, await readFile(join(workspace, ...path.split('/')), 'utf8'), ids);
    document.records.forEach(record => ids.add(record.id));
    seen.set(kind, ids);
  }
}

function inspectSqlite(path: string): { userVersion: number; schemaSha256: string } {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown };
    if (integrity.integrity_check !== 'ok') throw new BackupError('sqlite_integrity_failed', `SQLite integrity failed: ${basename(path)}`);
    const userVersion = Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    const rows = database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all() as Array<Record<string, unknown>>;
    return { userVersion, schemaSha256: sha256(JSON.stringify(rows)) };
  } finally { database.close(); }
}

function normalizeSnapshotSqlite(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA journal_mode = DELETE;');
    const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown };
    if (integrity.integrity_check !== 'ok') {
      throw new BackupError('sqlite_integrity_failed', `SQLite integrity failed: ${basename(path)}`);
    }
  } finally { database.close(); }
}

async function writeBundle(root: string, destination: string): Promise<void> {
  const files = [] as ArchiveBundle['files'];
  for (const path of await listFiles(root)) {
    const bytes = await readFile(join(root, ...path.split('/')));
    files.push({ path, size: bytes.byteLength, sha256: sha256(bytes), data: bytes.toString('base64') });
  }
  const bundle: ArchiveBundle = { version: 1, files };
  await writeFile(destination, JSON.stringify(bundle), { mode: 0o600 });
}

async function unpackBundle(bundlePath: string, destination: string): Promise<void> {
  let value: unknown;
  try { value = JSON.parse(await readFile(bundlePath, 'utf8')); } catch { throw new BackupError('archive_invalid', 'Decrypted archive is invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BackupError('archive_invalid', 'Decrypted archive is invalid');
  const bundle = value as Partial<ArchiveBundle>;
  if (bundle.version !== 1 || !Array.isArray(bundle.files)) throw new BackupError('archive_invalid', 'Decrypted archive is invalid');
  await mkdir(destination, { mode: 0o700 });
  const seen = new Set<string>();
  for (const item of bundle.files) {
    if (!item || !isSafeRelativePath(item.path) || seen.has(item.path)
      || !Number.isSafeInteger(item.size) || item.size < 0 || !/^[0-9a-f]{64}$/.test(item.sha256)
      || typeof item.data !== 'string') throw new BackupError('archive_invalid', 'Archive entry is invalid');
    seen.add(item.path);
    const bytes = Buffer.from(item.data, 'base64');
    if (bytes.byteLength !== item.size || sha256(bytes) !== item.sha256) throw new BackupError('archive_hash_mismatch', 'Archive entry hash mismatch');
    const output = join(destination, ...item.path.split('/'));
    if (!within(destination, output)) throw new BackupError('archive_path_escape', 'Archive entry escapes destination');
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await writeFile(output, bytes, { flag: 'wx', mode: 0o600 });
  }
}

async function copyAllowedMarkdownTree(
  source: string,
  destination: string,
  canaries: readonly string[],
): Promise<void> {
  const root = await realpath(source);
  for (const path of await listSourceFiles(root)) {
    if (!path.endsWith('.md')) continue;
    await copyStable(
      join(root, ...path.split('/')), join(destination, ...path.split('/')), canaries,
    );
  }
}

async function copyGitTree(
  source: string,
  destination: string,
  canaries: readonly string[],
): Promise<void> {
  const rootStat = await lstat(source, { bigint: true });
  assertDirectory(rootStat, 'Git directory');
  const root = await realpath(source);
  for (const path of await listSourceFiles(root)) {
    if (!gitPathAllowed(path)) continue;
    await copyStable(
      join(root, ...path.split('/')), join(destination, ...path.split('/')), canaries,
    );
  }
}

function gitPathAllowed(path: string): boolean {
  if (path.endsWith('.lock')) return false;
  if (['HEAD', 'config', 'description', 'index', 'packed-refs', 'shallow'].includes(path)) return true;
  return ['objects/', 'refs/', 'info/'].some(prefix => path.startsWith(prefix));
}

async function listSourceFiles(root: string, current = ''): Promise<string[]> {
  const directory = join(root, ...current.split('/').filter(Boolean));
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const path = current ? `${current}/${entry.name}` : entry.name;
    const full = join(root, ...path.split('/'));
    const info = await lstat(full, { bigint: true });
    if (info.isSymbolicLink()) throw new BackupError('source_link_rejected', `Snapshot source contains a link: ${path}`);
    if (info.isDirectory()) result.push(...await listSourceFiles(root, path));
    else if (info.isFile()) result.push(path);
    else throw new BackupError('source_nonregular_rejected', `Snapshot source is nonregular: ${path}`);
  }
  return result.sort();
}

async function copyStable(
  source: string,
  destination: string,
  canaries: readonly string[] = [],
): Promise<void> {
  const noFollow = (fsConstants as Partial<Record<'O_NOFOLLOW', number>>).O_NOFOLLOW ?? 0;
  const before = await lstat(source, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new BackupError('source_unsafe', `Snapshot source is unsafe: ${basename(source)}`);
  const handle = await open(source, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameStableFile(before, opened)) throw new BackupError('source_changed', 'Snapshot source changed while opening');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(source, { bigint: true });
    if (!sameStableFile(opened, after) || !sameStableFile(after, pathAfter)) throw new BackupError('source_changed', 'Snapshot source changed while reading');
    assertBytesSecretFree(destination, bytes, canaries);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
  } finally { await handle.close(); }
}

async function copyTreeVerified(source: string, destination: string): Promise<void> {
  for (const path of await listSourceFiles(source)) await copyStable(join(source, ...path.split('/')), join(destination, ...path.split('/')));
}

async function listFiles(root: string): Promise<string[]> {
  return listSourceFiles(root);
}

async function scanSnapshot(root: string, canaries: readonly string[]): Promise<void> {
  for (const path of await listFiles(root)) {
    const bytes = await readFile(join(root, ...path.split('/')));
    assertBytesSecretFree(path, bytes, canaries);
  }
}

async function assertFileSecretFree(
  file: string,
  logicalPath: string,
  canaries: readonly string[],
): Promise<void> {
  assertBytesSecretFree(logicalPath, await readFile(file), canaries);
}

function assertBytesSecretFree(
  logicalPath: string,
  bytes: Uint8Array,
  canaries: readonly string[],
): void {
  if (/secret|credential|oauth|token|\.key$/i.test(logicalPath)) {
    throw new BackupError('secret_material_detected', 'Secret-named material is excluded from backups');
  }
  const buffer = Buffer.from(bytes);
  const needles = [
    ...canaries.filter(Boolean).map(value => Buffer.from(value)),
    Buffer.from('-----BEGIN PRIVATE KEY-----'), Buffer.from('-----BEGIN AGE SECRET KEY-----'),
  ];
  const text = buffer.toString('latin1');
  if (needles.some(needle => needle.length > 0 && buffer.includes(needle))
    || /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/.test(text)
    || /https?:\/\/[^\s/:]+:[^\s/@]+@/i.test(text)) {
    throw new BackupError('secret_material_detected', 'Secret material was detected in backup input');
  }
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  try {
    return (await runExecFileCapture({ executable: 'git', args, cwd, timeoutMs: 30_000 })).trim();
  } catch {
    throw new BackupError('git_verify_failed', 'Git verification failed');
  }
}

async function assertGitHistoryClean(workspace: string, canaries: readonly string[]): Promise<void> {
  const patterns = [...canaries.filter(Boolean), '-----BEGIN PRIVATE KEY-----', '-----BEGIN AGE SECRET KEY-----'];
  if (patterns.length === 0) return;
  const commits = (await gitOutput(workspace, ['rev-list', '--all'])).split(/\s+/).filter(Boolean);
  if (commits.length === 0) return;
  const root = await privateTempRoot();
  try {
    const patternFile = join(root, 'patterns');
    await writeFile(patternFile, `${patterns.join('\n')}\n`, { mode: 0o600 });
    const { execFile } = await import('node:child_process');
    for (const commit of commits) {
      const found = await new Promise<boolean>((resolvePromise, reject) => execFile(
        'git', ['grep', '--quiet', '--fixed-strings', '--ignore-case', '-f', patternFile, commit],
        { cwd: workspace, shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 },
        error => {
          if (!error) resolvePromise(true);
          else if (typeof error.code === 'number' && error.code === 1) resolvePromise(false);
          else reject(new BackupError('git_scan_failed', 'Git history secret scan failed'));
        },
      ));
      if (found) throw new BackupError('secret_material_detected', 'Secret material was detected in Git history');
    }
  } finally { await cleanupPrivateRoot(root); }
}

async function privateTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  await chmod(root, 0o700);
  const real = await realpath(root);
  if (real !== resolve(root)) throw new BackupError('temp_root_unsafe', 'Private temporary directory is indirect');
  return real;
}

async function cleanupPrivateRoot(path: string): Promise<void> {
  const resolved = resolve(path);
  const parent = await realpath(dirname(resolved));
  if (parent !== await realpath(tmpdir()) || !basename(resolved).startsWith(TEMP_PREFIX)) {
    throw new BackupError('cleanup_target_unsafe', 'Refusing unsafe temporary cleanup target');
  }
  const info = await lstat(resolved, { bigint: true }).catch(() => undefined);
  if (!info) return;
  assertDirectory(info, 'temporary root');
  await rm(resolved, { recursive: true });
}

async function removeRestoreStaging(restoreRoot: string, staging: string): Promise<void> {
  const root = await realpath(restoreRoot);
  const target = resolve(staging);
  if (!within(root, target) || !/^\.restore-[0-9a-f-]+\.tmp$/.test(basename(target))) {
    throw new BackupError('cleanup_target_unsafe', 'Refusing unsafe restore cleanup target');
  }
  const info = await lstat(target, { bigint: true }).catch(() => undefined);
  if (!info) return;
  assertDirectory(info, 'restore staging directory');
  await rm(target, { recursive: true });
}

function assertDirectory(info: BigIntStats, description: string): void {
  if (!info.isDirectory() || info.isSymbolicLink()) throw new BackupError('path_unsafe', `${description} is not a real directory`);
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function assertAbsent(path: string): Promise<void> {
  if (await exists(path)) throw new BackupError('archive_exists', 'Backup archive already exists');
}

function assertNonSecretInputs(input: CreateBackupInput): void {
  if (!input.recipient || !input.identityFile) throw new BackupError('age_configuration_invalid', 'Age recipient and identity are required');
}

function reportFailure(health: SubsystemHealthJournal | undefined): void {
  health?.report({ errorCode: 'backup_failed', target: 'backup', message: 'Encrypted backup is unavailable' });
}

function asBackupError(error: unknown): BackupError {
  if (error instanceof BackupError) return error;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return new BackupError(error.code, 'Backup operation failed');
  }
  return new BackupError('backup_failed', 'Backup operation failed');
}

function seoulDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function validArchiveDate(name: string): boolean {
  const date = name.slice(0, 10);
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date;
}
