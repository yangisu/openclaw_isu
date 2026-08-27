import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/;
const HASH = /^[0-9a-f]{64}$/;
const ETAG = /^"[^"\r\n]{1,1022}"$/;

export type GoogleMutationAction = 'create' | 'update' | 'delete';
export type GoogleMutationStatus = 'pending' | 'submitting' | 'succeeded' | 'failed' | 'unknown';

export interface MutationClaim {
  requestId: string;
  action: GoogleMutationAction;
  eventId: string;
  payloadHash: string;
  etag?: string;
}

export interface MutationOutcome {
  status: 'succeeded' | 'failed' | 'unknown';
  resultEtag?: string | null;
  errorCode?: string | null;
}

export interface MutationRecord {
  requestId: string;
  action: GoogleMutationAction;
  eventId: string;
  etag?: string;
  payloadHash: string;
  status: GoogleMutationStatus;
  attempts: number;
  resultEtag?: string;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export class GoogleCalendarLedgerError extends Error {
  constructor(public readonly code: 'invalid_claim' | 'idempotency_conflict' | 'invalid_transition', message: string) {
    super(message);
    this.name = 'GoogleCalendarLedgerError';
  }
}

export class GoogleCalendarLedger {
  readonly #database: DatabaseSync;
  readonly #now: () => number;

  constructor(path: string, options: { now?: () => number } = {}) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(path);
    if (process.platform !== 'win32') chmodSync(path, 0o600);
    this.#now = options.now ?? Date.now;
    this.#database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS google_calendar_mutations (
        request_id TEXT PRIMARY KEY CHECK(length(request_id) = 36),
        action TEXT NOT NULL CHECK(action IN ('create', 'update', 'delete')),
        event_id TEXT NOT NULL CHECK(length(event_id) BETWEEN 1 AND 1024),
        etag TEXT,
        payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
        status TEXT NOT NULL CHECK(status IN ('pending', 'submitting', 'succeeded', 'failed', 'unknown')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        result_etag TEXT,
        error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 128),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS google_calendar_mutations_status_idx
        ON google_calendar_mutations (status, updated_at);
    `);
  }

  claim(input: MutationClaim): MutationRecord {
    validateClaim(input);
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.#select(input.requestId);
      if (existing) {
        if (existing.action !== input.action || existing.eventId !== input.eventId
          || existing.payloadHash !== input.payloadHash || (existing.etag ?? undefined) !== input.etag) {
          throw new GoogleCalendarLedgerError('idempotency_conflict', 'Calendar idempotency conflict');
        }
        this.#database.exec('COMMIT');
        return existing;
      }
      const now = new Date(this.#now()).toISOString();
      this.#database.prepare(`
        INSERT INTO google_calendar_mutations
          (request_id, action, event_id, etag, payload_hash, status, attempts, result_etag, error_code, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)
      `).run(input.requestId, input.action, input.eventId, input.etag ?? null, input.payloadHash, now, now);
      const inserted = this.#select(input.requestId);
      this.#database.exec('COMMIT');
      if (!inserted) throw new Error('ledger insert failed');
      return inserted;
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  markSubmitting(requestId: string): MutationRecord {
    validateRequestId(requestId);
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.#select(requestId);
      if (!current) throw new GoogleCalendarLedgerError('invalid_transition', 'Calendar mutation is missing');
      if (['succeeded', 'failed', 'unknown'].includes(current.status)) {
        throw new GoogleCalendarLedgerError('invalid_transition', 'Calendar mutation is terminal');
      }
      const changed = this.#database.prepare(`
        UPDATE google_calendar_mutations
        SET status = 'submitting', attempts = attempts + 1, updated_at = ?
        WHERE request_id = ? AND status IN ('pending', 'submitting')
      `).run(new Date(this.#now()).toISOString(), requestId).changes;
      if (changed !== 1) throw new GoogleCalendarLedgerError('invalid_transition', 'Calendar mutation transition failed');
      const updated = this.#select(requestId);
      this.#database.exec('COMMIT');
      if (!updated) throw new Error('ledger update failed');
      return updated;
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  finish(requestId: string, outcome: MutationOutcome): MutationRecord {
    validateRequestId(requestId);
    validateOutcome(outcome);
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.#select(requestId);
      if (!current || current.status !== 'submitting') {
        throw new GoogleCalendarLedgerError('invalid_transition', 'Calendar mutation is not submitting');
      }
      const changed = this.#database.prepare(`
        UPDATE google_calendar_mutations
        SET status = ?, result_etag = ?, error_code = ?, updated_at = ?
        WHERE request_id = ? AND status = 'submitting'
      `).run(
        outcome.status,
        outcome.resultEtag ?? null,
        outcome.errorCode ?? null,
        new Date(this.#now()).toISOString(),
        requestId,
      ).changes;
      if (changed !== 1) throw new GoogleCalendarLedgerError('invalid_transition', 'Calendar mutation transition failed');
      const updated = this.#select(requestId);
      this.#database.exec('COMMIT');
      if (!updated) throw new Error('ledger update failed');
      return updated;
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  get(requestId: string): MutationRecord | undefined {
    validateRequestId(requestId);
    return this.#select(requestId);
  }

  close(): void {
    this.#database.close();
  }

  #select(requestId: string): MutationRecord | undefined {
    const row = this.#database.prepare(`
      SELECT request_id, action, event_id, etag, payload_hash, status, attempts,
             result_etag, error_code, created_at, updated_at
      FROM google_calendar_mutations WHERE request_id = ?
    `).get(requestId) as LedgerRow | undefined;
    return row ? mapRow(row) : undefined;
  }
}

interface LedgerRow {
  request_id: string;
  action: GoogleMutationAction;
  event_id: string;
  etag: string | null;
  payload_hash: string;
  status: GoogleMutationStatus;
  attempts: number;
  result_etag: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: LedgerRow): MutationRecord {
  return {
    requestId: row.request_id,
    action: row.action,
    eventId: row.event_id,
    ...(row.etag === null ? {} : { etag: row.etag }),
    payloadHash: row.payload_hash,
    status: row.status,
    attempts: row.attempts,
    ...(row.result_etag === null ? {} : { resultEtag: row.result_etag }),
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateClaim(input: MutationClaim): void {
  if (!UUID.test(input.requestId) || !['create', 'update', 'delete'].includes(input.action)
    || !EVENT_ID.test(input.eventId) || !HASH.test(input.payloadHash)
    || (input.etag !== undefined && !ETAG.test(input.etag))) {
    throw new GoogleCalendarLedgerError('invalid_claim', 'Calendar mutation claim is invalid');
  }
}

function validateRequestId(requestId: string): void {
  if (!UUID.test(requestId)) throw new GoogleCalendarLedgerError('invalid_claim', 'Calendar request ID is invalid');
}

function validateOutcome(outcome: MutationOutcome): void {
  if (!['succeeded', 'failed', 'unknown'].includes(outcome.status)
    || (outcome.resultEtag !== undefined && outcome.resultEtag !== null && !ETAG.test(outcome.resultEtag))
    || (outcome.errorCode !== undefined && outcome.errorCode !== null
      && (!/^[a-z0-9_]{1,128}$/.test(outcome.errorCode)))) {
    throw new GoogleCalendarLedgerError('invalid_transition', 'Calendar mutation outcome is invalid');
  }
}
