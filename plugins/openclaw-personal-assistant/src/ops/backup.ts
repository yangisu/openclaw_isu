/// <reference types="node" />

import { createHash } from 'node:crypto';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import {
  chmod, lstat, mkdir, mkdtemp, open, readdir, realpath,
  rename, rm, stat, unlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';

import { VerifiedOutboxBackupEvidence } from '../calendar/outbox.js';
import { validateOutboxBackupDatabase } from '../calendar/outbox.js';
import { parseDocument, type RecordKind } from '../markdown/codec.js';
import { validateAlertBackupDatabase } from '../state/alerts.js';
import { validateHealthBackupDatabase, type SubsystemHealthJournal } from '../state/health.js';
import { validateOperationBackupDatabase } from '../state/operations.js';
import type { WorkspaceRepository } from '../workspace/repository.js';
import {
  BACKUP_EXCLUSIONS_VERSION, BACKUP_SCHEMA_VERSION, isSafeRelativePath, parseManifest, sha256,
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
const MARKDOWN_MAX_BYTES = 8 * 1024 * 1024;
export const RESTORE_EVIDENCE_MAX_BYTES = 8 * 1024 * 1024;

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
  pathSafety?: PathSafety;
  aclVerifier?: BackupAclVerifier;
  durability?: BackupDurability;
  publicationOps?: BackupPublicationOps;
  durabilityDiagnostic?: (event: 'directory-synced' | 'directory-sync-unsupported', path: string) => void;
}

export interface PathSafety {
  isReparsePoint(path: string): Promise<boolean>;
}

export function parseWindowsReparseClassification(output: string): boolean {
  const value = output.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new BackupError('reparse_classification_failed', 'Windows reparse classification returned an invalid result');
}

export interface BackupAclVerifier {
  verifyPrivateDirectory(path: string): Promise<void>;
  verifyBackupRoot(path: string): Promise<void>;
}

interface WindowsAclEvidence {
  currentSid: string;
  ownerSid: string;
  protected: boolean;
  rules: Array<{ sid: string; inherited: boolean; type: 'Allow' | 'Deny' }>;
}

export function validateWindowsBackupAcl(output: string): void {
  let evidence: WindowsAclEvidence;
  try { evidence = JSON.parse(output) as WindowsAclEvidence; }
  catch { throw new BackupError('acl_unsafe', 'Backup ACL evidence is invalid'); }
  const sid = /^S-\d(?:-\d+)+$/;
  if (!evidence || !sid.test(evidence.currentSid) || evidence.ownerSid !== evidence.currentSid
    || evidence.protected !== true || !Array.isArray(evidence.rules) || evidence.rules.length < 2) {
    throw new BackupError('acl_unsafe', 'Backup ACL owner or inheritance policy is unsafe');
  }
  const allowed = new Set([evidence.currentSid, 'S-1-5-32-544']);
  if (evidence.rules.some(rule => !rule || !allowed.has(rule.sid) || rule.inherited || rule.type !== 'Allow')
    || !evidence.rules.some(rule => rule.sid === evidence.currentSid)
    || !evidence.rules.some(rule => rule.sid === 'S-1-5-32-544')) {
    throw new BackupError('acl_unsafe', 'Backup ACL contains a denied, inherited, missing, or unknown principal');
  }
}

export interface BackupDurability {
  syncFile(path: string): Promise<void>;
  syncDirectory(path: string): Promise<void | 'unsupported'>;
}
export interface BackupPublicationOps {
  rename(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export function classifyDirectorySyncFailure(
  path: string, code: string | undefined, platform = process.platform,
): 'unsupported' | 'non-target-fallback' | 'fatal' {
  if (!['EINVAL', 'EPERM', 'EISDIR'].includes(code ?? '')) return 'fatal';
  if (platform === 'linux' && /^\/mnt\/d\//i.test(path)) return 'unsupported';
  if (platform !== 'win32') return 'fatal';
  return /^d:\\/i.test(path) ? 'unsupported' : 'non-target-fallback';
}

export interface CreateBackupInput extends BackupBase {
  repository: Pick<WorkspaceRepository, 'quiesce'>;
  workspaceDir: string;
  stateDir: string;
  backupDir: string;
  recipient: string;
  now?: () => Date;
  snapshotCheckpoint?: (phase: 'locked' | 'staged') => void | Promise<void>;
  sourceReadCheckpoint?: (path: string) => void | Promise<void>;
  destinationWriteCheckpoint?: (path: string) => void | Promise<void>;
}

export interface VerifyBackupInput extends BackupBase { archivePath: string }
export interface RestoreBackupInput extends VerifyBackupInput { restoreRoot: string }
export interface ScheduledRestoreInput extends RestoreBackupInput {
  stateDir: string;
  kind: 'daily-sample' | 'monthly-full';
  now?: () => Date;
}
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

const ARCHIVE_MAGIC = Buffer.from('OCPABK01', 'ascii');
export const BACKUP_ARCHIVE_LIMITS = Object.freeze({
  maxEntries: 1_000,
  maxPathBytes: 1_024,
  maxHeaderBytes: 4_096,
  maxFileBytes: 512 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
  maxArchiveBytes: 5 * 1024 * 1024 * 1024,
});

export async function createBackup(input: CreateBackupInput): Promise<VerifiedBackup> {
  const age = input.ageRunner ?? new AgeExecRunner();
  const acl = input.aclVerifier ?? defaultAclVerifier;
  const durability = input.durability ?? defaultDurability;
  const publication = input.publicationOps ?? defaultPublicationOps;
  let workRoot: string | undefined;
  let temporaryArchive: string | undefined;
  let incompleteMarker: string | undefined;
  let plaintextStaged = false;
  try {
    assertNonSecretInputs(input);
    await mkdir(input.backupDir, { recursive: true, mode: 0o700 });
    const backupRoot = await canonicalDirectoryRoot(input.backupDir, input.pathSafety);
    const stateRoot = await canonicalDirectoryRoot(input.stateDir, input.pathSafety);
    const date = seoulDate((input.now ?? (() => new Date()))());
    const finalArchive = join(backupRoot, `${date}.age`);
    incompleteMarker = `${finalArchive}.uncommitted`;
    temporaryArchive = `${finalArchive}.tmp`;
    await assertAbsent(finalArchive);
    await assertAbsent(temporaryArchive);
    await assertAbsent(incompleteMarker);
    workRoot = await privateStateTempRoot(stateRoot, input.pathSafety);
    await acl.verifyPrivateDirectory(workRoot);
    const snapshotRoot = join(workRoot, 'snapshot');
    const bundlePath = join(workRoot, 'snapshot.bundle');
    await mkdir(snapshotRoot, { mode: 0o700 });
    const manifest = await input.repository.quiesce(async () => {
      await input.snapshotCheckpoint?.('locked');
      const built = await stageSnapshot(input, snapshotRoot);
      plaintextStaged = true;
      await input.snapshotCheckpoint?.('staged');
      return built;
    });
    const outboxEvidence = VerifiedOutboxBackupEvidence.verifySnapshot(snapshotRoot);
    await acl.verifyBackupRoot(backupRoot);
    await writeBundle(snapshotRoot, bundlePath);
    await age.encrypt(bundlePath, temporaryArchive, input.recipient, input.signal);
    const encryptedIdentity = await lstat(temporaryArchive, { bigint: true });
    if (!encryptedIdentity.isFile() || encryptedIdentity.isSymbolicLink()) {
      throw new BackupError('archive_unsafe', 'Encrypted temporary archive is unsafe');
    }
    const verified = await verifyArchiveToFreshDirectory({
      archivePath: temporaryArchive, identityFile: input.identityFile, ageRunner: age,
      ...(input.signal ? { signal: input.signal } : {}), secretCanaries: input.secretCanaries,
    }, false);
    await cleanupPrivateRoot(verified.root);
    if (JSON.stringify(verified.manifest) !== JSON.stringify(manifest)) {
      throw new BackupError('manifest_changed', 'Verified manifest differs from staged manifest');
    }
    const beforeRename = await lstat(temporaryArchive, { bigint: true });
    if (!sameStableFile(encryptedIdentity, beforeRename)) {
      throw new BackupError('archive_changed', 'Encrypted archive changed before publication');
    }
    await durability.syncFile(temporaryArchive);
    const publicationMarker = incompleteMarker;
    await writeFile(publicationMarker, 'publication pending\n', { flag: 'wx', mode: 0o600 });
    await durability.syncFile(publicationMarker);
    await publication.rename(temporaryArchive, finalArchive);
    temporaryArchive = undefined;
    try {
      await requirePublicationDirectorySync(durability, backupRoot, input.durabilityDiagnostic);
      await publication.unlink(publicationMarker);
      await requirePublicationDirectorySync(durability, backupRoot, input.durabilityDiagnostic);
      incompleteMarker = undefined;
    } catch (error) {
      if (!(await exists(publicationMarker))) {
        await writeFile(publicationMarker, 'publication pending\n', { flag: 'wx', mode: 0o600 });
        await durability.syncFile(publicationMarker);
      }
      await rollbackPublishedArchive(finalArchive, publicationMarker, backupRoot, durability, publication);
      incompleteMarker = undefined;
      throw error instanceof BackupError ? error : new BackupError('archive_directory_sync_failed', 'Backup directory durability failed; archive was not published');
    }
    await cleanupBackupQuarantine({ stateDir: stateRoot, aclVerifier: acl, pathSafety: input.pathSafety });
    input.health?.recover('backup');
    return { archivePath: finalArchive, manifest, outboxEvidence };
  } catch (error) {
    reportFailure(input.health);
    if (workRoot && plaintextStaged) {
      await quarantinePrivateRoot(input.stateDir, workRoot, input.aclVerifier ?? defaultAclVerifier, input.pathSafety).then(() => { workRoot = undefined; }).catch(() => undefined);
    }
    throw asBackupError(error);
  } finally {
    if (workRoot) await cleanupPrivateRoot(workRoot).catch(() => undefined);
    if (temporaryArchive) await unlink(temporaryArchive).catch(() => undefined);
    if (incompleteMarker) {
      const final = incompleteMarker.slice(0, -'.uncommitted'.length);
      if (!(await exists(final))) await unlink(incompleteMarker).catch(() => undefined);
    }
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
    const root = await canonicalDirectoryRoot(input.restoreRoot, input.pathSafety, 'restore_root_unsafe');
    verified = await verifyArchiveToFreshDirectory(input);
    const restoreId = crypto.randomUUID();
    restorePath = join(root, `restore-${restoreId}`);
    restoreStaging = join(root, `.restore-${restoreId}.tmp`);
    await mkdir(restoreStaging, { mode: 0o700 });
    await copyTreeVerified(verified.snapshotRoot, restoreStaging);
    await materializeGitBundle(restoreStaging, verified.manifest.gitHead);
    await syncTree(restoreStaging, input.durability ?? defaultDurability);
    await rename(restoreStaging, restorePath);
    restoreStaging = undefined;
    await (input.durability ?? defaultDurability).syncDirectory(root);
    await cleanupPrivateRoot(verified.root);
    return { restorePath, manifest: verified.manifest };
  } catch (error) {
    if (verified) await cleanupPrivateRoot(verified.root).catch(() => undefined);
    if (restoreStaging) await removeRestoreStaging(input.restoreRoot, restoreStaging).catch(() => undefined);
    if (restorePath) await rm(restorePath, { recursive: true, force: true }).catch(() => undefined);
    throw asBackupError(error);
  }
}

/** Runs an isolated restore and records machine-readable evidence for the scheduler. */
export async function verifyScheduledRestore(input: ScheduledRestoreInput): Promise<{
  evidencePath: string; manifest: BackupManifest; restoreRetained: false;
}> {
  const stateRoot = await canonicalDirectoryRoot(input.stateDir, input.pathSafety);
  const evidencePath = join(stateRoot, 'backup-restore-verifications.jsonl');
  let restored: Awaited<ReturnType<typeof restoreBackup>> | undefined;
  try {
    restored = await restoreBackup(input);
    const detail = input.kind === 'daily-sample'
      ? await inspectDailyRestoreSample(restored.restorePath)
      : await inspectFullRestore(restored.restorePath);
    await recordRestoreEvidence(evidencePath, stateRoot, {
      version: 1, kind: input.kind, status: 'passed', archive: basename(input.archivePath),
      gitHead: restored.manifest.gitHead, verifiedAt: (input.now ?? (() => new Date()))().toISOString(), ...detail,
    }, input);
    await removeScheduledRestore(input.restoreRoot, restored.restorePath, input.pathSafety);
    await (input.durability ?? defaultDurability).syncDirectory(await realpath(input.restoreRoot));
    return { evidencePath, manifest: restored.manifest, restoreRetained: false };
  } catch (error) {
    if (restored) await removeScheduledRestore(input.restoreRoot, restored.restorePath, input.pathSafety).catch(() => undefined);
    await recordRestoreEvidence(evidencePath, stateRoot, {
      version: 1, kind: input.kind, status: 'failed', archive: basename(input.archivePath),
      errorCode: asBackupError(error).code, verifiedAt: (input.now ?? (() => new Date()))().toISOString(),
    }, input).catch(() => undefined);
    throw asBackupError(error);
  }
}

async function inspectDailyRestoreSample(restorePath: string): Promise<{ sample: { path: string; recordId: string; sha256: string } }> {
  const workspace = join(restorePath, 'workspace');
  const candidates = (await listFiles(workspace)).filter(path => /^(?:memory|archive)\/\d{4}-\d{2}-\d{2}\.md$/.test(path)).sort();
  for (const path of candidates) {
    const bytes = await readTextBounded(join(workspace, ...path.split('/')), MARKDOWN_MAX_BYTES);
    const document = parseDocument('daily', bytes, new Set());
    const record = document.records[0];
    if (record) return { sample: { path: `workspace/${path}`, recordId: record.id, sha256: sha256(Buffer.from(bytes)) } };
  }
  throw new BackupError('restore_sample_missing', 'Daily sample restore found no real record');
}

async function inspectFullRestore(restorePath: string): Promise<{ full: { fileCount: number; totalBytes: number; treeSha256: string } }> {
  const paths = await listFiles(restorePath); let totalBytes = 0;
  const digest = createHash('sha256');
  for (const path of paths) {
    const evidence = await hashFileBounded(join(restorePath, ...path.split('/')), BACKUP_ARCHIVE_LIMITS.maxFileBytes);
    totalBytes += evidence.size; digest.update(`${path}\0${evidence.size}\0${evidence.sha256}\n`);
  }
  return { full: { fileCount: paths.length, totalBytes, treeSha256: digest.digest('hex') } };
}

async function recordRestoreEvidence(
  evidencePath: string, stateRoot: string, record: Record<string, unknown>, input: ScheduledRestoreInput,
): Promise<void> {
  const pathSafety = input.pathSafety ?? DEFAULT_PATH_SAFETY;
  const existing = await lstat(evidencePath, { bigint: true }).catch(() => undefined);
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || await pathSafety.isReparsePoint(evidencePath)
    || await realpath(evidencePath) !== evidencePath || !within(stateRoot, evidencePath))) {
    throw new BackupError('restore_evidence_unsafe', 'Restore evidence path is unsafe');
  }
  const identity = existing ? await canonicalRegularFile(evidencePath, stateRoot, pathSafety) : undefined;
  let prior = identity ? await readTextBounded(identity.path, RESTORE_EVIDENCE_MAX_BYTES) : '';
  if (identity) await assertPathIdentity(identity, pathSafety);
  const temporary = join(stateRoot, `.backup-restore-evidence-${crypto.randomUUID()}.tmp`);
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(prior) + Buffer.byteLength(line) > RESTORE_EVIDENCE_MAX_BYTES * 3 / 4) {
    const retained: string[] = []; let bytes = Buffer.byteLength(line);
    for (const candidate of prior.trimEnd().split('\n').reverse()) {
      const size = Buffer.byteLength(candidate) + 1;
      if (bytes + size > RESTORE_EVIDENCE_MAX_BYTES / 2) break;
      retained.unshift(candidate); bytes += size;
    }
    prior = retained.length ? `${retained.join('\n')}\n` : '';
  }
  const durability = input.durability ?? defaultDurability;
  try {
    await writeFile(temporary, `${prior}${line}`, { flag: 'wx', mode: 0o600 });
    await durability.syncFile(temporary);
    if (identity) await assertPathIdentity(identity, pathSafety);
    await rename(temporary, evidencePath);
    await durability.syncDirectory(stateRoot);
  } finally { await unlink(temporary).catch(() => undefined); }
}

export async function applyRetention(input: RetentionInput): Promise<{ deleted: string[]; retained: string[] }> {
  try {
    const keep = Math.max(2, input.keep ?? 30);
    if (!Number.isSafeInteger(keep)) throw new BackupError('retention_invalid', 'Retention count is invalid');
    const pathSafety = input.pathSafety ?? DEFAULT_PATH_SAFETY;
    const root = await canonicalDirectoryRoot(input.backupDir, pathSafety, 'retention_root_unsafe');
    const publication = input.publicationOps ?? defaultPublicationOps;
    await recoverRetentionTombstones(root, pathSafety, publication, input.durability ?? defaultDurability);
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
      if (!before.isFile() || before.isSymbolicLink() || await pathSafety.isReparsePoint(resolvedPath)) continue;
      let real: string;
      try { real = await realpath(resolvedPath); } catch { continue; }
      if (!within(root, real) || real !== resolvedPath) continue;
      try {
        await assertArchiveEligible(real, pathSafety);
        await verifyBackup({ ...input, archivePath: real });
        verified.push({ path: real, identity: before });
      } catch { /* An unverified candidate is never eligible for deletion. */ }
    }
    verified.sort((left, right) => basename(right.path).localeCompare(basename(left.path)));
    const deleted: string[] = [];
    for (const candidate of verified.slice(keep)) {
      await assertArchiveEligible(candidate.path, pathSafety);
      const current = await lstat(candidate.path, { bigint: true });
      if (!sameStableFile(candidate.identity, current) || current.isSymbolicLink() || !current.isFile()
        || await pathSafety.isReparsePoint(candidate.path)) continue;
      const real = await realpath(candidate.path);
      if (!within(root, real) || real !== candidate.path) continue;
      const tombstone = `${candidate.path}.tombstone-${crypto.randomUUID()}`;
      await publication.rename(candidate.path, tombstone);
      try {
        if (await exists(`${candidate.path}.uncommitted`)) throw new BackupError('retention_marker_race', 'Archive publication marker appeared during retention');
        const moved = await lstat(tombstone, { bigint: true });
        if (!sameMovedFile(candidate.identity, moved) || !moved.isFile() || moved.isSymbolicLink()
          || await pathSafety.isReparsePoint(tombstone) || await realpath(tombstone) !== tombstone || !within(root, tombstone)) {
          throw new BackupError('retention_identity_changed', 'Retention tombstone identity does not match verified archive');
        }
        await publication.unlink(tombstone);
        await (input.durability ?? defaultDurability).syncDirectory(root);
      } catch (error) {
        if (!(await exists(candidate.path)) && await exists(tombstone)) {
          const tombstoneInfo = await lstat(tombstone, { bigint: true }).catch(() => undefined);
          if (tombstoneInfo && sameMovedFile(candidate.identity, tombstoneInfo)) {
            await publication.rename(tombstone, candidate.path).catch(() => undefined);
          } else {
            await publication.rename(tombstone, `${tombstone}.suspicious`).catch(() => undefined);
          }
        }
        throw error;
      }
      deleted.push(candidate.path);
    }
    return { deleted, retained: verified.slice(0, Math.max(keep, 2)).map(item => item.path) };
  } catch (error) {
    reportFailure(input.health);
    throw asBackupError(error);
  }
}

async function recoverRetentionTombstones(
  root: string, pathSafety: PathSafety, publication: BackupPublicationOps, durability: BackupDurability,
): Promise<void> {
  for (const name of await readdir(root)) {
    const match = /^(\d{4}-\d{2}-\d{2}\.age)\.tombstone-[0-9a-f-]+$/.exec(name);
    if (!match) continue;
    if (!validArchiveDate(match[1]!)) continue;
    const tombstone = join(root, name); const original = join(root, match[1]!);
    const info = await lstat(tombstone, { bigint: true }).catch(() => undefined);
    if (!info || !info.isFile() || info.isSymbolicLink() || await pathSafety.isReparsePoint(tombstone)
      || await realpath(tombstone) !== tombstone || await exists(original) || await exists(`${original}.uncommitted`)) continue;
    await publication.rename(tombstone, original);
    await durability.syncDirectory(root);
  }
}

async function assertArchiveEligible(path: string, pathSafety?: PathSafety): Promise<void> {
  const absolute = resolve(path);
  const name = basename(absolute);
  if (!ARCHIVE_NAME.test(name) || !validArchiveDate(name)) {
    throw new BackupError('archive_ineligible', 'Backup archive name is not an eligible recovery point');
  }
  if (await exists(`${absolute}.uncommitted`)) {
    throw new BackupError('archive_uncommitted', 'Backup archive publication is incomplete');
  }
  const info = await lstat(absolute, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || await (pathSafety ?? DEFAULT_PATH_SAFETY).isReparsePoint(absolute)
    || await realpath(absolute) !== absolute) throw new BackupError('archive_ineligible', 'Backup archive path is unsafe');
}

async function stageSnapshot(input: CreateBackupInput, snapshotRoot: string): Promise<BackupManifest> {
  const files: BackupFileEntry[] = [];
  const sqlite: BackupSqliteEntry[] = [];
  const pathSafety = input.pathSafety ?? DEFAULT_PATH_SAFETY;
  const workspaceRoot = await canonicalDirectoryRoot(input.workspaceDir, pathSafety, 'source_root_unsafe');
  const stateRoot = await canonicalDirectoryRoot(input.stateDir, pathSafety, 'source_root_unsafe');
  const gitHead = await gitOutput(workspaceRoot, ['rev-parse', 'HEAD']);
  await assertGitHistoryClean(workspaceRoot, input.secretCanaries ?? [], gitHead);
  await mkdir(join(snapshotRoot, 'workspace'), { recursive: true, mode: 0o700 });
  for (const name of ROOT_MARKDOWN.keys()) {
    const source = join(workspaceRoot, name);
    if (await exists(source)) await copyStable(
      source, join(snapshotRoot, 'workspace', name), input.secretCanaries ?? [], pathSafety, input.sourceReadCheckpoint,
      input.destinationWriteCheckpoint,
    );
  }
  for (const directory of ['memory', 'archive']) {
    const source = join(workspaceRoot, directory);
    if (await exists(source)) await copyAllowedMarkdownTree(
      workspaceRoot, source, join(snapshotRoot, 'workspace', directory),
      input.secretCanaries ?? [], pathSafety, input.sourceReadCheckpoint,
      input.destinationWriteCheckpoint,
    );
  }
  const gitDirectory = join(workspaceRoot, '.git');
  const gitInfo = await lstat(gitDirectory, { bigint: true });
  if (!gitInfo.isDirectory() || gitInfo.isSymbolicLink()
    || await pathSafety.isReparsePoint(gitDirectory)) {
    throw new BackupError('git_missing', 'Workspace Git metadata is not a direct directory');
  }
  const bundlePath = join(snapshotRoot, 'git', 'repository.bundle');
  await mkdir(dirname(bundlePath), { recursive: true, mode: 0o700 });
  try {
    await runExecFile({
      executable: 'git', args: ['bundle', 'create', bundlePath, 'HEAD'],
      cwd: workspaceRoot, timeoutMs: 30_000,
    });
  } catch {
    throw new BackupError('git_bundle_failed', 'Reachable Git snapshot could not be created');
  }
  await verifyGitBundle(bundlePath, gitHead, input.secretCanaries ?? []);

  await mkdir(join(snapshotRoot, 'state'), { recursive: true, mode: 0o700 });
  const sqlitePreflight = join(dirname(snapshotRoot), 'sqlite-preflight');
  await mkdir(sqlitePreflight, { mode: 0o700 });
  for (const name of [...REQUIRED_DATABASES, ...OPTIONAL_DATABASES]) {
    const source = join(stateRoot, name);
    if (!(await exists(source))) {
      if ((REQUIRED_DATABASES as readonly string[]).includes(name)) {
        throw new BackupError('sqlite_missing', `Required SQLite database is missing: ${name}`);
      }
      continue;
    }
    const sourceIdentity = await canonicalRegularFile(source, stateRoot, pathSafety);
    const destination = join(snapshotRoot, 'state', name);
    const preflight = join(sqlitePreflight, name);
    const sourceDb = new DatabaseSync(sourceIdentity.path, { readOnly: true });
    try {
      await assertPathIdentity(sourceIdentity, pathSafety);
      await sqliteBackup(sourceDb, preflight);
      await assertPathIdentity(sourceIdentity, pathSafety);
    } finally { sourceDb.close(); }
    normalizeSnapshotSqlite(preflight);
    await assertFileSecretFree(preflight, `state/${name}`, input.secretCanaries ?? []);
    await rename(preflight, destination);
    const evidence = inspectSqlite(destination);
    sqlite.push({ path: `state/${name}`, ...evidence });
  }
  await rm(sqlitePreflight, { recursive: true });
  await scanSnapshot(snapshotRoot, input.secretCanaries ?? []);
  for (const relativePath of await listFiles(snapshotRoot)) {
    const evidence = await hashFileBounded(
      join(snapshotRoot, ...relativePath.split('/')), BACKUP_ARCHIVE_LIMITS.maxFileBytes,
    );
    files.push({ path: relativePath, ...evidence });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  sqlite.sort((a, b) => a.path.localeCompare(b.path));
  const sourceTime = (input.now ?? (() => new Date()))();
  const createdAt = new Date(Math.floor(sourceTime.valueOf() / 1_000) * 1_000)
    .toISOString().replace('.000Z', 'Z');
  const manifest: BackupManifest = {
    version: 1, createdAt, gitHead, schemaVersion: BACKUP_SCHEMA_VERSION,
    exclusionsVersion: BACKUP_EXCLUSIONS_VERSION, files, sqlite,
  };
  await writeFile(join(snapshotRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return manifest;
}

async function verifyArchiveToFreshDirectory(input: VerifyBackupInput, requireEligible = true) {
  const age = input.ageRunner ?? new AgeExecRunner();
  const archivePath = resolve(input.archivePath);
  if (requireEligible) await assertArchiveEligible(archivePath, input.pathSafety);
  const archiveStat = await lstat(archivePath, { bigint: true });
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink()
    || await (input.pathSafety ?? DEFAULT_PATH_SAFETY).isReparsePoint(archivePath)) throw new BackupError('archive_unsafe', 'Backup archive is not a regular file');
  const realArchive = await realpath(archivePath);
  if (realArchive !== archivePath) throw new BackupError('archive_unsafe', 'Backup archive path is indirect');
  const root = await privateTempRoot();
  try {
    const privateArchive = join(root, 'archive.age');
    const bundlePath = join(root, 'decrypted.bundle');
    const snapshotRoot = join(root, 'snapshot');
    await copyStableStreaming(realArchive, privateArchive, BACKUP_ARCHIVE_LIMITS.maxArchiveBytes);
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
  const manifest = parseManifest(await readTextBounded(join(snapshotRoot, 'manifest.json'), 4 * 1024 * 1024));
  const actual = (await listFiles(snapshotRoot)).filter(path => path !== 'manifest.json').sort();
  const expected = manifest.files.map(file => file.path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new BackupError('manifest_file_set_mismatch', 'Snapshot file set does not match manifest');
  for (const entry of manifest.files) {
    const evidence = await hashFileBounded(
      join(snapshotRoot, ...entry.path.split('/')), BACKUP_ARCHIVE_LIMITS.maxFileBytes,
    );
    if (evidence.size !== entry.size || evidence.sha256 !== entry.sha256) {
      throw new BackupError('manifest_hash_mismatch', `Snapshot hash mismatch: ${entry.path}`);
    }
  }
  for (const entry of manifest.sqlite) {
    const evidence = inspectSqlite(join(snapshotRoot, ...entry.path.split('/')));
    if (evidence.userVersion !== entry.userVersion || evidence.schemaFingerprint !== entry.schemaFingerprint) {
      throw new BackupError('sqlite_schema_mismatch', `SQLite schema mismatch: ${entry.path}`);
    }
  }
  await validateMarkdown(snapshotRoot);
  await verifyGitBundle(
    join(snapshotRoot, 'git', 'repository.bundle'), manifest.gitHead, canaries,
  );
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
    const kind = path.startsWith('memory/')
      ? 'daily'
      : path.startsWith('archive/')
        ? (/^archive\/\d{4}-\d{2}-\d{2}\.md$/.test(path)
            ? 'daily'
            : path === `archive/${name}` ? ROOT_MARKDOWN.get(name) : undefined)
        : ROOT_MARKDOWN.get(name);
    if (!kind) throw new BackupError('markdown_path_invalid', `Unexpected Markdown path: ${path}`);
    const ids = seen.get(kind) ?? new Set<string>();
    const document = parseDocument(kind, await readTextBounded(join(workspace, ...path.split('/')), MARKDOWN_MAX_BYTES), ids);
    document.records.forEach(record => ids.add(record.id));
    seen.set(kind, ids);
  }
}

function inspectSqlite(path: string): { userVersion: number; schemaFingerprint: string } {
  const name = basename(path);
  try {
    if (name === 'operations.sqlite3') return validateOperationBackupDatabase(path);
    if (name === 'calendar-outbox.sqlite3') return validateOutboxBackupDatabase(path);
    if (name === 'alerts.sqlite3') return validateAlertBackupDatabase(path);
    if (name === 'subsystem-health.sqlite3') return validateHealthBackupDatabase(path);
    throw new BackupError('sqlite_schema_mismatch', 'Unexpected SQLite snapshot path');
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError('sqlite_schema_mismatch', `SQLite schema mismatch: ${name}`);
  }
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
  const paths = await listFiles(root);
  if (paths.length > BACKUP_ARCHIVE_LIMITS.maxEntries) {
    throw new BackupError('archive_entry_limit', 'Snapshot contains too many archive entries');
  }
  const output = await open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  let position = 0;
  let total = 0;
  try {
    position = await writeAt(output, ARCHIVE_MAGIC, position);
    for (const path of paths) {
      const source = join(root, ...path.split('/'));
      const evidence = await hashFileBounded(source, BACKUP_ARCHIVE_LIMITS.maxFileBytes);
      total += evidence.size;
      if (total > BACKUP_ARCHIVE_LIMITS.maxTotalBytes) throw new BackupError('archive_total_limit', 'Snapshot exceeds decoded archive limit');
      if (Buffer.byteLength(path) > BACKUP_ARCHIVE_LIMITS.maxPathBytes) throw new BackupError('archive_path_limit', 'Snapshot path exceeds archive limit');
      const header = Buffer.from(JSON.stringify({ path, size: evidence.size, sha256: evidence.sha256 }));
      if (header.byteLength > BACKUP_ARCHIVE_LIMITS.maxHeaderBytes) throw new BackupError('archive_header_limit', 'Snapshot header exceeds archive limit');
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(header.byteLength);
      position = await writeAt(output, length, position);
      position = await writeAt(output, header, position);
      position = await copyFileBytesIntoHandle(source, output, position, evidence);
      if (position > BACKUP_ARCHIVE_LIMITS.maxArchiveBytes) throw new BackupError('archive_size_limit', 'Archive exceeds encoded size limit');
    }
    await writeAt(output, Buffer.alloc(4), position);
    await output.sync();
  } finally { await output.close(); }
}

async function unpackBundle(bundlePath: string, destination: string): Promise<void> {
  const bundleStat = await lstat(bundlePath, { bigint: true });
  if (!bundleStat.isFile() || bundleStat.isSymbolicLink()
    || bundleStat.size > BigInt(BACKUP_ARCHIVE_LIMITS.maxArchiveBytes)) {
    throw new BackupError('archive_size_limit', 'Decrypted archive exceeds size limit');
  }
  const input = await open(bundlePath, fsConstants.O_RDONLY);
  await mkdir(destination, { mode: 0o700 });
  const seen = new Set<string>();
  let position = 0;
  let count = 0;
  let total = 0;
  try {
    const magic = await readExactly(input, ARCHIVE_MAGIC.byteLength, position);
    position += magic.byteLength;
    if (!magic.equals(ARCHIVE_MAGIC)) throw new BackupError('archive_invalid', 'Archive magic is invalid');
    while (true) {
      const lengthBytes = await readExactly(input, 4, position);
      position += 4;
      const headerLength = lengthBytes.readUInt32BE();
      if (headerLength === 0) break;
      if (headerLength > BACKUP_ARCHIVE_LIMITS.maxHeaderBytes) throw new BackupError('archive_header_limit', 'Archive header exceeds limit');
      if (++count > BACKUP_ARCHIVE_LIMITS.maxEntries) throw new BackupError('archive_entry_limit', 'Archive entry count exceeds limit');
      const headerBytes = await readExactly(input, headerLength, position);
      position += headerLength;
      let parsed: unknown;
      try { parsed = JSON.parse(headerBytes.toString('utf8')); } catch { throw new BackupError('archive_invalid', 'Archive header is invalid'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.keys(parsed).sort().join('\0') !== ['path', 'sha256', 'size'].sort().join('\0')) {
        throw new BackupError('archive_invalid', 'Archive header contract is invalid');
      }
      const item = parsed as { path: unknown; size: unknown; sha256: unknown };
      if (typeof item.path !== 'string' || !isSafeRelativePath(item.path)
        || Buffer.byteLength(item.path) > BACKUP_ARCHIVE_LIMITS.maxPathBytes || seen.has(item.path)
        || !Number.isSafeInteger(item.size) || Number(item.size) < 0
        || Number(item.size) > BACKUP_ARCHIVE_LIMITS.maxFileBytes
        || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256)) {
        throw new BackupError('archive_invalid', 'Archive entry is invalid');
      }
      const size = Number(item.size);
      total += size;
      if (total > BACKUP_ARCHIVE_LIMITS.maxTotalBytes) throw new BackupError('archive_total_limit', 'Archive decoded bytes exceed limit');
      seen.add(item.path);
      const outputPath = join(destination, ...item.path.split('/'));
      if (!within(destination, outputPath)) throw new BackupError('archive_path_escape', 'Archive entry escapes destination');
      await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
      const output = await open(outputPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      const hash = createHash('sha256');
      let remaining = size;
      let outputPosition = 0;
      let streamedHash: string;
      try {
        while (remaining > 0) {
          const bytes = await readExactly(input, Math.min(64 * 1024, remaining), position);
          position += bytes.byteLength;
          remaining -= bytes.byteLength;
          hash.update(bytes);
          outputPosition = await writeAll(output, bytes, outputPosition);
        }
        await output.sync();
        streamedHash = hash.digest('hex');
      } finally { await output.close(); }
      const destinationEvidence = await hashFileBounded(outputPath, BACKUP_ARCHIVE_LIMITS.maxFileBytes);
      if (streamedHash! !== item.sha256 || destinationEvidence.size !== size || destinationEvidence.sha256 !== item.sha256) {
        throw new BackupError('archive_hash_mismatch', 'Archive entry destination hash mismatch');
      }
    }
    if (position !== Number(bundleStat.size)) throw new BackupError('archive_trailing_bytes', 'Archive contains trailing bytes');
  } finally { await input.close(); }
}

async function writeAt(handle: Awaited<ReturnType<typeof open>>, bytes: Uint8Array, position: number): Promise<number> {
  return writeAll(handle, bytes, position);
}

export async function writeAll(
  handle: Pick<Awaited<ReturnType<typeof open>>, 'write'>,
  bytes: Uint8Array,
  position: number,
): Promise<number> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset);
    if (result.bytesWritten <= 0 || result.bytesWritten > bytes.byteLength - offset) {
      throw new BackupError('archive_write_failed', 'Archive write made invalid progress');
    }
    offset += result.bytesWritten;
  }
  return position + bytes.byteLength;
}

async function readExactly(handle: Awaited<ReturnType<typeof open>>, length: number, position: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(bytes, offset, length - offset, position + offset);
    if (result.bytesRead === 0) throw new BackupError('archive_truncated', 'Archive is truncated');
    offset += result.bytesRead;
  }
  return bytes;
}

async function hashFileBounded(path: string, maximum: number): Promise<{ size: number; sha256: string }> {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.size > BigInt(maximum)) throw new BackupError('archive_file_limit', 'Snapshot file exceeds archive limit');
  const handle = await open(path, fsConstants.O_RDONLY);
  const hash = createHash('sha256');
  let position = 0;
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (position < Number(info.size)) {
      const result = await handle.read(buffer, 0, Math.min(buffer.byteLength, Number(info.size) - position), position);
      if (result.bytesRead === 0) throw new BackupError('source_changed', 'Snapshot file was truncated while hashing');
      hash.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameStableFile(info, after)) throw new BackupError('source_changed', 'Snapshot file changed while hashing');
    return { size: position, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}

async function copyFileBytesIntoHandle(source: string, destination: Awaited<ReturnType<typeof open>>, outputPosition: number, expected: { size: number; sha256: string }): Promise<number> {
  const input = await open(source, fsConstants.O_RDONLY);
  const before = await input.stat({ bigint: true });
  const hash = createHash('sha256');
  let inputPosition = 0;
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (inputPosition < expected.size) {
      const result = await input.read(buffer, 0, Math.min(buffer.byteLength, expected.size - inputPosition), inputPosition);
      if (result.bytesRead === 0) throw new BackupError('source_changed', 'Snapshot file truncated while archiving');
      const bytes = buffer.subarray(0, result.bytesRead);
      hash.update(bytes);
      outputPosition = await writeAt(destination, bytes, outputPosition);
      inputPosition += result.bytesRead;
    }
    const after = await input.stat({ bigint: true });
    if (!sameStableFile(before, after) || inputPosition !== expected.size || hash.digest('hex') !== expected.sha256) {
      throw new BackupError('source_changed', 'Snapshot file changed while archiving');
    }
    return outputPosition;
  } finally { await input.close(); }
}

async function copyStableStreaming(source: string, destination: string, maximum: number): Promise<void> {
  const evidence = await hashFileBounded(source, maximum);
  const output = await open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    await copyFileBytesIntoHandle(source, output, 0, evidence);
    await output.sync();
  } finally { await output.close(); }
  const destinationEvidence = await hashFileBounded(destination, maximum);
  if (destinationEvidence.size !== evidence.size || destinationEvidence.sha256 !== evidence.sha256) {
    throw new BackupError('destination_mismatch', 'Stable copy destination differs from source');
  }
}

async function copyAllowedMarkdownTree(
  workspaceRoot: string,
  source: string,
  destination: string,
  canaries: readonly string[],
  pathSafety: PathSafety,
  checkpoint?: (path: string) => void | Promise<void>,
  destinationCheckpoint?: (path: string) => void | Promise<void>,
): Promise<void> {
  const root = await canonicalDirectoryUnder(source, workspaceRoot, pathSafety);
  for (const path of await listSourceFiles(root, '', pathSafety)) {
    if (!path.endsWith('.md')) continue;
    await copyStable(
      join(root, ...path.split('/')), join(destination, ...path.split('/')), canaries, pathSafety,
      checkpoint,
      destinationCheckpoint,
    );
  }
}

async function listSourceFiles(
  root: string,
  current = '',
  pathSafety: PathSafety = DEFAULT_PATH_SAFETY,
): Promise<string[]> {
  const directory = join(root, ...current.split('/').filter(Boolean));
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const path = current ? `${current}/${entry.name}` : entry.name;
    const full = join(root, ...path.split('/'));
    const info = await lstat(full, { bigint: true });
    if (info.isSymbolicLink() || await pathSafety.isReparsePoint(full)) {
      throw new BackupError('source_reparse_rejected', `Snapshot source contains a reparse point: ${path}`);
    }
    const canonical = await realpath(full);
    if (!within(root, canonical) || canonical !== resolve(full)) {
      throw new BackupError('source_path_escape', `Snapshot source escapes its root: ${path}`);
    }
    if (info.isDirectory()) result.push(...await listSourceFiles(root, path, pathSafety));
    else if (info.isFile()) result.push(path);
    else throw new BackupError('source_nonregular_rejected', `Snapshot source is nonregular: ${path}`);
  }
  return result.sort();
}

async function copyStable(
  source: string,
  destination: string,
  canaries: readonly string[] = [],
  pathSafety: PathSafety = DEFAULT_PATH_SAFETY,
  checkpoint?: (path: string) => void | Promise<void>,
  destinationCheckpoint?: (path: string) => void | Promise<void>,
): Promise<void> {
  const noFollow = (fsConstants as Partial<Record<'O_NOFOLLOW', number>>).O_NOFOLLOW ?? 0;
  const before = await lstat(source, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || await pathSafety.isReparsePoint(source)) {
    throw new BackupError('source_reparse_rejected', `Snapshot source is unsafe: ${basename(source)}`);
  }
  const canonical = await realpath(source);
  if (canonical !== resolve(source)) throw new BackupError('source_path_escape', 'Snapshot source is indirect');
  const handle = await open(source, fsConstants.O_RDONLY | noFollow);
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameStableFile(before, opened)) throw new BackupError('source_changed', 'Snapshot source changed while opening');
    if (opened.size > BigInt(BACKUP_ARCHIVE_LIMITS.maxFileBytes)) throw new BackupError('source_size_limit', 'Snapshot source exceeds per-file limit');
    assertLogicalPathSecretFree(destination);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    output = await open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    const copied = await streamHandleWithSecretScan(handle, output, destination, canaries, Number(opened.size));
    await output.sync();
    await output.close(); output = undefined;
    await destinationCheckpoint?.(destination);
    const destinationEvidence = await hashFileBounded(destination, BACKUP_ARCHIVE_LIMITS.maxFileBytes);
    if (destinationEvidence.size !== copied.size || destinationEvidence.sha256 !== copied.sha256) {
      throw new BackupError('destination_mismatch', 'Snapshot destination differs from streamed source');
    }
    await checkpoint?.(source);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(source, { bigint: true });
    if (!sameStableFile(opened, after) || !sameStableFile(after, pathAfter)
      || await pathSafety.isReparsePoint(source) || await realpath(source) !== canonical) {
      throw new BackupError('source_changed', 'Snapshot source changed while reading');
    }
  } finally { await output?.close(); await handle.close(); }
}

async function copyTreeVerified(source: string, destination: string): Promise<void> {
  for (const path of await listSourceFiles(source)) await copyStable(join(source, ...path.split('/')), join(destination, ...path.split('/')));
}

async function syncTree(root: string, durability: BackupDurability): Promise<void> {
  for (const relativePath of await listSourceFiles(root)) {
    const path = join(root, ...relativePath.split('/'));
    if (process.platform === 'win32') await chmod(path, 0o600);
    await durability.syncFile(path);
  }
  await durability.syncDirectory(root);
}

interface CanonicalFileIdentity {
  path: string;
  stat: BigIntStats;
}

const DEFAULT_PATH_SAFETY: PathSafety = {
  async isReparsePoint(path) {
    if ((await lstat(path)).isSymbolicLink()) return true;
    const windowsPath = process.platform === 'win32' && /^d:\\/i.test(path)
      ? path
      : process.platform === 'linux' && /^\/mnt\/d\//i.test(path)
        ? await runExecFileCapture({ executable: 'wslpath', args: ['-w', path], timeoutMs: 10_000 }).then(value => value.trim())
        : undefined;
    if (!windowsPath) return false;
    try {
      const output = await runExecFileCapture({
        executable: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command',
          '$p=$args[0];[bool]((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)', windowsPath],
        timeoutMs: 10_000,
      });
      return parseWindowsReparseClassification(output);
    } catch (error) {
      if (error instanceof BackupError) throw error;
      throw new BackupError('reparse_classification_failed', 'Windows reparse classification was unavailable');
    }
  },
};

async function canonicalDirectoryRoot(
  path: string,
  pathSafety: PathSafety = DEFAULT_PATH_SAFETY,
  code = 'path_unsafe',
): Promise<string> {
  const absolute = resolve(path);
  const before = await lstat(absolute, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || await pathSafety.isReparsePoint(absolute)) {
    throw new BackupError(code, 'Configured source root is not a direct directory');
  }
  const canonical = await realpath(absolute);
  const after = await lstat(canonical, { bigint: true });
  if (canonical !== absolute || !sameStableFile(before, after)) {
    throw new BackupError(code, 'Configured source root identity changed');
  }
  return canonical;
}

async function canonicalDirectoryUnder(
  path: string,
  expectedRoot: string,
  pathSafety: PathSafety = DEFAULT_PATH_SAFETY,
): Promise<string> {
  const absolute = resolve(path);
  const before = await lstat(absolute, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || await pathSafety.isReparsePoint(absolute)) {
    throw new BackupError('source_reparse_rejected', 'Allowlisted source directory is indirect');
  }
  const canonical = await realpath(absolute);
  const after = await lstat(canonical, { bigint: true });
  if (!within(expectedRoot, canonical) || canonical !== absolute || !sameStableFile(before, after)) {
    throw new BackupError('source_path_escape', 'Allowlisted source directory escapes workspace');
  }
  return canonical;
}

async function canonicalRegularFile(
  path: string,
  expectedRoot: string,
  pathSafety: PathSafety,
): Promise<CanonicalFileIdentity> {
  const absolute = resolve(path);
  const before = await lstat(absolute, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || await pathSafety.isReparsePoint(absolute)) {
    throw new BackupError('source_reparse_rejected', 'SQLite source is not a direct regular file');
  }
  const canonical = await realpath(absolute);
  const after = await lstat(canonical, { bigint: true });
  if (!within(expectedRoot, canonical) || canonical !== absolute || !sameStableFile(before, after)) {
    throw new BackupError('source_path_escape', 'SQLite source escapes state root');
  }
  return { path: canonical, stat: after };
}

async function assertPathIdentity(identity: CanonicalFileIdentity, pathSafety: PathSafety): Promise<void> {
  const current = await lstat(identity.path, { bigint: true });
  if (!current.isFile() || current.isSymbolicLink() || await pathSafety.isReparsePoint(identity.path)
    || !sameStableFile(identity.stat, current)) {
    throw new BackupError('source_changed', 'SQLite source identity changed during backup');
  }
}

async function listFiles(root: string): Promise<string[]> {
  return listSourceFiles(root);
}

async function scanSnapshot(root: string, canaries: readonly string[]): Promise<void> {
  for (const path of await listFiles(root)) {
    await assertFileSecretFree(join(root, ...path.split('/')), path, canaries);
  }
}

async function assertFileSecretFree(
  file: string,
  logicalPath: string,
  canaries: readonly string[],
): Promise<void> {
  assertLogicalPathSecretFree(logicalPath);
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat({ bigint: true });
    if (info.size > BigInt(BACKUP_ARCHIVE_LIMITS.maxFileBytes)) throw new BackupError('source_size_limit', 'Secret scan input exceeds per-file limit');
    await streamHandleWithSecretScan(handle, undefined, logicalPath, canaries, Number(info.size));
  } finally { await handle.close(); }
}

function assertLogicalPathSecretFree(logicalPath: string): void {
  if (/secret|credential|oauth|token|\.key$/i.test(logicalPath)) {
    throw new BackupError('secret_material_detected', 'Secret-named material is excluded from backups');
  }
}

async function streamHandleWithSecretScan(
  input: Awaited<ReturnType<typeof open>>,
  output: Awaited<ReturnType<typeof open>> | undefined,
  logicalPath: string,
  canaries: readonly string[],
  expectedSize: number,
): Promise<{ size: number; sha256: string }> {
  assertLogicalPathSecretFree(logicalPath);
  const needles = [...canaries.filter(Boolean), '-----BEGIN PRIVATE KEY-----', '-----BEGIN AGE SECRET KEY-----'];
  const overlap = Math.max(256, ...needles.map(value => Buffer.byteLength(value))) - 1;
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const hash = createHash('sha256');
  let carry = Buffer.alloc(0); let position = 0;
  while (position < expectedSize) {
    const { bytesRead } = await input.read(chunk, 0, Math.min(chunk.length, expectedSize - position), position);
    if (bytesRead === 0) throw new BackupError('source_changed', 'Snapshot source was truncated while reading');
    const bytes = chunk.subarray(0, bytesRead);
    const window = Buffer.concat([carry, bytes]);
    assertBytesSecretFree(logicalPath, window, canaries);
    hash.update(bytes);
    if (output) await writeAll(output, bytes, position);
    carry = Buffer.from(window.subarray(Math.max(0, window.length - overlap)));
    position += bytesRead;
  }
  return { size: position, sha256: hash.digest('hex') };
}

async function readTextBounded(path: string, maximum: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat({ bigint: true });
    if (info.size > BigInt(maximum)) throw new BackupError('markdown_size_limit', 'Markdown file exceeds validation limit');
    return await handle.readFile({ encoding: 'utf8' });
  } finally { await handle.close(); }
}

function assertBytesSecretFree(
  logicalPath: string,
  bytes: Uint8Array,
  canaries: readonly string[],
): void {
  assertLogicalPathSecretFree(logicalPath);
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

async function assertGitHistoryClean(
  workspace: string,
  canaries: readonly string[],
  head: string,
): Promise<void> {
  const patterns = [...canaries.filter(Boolean), '-----BEGIN PRIVATE KEY-----', '-----BEGIN AGE SECRET KEY-----'];
  if (patterns.length === 0) return;
  const commits = (await gitOutput(workspace, ['rev-list', head])).split(/\s+/).filter(Boolean);
  if (commits.length === 0) return;
  const { execFile } = await import('node:child_process');
  for (const pattern of patterns) {
    if (Buffer.byteLength(pattern) > 8 * 1024) throw new BackupError('secret_scan_pattern_invalid', 'Secret scan pattern exceeds safe process argument limit');
    for (const commit of commits) {
      const found = await new Promise<boolean>((resolvePromise, reject) => execFile(
        'git', ['grep', '--quiet', '--fixed-strings', '--ignore-case', '-e', pattern, commit],
        { cwd: workspace, shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 },
        error => {
          if (!error) resolvePromise(true);
          else if (typeof error.code === 'number' && error.code === 1) resolvePromise(false);
          else reject(new BackupError('git_scan_failed', 'Git history secret scan failed'));
        },
      ));
      if (found) throw new BackupError('secret_material_detected', 'Secret material was detected in Git history');
    }
  }
}

async function verifyGitBundle(
  bundlePath: string,
  expectedHead: string,
  canaries: readonly string[],
): Promise<void> {
  const root = await privateTempRoot();
  const clone = join(root, 'repository');
  try {
    await runExecFile({
      executable: 'git', args: ['clone', '--quiet', '--no-local', bundlePath, clone],
      timeoutMs: 30_000,
    });
    const head = await gitOutput(clone, ['rev-parse', 'HEAD']);
    if (head !== expectedHead) throw new BackupError('git_head_mismatch', 'Git bundle HEAD does not match manifest');
    await gitOutput(clone, ['fsck', '--full', '--no-dangling']);
    await assertGitHistoryClean(clone, canaries, expectedHead);
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError('git_verify_failed', 'Git bundle verification failed');
  } finally { await cleanupPrivateRoot(root); }
}

async function materializeGitBundle(restoreStaging: string, expectedHead: string): Promise<void> {
  const materialized = join(restoreStaging, '.git-materialize');
  const workspace = join(restoreStaging, 'workspace');
  const bundle = join(restoreStaging, 'git', 'repository.bundle');
  try {
    await runExecFile({
      executable: 'git', args: ['clone', '--quiet', '--no-local', bundle, materialized],
      timeoutMs: 30_000,
    });
    await runExecFile({
      executable: 'git', args: ['remote', 'remove', 'origin'], cwd: materialized,
      timeoutMs: 30_000,
    });
    if (await gitOutput(materialized, ['rev-parse', 'HEAD']) !== expectedHead) {
      throw new BackupError('git_head_mismatch', 'Materialized Git HEAD does not match manifest');
    }
    await rename(join(materialized, '.git'), join(workspace, '.git'));
    await rm(materialized, { recursive: true });
    await gitOutput(workspace, ['fsck', '--full', '--no-dangling']);
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError('git_restore_failed', 'Git bundle could not be materialized');
  }
}

async function privateTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  await chmod(root, 0o700);
  const real = await realpath(root);
  if (real !== resolve(root)) throw new BackupError('temp_root_unsafe', 'Private temporary directory is indirect');
  return real;
}

async function privateStateTempRoot(stateRoot: string, pathSafety?: PathSafety): Promise<string> {
  const parent = join(stateRoot, '.backup-private');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const canonicalParent = await canonicalDirectoryUnder(parent, stateRoot, pathSafety);
  const root = await mkdtemp(join(canonicalParent, TEMP_PREFIX));
  await chmod(root, 0o700);
  return canonicalDirectoryUnder(root, canonicalParent, pathSafety);
}

const defaultAclVerifier: BackupAclVerifier = {
  async verifyPrivateDirectory(path) {
    const info = await lstat(path, { bigint: true });
    assertDirectory(info, 'private directory');
    if (process.platform !== 'win32' && (Number(info.mode) & 0o077) !== 0) {
      throw new BackupError('acl_unsafe', 'Private directory permits group or other access');
    }
    await verifyWindowsAclPath(path);
  },
  async verifyBackupRoot(path) {
    const info = await lstat(path, { bigint: true });
    assertDirectory(info, 'backup root');
    await verifyWindowsAclPath(path);
  },
};

async function verifyWindowsAclPath(path: string): Promise<void> {
  // The deployed D: target is NTFS and must be explicitly audited by the host.
  const windowsPath = process.platform === 'win32' && /^d:\\/i.test(path)
      ? path
      : process.platform === 'linux' && /^\/mnt\/d\//i.test(path)
        ? await runExecFileCapture({ executable: 'wslpath', args: ['-w', path], timeoutMs: 10_000 }).then(value => value.trim())
        : undefined;
  if (windowsPath) {
      const output = await runExecFileCapture({
        executable: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command',
          '$p=$args[0];$a=Get-Acl -LiteralPath $p;$u=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$o=$a.Owner;if($o -notmatch "^S-"){$o=([Security.Principal.NTAccount]$o).Translate([Security.Principal.SecurityIdentifier]).Value};$r=@($a.Access|%{$s=$_.IdentityReference;if($s -isnot [Security.Principal.SecurityIdentifier]){$s=$s.Translate([Security.Principal.SecurityIdentifier])};@{sid=$s.Value;inherited=$_.IsInherited;type=$_.AccessControlType.ToString()}});@{currentSid=$u;ownerSid=$o;protected=$a.AreAccessRulesProtected;rules=$r}|ConvertTo-Json -Compress -Depth 4', windowsPath],
        timeoutMs: 10_000,
      });
      validateWindowsBackupAcl(output);
  }
}

const defaultDurability: BackupDurability = {
  async syncFile(path) { const handle = await open(path, 'r+'); try { await handle.sync(); } finally { await handle.close(); } },
  async syncDirectory(path) {
    let handle;
    try {
      handle = await open(path, 'r');
      await handle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows does not expose directory handles through Node; the atomic rename
      // is the strongest available fallback on these documented error codes.
      const classification = classifyDirectorySyncFailure(path, code);
      if (classification === 'fatal') throw error;
      if (classification === 'unsupported') return 'unsupported';
      return;
    } finally { await handle?.close(); }
  },
};

const defaultPublicationOps: BackupPublicationOps = { rename, unlink };

async function requirePublicationDirectorySync(
  durability: BackupDurability,
  root: string,
  diagnostic?: BackupBase['durabilityDiagnostic'],
): Promise<void> {
  const result = await durability.syncDirectory(root);
  const event = result === 'unsupported' ? 'directory-sync-unsupported' : 'directory-synced';
  diagnostic?.(event, root);
  if (result === 'unsupported') {
    throw new BackupError('archive_directory_sync_unsupported', 'Platform cannot durably publish the backup directory; archive remains uncommitted');
  }
}

async function rollbackPublishedArchive(
  finalArchive: string,
  marker: string,
  root: string,
  durability: BackupDurability,
  publication: BackupPublicationOps,
): Promise<void> {
  try {
    await publication.rename(finalArchive, `${finalArchive}.failed-${crypto.randomUUID()}`);
    await durability.syncDirectory(root).catch(() => undefined);
    await publication.unlink(marker).catch(() => undefined);
    return;
  } catch {
    try {
      await publication.unlink(finalArchive);
      await durability.syncDirectory(root).catch(() => undefined);
      await publication.unlink(marker).catch(() => undefined);
      return;
    } catch {
      throw new BackupError('archive_rollback_failed', `Backup publication rollback failed; ${basename(finalArchive)} remains explicitly ineligible while ${basename(marker)} exists`);
    }
  }
}

async function quarantinePrivateRoot(stateDir: string, workRoot: string, acl: BackupAclVerifier, pathSafety?: PathSafety): Promise<string> {
  const stateRoot = await canonicalDirectoryRoot(stateDir, pathSafety);
  const quarantine = join(stateRoot, '.backup-quarantine');
  await mkdir(quarantine, { recursive: true, mode: 0o700 });
  await chmod(quarantine, 0o700);
  await acl.verifyPrivateDirectory(quarantine);
  const canonical = await canonicalDirectoryUnder(quarantine, stateRoot, pathSafety);
  const destination = join(canonical, `quarantine-${crypto.randomUUID()}`);
  await rename(workRoot, destination);
  await acl.verifyPrivateDirectory(destination);
  return destination;
}

export async function cleanupBackupQuarantine(input: { stateDir: string; aclVerifier?: BackupAclVerifier; pathSafety?: PathSafety }): Promise<string[]> {
  const stateRoot = await canonicalDirectoryRoot(input.stateDir, input.pathSafety);
  const quarantine = join(stateRoot, '.backup-quarantine');
  const rootInfo = await lstat(quarantine, { bigint: true }).catch(() => undefined);
  if (!rootInfo) return [];
  assertDirectory(rootInfo, 'backup quarantine');
  if (await (input.pathSafety ?? DEFAULT_PATH_SAFETY).isReparsePoint(quarantine)) throw new BackupError('quarantine_unsafe', 'Quarantine root is indirect');
  const root = await realpath(quarantine);
  const removed: string[] = [];
  for (const name of await readdir(root)) {
    if (!/^quarantine-[0-9a-f-]+$/.test(name)) continue;
    const candidate = join(root, name);
    const info = await lstat(candidate, { bigint: true }).catch(() => undefined);
    if (!info || !info.isDirectory() || info.isSymbolicLink() || await (input.pathSafety ?? DEFAULT_PATH_SAFETY).isReparsePoint(candidate)) continue;
    if (await realpath(candidate) !== candidate) continue;
    await (input.aclVerifier ?? defaultAclVerifier).verifyPrivateDirectory(candidate);
    await rm(candidate, { recursive: true });
    removed.push(candidate);
  }
  return removed;
}

async function cleanupPrivateRoot(path: string): Promise<void> {
  const resolved = resolve(path);
  const parent = await realpath(dirname(resolved));
  const safeParent = parent === await realpath(tmpdir()) || basename(parent) === '.backup-private';
  if (!safeParent || !basename(resolved).startsWith(TEMP_PREFIX)) {
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

async function removeScheduledRestore(restoreRoot: string, restorePath: string, pathSafety?: PathSafety): Promise<void> {
  const root = await canonicalDirectoryRoot(restoreRoot, pathSafety, 'restore_root_unsafe');
  const target = resolve(restorePath);
  if (!within(root, target) || !/^restore-[0-9a-f-]+$/.test(basename(target))) {
    throw new BackupError('cleanup_target_unsafe', 'Refusing unsafe scheduled restore cleanup target');
  }
  const info = await lstat(target, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || await (pathSafety ?? DEFAULT_PATH_SAFETY).isReparsePoint(target)
    || await realpath(target) !== target) throw new BackupError('cleanup_target_unsafe', 'Scheduled restore cleanup target is indirect');
  await rm(target, { recursive: true });
}

function assertDirectory(info: BigIntStats, description: string): void {
  if (!info.isDirectory() || info.isSymbolicLink()) throw new BackupError('path_unsafe', `${description} is not a real directory`);
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameMovedFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.size === right.size && left.mtimeNs === right.mtimeNs;
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
    return new BackupError(error.code, `Backup operation failed (${error.code})`);
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
