/// <reference types="node" />

import { createHash } from 'node:crypto';

export interface BackupFileEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface BackupSqliteEntry {
  path: string;
  userVersion: number;
  schemaFingerprint: string;
}

export interface BackupManifest {
  version: 1;
  createdAt: string;
  gitHead: string;
  schemaVersion: string;
  exclusionsVersion: string;
  files: BackupFileEntry[];
  sqlite: BackupSqliteEntry[];
}

export const BACKUP_EXCLUSIONS_VERSION = '1';
export const BACKUP_SCHEMA_VERSION = 'openclaw-personal-assistant-backup:1';
const REQUIRED_FILES = [
  'workspace/INBOX.md', 'workspace/MEMORY.md', 'workspace/NOTES.md',
  'workspace/STUDY.md', 'workspace/TASKS.md', 'workspace/USER.md',
  'state/alerts.sqlite3', 'state/calendar-outbox.sqlite3', 'state/operations.sqlite3',
  'git/repository.bundle',
] as const;
const REQUIRED_DATABASES = [
  'state/alerts.sqlite3', 'state/calendar-outbox.sqlite3', 'state/operations.sqlite3',
] as const;

export function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isSafeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.includes('\\')
    && path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
}

export function parseManifest(source: string): BackupManifest {
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw manifestError(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw manifestError();
  const input = value as Record<string, unknown>;
  if (!exactKeys(input, ['version', 'createdAt', 'gitHead', 'schemaVersion', 'exclusionsVersion', 'files', 'sqlite'])
    || input.version !== 1 || typeof input.createdAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(input.createdAt)
    || new Date(input.createdAt).toISOString().replace('.000Z', 'Z') !== input.createdAt
    || !/^[0-9a-f]{40}$/.test(String(input.gitHead))
    || input.schemaVersion !== BACKUP_SCHEMA_VERSION
    || input.exclusionsVersion !== BACKUP_EXCLUSIONS_VERSION
    || !Array.isArray(input.files) || !Array.isArray(input.sqlite)) throw manifestError();
  const files = input.files.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw manifestError();
    const file = item as Record<string, unknown>;
    if (!exactKeys(file, ['path', 'size', 'sha256'])
      || !isAllowedBackupPath(String(file.path)) || !Number.isSafeInteger(file.size)
      || Number(file.size) < 0 || !/^[0-9a-f]{64}$/.test(String(file.sha256))) throw manifestError();
    return { path: String(file.path), size: Number(file.size), sha256: String(file.sha256) };
  });
  const sqlite = input.sqlite.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw manifestError();
    const entry = item as Record<string, unknown>;
    if (!exactKeys(entry, ['path', 'userVersion', 'schemaFingerprint'])
      || !/^state\/(?:operations|calendar-outbox|alerts|subsystem-health)\.sqlite3$/.test(String(entry.path))
      || !Number.isSafeInteger(entry.userVersion)
      || Number(entry.userVersion) < 0 || !/^[0-9a-f]{64}$/.test(String(entry.schemaFingerprint))) throw manifestError();
    return { path: String(entry.path), userVersion: Number(entry.userVersion), schemaFingerprint: String(entry.schemaFingerprint) };
  });
  if (new Set(files.map(file => file.path)).size !== files.length
    || new Set(sqlite.map(entry => entry.path)).size !== sqlite.length
    || !isSorted(files.map(file => file.path)) || !isSorted(sqlite.map(entry => entry.path))
    || sqlite.some(entry => !files.some(file => file.path === entry.path))
    || REQUIRED_FILES.some(path => !files.some(file => file.path === path))
    || REQUIRED_DATABASES.some(path => !sqlite.some(entry => entry.path === path))
    || (files.some(file => file.path === 'state/subsystem-health.sqlite3')
      !== sqlite.some(entry => entry.path === 'state/subsystem-health.sqlite3'))) throw manifestError();
  return {
    version: 1, createdAt: input.createdAt, gitHead: String(input.gitHead),
    schemaVersion: input.schemaVersion, exclusionsVersion: input.exclusionsVersion,
    files, sqlite,
  };
}

function manifestError(): Error & { code: string } {
  return Object.assign(new Error('Backup manifest contract is invalid'), { code: 'manifest_contract_invalid' });
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function isSorted(paths: readonly string[]): boolean {
  return paths.every((path, index) => index === 0 || paths[index - 1]!.localeCompare(path) < 0);
}

function isAllowedBackupPath(path: string): boolean {
  if (!isSafeRelativePath(path)) return false;
  if (REQUIRED_FILES.includes(path as never) || path === 'state/subsystem-health.sqlite3') return true;
  if (/^workspace\/(?:memory|archive)\/(?:[^/]+\/)*[^/]+\.md$/.test(path)) return true;
  if (path === 'git/repository.bundle') return true;
  return false;
}
