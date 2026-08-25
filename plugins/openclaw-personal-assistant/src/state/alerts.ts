/// <reference types="node" />

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  alertFingerprint, buildBriefing,
  type ActiveSubsystemError, type BriefingInput, type BriefingResult,
} from '../briefing/build.js';

const ALERT_SCHEMA_VERSION = 2;
const DEFAULT_LEASE_MS = 10 * 60_000;

interface AlertRow {
  fingerprint: string;
  error_code: string;
  target: string;
  active: number;
  delivered: number;
  claim_id: string | null;
  lease_expires_at: number | null;
}

interface ChunkRow { claim_id: string; chunk_index: number }

export interface AlertState {
  fingerprint: string;
  errorCode: string;
  target: string;
  active: boolean;
  delivered: boolean;
  claimed: boolean;
}

export interface BriefingDeliveryBinding {
  sessionKey: string;
  channelId: string;
  target: string;
}

export interface SentBriefingMessage extends BriefingDeliveryBinding {
  content: string;
  success: boolean;
}

export type BriefingRenderer = (errors: ActiveSubsystemError[]) => BriefingResult;

export interface AlertJournal {
  claimAndRender(errors: ActiveSubsystemError[], delivery: BriefingDeliveryBinding, renderer: BriefingRenderer): BriefingResult;
  acknowledgeMessage(message: SentBriefingMessage): boolean;
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
      this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
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

  claimAndRender(
    errors: ActiveSubsystemError[],
    delivery: BriefingDeliveryBinding,
    renderer: BriefingRenderer,
  ): BriefingResult {
    validateDelivery(delivery);
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
      if (claimId) {
        const claim = this.#database.prepare(`
          UPDATE alert_fingerprints
          SET claim_id = ?, lease_expires_at = ?, updated_at = ?
          WHERE fingerprint = ? AND active = 1 AND delivered = 0
            AND (claim_id IS NULL OR lease_expires_at <= ?)
        `);
        for (const error of claimable) {
          const result = claim.run(claimId, expiresAt, timestamp(now), error.fingerprint!, now);
          if (result.changes !== 1) throw new Error('alert claim race');
        }
      }

      const result = renderer(claimable);
      validateRenderedResult(result);
      if (claimId) this.#bindClaim(claimId, expiresAt, delivery, claimable, result, now);
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  acknowledgeMessage(message: SentBriefingMessage): boolean {
    validateDelivery(message);
    if (!message.content) return false;
    const now = this.#now();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#releaseExpired(now);
      const chunk = this.#database.prepare(`
        SELECT c.claim_id, c.chunk_index
        FROM delivery_claim_chunks c
        JOIN delivery_claims d ON d.claim_id = c.claim_id
        WHERE d.session_key = ? AND d.channel_id = ? AND d.target = ?
          AND d.expires_at > ? AND c.acknowledged = 0
          AND c.content_hash = ? AND c.content = ?
        ORDER BY d.expires_at, c.chunk_index LIMIT 1
      `).get(
        message.sessionKey, message.channelId, message.target, now,
        contentHash(message.content), message.content,
      ) as unknown as ChunkRow | undefined;
      if (!chunk) {
        this.#database.exec('COMMIT');
        return false;
      }

      const fingerprints = this.#database.prepare(`
        SELECT fingerprint FROM delivery_chunk_fingerprints
        WHERE claim_id = ? AND chunk_index = ? ORDER BY fingerprint
      `).all(chunk.claim_id, chunk.chunk_index) as unknown as Array<{ fingerprint: string }>;
      if (message.success) {
        this.#database.prepare(`
          UPDATE delivery_claim_chunks SET acknowledged = 1
          WHERE claim_id = ? AND chunk_index = ? AND acknowledged = 0
        `).run(chunk.claim_id, chunk.chunk_index);
        const acknowledge = this.#database.prepare(`
          UPDATE alert_fingerprints
          SET delivered = 1, claim_id = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE fingerprint = ? AND claim_id = ? AND active = 1
        `);
        for (const row of fingerprints) acknowledge.run(timestamp(now), row.fingerprint, chunk.claim_id);
      } else {
        const release = this.#database.prepare(`
          UPDATE alert_fingerprints
          SET claim_id = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE fingerprint = ? AND claim_id = ? AND delivered = 0
        `);
        for (const row of fingerprints) release.run(timestamp(now), row.fingerprint, chunk.claim_id);
        this.#database.prepare(
          'DELETE FROM delivery_claim_chunks WHERE claim_id = ? AND chunk_index = ?',
        ).run(chunk.claim_id, chunk.chunk_index);
      }
      this.#deleteCompletedClaim(chunk.claim_id);
      this.#database.exec('COMMIT');
      return true;
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
    this.#database.prepare('DELETE FROM delivery_claims WHERE expires_at <= ?').run(now);
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

  #bindClaim(
    claimId: string,
    expiresAt: number,
    delivery: BriefingDeliveryBinding,
    claimed: ActiveSubsystemError[],
    result: BriefingResult,
    now: number,
  ): void {
    const claimedFingerprints = new Set(claimed.map(error => error.fingerprint!));
    const included = new Set(result.includedErrorFingerprints);
    const release = this.#database.prepare(`
      UPDATE alert_fingerprints
      SET claim_id = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE fingerprint = ? AND claim_id = ?
    `);
    for (const fingerprint of claimedFingerprints) {
      if (!included.has(fingerprint)) release.run(timestamp(now), fingerprint, claimId);
    }
    if (included.size === 0) return;
    for (const fingerprint of included) {
      if (!claimedFingerprints.has(fingerprint)) throw new Error('renderer included an unclaimed fingerprint');
    }

    this.#database.prepare(`
      INSERT INTO delivery_claims (claim_id, session_key, channel_id, target, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(claimId, delivery.sessionKey, delivery.channelId, delivery.target, expiresAt);
    const insertChunk = this.#database.prepare(`
      INSERT INTO delivery_claim_chunks (
        claim_id, chunk_index, content_hash, content, acknowledged
      ) VALUES (?, ?, ?, ?, 0)
    `);
    const insertFingerprint = this.#database.prepare(`
      INSERT INTO delivery_chunk_fingerprints (claim_id, chunk_index, fingerprint)
      VALUES (?, ?, ?)
    `);
    for (let index = 0; index < result.messages.length; index += 1) {
      const fingerprints = result.messageErrorFingerprints[index] ?? [];
      if (fingerprints.length === 0) continue;
      const content = result.messages[index]!;
      insertChunk.run(claimId, index, contentHash(content), content);
      for (const fingerprint of fingerprints) {
        if (!included.has(fingerprint)) throw new Error('chunk contains an unincluded fingerprint');
        insertFingerprint.run(claimId, index, fingerprint);
      }
    }
    const covered = new Set(result.messageErrorFingerprints.flat());
    if ([...included].some(fingerprint => !covered.has(fingerprint))) {
      throw new Error('renderer did not bind every included fingerprint to an outbound chunk');
    }
  }

  #deleteCompletedClaim(claimId: string): void {
    const remaining = this.#database.prepare(`
      SELECT count(*) AS count FROM delivery_claim_chunks
      WHERE claim_id = ? AND acknowledged = 0
    `).get(claimId) as { count: number };
    if (remaining.count === 0) this.#database.prepare('DELETE FROM delivery_claims WHERE claim_id = ?').run(claimId);
  }
}

export class BriefingService {
  constructor(private readonly alerts: AlertJournal) {}

  async run(input: BriefingInput, delivery: BriefingDeliveryBinding): Promise<BriefingResult> {
    return this.alerts.claimAndRender(input.activeErrors, delivery, activeErrors => (
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

function validateDelivery(delivery: BriefingDeliveryBinding): void {
  if (!delivery.sessionKey || !delivery.channelId || !delivery.target) {
    throw new TypeError('briefing delivery session, channel, and target are required');
  }
}

function validateRenderedResult(result: BriefingResult): void {
  if (result.messages.length !== result.messageErrorFingerprints.length) {
    throw new Error('briefing message fingerprint mapping is incomplete');
  }
  if (!result.send && (result.messages.length > 0 || result.includedErrorFingerprints.length > 0)) {
    throw new Error('silent briefing cannot contain messages or fingerprints');
  }
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function timestamp(now: number): string { return new Date(now).toISOString(); }

function ensureAlertSchema(database: DatabaseSync): void {
  const version = Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  const exists = tableExists(database, 'alert_fingerprints');
  if (version === 0 && !exists) createAlertSchema(database);
  else if (version === 0 && exists) migrateLegacyAlertSchema(database);
  else if (version !== ALERT_SCHEMA_VERSION) {
    throw new AlertLedgerError('alert_schema_mismatch', `Unsupported alert schema version ${version}`);
  }
  validateAlertSchema(database);
}

function createAlertSchema(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE alert_fingerprints (
      fingerprint TEXT PRIMARY KEY CHECK(length(fingerprint) = 64),
      error_code TEXT NOT NULL CHECK(length(error_code) > 0),
      target TEXT NOT NULL CHECK(length(target) > 0),
      active INTEGER NOT NULL CHECK(active IN (0, 1)),
      delivered INTEGER NOT NULL CHECK(delivered IN (0, 1)),
      claim_id TEXT,
      lease_expires_at INTEGER,
      updated_at TEXT NOT NULL
    ) STRICT;
    ${deliverySchemaSql()}
    PRAGMA user_version = ${ALERT_SCHEMA_VERSION};
    COMMIT;
  `);
}

function migrateLegacyAlertSchema(database: DatabaseSync): void {
  const expectedLegacy = [
    ['fingerprint', 'TEXT', 1, 1], ['error_code', 'TEXT', 1, 0],
    ['target', 'TEXT', 1, 0], ['active', 'INTEGER', 1, 0],
    ['delivered', 'INTEGER', 1, 0], ['updated_at', 'TEXT', 1, 0],
  ];
  if (JSON.stringify(tableShape(database, 'alert_fingerprints')) !== JSON.stringify(expectedLegacy)) {
    throw new AlertLedgerError('alert_schema_mismatch', 'Legacy alert table shape is incompatible');
  }
  database.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE alert_fingerprints RENAME TO alert_fingerprints_legacy;
    CREATE TABLE alert_fingerprints (
      fingerprint TEXT PRIMARY KEY CHECK(length(fingerprint) = 64),
      error_code TEXT NOT NULL CHECK(length(error_code) > 0),
      target TEXT NOT NULL CHECK(length(target) > 0),
      active INTEGER NOT NULL CHECK(active IN (0, 1)),
      delivered INTEGER NOT NULL CHECK(delivered IN (0, 1)),
      claim_id TEXT,
      lease_expires_at INTEGER,
      updated_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO alert_fingerprints (
      fingerprint, error_code, target, active, delivered, claim_id, lease_expires_at, updated_at
    ) SELECT fingerprint, error_code, target, active, delivered, NULL, NULL, updated_at
      FROM alert_fingerprints_legacy;
    DROP TABLE alert_fingerprints_legacy;
    ${deliverySchemaSql()}
    PRAGMA user_version = ${ALERT_SCHEMA_VERSION};
    COMMIT;
  `);
}

function deliverySchemaSql(): string {
  return `
    CREATE TABLE delivery_claims (
      claim_id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      target TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE delivery_claim_chunks (
      claim_id TEXT NOT NULL REFERENCES delivery_claims(claim_id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
      content TEXT NOT NULL,
      acknowledged INTEGER NOT NULL CHECK(acknowledged IN (0, 1)),
      PRIMARY KEY (claim_id, chunk_index)
    ) STRICT;
    CREATE TABLE delivery_chunk_fingerprints (
      claim_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      fingerprint TEXT NOT NULL REFERENCES alert_fingerprints(fingerprint) ON DELETE CASCADE,
      PRIMARY KEY (claim_id, chunk_index, fingerprint),
      FOREIGN KEY (claim_id, chunk_index)
        REFERENCES delivery_claim_chunks(claim_id, chunk_index) ON DELETE CASCADE
    ) STRICT;
  `;
}

function validateAlertSchema(database: DatabaseSync): void {
  const expected = new Map<string, unknown>([
    ['alert_fingerprints', [
      ['fingerprint', 'TEXT', 1, 1], ['error_code', 'TEXT', 1, 0],
      ['target', 'TEXT', 1, 0], ['active', 'INTEGER', 1, 0],
      ['delivered', 'INTEGER', 1, 0], ['claim_id', 'TEXT', 0, 0],
      ['lease_expires_at', 'INTEGER', 0, 0], ['updated_at', 'TEXT', 1, 0],
    ]],
    ['delivery_claims', [
      ['claim_id', 'TEXT', 1, 1], ['session_key', 'TEXT', 1, 0],
      ['channel_id', 'TEXT', 1, 0], ['target', 'TEXT', 1, 0],
      ['expires_at', 'INTEGER', 1, 0],
    ]],
    ['delivery_claim_chunks', [
      ['claim_id', 'TEXT', 1, 1], ['chunk_index', 'INTEGER', 1, 2],
      ['content_hash', 'TEXT', 1, 0], ['content', 'TEXT', 1, 0],
      ['acknowledged', 'INTEGER', 1, 0],
    ]],
    ['delivery_chunk_fingerprints', [
      ['claim_id', 'TEXT', 1, 1], ['chunk_index', 'INTEGER', 1, 2],
      ['fingerprint', 'TEXT', 1, 3],
    ]],
  ]);
  for (const [table, shape] of expected) {
    if (JSON.stringify(tableShape(database, table)) !== JSON.stringify(shape)) {
      throw new AlertLedgerError('alert_schema_mismatch', `Alert table ${table} is incompatible`);
    }
  }
}

function tableShape(database: DatabaseSync, table: string): unknown[] {
  const safe = ['alert_fingerprints', 'delivery_claims', 'delivery_claim_chunks', 'delivery_chunk_fingerprints'];
  if (!safe.includes(table)) throw new TypeError('unknown alert table');
  return (database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
    name: string; type: string; notnull: number; pk: number;
  }>).map(column => [column.name, column.type, column.notnull, column.pk]);
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}
