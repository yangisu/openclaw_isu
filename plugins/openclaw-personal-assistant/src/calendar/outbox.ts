/// <reference types="node" />

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
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
  idempotencyKey: string;
}

export interface CalendarOutboxAuditEntry {
  requestId: string;
  payloadHash: string;
  completedAt: string;
  deletedAt: string;
  backupManifestId: string;
  backupManifestHash: string;
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
  backup_manifest_hash: string;
}

interface WarningRow {
  request_id: string;
  warning_kind: 'pending' | 'confirmation_required';
  version: number | bigint;
  idempotency_key: string;
  reason: CalendarOutboxWarning['reason'];
  delivery_status: 'pending' | 'delivered';
  attempt_count: number | bigint;
  last_attempt_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

interface BackupManifest {
  version: 1;
  createdAt: string;
  gitHead: string;
  schemaVersion: string;
  exclusionsVersion: string;
  files: Array<{ path: string; size: number; sha256: string }>;
}

const CONFIRMATION_LIFETIME_MS = 10 * 60 * 1_000;
const DEFAULT_STALE_AFTER_MS = 15_000;
const SUCCEEDED_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const RETRY_DELAYS_MS = [100, 200] as const;
const MAX_SQLITE_INTEGER = 9_223_372_036_854_775_807n;
const MAX_SAFE_VERSION = Number.MAX_SAFE_INTEGER;
const OUTBOX_SCHEMA_VERSION = 1;
const OUTBOX_SNAPSHOT_PATH = 'state/calendar-outbox.sqlite3';
const REQUEST_COLUMNS = `
  request_id, version, status, uid, calendar_id, payload_ical, payload_hash,
  confirmed_by, confirmed_at, confirmation_expires_at, confirmation_consumed_at,
  attempt_count, last_attempt_at, created_at, updated_at, http_status,
  process_type, returned_ical_uid, error_code
`;

// Keep this in lock-step with outbox-schema.sql. It is embedded so compiled output
// remains self-contained when package assets are not copied beside dist/*.js.
const OUTBOX_SCHEMA = `
CREATE TABLE calendar_requests (
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
  version INTEGER NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740991),
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

CREATE INDEX calendar_requests_status_updated_idx
  ON calendar_requests (status, updated_at, request_id);

CREATE TABLE calendar_outbox_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version BETWEEN 1 AND 9007199254740991),
  schema_fingerprint TEXT NOT NULL
    CHECK (length(schema_fingerprint) = 64 AND schema_fingerprint NOT GLOB '*[^0-9a-f]*')
) STRICT;

CREATE TABLE calendar_reconcile_warnings (
  request_id TEXT NOT NULL,
  warning_kind TEXT NOT NULL CHECK (warning_kind IN ('pending','confirmation_required')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740991),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(idempotency_key) = 64 AND idempotency_key NOT GLOB '*[^0-9a-f]*'),
  reason TEXT NOT NULL
    CHECK (reason IN ('reconcile_unavailable','reconcile_not_found','confirmation_required')),
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('pending','delivered')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 9007199254740991),
  last_attempt_at TEXT CHECK (
    last_attempt_at IS NULL OR
    (length(last_attempt_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', last_attempt_at) = last_attempt_at)
  ),
  delivered_at TEXT CHECK (
    delivered_at IS NULL OR
    (length(delivered_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', delivered_at) = delivered_at)
  ),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', created_at) = created_at),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', updated_at) = updated_at),
  PRIMARY KEY (request_id, warning_kind),
  FOREIGN KEY (request_id) REFERENCES calendar_requests(request_id) ON DELETE CASCADE,
  CHECK (
    (delivery_status = 'pending' AND delivered_at IS NULL)
    OR (delivery_status = 'delivered' AND delivered_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX calendar_reconcile_warnings_delivery_idx
  ON calendar_reconcile_warnings (delivery_status, created_at, request_id, warning_kind);

CREATE TABLE calendar_outbox_audit (
  request_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL
    CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  completed_at TEXT NOT NULL
    CHECK (length(completed_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', completed_at) = completed_at),
  deleted_at TEXT NOT NULL
    CHECK (length(deleted_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', deleted_at) = deleted_at),
  backup_manifest_id TEXT NOT NULL CHECK (length(backup_manifest_id) > 0),
  backup_manifest_hash TEXT NOT NULL
    CHECK (length(backup_manifest_hash) = 64 AND backup_manifest_hash NOT GLOB '*[^0-9a-f]*')
) STRICT;
`;

const EXPECTED_SCHEMA = schemaObjects(OUTBOX_SCHEMA);
const OUTBOX_SCHEMA_FINGERPRINT = schemaFingerprint(EXPECTED_SCHEMA);
const VERIFIED_EVIDENCE_TOKEN = Symbol('verified-outbox-backup-evidence');
const VERIFIED_EVIDENCE = new WeakMap<object, {
  manifestId: string;
  manifestHash: string;
  coveredRequests: ReadonlyMap<string, string>;
}>();

export class VerifiedOutboxBackupEvidence {
  private constructor(
    token: symbol,
    public readonly manifestId: string,
    public readonly manifestHash: string,
    coveredRequests: ReadonlyMap<string, string>,
  ) {
    if (token !== VERIFIED_EVIDENCE_TOKEN) {
      throw new CalendarOutboxError('invalid_backup_evidence', 'Backup evidence was not minted by the verifier');
    }
    VERIFIED_EVIDENCE.set(this, {
      manifestId,
      manifestHash,
      coveredRequests: new Map(coveredRequests),
    });
    Object.freeze(this);
  }

  static verifySnapshot(snapshotRoot: string): VerifiedOutboxBackupEvidence {
    try {
      const rootPath = resolve(snapshotRoot);
      const rootStat = lstatSync(rootPath);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('snapshot root is not a real directory');
      const realRoot = realpathSync(rootPath);
      const manifestPath = join(realRoot, 'manifest.json');
      const manifestStat = lstatSync(manifestPath);
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('manifest is not a regular file');
      const manifestBytes = readFileSync(manifestPath);
      const manifestHash = sha256(manifestBytes);
      const manifest = parseBackupManifest(manifestBytes.toString('utf8'));
      const entry = manifest.files.find(file => file.path === OUTBOX_SNAPSHOT_PATH);
      if (!entry) throw new Error('calendar outbox snapshot is not listed');

      const snapshotPath = join(realRoot, ...OUTBOX_SNAPSHOT_PATH.split('/'));
      const snapshotStat = lstatSync(snapshotPath);
      if (!snapshotStat.isFile() || snapshotStat.isSymbolicLink()) throw new Error('snapshot is not a regular file');
      const realSnapshot = realpathSync(snapshotPath);
      const relativeSnapshot = relative(realRoot, realSnapshot);
      if (!relativeSnapshot || relativeSnapshot.startsWith('..') || isAbsolute(relativeSnapshot)) {
        throw new Error('snapshot escapes its verified root');
      }
      const snapshotBytes = readFileSync(realSnapshot);
      if (entry.size !== snapshotBytes.byteLength || entry.sha256 !== sha256(snapshotBytes)) {
        throw new Error('snapshot coverage hash mismatch');
      }

      const database = new DatabaseSync(realSnapshot, { readOnly: true, readBigInts: true });
      try {
        validateExistingSchema(database);
        const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown };
        if (integrity.integrity_check !== 'ok') throw new Error('snapshot integrity check failed');
        const rows = database.prepare('SELECT request_id, payload_hash FROM calendar_requests')
          .all() as Array<{ request_id: string; payload_hash: string }>;
        const coverage = new Map(rows.map(row => [row.request_id, row.payload_hash]));
        return new VerifiedOutboxBackupEvidence(
          VERIFIED_EVIDENCE_TOKEN,
          `${manifest.createdAt}:${manifest.gitHead}`,
          manifestHash,
          coverage,
        );
      } finally {
        database.close();
      }
    } catch (error) {
      if (error instanceof CalendarOutboxError && error.code === 'invalid_backup_evidence') throw error;
      throw new CalendarOutboxError('invalid_backup_evidence', 'Backup manifest coverage could not be verified');
    }
  }

}

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
    try {
      this.#database.exec('PRAGMA busy_timeout = 10000;');
      this.#database.exec('PRAGMA foreign_keys = ON;');
      this.#database.exec('PRAGMA journal_mode = WAL;');
      initializeOrValidateSchema(this.#database);
    } catch (error) {
      this.#database.close();
      if (error instanceof CalendarOutboxError && error.code === 'outbox_schema_mismatch') throw error;
      throw new CalendarOutboxError('outbox_schema_mismatch', 'Calendar outbox schema validation failed');
    }
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
      assertVersionCanIncrement(current.version);
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

  async recover(): Promise<CalendarRequest[]> {
    this.#assertOpen();
    const now = Date.parse(this.#timestamp());
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
    await this.#deliverPendingWarnings();
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

  pruneSucceeded(evidence: VerifiedOutboxBackupEvidence): string[] {
    this.#assertOpen();
    const verified = evidence && typeof evidence === 'object' ? VERIFIED_EVIDENCE.get(evidence) : undefined;
    if (!verified) {
      throw new CalendarOutboxError('invalid_backup_evidence', 'Verified backup evidence is required');
    }
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
      if (verified.coveredRequests.get(current.requestId) !== current.payloadHash) continue;
      this.#transaction(() => {
        assertVersionCanIncrement(current.version);
        const versioned = this.#database.prepare(`
          UPDATE calendar_requests SET version = version + 1
          WHERE request_id = ? AND version = ? AND status = 'succeeded'
        `).run(current.requestId, current.version);
        assertOneChange(versioned.changes, current.requestId);
        const audit = this.#database.prepare(`
          INSERT INTO calendar_outbox_audit (
            request_id, payload_hash, completed_at, deleted_at, backup_manifest_id, backup_manifest_hash
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          current.requestId, current.payloadHash, current.updatedAt, now,
          verified.manifestId, verified.manifestHash,
        );
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
      SELECT request_id, payload_hash, completed_at, deleted_at, backup_manifest_id, backup_manifest_hash
      FROM calendar_outbox_audit ORDER BY deleted_at, request_id
    `).all() as unknown as AuditRow[];
    return rows.map(row => ({
      requestId: row.request_id,
      payloadHash: row.payload_hash,
      completedAt: row.completed_at,
      deletedAt: row.deleted_at,
      backupManifestId: row.backup_manifest_id,
      backupManifestHash: row.backup_manifest_hash,
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
      assertVersionCanIncrement(current.version);
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
      assertVersionCanIncrement(current.version);
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
      assertVersionCanIncrement(current.version);
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
    const target = storedEvent(current);
    let events: CalendarEvent[];
    try {
      events = await this.#caldav.listEvents(eventRange(target));
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

    const recurrenceId = target.recurrenceId ?? null;
    const matches = events.filter(event => event.calendarId === current.calendarId && event.uid === current.uid &&
      (event.recurrenceId ?? null) === recurrenceId);
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
    const idempotencyKey = sha256(`calendar-outbox-warning:v1\0${current.requestId}\0${kind}`);
    this.#transaction(() => {
      const now = this.#timestamp();
      this.#database.prepare(`
        INSERT OR IGNORE INTO calendar_reconcile_warnings (
          request_id, warning_kind, version, idempotency_key, reason, delivery_status,
          attempt_count, last_attempt_at, delivered_at, created_at, updated_at
        ) VALUES (?, ?, 0, ?, ?, 'pending', 0, NULL, NULL, ?, ?)
      `).run(current.requestId, kind, idempotencyKey, reason, now, now);
    });
    await this.#deliverWarning(idempotencyKey);
  }

  async #deliverPendingWarnings(): Promise<void> {
    const rows = this.#database.prepare(`
      SELECT idempotency_key FROM calendar_reconcile_warnings
      WHERE delivery_status = 'pending'
      ORDER BY created_at, request_id, warning_kind
    `).all() as Array<{ idempotency_key: string }>;
    for (const row of rows) await this.#deliverWarning(row.idempotency_key);
  }

  async #deliverWarning(idempotencyKey: string): Promise<void> {
    if (!this.#warn) return;
    let warning = this.#warning(idempotencyKey);
    if (!warning || warning.delivery_status === 'delivered') return;
    warning = this.#transaction(() => {
      assertVersionCanIncrement(Number(warning!.version));
      if (Number(warning!.attempt_count) >= MAX_SAFE_VERSION) {
        throw new CalendarOutboxError('outbox_version_overflow', 'Warning attempt counter cannot be incremented safely');
      }
      const now = this.#timestamp();
      const result = this.#database.prepare(`
        UPDATE calendar_reconcile_warnings
        SET version = version + 1, attempt_count = attempt_count + 1,
            last_attempt_at = ?, updated_at = ?
        WHERE idempotency_key = ? AND version = ? AND delivery_status = 'pending'
      `).run(now, now, idempotencyKey, warning!.version);
      assertOneChange(result.changes, warning!.request_id);
      return this.#warning(idempotencyKey)!;
    });

    await this.#warn({
      requestId: warning.request_id,
      reason: warning.reason,
      idempotencyKey: warning.idempotency_key,
    });

    this.#transaction(() => {
      assertVersionCanIncrement(Number(warning!.version));
      const now = this.#timestamp();
      const result = this.#database.prepare(`
        UPDATE calendar_reconcile_warnings
        SET version = version + 1, delivery_status = 'delivered', delivered_at = ?, updated_at = ?
        WHERE idempotency_key = ? AND version = ? AND delivery_status = 'pending'
      `).run(now, now, idempotencyKey, warning!.version);
      if (Number(result.changes) === 0 && this.#warning(idempotencyKey)?.delivery_status === 'delivered') return;
      assertOneChange(result.changes, warning!.request_id);
    });
  }

  #warning(idempotencyKey: string): WarningRow | undefined {
    return this.#database.prepare(`
      SELECT request_id, warning_kind, version, idempotency_key, reason, delivery_status,
             attempt_count, last_attempt_at, delivered_at, created_at, updated_at
      FROM calendar_reconcile_warnings WHERE idempotency_key = ?
    `).get(idempotencyKey) as unknown as WarningRow | undefined;
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

function storedEvent(request: CalendarRequest): CalendarEvent {
  const events = parseIcal(request.payloadIcal, request.calendarId);
  if (events.length !== 1) throw new CalendarOutboxError('invalid_payload', 'Stored calendar payload is invalid');
  return events[0];
}

function eventRange(event: CalendarEvent): { start: string; end: string } {
  return {
    start: rangeTimestamp(event.dtstart),
    end: rangeTimestamp(event.dtend),
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

function assertVersionCanIncrement(version: number): void {
  if (!Number.isSafeInteger(version) || version < 0 || version >= MAX_SAFE_VERSION) {
    throw new CalendarOutboxError('outbox_version_overflow', 'Calendar request version cannot be incremented safely');
  }
}

interface SchemaObject {
  type: 'table' | 'index';
  name: string;
  sql: string;
}

function schemaObjects(source: string): SchemaObject[] {
  const objects: SchemaObject[] = [];
  for (const part of source.trim().split(/;\s*(?=CREATE|$)/i)) {
    const sql = part.trim();
    if (!sql) continue;
    const match = /^CREATE\s+(TABLE|INDEX)\s+([a-z_][a-z0-9_]*)/i.exec(sql);
    if (!match) throw new Error('invalid embedded outbox schema');
    objects.push({ type: match[1].toLowerCase() as 'table' | 'index', name: match[2], sql });
  }
  return objects.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

function schemaFingerprint(objects: readonly SchemaObject[]): string {
  return sha256(JSON.stringify(objects.map(object => ({
    type: object.type,
    name: object.name,
    sql: canonicalSql(object.sql),
  }))));
}

function canonicalSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function initializeOrValidateSchema(database: DatabaseSync): void {
  let inTransaction = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    inTransaction = true;
    const row = database.prepare(`
      SELECT count(*) AS count FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    `).get() as { count: number | bigint };
    if (Number(row.count) === 0) {
      database.exec(OUTBOX_SCHEMA);
      database.prepare(`
        INSERT INTO calendar_outbox_metadata (singleton, schema_version, schema_fingerprint)
        VALUES (1, ?, ?)
      `).run(OUTBOX_SCHEMA_VERSION, OUTBOX_SCHEMA_FINGERPRINT);
      database.exec(`PRAGMA user_version = ${OUTBOX_SCHEMA_VERSION};`);
    }
    validateExistingSchema(database);
    database.exec('COMMIT;');
    inTransaction = false;
  } catch (error) {
    if (inTransaction) database.exec('ROLLBACK;');
    if (error instanceof CalendarOutboxError && error.code === 'outbox_schema_mismatch') throw error;
    throw new CalendarOutboxError('outbox_schema_mismatch', 'Calendar outbox schema does not match the required schema');
  }
}

function validateExistingSchema(database: DatabaseSync): void {
  try {
    const actual = (database.prepare(`
      SELECT type, name, sql FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ type: string; name: string; sql: string }>).map(row => ({
      type: row.type as 'table' | 'index', name: row.name, sql: row.sql,
    }));
    if (actual.length !== EXPECTED_SCHEMA.length) throw new Error('schema object count differs');
    for (let index = 0; index < EXPECTED_SCHEMA.length; index += 1) {
      const expected = EXPECTED_SCHEMA[index];
      const found = actual[index];
      if (found.type !== expected.type || found.name !== expected.name ||
          canonicalSql(found.sql) !== canonicalSql(expected.sql)) {
        throw new Error(`schema object ${expected.name} differs`);
      }
    }

    const tableRows = database.prepare(`
      SELECT name, strict FROM pragma_table_list
      WHERE name IN ('calendar_requests','calendar_outbox_metadata','calendar_reconcile_warnings','calendar_outbox_audit')
    `).all() as Array<{ name: string; strict: number | bigint }>;
    if (tableRows.length !== 4 || tableRows.some(row => Number(row.strict) !== 1)) {
      throw new Error('outbox tables are not STRICT');
    }

    const version = database.prepare('PRAGMA user_version').get() as { user_version: number | bigint };
    const metadata = database.prepare(`
      SELECT singleton, schema_version, schema_fingerprint FROM calendar_outbox_metadata
    `).get() as { singleton: number | bigint; schema_version: number | bigint; schema_fingerprint: string } | undefined;
    if (Number(version.user_version) !== OUTBOX_SCHEMA_VERSION || !metadata ||
        Number(metadata.singleton) !== 1 || Number(metadata.schema_version) !== OUTBOX_SCHEMA_VERSION ||
        metadata.schema_fingerprint !== OUTBOX_SCHEMA_FINGERPRINT ||
        schemaFingerprint(actual) !== OUTBOX_SCHEMA_FINGERPRINT) {
      throw new Error('outbox schema version or fingerprint differs');
    }
  } catch (error) {
    throw new CalendarOutboxError('outbox_schema_mismatch', 'Calendar outbox schema does not match the required schema');
  }
}

function parseBackupManifest(source: string): BackupManifest {
  const value = JSON.parse(source) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('manifest is not an object');
  const manifest = value as Record<string, unknown>;
  if (manifest.version !== 1 || typeof manifest.createdAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(manifest.createdAt) ||
      Number.isNaN(Date.parse(manifest.createdAt)) || formatTimestamp(new Date(manifest.createdAt)) !== manifest.createdAt ||
      !/^[0-9a-f]{40}$/.test(String(manifest.gitHead)) ||
      typeof manifest.schemaVersion !== 'string' || !manifest.schemaVersion ||
      typeof manifest.exclusionsVersion !== 'string' || !manifest.exclusionsVersion ||
      !Array.isArray(manifest.files)) {
    throw new Error('manifest header is invalid');
  }
  const files = manifest.files.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('manifest file is invalid');
    const file = item as Record<string, unknown>;
    if (typeof file.path !== 'string' || !file.path || file.path.startsWith('/') || file.path.includes('\\') ||
        file.path.split('/').some(part => !part || part === '.' || part === '..') ||
        !Number.isSafeInteger(file.size) || Number(file.size) < 0 ||
        typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new Error('manifest file entry is invalid');
    }
    return { path: file.path, size: Number(file.size), sha256: file.sha256 };
  });
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error('manifest paths are duplicated');
  return {
    version: 1,
    createdAt: manifest.createdAt,
    gitHead: String(manifest.gitHead),
    schemaVersion: manifest.schemaVersion,
    exclusionsVersion: manifest.exclusionsVersion,
    files,
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
