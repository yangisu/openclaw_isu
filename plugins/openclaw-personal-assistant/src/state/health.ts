/// <reference types="node" />

import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ActiveSubsystemError } from '../briefing/build.js';

const HEALTH_SCHEMA_VERSION = 1;

export class SubsystemHealthError extends Error {
  constructor(public readonly code: 'health_schema_mismatch', message: string) {
    super(message);
    this.name = 'SubsystemHealthError';
  }
}

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
      const version = Number((this.#database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      if (version === 0 && !tableExists(this.#database, 'subsystem_health')) {
        this.#database.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE subsystem_health (
            target TEXT PRIMARY KEY CHECK(length(target) > 0),
            error_code TEXT NOT NULL CHECK(length(error_code) > 0),
            message TEXT NOT NULL CHECK(length(message) > 0),
            active INTEGER NOT NULL CHECK(active IN (0, 1)),
            updated_at INTEGER NOT NULL
          ) STRICT;
          PRAGMA user_version = ${HEALTH_SCHEMA_VERSION};
          COMMIT;
        `);
      } else if (version !== HEALTH_SCHEMA_VERSION) {
        throw new SubsystemHealthError('health_schema_mismatch', `Unsupported subsystem health schema version ${version}`);
      }
      validateTableShape(this.#database);
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

  close(): void {
    this.#database.close();
  }
}

function validateError(error: ActiveSubsystemError): void {
  if (!error.target || !error.errorCode || !error.message) {
    throw new TypeError('health error code, target, and message are required');
  }
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) !== undefined;
}

function validateTableShape(database: DatabaseSync): void {
  const actual = database.prepare('PRAGMA table_info(subsystem_health)').all() as unknown as Array<{
    name: string; type: string; notnull: number; pk: number;
  }>;
  const expected = [
    ['target', 'TEXT', 1, 1],
    ['error_code', 'TEXT', 1, 0],
    ['message', 'TEXT', 1, 0],
    ['active', 'INTEGER', 1, 0],
    ['updated_at', 'INTEGER', 1, 0],
  ];
  const normalized = actual.map(column => [column.name, column.type, column.notnull, column.pk]);
  if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
    throw new SubsystemHealthError('health_schema_mismatch', 'Subsystem health table shape is incompatible');
  }
}
