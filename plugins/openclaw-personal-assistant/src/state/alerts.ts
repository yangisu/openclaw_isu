/// <reference types="node" />

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  alertFingerprint, buildBriefing,
  type ActiveSubsystemError, type BriefingInput, type BriefingResult,
} from '../briefing/build.js';

const ALERT_SCHEMA_VERSION = 3;
const DEFAULT_LEASE_MS = 10 * 60_000;

const ALERT_TABLE_SQL = `
  CREATE TABLE alert_fingerprints (
    fingerprint TEXT PRIMARY KEY CHECK(length(fingerprint) = 64),
    error_code TEXT NOT NULL CHECK(length(error_code) > 0),
    target TEXT NOT NULL CHECK(length(target) > 0),
    active INTEGER NOT NULL CHECK(active IN (0, 1)),
    delivered INTEGER NOT NULL CHECK(delivered IN (0, 1)),
    claim_id TEXT,
    lease_expires_at INTEGER,
    updated_at TEXT NOT NULL
  ) STRICT
`;

const ALERT_CLAIM_INDEX_SQL = `
  CREATE INDEX alert_claim_idx
  ON alert_fingerprints (active, delivered, lease_expires_at, claim_id)
`;

export const ALERT_BACKUP_SCHEMA_VERSION = ALERT_SCHEMA_VERSION;
export const ALERT_BACKUP_SCHEMA_FINGERPRINT = createHash('sha256')
  .update(`${normalizeSql(ALERT_TABLE_SQL)}\n${normalizeSql(ALERT_CLAIM_INDEX_SQL)}`)
  .digest('hex');

export function validateAlertBackupDatabase(path: string): {
  userVersion: number;
  schemaFingerprint: string;
} {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const version = Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (version !== ALERT_SCHEMA_VERSION) {
      throw new AlertLedgerError('alert_schema_mismatch', 'Alert backup schema version is incompatible');
    }
    validateCurrentAlertSchema(database);
    return { userVersion: version, schemaFingerprint: ALERT_BACKUP_SCHEMA_FINGERPRINT };
  } finally { database.close(); }
}

const LEGACY_ALERT_TABLE_SQL = `
  CREATE TABLE alert_fingerprints (
    fingerprint TEXT PRIMARY KEY CHECK(length(fingerprint) = 64),
    error_code TEXT NOT NULL CHECK(length(error_code) > 0),
    target TEXT NOT NULL CHECK(length(target) > 0),
    active INTEGER NOT NULL CHECK(active IN (0, 1)),
    delivered INTEGER NOT NULL CHECK(delivered IN (0, 1)),
    updated_at TEXT NOT NULL
  ) STRICT
`;

const V2_DELIVERY_CLAIMS_SQL = `
  CREATE TABLE delivery_claims (
    claim_id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    target TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT
`;

const V2_DELIVERY_CHUNKS_SQL = `
  CREATE TABLE delivery_claim_chunks (
    claim_id TEXT NOT NULL REFERENCES delivery_claims(claim_id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
    content TEXT NOT NULL,
    acknowledged INTEGER NOT NULL CHECK(acknowledged IN (0, 1)),
    PRIMARY KEY (claim_id, chunk_index)
  ) STRICT
`;

const V2_DELIVERY_FINGERPRINTS_SQL = `
  CREATE TABLE delivery_chunk_fingerprints (
    claim_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    fingerprint TEXT NOT NULL REFERENCES alert_fingerprints(fingerprint) ON DELETE CASCADE,
    PRIMARY KEY (claim_id, chunk_index, fingerprint),
    FOREIGN KEY (claim_id, chunk_index)
      REFERENCES delivery_claim_chunks(claim_id, chunk_index) ON DELETE CASCADE
  ) STRICT
`;

interface AlertRow {
  fingerprint: string;
  error_code: string;
  target: string;
  active: number;
  delivered: number;
  claim_id: string | null;
  lease_expires_at: number | null;
}

export interface AlertState {
  fingerprint: string;
  errorCode: string;
  target: string;
  active: boolean;
  delivered: boolean;
  claimed: boolean;
}

export interface AlertClaim {
  claimId?: string;
  result: BriefingResult;
}

export type BriefingRenderer = (errors: ActiveSubsystemError[]) => BriefingResult;

export interface AlertJournal {
  claimAndRender(errors: ActiveSubsystemError[], renderer: BriefingRenderer): AlertClaim;
  acknowledgePayloads(claim: AlertClaim, sentPayloadIndices: readonly number[]): number;
  close(): void;
}

export class AlertLedgerError extends Error {
  constructor(public readonly code: 'alert_schema_mismatch', message: string) {
    super(message);
    this.name = 'AlertLedgerError';
  }
}

export class AlertLedger implements AlertJournal {
  readonly stateDir: string;
  readonly #database: DatabaseSync;
  readonly #now: () => number;
  readonly #leaseMs: number;

  constructor(stateDir: string, options: { now?: () => number; leaseMs?: number } = {}) {
    this.stateDir = stateDir;
    this.#now = options.now ?? Date.now;
    this.#leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    if (!Number.isSafeInteger(this.#leaseMs) || this.#leaseMs <= 0) {
      throw new TypeError('alert leaseMs must be a positive safe integer');
    }
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const databasePath = join(stateDir, 'alerts.sqlite3');
    this.#database = new DatabaseSync(databasePath);
    try {
      this.#database.exec('PRAGMA busy_timeout = 5000;');
      ensureAlertSchema(this.#database);
      this.#database.exec('PRAGMA journal_mode = WAL;');
      chmodSync(stateDir, 0o700);
      chmodSync(databasePath, 0o600);
    } catch (error) {
      this.#database.close();
      if (error instanceof AlertLedgerError) throw error;
      throw new AlertLedgerError('alert_schema_mismatch', 'Alert database schema is incompatible');
    }
  }

  claimAndRender(errors: ActiveSubsystemError[], renderer: BriefingRenderer): AlertClaim {
    const unique = normalizedErrors(errors);
    const now = this.#now();
    const expiresAt = now + this.#leaseMs;
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(expiresAt)) {
      throw new RangeError('alert clock or lease expiry is outside the safe integer range');
    }

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#releaseExpired(now);
      this.#synchronizeActive(unique, now);
      const claimable = this.#claimableErrors(unique, now);
      const claimId = claimable.length > 0 ? randomUUID() : undefined;
      if (claimId) this.#claim(claimId, claimable, expiresAt, now);

      const result = renderer(claimable);
      validateRenderedResult(result);
      const bound = claimId ? this.#validateAndReleaseOmitted(claimId, claimable, result, now) : false;
      this.#database.exec('COMMIT');
      return { ...(bound ? { claimId } : {}), result };
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  acknowledgePayloads(claim: AlertClaim, sentPayloadIndices: readonly number[]): number {
    if (!claim.claimId) return 0;
    const indices = new Set(sentPayloadIndices);
    for (const index of indices) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= claim.result.messages.length) {
        throw new RangeError('sent briefing payload index is invalid');
      }
    }
    const fingerprints = new Set(
      [...indices].flatMap(index => claim.result.messageErrorFingerprints[index] ?? []),
    );
    if (fingerprints.size === 0) return 0;

    const now = this.#now();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#releaseExpired(now);
      const acknowledge = this.#database.prepare(`
        UPDATE alert_fingerprints
        SET delivered = 1, claim_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE fingerprint = ? AND claim_id = ? AND active = 1 AND delivered = 0
      `);
      let count = 0;
      for (const fingerprint of fingerprints) {
        count += Number(acknowledge.run(timestamp(now), fingerprint, claim.claimId).changes);
      }
      this.#database.exec('COMMIT');
      return count;
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  list(): AlertState[] {
    const rows = this.#database.prepare(`
      SELECT fingerprint, error_code, target, active, delivered, claim_id, lease_expires_at
      FROM alert_fingerprints ORDER BY fingerprint
    `).all() as unknown as AlertRow[];
    return rows.map(row => ({
      fingerprint: row.fingerprint,
      errorCode: row.error_code,
      target: row.target,
      active: row.active === 1,
      delivered: row.delivered === 1,
      claimed: row.claim_id !== null && (row.lease_expires_at ?? 0) > this.#now(),
    }));
  }

  close(): void { this.#database.close(); }

  #releaseExpired(now: number): void {
    this.#database.prepare(`
      UPDATE alert_fingerprints
      SET claim_id = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE delivered = 0 AND claim_id IS NOT NULL AND lease_expires_at <= ?
    `).run(timestamp(now), now);
  }

  #synchronizeActive(unique: Map<string, ActiveSubsystemError>, now: number): void {
    const fingerprints = [...unique.keys()];
    if (fingerprints.length === 0) {
      this.#database.prepare(`
        UPDATE alert_fingerprints
        SET active = 0, claim_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE active = 1
      `).run(timestamp(now));
    } else {
      const placeholders = fingerprints.map(() => '?').join(', ');
      this.#database.prepare(`
        UPDATE alert_fingerprints
        SET active = 0, claim_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE active = 1 AND fingerprint NOT IN (${placeholders})
      `).run(timestamp(now), ...fingerprints);
    }

    const select = this.#database.prepare(`
      SELECT fingerprint, error_code, target, active, delivered, claim_id, lease_expires_at
      FROM alert_fingerprints WHERE fingerprint = ?
    `);
    const insert = this.#database.prepare(`
      INSERT INTO alert_fingerprints (
        fingerprint, error_code, target, active, delivered, claim_id, lease_expires_at, updated_at
      ) VALUES (?, ?, ?, 1, 0, NULL, NULL, ?)
    `);
    const updateActive = this.#database.prepare(`
      UPDATE alert_fingerprints SET error_code = ?, target = ?, active = 1, updated_at = ?
      WHERE fingerprint = ?
    `);
    const recover = this.#database.prepare(`
      UPDATE alert_fingerprints
      SET error_code = ?, target = ?, active = 1, delivered = 0,
        claim_id = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE fingerprint = ?
    `);
    for (const [fingerprint, error] of unique) {
      const row = select.get(fingerprint) as unknown as AlertRow | undefined;
      if (!row) insert.run(fingerprint, error.errorCode, error.target, timestamp(now));
      else if (row.active === 0) recover.run(error.errorCode, error.target, timestamp(now), fingerprint);
      else updateActive.run(error.errorCode, error.target, timestamp(now), fingerprint);
    }
  }

  #claimableErrors(unique: Map<string, ActiveSubsystemError>, now: number): ActiveSubsystemError[] {
    const select = this.#database.prepare(`
      SELECT fingerprint, error_code, target, active, delivered, claim_id, lease_expires_at
      FROM alert_fingerprints WHERE fingerprint = ?
    `);
    return [...unique.entries()]
      .filter(([fingerprint]) => {
        const row = select.get(fingerprint) as unknown as AlertRow;
        return row.active === 1 && row.delivered === 0
          && (row.claim_id === null || (row.lease_expires_at ?? 0) <= now);
      })
      .map(([, error]) => error)
      .sort((left, right) => left.errorCode.localeCompare(right.errorCode)
        || left.target.localeCompare(right.target));
  }

  #claim(claimId: string, errors: ActiveSubsystemError[], expiresAt: number, now: number): void {
    const claim = this.#database.prepare(`
      UPDATE alert_fingerprints
      SET claim_id = ?, lease_expires_at = ?, updated_at = ?
      WHERE fingerprint = ? AND active = 1 AND delivered = 0
        AND (claim_id IS NULL OR lease_expires_at <= ?)
    `);
    for (const error of errors) {
      const result = claim.run(claimId, expiresAt, timestamp(now), error.fingerprint!, now);
      if (result.changes !== 1) throw new Error('alert claim race');
    }
  }

  #validateAndReleaseOmitted(
    claimId: string,
    claimed: ActiveSubsystemError[],
    result: BriefingResult,
    now: number,
  ): boolean {
    const claimedFingerprints = new Set(claimed.map(error => error.fingerprint!));
    const included = new Set(result.includedErrorFingerprints);
    for (const fingerprint of included) {
      if (!claimedFingerprints.has(fingerprint)) throw new Error('renderer included an unclaimed fingerprint');
    }
    const occurrences = new Map<string, number>();
    for (const fingerprints of result.messageErrorFingerprints) {
      for (const fingerprint of fingerprints) {
        if (!included.has(fingerprint)) throw new Error('payload contains an unincluded fingerprint');
        occurrences.set(fingerprint, (occurrences.get(fingerprint) ?? 0) + 1);
      }
    }
    for (const fingerprint of included) {
      if (occurrences.get(fingerprint) !== 1) {
        throw new Error('renderer must bind each included fingerprint to exactly one payload');
      }
    }

    const release = this.#database.prepare(`
      UPDATE alert_fingerprints
      SET claim_id = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE fingerprint = ? AND claim_id = ?
    `);
    for (const fingerprint of claimedFingerprints) {
      if (!included.has(fingerprint)) release.run(timestamp(now), fingerprint, claimId);
    }
    return included.size > 0;
  }
}

export class BriefingService {
  constructor(private readonly alerts: AlertJournal) {}

  run(input: BriefingInput): AlertClaim {
    return this.alerts.claimAndRender(input.activeErrors, activeErrors => (
      buildBriefing({ ...input, activeErrors })
    ));
  }
}

function normalizedErrors(errors: ActiveSubsystemError[]): Map<string, ActiveSubsystemError> {
  const unique = new Map<string, ActiveSubsystemError>();
  for (const error of errors) {
    if (!error.errorCode || !error.target || !error.message) throw new TypeError('invalid active subsystem error');
    const fingerprint = alertFingerprint(error.errorCode, error.target);
    if (!unique.has(fingerprint)) unique.set(fingerprint, { ...error, fingerprint });
  }
  return unique;
}

function validateRenderedResult(result: BriefingResult): void {
  if (result.messages.length !== result.messageErrorFingerprints.length) {
    throw new Error('briefing message fingerprint mapping is incomplete');
  }
  if (!result.send && (result.messages.length > 0 || result.includedErrorFingerprints.length > 0)) {
    throw new Error('silent briefing cannot contain messages or fingerprints');
  }
}

function timestamp(now: number): string { return new Date(now).toISOString(); }

function ensureAlertSchema(database: DatabaseSync): void {
  const version = Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  const exists = schemaObject(database, 'table', 'alert_fingerprints') !== undefined;
  if (version === 0 && !exists) createAlertSchema(database);
  else if (version === 0 && exists) migrateLegacyAlertSchema(database);
  else if (version === 2) migrateV2AlertSchema(database);
  else if (version !== ALERT_SCHEMA_VERSION) {
    throw new AlertLedgerError('alert_schema_mismatch', `Unsupported alert schema version ${version}`);
  }
  validateCurrentAlertSchema(database);
}

function createAlertSchema(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
    ${ALERT_TABLE_SQL};
    ${ALERT_CLAIM_INDEX_SQL};
    PRAGMA user_version = ${ALERT_SCHEMA_VERSION};
    COMMIT;
  `);
}

function migrateLegacyAlertSchema(database: DatabaseSync): void {
  requireSchemaSql(database, 'table', 'alert_fingerprints', LEGACY_ALERT_TABLE_SQL);
  database.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE alert_fingerprints RENAME TO alert_fingerprints_legacy;
    ${ALERT_TABLE_SQL};
    INSERT INTO alert_fingerprints (
      fingerprint, error_code, target, active, delivered, claim_id, lease_expires_at, updated_at
    ) SELECT fingerprint, error_code, target, active, delivered, NULL, NULL, updated_at
      FROM alert_fingerprints_legacy;
    DROP TABLE alert_fingerprints_legacy;
    ${ALERT_CLAIM_INDEX_SQL};
    PRAGMA user_version = ${ALERT_SCHEMA_VERSION};
    COMMIT;
  `);
}

function migrateV2AlertSchema(database: DatabaseSync): void {
  requireSchemaSql(database, 'table', 'alert_fingerprints', ALERT_TABLE_SQL);
  requireSchemaSql(database, 'table', 'delivery_claims', V2_DELIVERY_CLAIMS_SQL);
  requireSchemaSql(database, 'table', 'delivery_claim_chunks', V2_DELIVERY_CHUNKS_SQL);
  requireSchemaSql(database, 'table', 'delivery_chunk_fingerprints', V2_DELIVERY_FINGERPRINTS_SQL);
  database.exec(`
    BEGIN IMMEDIATE;
    DROP TABLE delivery_chunk_fingerprints;
    DROP TABLE delivery_claim_chunks;
    DROP TABLE delivery_claims;
    ${ALERT_CLAIM_INDEX_SQL};
    PRAGMA user_version = ${ALERT_SCHEMA_VERSION};
    COMMIT;
  `);
}

function validateCurrentAlertSchema(database: DatabaseSync): void {
  requireSchemaSql(database, 'table', 'alert_fingerprints', ALERT_TABLE_SQL);
  requireSchemaSql(database, 'index', 'alert_claim_idx', ALERT_CLAIM_INDEX_SQL);
  const unexpected = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
      AND name NOT IN ('alert_fingerprints', 'alert_claim_idx')
  `).all();
  if (unexpected.length > 0) {
    throw new AlertLedgerError('alert_schema_mismatch', 'Alert database contains unexpected schema objects');
  }
  const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown };
  if (integrity.integrity_check !== 'ok') {
    throw new AlertLedgerError('alert_schema_mismatch', 'Alert database integrity check failed');
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
    throw new AlertLedgerError('alert_schema_mismatch', `Alert ${type} ${name} is incompatible`);
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
