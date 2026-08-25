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
  schemaSha256: string;
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
  if (input.version !== 1 || typeof input.createdAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(input.createdAt)
    || new Date(input.createdAt).toISOString().replace('.000Z', 'Z') !== input.createdAt
    || !/^[0-9a-f]{40}$/.test(String(input.gitHead))
    || typeof input.schemaVersion !== 'string' || input.schemaVersion.length === 0
    || typeof input.exclusionsVersion !== 'string' || input.exclusionsVersion.length === 0
    || !Array.isArray(input.files) || !Array.isArray(input.sqlite)) throw manifestError();
  const files = input.files.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw manifestError();
    const file = item as Record<string, unknown>;
    if (!isSafeRelativePath(String(file.path)) || !Number.isSafeInteger(file.size)
      || Number(file.size) < 0 || !/^[0-9a-f]{64}$/.test(String(file.sha256))) throw manifestError();
    return { path: String(file.path), size: Number(file.size), sha256: String(file.sha256) };
  });
  const sqlite = input.sqlite.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw manifestError();
    const entry = item as Record<string, unknown>;
    if (!isSafeRelativePath(String(entry.path)) || !Number.isSafeInteger(entry.userVersion)
      || Number(entry.userVersion) < 0 || !/^[0-9a-f]{64}$/.test(String(entry.schemaSha256))) throw manifestError();
    return { path: String(entry.path), userVersion: Number(entry.userVersion), schemaSha256: String(entry.schemaSha256) };
  });
  if (new Set(files.map(file => file.path)).size !== files.length
    || new Set(sqlite.map(entry => entry.path)).size !== sqlite.length
    || sqlite.some(entry => !files.some(file => file.path === entry.path))) throw manifestError();
  return {
    version: 1, createdAt: input.createdAt, gitHead: String(input.gitHead),
    schemaVersion: input.schemaVersion, exclusionsVersion: input.exclusionsVersion,
    files, sqlite,
  };
}

function manifestError(): Error & { code: string } {
  return Object.assign(new Error('Backup manifest is invalid'), { code: 'manifest_invalid' });
}
