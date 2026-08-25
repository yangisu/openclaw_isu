/// <reference types="node" />

import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  alertFingerprint,
  buildBriefing,
  type ActiveSubsystemError,
  type BriefingInput,
  type BriefingResult,
} from '../briefing/build.js';

interface AlertRow {
  fingerprint: string;
  error_code: string;
  target: string;
  active: number;
  delivered: number;
}

export interface AlertState {
  fingerprint: string;
  errorCode: string;
  target: string;
  active: boolean;
  delivered: boolean;
}

export interface AlertJournal {
  prepare(errors: ActiveSubsystemError[]): ActiveSubsystemError[];
  markDelivered(fingerprints: string[]): void;
  close(): void;
}

export class AlertLedger implements AlertJournal {
  readonly stateDir: string;
  readonly #database: DatabaseSync;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const databasePath = join(stateDir, 'alerts.sqlite3');
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS alert_fingerprints (
        fingerprint TEXT PRIMARY KEY CHECK(length(fingerprint) = 64),
        error_code TEXT NOT NULL CHECK(length(error_code) > 0),
        target TEXT NOT NULL CHECK(length(target) > 0),
        active INTEGER NOT NULL CHECK(active IN (0, 1)),
        delivered INTEGER NOT NULL CHECK(delivered IN (0, 1)),
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    chmodSync(stateDir, 0o700);
    chmodSync(databasePath, 0o600);
  }

  prepare(errors: ActiveSubsystemError[]): ActiveSubsystemError[] {
    const unique = new Map<string, ActiveSubsystemError>();
    for (const error of errors) {
      const fingerprint = alertFingerprint(error.errorCode, error.target);
      if (!unique.has(fingerprint)) unique.set(fingerprint, { ...error, fingerprint });
    }
    const pending: ActiveSubsystemError[] = [];
    const now = new Date().toISOString();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const previous = new Map((this.#database.prepare(
        'SELECT fingerprint, error_code, target, active, delivered FROM alert_fingerprints',
      ).all() as unknown as AlertRow[]).map(row => [row.fingerprint, row]));
      this.#database.prepare('UPDATE alert_fingerprints SET active = 0, updated_at = ? WHERE active = 1')
        .run(now);
      const insert = this.#database.prepare(`
        INSERT INTO alert_fingerprints (fingerprint, error_code, target, active, delivered, updated_at)
        VALUES (?, ?, ?, 1, 0, ?)
      `);
      const reactivate = this.#database.prepare(`
        UPDATE alert_fingerprints
        SET error_code = ?, target = ?, active = 1, delivered = ?, updated_at = ?
        WHERE fingerprint = ?
      `);
      for (const [fingerprint, error] of unique) {
        const row = previous.get(fingerprint);
        if (!row) {
          insert.run(fingerprint, error.errorCode, error.target, now);
          pending.push(error);
          continue;
        }
        const recovered = row.active === 0;
        const delivered = recovered ? 0 : row.delivered;
        reactivate.run(error.errorCode, error.target, delivered, now, fingerprint);
        if (delivered === 0) pending.push(error);
      }
      this.#database.exec('COMMIT');
      return pending;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  markDelivered(fingerprints: string[]): void {
    const update = this.#database.prepare(`
      UPDATE alert_fingerprints SET delivered = 1, updated_at = ?
      WHERE fingerprint = ? AND active = 1
    `);
    const now = new Date().toISOString();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      for (const fingerprint of new Set(fingerprints)) update.run(now, fingerprint);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  list(): AlertState[] {
    const rows = this.#database.prepare(`
      SELECT fingerprint, error_code, target, active, delivered
      FROM alert_fingerprints ORDER BY fingerprint
    `).all() as unknown as AlertRow[];
    return rows.map(row => ({
      fingerprint: row.fingerprint,
      errorCode: row.error_code,
      target: row.target,
      active: row.active === 1,
      delivered: row.delivered === 1,
    }));
  }

  close(): void {
    this.#database.close();
  }
}

export class BriefingService {
  constructor(private readonly alerts: AlertJournal) {}

  async run(
    input: BriefingInput,
    deliver: (messages: string[]) => Promise<void>,
  ): Promise<BriefingResult> {
    const activeErrors = this.alerts.prepare(input.activeErrors);
    const result = buildBriefing({ ...input, activeErrors });
    if (!result.send) return result;
    await deliver(result.messages);
    this.alerts.markDelivered(result.includedErrorFingerprints);
    return result;
  }
}
