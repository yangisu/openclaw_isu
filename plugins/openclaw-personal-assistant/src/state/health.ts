/// <reference types="node" />

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ActiveSubsystemError } from '../briefing/build.js';

const HEALTH_SCHEMA_VERSION = 2;

const HEALTH_TABLE_SQL = `
  CREATE TABLE subsystem_health (
    target TEXT PRIMARY KEY CHECK(length(target) > 0),
    error_code TEXT NOT NULL CHECK(length(error_code) > 0),
    message TEXT NOT NULL CHECK(length(message) > 0),
    active INTEGER NOT NULL CHECK(active IN (0, 1)),
    updated_at INTEGER NOT NULL
  ) STRICT
`;

const HEALTH_ACTIVE_INDEX_SQL = `
  CREATE INDEX health_active_idx ON subsystem_health (active, target)
`;

export const HEALTH_BACKUP_SCHEMA_VERSION = HEALTH_SCHEMA_VERSION;
export const HEALTH_BACKUP_SCHEMA_FINGERPRINT = createHash('sha256')
  .update(`${normalizeSql(HEALTH_TABLE_SQL)}\n${normalizeSql(HEALTH_ACTIVE_INDEX_SQL)}`)
  .digest('hex');

export function validateHealthBackupDatabase(path: string): {
  userVersion: number;
  schemaFingerprint: string;
} {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const version = Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (version !== HEALTH_SCHEMA_VERSION) {
      throw new SubsystemHealthError('health_schema_mismatch', 'Health backup schema version is incompatible');
    }
    validateCurrentHealthSchema(database);
    return { userVersion: version, schemaFingerprint: HEALTH_BACKUP_SCHEMA_FINGERPRINT };
  } finally { database.close(); }
}

export class SubsystemHealthError extends Error {
  constructor(public readonly code: 'health_schema_mismatch', message: string) {
    super(message);
    this.name = 'SubsystemHealthError';
  }
}

/** Task 9 backup code must call report on failure and recover only after verified success. */
export interface SubsystemHealthJournal {
  report(error: ActiveSubsystemError): void;
  recover(target: string): void;
  listActive(): ActiveSubsystemError[];
  close(): void;
}

interface HealthRow {
  target: string;
  error_code: string;
  message: string;
}

export class SubsystemHealthStore implements SubsystemHealthJournal {
  readonly #database: DatabaseSync;
  readonly #now: () => number;

  constructor(stateDir: string, options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const path = join(stateDir, 'subsystem-health.sqlite3');
    this.#database = new DatabaseSync(path);
    try {
      this.#database.exec('PRAGMA busy_timeout = 5000;');
      ensureHealthSchema(this.#database);
      chmodSync(stateDir, 0o700);
      chmodSync(path, 0o600);
    } catch (error) {
      this.#database.close();
      if (error instanceof SubsystemHealthError) throw error;
      throw new SubsystemHealthError('health_schema_mismatch', 'Subsystem health schema is incompatible');
    }
  }

  report(error: ActiveSubsystemError): void {
    validateError(error);
    this.#database.prepare(`
      INSERT INTO subsystem_health (target, error_code, message, active, updated_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(target) DO UPDATE SET
        error_code = excluded.error_code,
        message = excluded.message,
        active = 1,
        updated_at = excluded.updated_at
    `).run(error.target, error.errorCode, error.message, this.#now());
  }

  recover(target: string): void {
    if (!target) throw new TypeError('health target is required');
    this.#database.prepare(
      'UPDATE subsystem_health SET active = 0, updated_at = ? WHERE target = ?',
    ).run(this.#now(), target);
  }

  listActive(): ActiveSubsystemError[] {
    const rows = this.#database.prepare(`
      SELECT target, error_code, message FROM subsystem_health
      WHERE active = 1 ORDER BY target
    `).all() as unknown as HealthRow[];
    return rows.map(row => ({
      target: row.target,
      errorCode: row.error_code,
      message: row.message,
    }));
  }

  close(): void { this.#database.close(); }
}

function ensureHealthSchema(database: DatabaseSync): void {
  const version = Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  const exists = schemaObject(database, 'table', 'subsystem_health') !== undefined;
  if (version === 0 && !exists) createHealthSchema(database);
  else if (version === 1) migrateV1HealthSchema(database);
  else if (version !== HEALTH_SCHEMA_VERSION) {
    throw new SubsystemHealthError('health_schema_mismatch', `Unsupported subsystem health schema version ${version}`);
  }
  validateCurrentHealthSchema(database);
}

function createHealthSchema(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
    ${HEALTH_TABLE_SQL};
    ${HEALTH_ACTIVE_INDEX_SQL};
    PRAGMA user_version = ${HEALTH_SCHEMA_VERSION};
    COMMIT;
  `);
}

function migrateV1HealthSchema(database: DatabaseSync): void {
  requireSchemaSql(database, 'table', 'subsystem_health', HEALTH_TABLE_SQL);
  database.exec(`
    BEGIN IMMEDIATE;
    ${HEALTH_ACTIVE_INDEX_SQL};
    PRAGMA user_version = ${HEALTH_SCHEMA_VERSION};
    COMMIT;
  `);
}

function validateCurrentHealthSchema(database: DatabaseSync): void {
  requireSchemaSql(database, 'table', 'subsystem_health', HEALTH_TABLE_SQL);
  requireSchemaSql(database, 'index', 'health_active_idx', HEALTH_ACTIVE_INDEX_SQL);
  const unexpected = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
      AND name NOT IN ('subsystem_health', 'health_active_idx')
  `).all();
  if (unexpected.length > 0) {
    throw new SubsystemHealthError('health_schema_mismatch', 'Subsystem health has unexpected schema objects');
  }
  const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown };
  if (integrity.integrity_check !== 'ok') {
    throw new SubsystemHealthError('health_schema_mismatch', 'Subsystem health integrity check failed');
  }
}

function validateError(error: ActiveSubsystemError): void {
  if (!error.target || !error.errorCode || !error.message) {
    throw new TypeError('health error code, target, and message are required');
  }
}

function requireSchemaSql(
  database: DatabaseSync,
  type: 'table' | 'index',
  name: string,
  expected: string,
): void {
  const actual = schemaObject(database, type, name);
  if (!actual || normalizeSql(actual) !== normalizeSql(expected)) {
    throw new SubsystemHealthError('health_schema_mismatch', `Subsystem health ${type} ${name} is incompatible`);
  }
}

function schemaObject(database: DatabaseSync, type: 'table' | 'index', name: string): string | undefined {
  const row = database.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
    .get(type, name) as { sql?: unknown } | undefined;
  return typeof row?.sql === 'string' ? row.sql : undefined;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim().toLowerCase();
}
