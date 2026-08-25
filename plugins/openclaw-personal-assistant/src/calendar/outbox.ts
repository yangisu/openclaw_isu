/// <reference types="node" />

import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseIcal, semanticEventHash, type CalendarEvent } from './ical.js';
import type { CreateScheduleRequest } from './naver-api.js';

export type CalendarRequestStatus =
  | 'draft'
  | 'confirmed'
  | 'submitting'
  | 'pending_reconcile'
  | 'succeeded'
  | 'failed';

export interface CalendarRequest {
  requestId: string;
  version: number;
  status: CalendarRequestStatus;
  uid: string;
  calendarId: string;
  payloadIcal: string;
  payloadHash: string;
  confirmedBy?: string;
  confirmedAt?: string;
  confirmationExpiresAt?: string;
  confirmationConsumedAt?: string;
  attemptCount: number;
  lastAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
  httpStatus?: number;
  processType?: 'create' | 'modify';
  returnedIcalUid?: string;
  errorCode?: string;
}

export interface PrepareCalendarRequest {
  calendarId: string;
  uid: string;
  payloadIcal: string;
  payloadHash: string;
  requestId?: string;
}

export interface CalendarOutboxWarning {
  requestId: string;
  reason: 'reconcile_unavailable' | 'reconcile_not_found' | 'confirmation_required';
}

export interface BackupManifestEvidence {
  manifestId: string;
  includedRequestIds: readonly string[];
}

export interface CalendarOutboxAuditEntry {
  requestId: string;
  payloadHash: string;
  completedAt: string;
  deletedAt: string;
  backupManifestId: string;
}

interface CalendarApiLike {
  createSchedule(request: CreateScheduleRequest): Promise<{
    processType: 'create' | 'modify';
    calendarId: string;
    icalUid: string;
  }>;
}

interface CalDavLike {
  listEvents(range: { start: string | Date; end: string | Date }): Promise<CalendarEvent[]>;
}

export interface CalendarOutboxOptions {
  stateDir: string;
  api: CalendarApiLike;
  caldav: CalDavLike;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  requestId?: () => string;
  warn?: (warning: CalendarOutboxWarning) => void | Promise<void>;
  /** Fault-injection/lifecycle checkpoint. It must not perform external I/O. */
  checkpoint?: (phase: 'afterAcquire' | 'beforeAttempt') => void;
  submittingStaleAfterMs?: number;
}

export class CalendarOutboxError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CalendarOutboxError';
  }
}

interface CalendarRequestRow {
  request_id: string;
  version: number | bigint;
  status: CalendarRequestStatus;
  uid: string;
  calendar_id: string;
  payload_ical: string;
  payload_hash: string;
  confirmed_by: number | bigint | null;
  confirmed_at: string | null;
  confirmation_expires_at: string | null;
  confirmation_consumed_at: string | null;
  attempt_count: number | bigint;
  last_attempt_at: string | null;
  created_at: string;
  updated_at: string;
  http_status: number | bigint | null;
  process_type: 'create' | 'modify' | null;
  returned_ical_uid: string | null;
  error_code: string | null;
}

interface AuditRow {
  request_id: string;
  payload_hash: string;
  completed_at: string;
  deleted_at: string;
  backup_manifest_id: string;
}

const CONFIRMATION_LIFETIME_MS = 10 * 60 * 1_000;
const DEFAULT_STALE_AFTER_MS = 15_000;
const SUCCEEDED_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const RETRY_DELAYS_MS = [100, 200] as const;
const MAX_SQLITE_INTEGER = 9_223_372_036_854_775_807n;
const REQUEST_COLUMNS = `
  request_id, version, status, uid, calendar_id, payload_ical, payload_hash,
  confirmed_by, confirmed_at, confirmation_expires_at, confirmation_consumed_at,
  attempt_count, last_attempt_at, created_at, updated_at, http_status,
  process_type, returned_ical_uid, error_code
`;

// Keep this in lock-step with outbox-schema.sql. It is embedded so compiled output
// remains self-contained when package assets are not copied beside dist/*.js.
const OUTBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS calendar_requests (
  request_id TEXT PRIMARY KEY
    CHECK (
      length(request_id) = 36
      AND substr(request_id, 9, 1) = '-'
      AND substr(request_id, 14, 1) = '-'
      AND substr(request_id, 19, 1) = '-'
      AND substr(request_id, 24, 1) = '-'
      AND length(replace(request_id, '-', '')) = 32
      AND lower(request_id) = request_id
      AND replace(request_id, '-', '') NOT GLOB '*[^0-9a-f]*'
    ),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  status TEXT NOT NULL
    CHECK (status IN ('draft','confirmed','submitting','pending_reconcile','succeeded','failed')),
  uid TEXT NOT NULL CHECK (length(uid) > 0),
  calendar_id TEXT NOT NULL CHECK (length(calendar_id) > 0),
  payload_ical TEXT NOT NULL CHECK (length(payload_ical) > 0),
  payload_hash TEXT NOT NULL
    CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  confirmed_by INTEGER CHECK (confirmed_by > 0),
  confirmed_at TEXT CHECK (
    confirmed_at IS NULL OR
    (length(confirmed_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', confirmed_at) = confirmed_at)
  ),
  confirmation_expires_at TEXT CHECK (
    confirmation_expires_at IS NULL OR
    (length(confirmation_expires_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', confirmation_expires_at) = confirmation_expires_at)
  ),
  confirmation_consumed_at TEXT CHECK (
    confirmation_consumed_at IS NULL OR
    (length(confirmation_consumed_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', confirmation_consumed_at) = confirmation_consumed_at)
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  last_attempt_at TEXT CHECK (
    last_attempt_at IS NULL OR
    (length(last_attempt_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', last_attempt_at) = last_attempt_at)
  ),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', created_at) = created_at),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', updated_at) = updated_at),
  http_status INTEGER CHECK (http_status BETWEEN 100 AND 599),
  process_type TEXT CHECK (process_type IN ('create','modify')),
  returned_ical_uid TEXT CHECK (returned_ical_uid IS NULL OR length(returned_ical_uid) > 0),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) > 0),
  CHECK (
    (status = 'draft' AND confirmed_by IS NULL AND confirmed_at IS NULL
      AND confirmation_expires_at IS NULL AND confirmation_consumed_at IS NULL)
    OR
    (status = 'confirmed' AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL
      AND confirmation_expires_at IS NOT NULL AND confirmation_consumed_at IS NULL)
    OR
    (status IN ('submitting','pending_reconcile','succeeded','failed')
      AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL
      AND confirmation_expires_at IS NOT NULL AND confirmation_consumed_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX IF NOT EXISTS calendar_requests_status_updated_idx
  ON calendar_requests (status, updated_at, request_id);

CREATE TABLE IF NOT EXISTS calendar_reconcile_warnings (
  request_id TEXT NOT NULL,
  warning_kind TEXT NOT NULL CHECK (warning_kind IN ('pending','confirmation_required')),
  warned_at TEXT NOT NULL
    CHECK (length(warned_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', warned_at) = warned_at),
  PRIMARY KEY (request_id, warning_kind),
  FOREIGN KEY (request_id) REFERENCES calendar_requests(request_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS calendar_outbox_audit (
  request_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL
    CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  completed_at TEXT NOT NULL
    CHECK (length(completed_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', completed_at) = completed_at),
  deleted_at TEXT NOT NULL
    CHECK (length(deleted_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', deleted_at) = deleted_at),
  backup_manifest_id TEXT NOT NULL CHECK (length(backup_manifest_id) > 0)
) STRICT;
`;

export class CalendarOutbox {
  readonly #database: DatabaseSync;
  readonly #databasePath: string;
  readonly #api: CalendarApiLike;
  readonly #caldav: CalDavLike;
  readonly #now: () => Date;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #requestId: () => string;
  readonly #warn?: (warning: CalendarOutboxWarning) => void | Promise<void>;
  readonly #checkpoint?: (phase: 'afterAcquire' | 'beforeAttempt') => void;
  readonly #submittingStaleAfterMs: number;
  #closed = false;

  constructor(options: CalendarOutboxOptions) {
    if (!options.stateDir) throw new CalendarOutboxError('invalid_state_dir', 'Outbox state directory is required');
    if (!Number.isSafeInteger(options.submittingStaleAfterMs ?? DEFAULT_STALE_AFTER_MS) ||
        (options.submittingStaleAfterMs ?? DEFAULT_STALE_AFTER_MS) <= 0) {
      throw new CalendarOutboxError('invalid_stale_timeout', 'Submitting stale timeout must be a positive integer');
    }
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(options.stateDir, 0o700);
    this.#databasePath = join(options.stateDir, 'calendar-outbox.sqlite3');
    this.#database = new DatabaseSync(this.#databasePath, { readBigInts: true });
    this.#database.exec('PRAGMA busy_timeout = 10000;');
    this.#database.exec('PRAGMA foreign_keys = ON;');
    this.#database.exec('PRAGMA journal_mode = WAL;');
    this.#database.exec(OUTBOX_SCHEMA);
    this.#secureDatabaseFiles();
    this.#api = options.api;
    this.#caldav = options.caldav;
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.#requestId = options.requestId ?? randomUUID;
    this.#warn = options.warn;
    this.#checkpoint = options.checkpoint;
    this.#submittingStaleAfterMs = options.submittingStaleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  }

  prepare(input: PrepareCalendarRequest): CalendarRequest {
    this.#assertOpen();
    const requestId = input.requestId ?? this.#requestId();
    validateUuid(requestId);
    validatePayload(input);
    const now = this.#timestamp();
    try {
      this.#database.prepare(`
        INSERT INTO calendar_requests (
          request_id, version, status, uid, calendar_id, payload_ical, payload_hash,
          confirmed_by, confirmed_at, confirmation_expires_at, confirmation_consumed_at,
          attempt_count, last_attempt_at, created_at, updated_at,
          http_status, process_type, returned_ical_uid, error_code
        ) VALUES (?, 0, 'draft', ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, NULL, ?, ?, NULL, NULL, NULL, NULL)
      `).run(requestId, input.uid, input.calendarId, input.payloadIcal, input.payloadHash, now, now);
    } catch (error) {
      if (this.get(requestId)) {
        throw new CalendarOutboxError('request_id_conflict', `Calendar request ${requestId} already exists`);
      }
      throw error;
    }
    this.#secureDatabaseFiles();
    return this.#require(requestId);
  }

  confirm(requestId: string, senderId: string, payloadHash: string): CalendarRequest {
    this.#assertOpen();
    const numericSender = validateSenderId(senderId);
    return this.#transaction(() => {
      const current = this.#require(requestId);
      if (current.payloadHash !== payloadHash) {
        throw new CalendarOutboxError('payload_changed', 'Calendar payload changed after it was presented');
      }
      const nowDate = this.#nowDate();
      const now = formatTimestamp(nowDate);
      if (current.status === 'confirmed' && current.confirmationConsumedAt === undefined &&
          Date.parse(current.confirmationExpiresAt!) > nowDate.valueOf()) {
        if (current.confirmedBy !== senderId) {
          throw new CalendarOutboxError('confirmation_owner_mismatch', 'Confirmation belongs to another sender');
        }
        return current;
      }
      if (current.status !== 'draft' && current.status !== 'failed' && current.status !== 'confirmed') {
        throw new CalendarOutboxError('confirmation_consumed', 'Calendar confirmation was already consumed');
      }
      if (current.status === 'confirmed' && current.confirmationConsumedAt !== undefined) {
        throw new CalendarOutboxError('confirmation_consumed', 'Calendar confirmation was already consumed');
      }
      const expiresAt = formatTimestamp(new Date(nowDate.valueOf() + CONFIRMATION_LIFETIME_MS));
      const result = this.#database.prepare(`
        UPDATE calendar_requests
        SET status = 'confirmed', confirmed_by = ?, confirmed_at = ?, confirmation_expires_at = ?,
            confirmation_consumed_at = NULL, attempt_count = 0, last_attempt_at = NULL,
            http_status = NULL, process_type = NULL, returned_ical_uid = NULL, error_code = NULL,
            updated_at = ?, version = version + 1
        WHERE request_id = ? AND version = ? AND status = ?
      `).run(numericSender, now, expiresAt, now, current.requestId, current.version, current.status);
      assertOneChange(result.changes, current.requestId);
      return this.#require(current.requestId);
    });
  }

  async confirmAndSubmit(requestId: string, senderId: string, payloadHash: string): Promise<CalendarRequest> {
    this.confirm(requestId, senderId, payloadHash);
    return this.submit(requestId, senderId);
  }

  async submit(requestId: string, senderId: string): Promise<CalendarRequest> {
    this.#assertOpen();
    validateSenderId(senderId);
    let current = this.#acquireSubmission(requestId, senderId);
    this.#checkpoint?.('afterAcquire');

    while (current.attemptCount < 3) {
      this.#checkpoint?.('beforeAttempt');
      current = this.#beginAttempt(current);
      let response: { processType: 'create' | 'modify'; calendarId: string; icalUid: string };
      try {
        response = await this.#api.createSchedule({
          calendarId: current.calendarId,
          scheduleIcalString: current.payloadIcal,
        });
      } catch (error) {
        const code = errorCode(error);
        if (code === 'request_pre_send') {
          if (current.attemptCount < 3) {
            await this.#sleep(RETRY_DELAYS_MS[current.attemptCount - 1]);
            continue;
          }
          return this.#finish(current, 'failed', { errorCode: code });
        }
        if (isProvenNoCreate(code)) return this.#finish(current, 'failed', { errorCode: code });
        return this.#finish(current, 'pending_reconcile', { errorCode: code });
      }

      if (response.processType !== 'create' || response.calendarId !== current.calendarId ||
          response.icalUid !== current.uid) {
        return this.#finish(current, 'pending_reconcile', {
          httpStatus: 200,
          processType: response.processType,
          returnedIcalUid: response.icalUid,
          errorCode: response.processType === 'modify' ? 'request_maybe_sent' : 'response_identity_mismatch',
        });
      }
      return this.#finish(current, 'succeeded', {
        httpStatus: 200,
        processType: response.processType,
        returnedIcalUid: response.icalUid,
      });
    }
    return this.#finish(current, 'failed', { errorCode: 'request_pre_send' });
  }

  recover(): CalendarRequest[] {
    this.#assertOpen();
    const now = this.#nowDate().valueOf();
    const candidates = this.#database.prepare(`
      SELECT ${REQUEST_COLUMNS} FROM calendar_requests
      WHERE status = 'submitting'
      ORDER BY created_at, request_id
    `).all() as unknown as CalendarRequestRow[];
    const recovered: CalendarRequest[] = [];
    for (const row of candidates) {
      const current = mapRequest(row);
      if (now - Date.parse(current.updatedAt) <= this.#submittingStaleAfterMs) continue;
      recovered.push(this.#finish(current, 'pending_reconcile', { errorCode: 'stale_submitting' }));
    }
    return recovered;
  }

  async reconcile(requestId?: string): Promise<CalendarRequest[]> {
    this.#assertOpen();
    const rows = requestId === undefined
      ? this.#database.prepare(`
          SELECT ${REQUEST_COLUMNS} FROM calendar_requests
          WHERE status = 'pending_reconcile' ORDER BY created_at, request_id
        `).all() as unknown as CalendarRequestRow[]
      : this.#database.prepare(`
          SELECT ${REQUEST_COLUMNS} FROM calendar_requests
          WHERE request_id = ? AND status = 'pending_reconcile'
        `).all(requestId) as unknown as CalendarRequestRow[];
    if (requestId !== undefined && rows.length === 0) {
      const existing = this.get(requestId);
      if (!existing) throw new CalendarOutboxError('request_not_found', `Calendar request ${requestId} does not exist`);
      throw new CalendarOutboxError('invalid_status', `Calendar request ${requestId} is not pending reconciliation`);
    }

    const reconciled: CalendarRequest[] = [];
    for (const row of rows) reconciled.push(await this.#reconcileOne(mapRequest(row)));
    return reconciled;
  }

  pruneSucceeded(evidence: BackupManifestEvidence): string[] {
    this.#assertOpen();
    if (!evidence.manifestId) {
      throw new CalendarOutboxError('invalid_backup_evidence', 'Backup manifest ID is required');
    }
    const included = new Set(evidence.includedRequestIds);
    const nowDate = this.#nowDate();
    const now = formatTimestamp(nowDate);
    const cutoff = formatTimestamp(new Date(nowDate.valueOf() - SUCCEEDED_RETENTION_MS));
    const candidates = this.#database.prepare(`
      SELECT ${REQUEST_COLUMNS} FROM calendar_requests
      WHERE status = 'succeeded' AND updated_at < ?
      ORDER BY updated_at, request_id
    `).all(cutoff) as unknown as CalendarRequestRow[];
    const deleted: string[] = [];
    for (const row of candidates) {
      const current = mapRequest(row);
      if (!included.has(current.requestId)) continue;
      this.#transaction(() => {
        const versioned = this.#database.prepare(`
          UPDATE calendar_requests SET version = version + 1
          WHERE request_id = ? AND version = ? AND status = 'succeeded'
        `).run(current.requestId, current.version);
        assertOneChange(versioned.changes, current.requestId);
        const audit = this.#database.prepare(`
          INSERT INTO calendar_outbox_audit (
            request_id, payload_hash, completed_at, deleted_at, backup_manifest_id
          ) VALUES (?, ?, ?, ?, ?)
        `).run(current.requestId, current.payloadHash, current.updatedAt, now, evidence.manifestId);
        assertOneChange(audit.changes, current.requestId);
        const removed = this.#database.prepare(`
          DELETE FROM calendar_requests
          WHERE request_id = ? AND version = ? AND status = 'succeeded'
        `).run(current.requestId, current.version + 1);
        assertOneChange(removed.changes, current.requestId);
      });
      deleted.push(current.requestId);
    }
    return deleted;
  }

  auditEntries(): CalendarOutboxAuditEntry[] {
    this.#assertOpen();
    const rows = this.#database.prepare(`
      SELECT request_id, payload_hash, completed_at, deleted_at, backup_manifest_id
      FROM calendar_outbox_audit ORDER BY deleted_at, request_id
    `).all() as unknown as AuditRow[];
    return rows.map(row => ({
      requestId: row.request_id,
      payloadHash: row.payload_hash,
      completedAt: row.completed_at,
      deletedAt: row.deleted_at,
      backupManifestId: row.backup_manifest_id,
    }));
  }

  get(requestId: string): CalendarRequest | undefined {
    this.#assertOpen();
    const row = this.#database.prepare(`
      SELECT ${REQUEST_COLUMNS} FROM calendar_requests WHERE request_id = ?
    `).get(requestId) as unknown as CalendarRequestRow | undefined;
    return row ? mapRequest(row) : undefined;
  }

  close(): void {
    if (this.#closed) return;
    this.#secureDatabaseFiles();
    this.#database.close();
    this.#closed = true;
    this.#secureDatabaseFiles();
  }

  #acquireSubmission(requestId: string, senderId: string): CalendarRequest {
    return this.#transaction(() => {
      const current = this.#require(requestId);
      if (current.status !== 'confirmed' || current.confirmationConsumedAt !== undefined) {
        throw new CalendarOutboxError('confirmation_consumed', 'Calendar confirmation was already consumed');
      }
      if (current.confirmedBy !== senderId) {
        throw new CalendarOutboxError('confirmation_owner_mismatch', 'Confirmation belongs to another sender');
      }
      const nowDate = this.#nowDate();
      const now = formatTimestamp(nowDate);
      if (Date.parse(current.confirmationExpiresAt!) <= nowDate.valueOf()) {
        throw new CalendarOutboxError('confirmation_expired', 'Calendar confirmation expired');
      }
      const result = this.#database.prepare(`
        UPDATE calendar_requests
        SET status = 'submitting', confirmation_consumed_at = ?, updated_at = ?, version = version + 1
        WHERE request_id = ? AND version = ? AND status = 'confirmed'
          AND confirmation_consumed_at IS NULL AND confirmation_expires_at > ?
      `).run(now, now, current.requestId, current.version, now);
      assertOneChange(result.changes, current.requestId);
      return this.#require(current.requestId);
    });
  }

  #beginAttempt(current: CalendarRequest): CalendarRequest {
    return this.#transaction(() => {
      const now = this.#timestamp();
      const result = this.#database.prepare(`
        UPDATE calendar_requests
        SET attempt_count = attempt_count + 1, last_attempt_at = ?, updated_at = ?, version = version + 1
        WHERE request_id = ? AND version = ? AND status = 'submitting' AND attempt_count = ? AND attempt_count < 3
      `).run(now, now, current.requestId, current.version, current.attemptCount);
      assertOneChange(result.changes, current.requestId);
      return this.#require(current.requestId);
    });
  }

  #finish(
    current: CalendarRequest,
    status: 'pending_reconcile' | 'succeeded' | 'failed',
    fields: {
      httpStatus?: number;
      processType?: 'create' | 'modify';
      returnedIcalUid?: string;
      errorCode?: string;
    },
  ): CalendarRequest {
    return this.#transaction(() => {
      const now = this.#timestamp();
      const result = this.#database.prepare(`
        UPDATE calendar_requests
        SET status = ?, http_status = ?, process_type = ?, returned_ical_uid = ?, error_code = ?,
            updated_at = ?, version = version + 1
        WHERE request_id = ? AND version = ? AND status = ?
      `).run(
        status,
        fields.httpStatus ?? null,
        fields.processType ?? null,
        fields.returnedIcalUid ?? null,
        fields.errorCode ?? null,
        now,
        current.requestId,
        current.version,
        current.status,
      );
      assertOneChange(result.changes, current.requestId);
      return this.#require(current.requestId);
    });
  }

  async #reconcileOne(current: CalendarRequest): Promise<CalendarRequest> {
    let events: CalendarEvent[];
    try {
      events = await this.#caldav.listEvents(eventRange(current));
    } catch (error) {
      if (errorCode(error) === 'CALDAV_DUPLICATE_UID') {
        const failed = this.#finish(current, 'failed', { errorCode: 'reconcile_multiple_matches' });
        await this.#notifyOnce(failed, 'confirmation_required', 'confirmation_required');
        return failed;
      }
      const pending = this.#setPendingError(current, 'reconcile_unavailable');
      await this.#notifyOnce(pending, 'pending', 'reconcile_unavailable');
      return pending;
    }

    const matches = events.filter(event => event.calendarId === current.calendarId && event.uid === current.uid);
    if (matches.length === 0) {
      const pending = this.#setPendingError(current, 'reconcile_not_found');
      await this.#notifyOnce(pending, 'pending', 'reconcile_not_found');
      return pending;
    }
    if (matches.length !== 1) {
      const failed = this.#finish(current, 'failed', { errorCode: 'reconcile_multiple_matches' });
      await this.#notifyOnce(failed, 'confirmation_required', 'confirmation_required');
      return failed;
    }
    let matchingHash: string;
    try {
      matchingHash = semanticEventHash(matches[0]);
    } catch {
      matchingHash = '';
    }
    if (matchingHash !== current.payloadHash) {
      const failed = this.#finish(current, 'failed', { errorCode: 'reconcile_payload_mismatch' });
      await this.#notifyOnce(failed, 'confirmation_required', 'confirmation_required');
      return failed;
    }
    return this.#finish(current, 'succeeded', {
      httpStatus: current.httpStatus,
      processType: current.processType,
      returnedIcalUid: current.returnedIcalUid ?? matches[0].uid,
    });
  }

  #setPendingError(current: CalendarRequest, errorCodeValue: string): CalendarRequest {
    if (current.errorCode === errorCodeValue) return current;
    return this.#finish(current, 'pending_reconcile', {
      httpStatus: current.httpStatus,
      processType: current.processType,
      returnedIcalUid: current.returnedIcalUid,
      errorCode: errorCodeValue,
    });
  }

  async #notifyOnce(
    current: CalendarRequest,
    kind: 'pending' | 'confirmation_required',
    reason: CalendarOutboxWarning['reason'],
  ): Promise<void> {
    const inserted = this.#transaction(() => this.#database.prepare(`
      INSERT OR IGNORE INTO calendar_reconcile_warnings (request_id, warning_kind, warned_at)
      VALUES (?, ?, ?)
    `).run(current.requestId, kind, this.#timestamp()).changes);
    if (Number(inserted) === 1) await this.#warn?.({ requestId: current.requestId, reason });
  }

  #require(requestId: string): CalendarRequest {
    const request = this.get(requestId);
    if (!request) throw new CalendarOutboxError('request_not_found', `Calendar request ${requestId} does not exist`);
    return request;
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE;');
    try {
      const result = operation();
      this.#database.exec('COMMIT;');
      this.#secureDatabaseFiles();
      return result;
    } catch (error) {
      this.#database.exec('ROLLBACK;');
      throw error;
    }
  }

  #nowDate(): Date {
    const now = this.#now();
    if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
      throw new CalendarOutboxError('invalid_clock', 'UTC clock returned an invalid date');
    }
    return now;
  }

  #timestamp(): string {
    return formatTimestamp(this.#nowDate());
  }

  #assertOpen(): void {
    if (this.#closed) throw new CalendarOutboxError('outbox_closed', 'Calendar outbox is closed');
  }

  #secureDatabaseFiles(): void {
    for (const path of [this.#databasePath, `${this.#databasePath}-wal`, `${this.#databasePath}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }
}

function validatePayload(input: PrepareCalendarRequest): void {
  if (!input.calendarId || !input.uid || !input.payloadIcal) {
    throw new CalendarOutboxError('invalid_payload', 'Calendar ID, UID, and iCalendar payload are required');
  }
  if (!/^[0-9a-f]{64}$/.test(input.payloadHash)) {
    throw new CalendarOutboxError('invalid_payload', 'Calendar semantic hash must be lowercase SHA-256');
  }
  let events: CalendarEvent[];
  try {
    events = parseIcal(input.payloadIcal, input.calendarId);
  } catch {
    throw new CalendarOutboxError('invalid_payload', 'Calendar payload is not valid iCalendar');
  }
  if (events.length !== 1 || events[0].uid !== input.uid || events[0].calendarId !== input.calendarId) {
    throw new CalendarOutboxError('invalid_payload', 'Calendar payload identity does not match the request');
  }
  if (semanticEventHash(events[0]) !== input.payloadHash) {
    throw new CalendarOutboxError('payload_changed', 'Calendar payload does not match its semantic hash');
  }
}

function validateUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new CalendarOutboxError('invalid_request_id', 'Calendar request ID must be a lowercase UUID');
  }
}

function validateSenderId(value: string): bigint {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new CalendarOutboxError('invalid_sender_id', 'Telegram sender ID must be a positive integer');
  }
  const numeric = BigInt(value);
  if (numeric > MAX_SQLITE_INTEGER) {
    throw new CalendarOutboxError('invalid_sender_id', 'Telegram sender ID is outside SQLite integer range');
  }
  return numeric;
}

function formatTimestamp(date: Date): string {
  return new Date(Math.floor(date.valueOf() / 1_000) * 1_000).toISOString().replace('.000Z', 'Z');
}

function mapRequest(row: CalendarRequestRow): CalendarRequest {
  return {
    requestId: row.request_id,
    version: Number(row.version),
    status: row.status,
    uid: row.uid,
    calendarId: row.calendar_id,
    payloadIcal: row.payload_ical,
    payloadHash: row.payload_hash,
    ...(row.confirmed_by === null ? {} : { confirmedBy: String(row.confirmed_by) }),
    ...(row.confirmed_at === null ? {} : { confirmedAt: row.confirmed_at }),
    ...(row.confirmation_expires_at === null ? {} : { confirmationExpiresAt: row.confirmation_expires_at }),
    ...(row.confirmation_consumed_at === null ? {} : { confirmationConsumedAt: row.confirmation_consumed_at }),
    attemptCount: Number(row.attempt_count),
    ...(row.last_attempt_at === null ? {} : { lastAttemptAt: row.last_attempt_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.http_status === null ? {} : { httpStatus: Number(row.http_status) }),
    ...(row.process_type === null ? {} : { processType: row.process_type }),
    ...(row.returned_ical_uid === null ? {} : { returnedIcalUid: row.returned_ical_uid }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
  };
}

function eventRange(request: CalendarRequest): { start: string; end: string } {
  const events = parseIcal(request.payloadIcal, request.calendarId);
  if (events.length !== 1) throw new CalendarOutboxError('invalid_payload', 'Stored calendar payload is invalid');
  return {
    start: rangeTimestamp(events[0].dtstart),
    end: rangeTimestamp(events[0].dtend),
  };
}

function rangeTimestamp(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error.code) {
    return error.code;
  }
  return 'request_maybe_sent';
}

function isProvenNoCreate(code: string): boolean {
  return code === 'naver_auth' || code === 'naver_rate_limited' ||
    code === 'naver_http' || code === 'naver_invalid_request';
}

function assertOneChange(changes: number | bigint, requestId: string): void {
  if (Number(changes) !== 1) {
    throw new CalendarOutboxError('cas_conflict', `Calendar request ${requestId} changed concurrently`);
  }
}
