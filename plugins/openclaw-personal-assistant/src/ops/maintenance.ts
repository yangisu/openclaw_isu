/// <reference types="node" />

import { chmodSync, mkdirSync } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  AgeExecRunner, applyRetention, BackupError, createBackup, verifyBackup, verifyScheduledRestore,
  type AgeRunner,
  type CreateBackupInput, type RetentionInput, type ScheduledRestoreInput,
  type VerifiedBackup, type VerifyBackupInput,
} from './backup.js';
import { SubsystemHealthStore, type SubsystemHealthJournal } from '../state/health.js';
import { SecretFileStore } from '../secrets/file-store.js';
import { productionSecretFs, readSecretFile } from '../secrets/file-store-internal.js';
import { openRepository } from '../workspace/repository.js';

export interface MaintenanceConfig {
  version: 1;
  workspaceDir: string;
  stateDir: string;
  backupDir: string;
  restoreRoot: string;
  identityFile: string;
  recipient: string;
}

interface MaintenanceRepository {
  quiesce<T>(work: () => Promise<T>): Promise<T>;
  close(): void;
}

export interface MaintenanceDependencies {
  openHealth(config: MaintenanceConfig): SubsystemHealthJournal;
  openRepository(config: MaintenanceConfig): Promise<MaintenanceRepository>;
  createBackup(input: CreateBackupInput): Promise<VerifiedBackup>;
  verifyBackup(input: VerifyBackupInput): Promise<VerifiedBackup>;
  verifyScheduledRestore(input: ScheduledRestoreInput): Promise<{
    evidencePath: string; manifest: VerifiedBackup['manifest']; restoreRetained: false;
  }>;
  applyRetention(input: RetentionInput): Promise<{ deleted: string[]; retained: string[] }>;
  now(): Date;
}

export interface MaintenanceResult {
  status: 'open';
  kind: 'daily' | 'monthly';
  archive: string;
  evidencePath: string;
  deletedCount: number;
}

export class MaintenanceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'MaintenanceError';
  }
}

export interface MaintenanceConfigDependencies {
  readConfig?(path: string): Promise<unknown>;
  validateIdentity?(path: string): Promise<void>;
  ageRunner?: AgeRunner;
  maintenanceDependencies?: Partial<MaintenanceDependencies>;
  run?: typeof runMaintenance;
}

const defaults: MaintenanceDependencies = {
  openHealth: config => new SubsystemHealthStore(config.stateDir),
  openRepository: async config => openRepository({
    workspaceDir: config.workspaceDir, stateDir: config.stateDir, backupDir: config.backupDir,
    telegramUserId: '123456789', timezone: 'Asia/Seoul',
  }),
  createBackup,
  verifyBackup,
  verifyScheduledRestore,
  applyRetention,
  now: () => new Date(),
};

export async function runMaintenance(input: {
  kind: 'daily' | 'monthly';
  config: MaintenanceConfig;
  dependencies?: Partial<MaintenanceDependencies>;
}): Promise<MaintenanceResult> {
  const dependencies = { ...defaults, ...input.dependencies };
  const lock = acquireMaintenanceLock(input.config.stateDir);
  let health: SubsystemHealthJournal | undefined;
  let repository: MaintenanceRepository | undefined;
  try {
    health = dependencies.openHealth(input.config);
    if (input.kind === 'monthly') {
      const archivePath = await selectNewestArchive(input.config.backupDir);
      const verified = await dependencies.verifyBackup({
        archivePath, identityFile: input.config.identityFile, health,
      });
      const restore = await dependencies.verifyScheduledRestore({
        archivePath: verified.archivePath, restoreRoot: input.config.restoreRoot,
        identityFile: input.config.identityFile, stateDir: input.config.stateDir,
        kind: 'monthly-full', health, now: dependencies.now,
      });
      try { health.recover('backup'); }
      catch { throw new MaintenanceError('maintenance_health_failed', 'Backup health recovery failed'); }
      return {
        status: 'open', kind: 'monthly', archive: verified.archivePath,
        evidencePath: restore.evidencePath, deletedCount: 0,
      };
    }
    repository = await dependencies.openRepository(input.config);
    const created = await dependencies.createBackup({
      repository, workspaceDir: input.config.workspaceDir, stateDir: input.config.stateDir,
      backupDir: input.config.backupDir, identityFile: input.config.identityFile,
      recipient: input.config.recipient, health, now: dependencies.now,
    });
    const verified = await dependencies.verifyBackup({
      archivePath: created.archivePath, identityFile: input.config.identityFile, health,
    });
    const restore = await dependencies.verifyScheduledRestore({
      archivePath: verified.archivePath, restoreRoot: input.config.restoreRoot,
      identityFile: input.config.identityFile, stateDir: input.config.stateDir,
      kind: 'daily-sample', health, now: dependencies.now,
    });
    try { health.recover('backup'); }
    catch { throw new MaintenanceError('maintenance_health_failed', 'Backup health recovery failed'); }
    const retention = await dependencies.applyRetention({
      backupDir: input.config.backupDir, identityFile: input.config.identityFile,
      health, keep: 30, now: dependencies.now,
    });
    return {
      status: 'open', kind: 'daily', archive: verified.archivePath,
      evidencePath: restore.evidencePath, deletedCount: retention.deleted.length,
    };
  } catch (error) {
    try {
      health?.report({
        target: 'backup', errorCode: maintenanceErrorCode(error),
        message: 'Automated backup maintenance is unavailable',
      });
    } catch { /* preserve the original maintenance failure */ }
    throw normalizeMaintenanceError(error);
  } finally {
    try { repository?.close(); } catch { /* resources are best-effort after a failed run */ }
    try { health?.close(); } catch { /* resources are best-effort after a failed run */ }
    lock.release();
  }
}

export function parseMaintenanceConfig(raw: unknown): MaintenanceConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidConfig();
  const value = raw as Record<string, unknown>;
  const keys = ['backupDir', 'identityFile', 'recipient', 'restoreRoot', 'stateDir', 'version', 'workspaceDir'];
  if (Object.keys(value).sort().join('\0') !== keys.join('\0') || value.version !== 1) throw invalidConfig();
  for (const key of ['workspaceDir', 'stateDir', 'backupDir', 'restoreRoot', 'identityFile'] as const) {
    const path = value[key];
    if (typeof path !== 'string' || !posix.isAbsolute(path) || posix.normalize(path) !== path
      || path.includes('/../') || path.includes('//') || path.startsWith('/absolute/')) throw invalidConfig();
  }
  if (typeof value.recipient !== 'string' || !/^age1[0-9a-z]{10,}$/.test(value.recipient)) throw invalidConfig();
  const identity = value.identityFile as string;
  if (/^\/mnt\/d(?:\/|$)/i.test(identity) || /(?:^|\/)\.git(?:\/|$)/.test(identity)) throw invalidConfig();
  for (const root of [value.workspaceDir, value.stateDir, value.backupDir, value.restoreRoot] as string[]) {
    const rel = posix.relative(root, identity);
    if (rel === '' || (!rel.startsWith('..') && !posix.isAbsolute(rel))) throw invalidConfig();
  }
  return {
    version: 1,
    workspaceDir: value.workspaceDir as string,
    stateDir: value.stateDir as string,
    backupDir: value.backupDir as string,
    restoreRoot: value.restoreRoot as string,
    identityFile: identity,
    recipient: value.recipient,
  };
}

export async function runMaintenanceFromConfig(
  kind: 'daily' | 'monthly', configPath: string, dependencies: MaintenanceConfigDependencies = {},
): Promise<MaintenanceResult> {
  const { config, validateIdentity } = await loadMaintenanceConfig(configPath, dependencies);
  const baseAge = dependencies.ageRunner ?? new AgeExecRunner();
  const age: AgeRunner = {
    encrypt: (inputPath, outputPath, recipient, signal) => baseAge.encrypt(inputPath, outputPath, recipient, signal),
    async decrypt(inputPath, outputPath, identityFile, signal) {
      try { await validateIdentity(identityFile); }
      catch { throw new MaintenanceError('maintenance_identity_unavailable', 'Offline backup identity is unavailable'); }
      await baseAge.decrypt(inputPath, outputPath, identityFile, signal);
    },
  };
  const operational: Partial<MaintenanceDependencies> = {
    ...dependencies.maintenanceDependencies,
    createBackup: input => createBackup({ ...input, ageRunner: age }),
    verifyBackup: input => verifyBackup({ ...input, ageRunner: age }),
    verifyScheduledRestore: input => verifyScheduledRestore({ ...input, ageRunner: age }),
    applyRetention: input => applyRetention({ ...input, ageRunner: age }),
  };
  return (dependencies.run ?? runMaintenance)({ kind, config, dependencies: operational });
}

export async function validateMaintenanceConfigFromFile(
  configPath: string, dependencies: MaintenanceConfigDependencies = {},
): Promise<void> {
  await loadMaintenanceConfig(configPath, dependencies);
}

async function loadMaintenanceConfig(configPath: string, dependencies: MaintenanceConfigDependencies): Promise<{
  config: MaintenanceConfig; validateIdentity(path: string): Promise<void>;
}> {
  const readConfig = dependencies.readConfig
    ?? (async path => new SecretFileStore<unknown>(path, 32 * 1024).read());
  const config = parseMaintenanceConfig(await readConfig(configPath));
  const validateIdentity = dependencies.validateIdentity ?? validateIdentityFile;
  try { await validateIdentity(config.identityFile); }
  catch { throw new MaintenanceError('maintenance_identity_unavailable', 'Offline backup identity is unavailable'); }
  return { config, validateIdentity };
}

async function validateIdentityFile(path: string): Promise<void> {
  const content = await readSecretFile(path, productionSecretFs, 1024 * 1024);
  if (!content.trim()) throw new MaintenanceError('maintenance_identity_unavailable', 'Offline backup identity is empty');
}

function invalidConfig(): MaintenanceError {
  return new MaintenanceError('maintenance_config_invalid', 'Maintenance config is invalid');
}

async function selectNewestArchive(backupDir: string): Promise<string> {
  const root = resolve(backupDir);
  if (await realpath(root) !== root) throw new MaintenanceError('maintenance_backup_root_unsafe', 'Backup root is indirect');
  const names = (await readdir(root)).filter(name => /^\d{4}-\d{2}-\d{2}\.age$/.test(name)).sort().reverse();
  const name = names[0];
  if (!name) throw new MaintenanceError('maintenance_archive_missing', 'No verified archive is available');
  const path = resolve(root, name);
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new MaintenanceError('maintenance_archive_unsafe', 'Archive path is unsafe');
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) {
    throw new MaintenanceError('maintenance_archive_unsafe', 'Archive path is unsafe');
  }
  return path;
}

function acquireMaintenanceLock(stateDir: string): { release(): void } {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(join(stateDir, 'maintenance-lock.sqlite3'));
  try {
    database.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;');
    chmodSync(join(stateDir, 'maintenance-lock.sqlite3'), 0o600);
  } catch {
    database.close();
    throw new MaintenanceError('maintenance_busy', 'Another maintenance run is active');
  }
  return {
    release() {
      try { database.exec('ROLLBACK'); } finally { database.close(); }
    },
  };
}

function maintenanceErrorCode(error: unknown): string {
  if (error instanceof MaintenanceError || error instanceof BackupError) return error.code;
  return 'maintenance_failed';
}

function normalizeMaintenanceError(error: unknown): Error {
  if (error instanceof MaintenanceError || error instanceof BackupError) return error;
  return new MaintenanceError('maintenance_failed', 'Maintenance failed');
}
