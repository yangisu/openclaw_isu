import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CalendarOutbox,
  CalendarOutboxError,
  VerifiedOutboxBackupEvidence,
  type CalendarOutboxWarning,
} from '../../src/calendar/outbox.js';
import { NaverCalendarError, type CreateScheduleRequest } from '../../src/calendar/naver-api.js';
import {
  buildIcal,
  parseIcal,
  semanticEventHash,
  type CalendarEvent,
  type CalendarEventDraft,
} from '../../src/calendar/ical.js';

const SENDER_ID = '740123456';
const START = new Date('2026-08-25T00:00:00.900Z');

type ApiOutcome =
  | { type: 'success'; processType?: 'create' | 'modify'; calendarId?: string; icalUid?: string }
  | { type: 'error'; code: string };

class FakeCalendarApi {
  readonly calls: CreateScheduleRequest[] = [];
  outcomes: ApiOutcome[] = [];

  async createSchedule(request: CreateScheduleRequest): Promise<{
    processType: 'create' | 'modify';
    calendarId: string;
    icalUid: string;
  }> {
    this.calls.push(request);
    const outcome = this.outcomes.shift() ?? { type: 'success' as const };
    if (outcome.type === 'error') throw new NaverCalendarError(outcome.code as never, outcome.code);
    return {
      processType: outcome.processType ?? 'create',
      calendarId: outcome.calendarId ?? request.calendarId,
      icalUid: outcome.icalUid ?? eventUid(request.scheduleIcalString),
    };
  }
}

class FakeCalDav {
  calls: Array<{ start: string | Date; end: string | Date }> = [];
  outcomes: Array<CalendarEvent[] | Error> = [];

  async listEvents(range: { start: string | Date; end: string | Date }): Promise<CalendarEvent[]> {
    this.calls.push(range);
    const outcome = this.outcomes.shift() ?? [];
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

const directories: string[] = [];
const openOutboxes: CalendarOutbox[] = [];

afterEach(async () => {
  for (const outbox of openOutboxes.splice(0)) outbox.close();
  await Promise.all(directories.splice(0).map(path => rm(path, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 20,
  })));
});

async function fixture(overrides: {
  api?: FakeCalendarApi;
  caldav?: FakeCalDav;
  now?: Date;
  warnings?: CalendarOutboxWarning[];
  warn?: (warning: CalendarOutboxWarning) => void | Promise<void>;
  checkpoint?: (phase: 'afterAcquire' | 'beforeAttempt') => void;
} = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'calendar-outbox-'));
  directories.push(stateDir);
  const api = overrides.api ?? new FakeCalendarApi();
  const caldav = overrides.caldav ?? new FakeCalDav();
  const warnings = overrides.warnings ?? [];
  let current = new Date(overrides.now ?? START);
  const delays: number[] = [];
  let nextId = 1;
  const create = () => {
    const outbox = new CalendarOutbox({
      stateDir,
      api,
      caldav,
      now: () => new Date(current),
      sleep: async delay => { delays.push(delay); },
      requestId: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
      warn: overrides.warn ?? (warning => { warnings.push(warning); }),
      checkpoint: overrides.checkpoint,
    });
    openOutboxes.push(outbox);
    return outbox;
  };
  return {
    stateDir,
    api,
    caldav,
    warnings,
    delays,
    create,
    outbox: create(),
    setNow(value: string | Date) { current = new Date(value); },
    advance(milliseconds: number) { current = new Date(current.valueOf() + milliseconds); },
  };
}

async function stateDirectory(): Promise<string> {
  const stateDir = await mkdtemp(join(tmpdir(), 'calendar-outbox-schema-'));
  directories.push(stateDir);
  return stateDir;
}

function openAt(stateDir: string): CalendarOutbox {
  const outbox = new CalendarOutbox({
    stateDir,
    api: new FakeCalendarApi(),
    caldav: new FakeCalDav(),
    now: () => new Date(START),
  });
  openOutboxes.push(outbox);
  return outbox;
}

function draft(overrides: Partial<CalendarEventDraft> = {}) {
  const event: CalendarEventDraft = {
    calendarId: 'personal',
    uid: 'calendar-request-1',
    dtstart: '2026-08-25T09:00:00+09:00',
    dtend: '2026-08-25T10:00:00+09:00',
    summary: 'Dentist appointment',
    ...overrides,
  };
  return {
    calendarId: event.calendarId,
    uid: event.uid,
    payloadIcal: buildIcal(event),
    payloadHash: semanticEventHash(event),
  };
}

function eventUid(ical: string): string {
  return parseIcal(ical, 'ignored')[0].uid;
}

async function makePending(f: Awaited<ReturnType<typeof fixture>>) {
  f.api.outcomes.push({ type: 'error', code: 'request_maybe_sent' });
  const prepared = f.outbox.prepare(draft());
  f.outbox.confirm(prepared.requestId, SENDER_ID, prepared.payloadHash);
  await f.outbox.submit(prepared.requestId, SENDER_ID);
  return f.outbox.get(prepared.requestId)!;
}

async function backupSnapshotFixture(stateDir: string): Promise<string> {
  const backupRoot = await mkdtemp(join(tmpdir(), 'calendar-outbox-backup-'));
  directories.push(backupRoot);
  const snapshotDirectory = join(backupRoot, 'state');
  const snapshotPath = join(snapshotDirectory, 'calendar-outbox.sqlite3');
  await mkdir(snapshotDirectory, { recursive: true });
  await copyFile(join(stateDir, 'calendar-outbox.sqlite3'), snapshotPath);
  const contents = await readFile(snapshotPath);
  const manifest = {
    version: 1,
    createdAt: '2026-09-25T00:00:01Z',
    gitHead: '0'.repeat(40),
    schemaVersion: 'calendar-outbox:1',
    exclusionsVersion: '1',
    files: [{
      path: 'state/calendar-outbox.sqlite3',
      size: contents.byteLength,
      sha256: createHash('sha256').update(contents).digest('hex'),
    }],
  };
  await writeFile(join(backupRoot, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  return backupRoot;
}

describe('CalendarOutbox schema and confirmation state machine', () => {
  it('creates the exact request columns in a STRICT SQLite table', async () => {
    const f = await fixture();
    f.outbox.prepare(draft());
    const database = new DatabaseSync(join(f.stateDir, 'calendar-outbox.sqlite3'), { readOnly: true });
    const columns = database.prepare('PRAGMA table_info(calendar_requests)').all() as Array<{ name: string }>;
    const definition = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'calendar_requests'",
    ).get() as { sql: string };
    expect(columns.map(column => column.name)).toEqual([
      'request_id', 'version', 'status', 'uid', 'calendar_id', 'payload_ical', 'payload_hash',
      'confirmed_by', 'confirmed_at', 'confirmation_expires_at', 'confirmation_consumed_at',
      'attempt_count', 'last_attempt_at', 'created_at', 'updated_at', 'http_status',
      'process_type', 'returned_ical_uid', 'error_code',
    ]);
    expect(definition.sql).toMatch(/\) STRICT$/);
    expect(() => database.prepare('UPDATE calendar_requests SET attempt_count = 4').run()).toThrow();
    database.close();
    f.outbox.close();
  });

  it('reopens an existing exact schema and preserves its rows', async () => {
    const f = await fixture();
    const prepared = f.outbox.prepare(draft());
    f.outbox.close();
    const reopened = f.create();
    expect(reopened.get(prepared.requestId)).toEqual(prepared);
    reopened.close();
  });

  it('fails closed on a precreated non-STRICT request table', async () => {
    const stateDir = await stateDirectory();
    const database = new DatabaseSync(join(stateDir, 'calendar-outbox.sqlite3'));
    database.exec('CREATE TABLE calendar_requests (request_id TEXT PRIMARY KEY)');
    database.close();
    expect(() => openAt(stateDir)).toThrowError(expect.objectContaining({ code: 'outbox_schema_mismatch' }));
  });

  it('rejects weaker request constraints even when valid metadata is retained', async () => {
    const f = await fixture();
    f.outbox.close();
    const database = new DatabaseSync(join(f.stateDir, 'calendar-outbox.sqlite3'));
    database.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE calendar_requests;
      CREATE TABLE calendar_requests (
        request_id TEXT PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL,
        uid TEXT NOT NULL, calendar_id TEXT NOT NULL, payload_ical TEXT NOT NULL, payload_hash TEXT NOT NULL,
        confirmed_by INTEGER, confirmed_at TEXT, confirmation_expires_at TEXT,
        confirmation_consumed_at TEXT, attempt_count INTEGER NOT NULL, last_attempt_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, http_status INTEGER,
        process_type TEXT, returned_ical_uid TEXT, error_code TEXT
      ) STRICT;
    `);
    database.close();
    expect(() => f.create()).toThrowError(expect.objectContaining({ code: 'outbox_schema_mismatch' }));
  });

  it('rejects an existing schema with the wrong version', async () => {
    const f = await fixture();
    f.outbox.close();
    const database = new DatabaseSync(join(f.stateDir, 'calendar-outbox.sqlite3'));
    database.exec('PRAGMA user_version = 999;');
    database.prepare('UPDATE calendar_outbox_metadata SET schema_version = 999').run();
    database.close();
    expect(() => f.create()).toThrowError(expect.objectContaining({ code: 'outbox_schema_mismatch' }));
  });

  it('stores owner-only state and UTC whole-second timestamps', async () => {
    const f = await fixture();
    const prepared = f.outbox.prepare(draft());
    expect(prepared).toMatchObject({
      version: 0,
      status: 'draft',
      createdAt: '2026-08-25T00:00:00Z',
      updatedAt: '2026-08-25T00:00:00Z',
      attemptCount: 0,
    });
    if (process.platform !== 'win32') {
      expect((await stat(f.stateDir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(f.stateDir, 'calendar-outbox.sqlite3'))).mode & 0o777).toBe(0o600);
    }
    f.outbox.close();
  });

  it('consumes one confirmation for one submission across concurrent connections', async () => {
    const f = await fixture();
    const second = f.create();
    const prepared = f.outbox.prepare(draft());
    const confirmed = f.outbox.confirm(prepared.requestId, SENDER_ID, prepared.payloadHash);
    expect(confirmed).toMatchObject({ version: 1, status: 'confirmed', confirmedBy: SENDER_ID });

    const results = await Promise.allSettled([
      f.outbox.submit(prepared.requestId, SENDER_ID),
      second.submit(prepared.requestId, SENDER_ID),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejection.reason).toMatchObject({ code: 'confirmation_consumed' });
    expect(f.api.calls).toHaveLength(1);
    expect(f.outbox.get(prepared.requestId)).toMatchObject({
      version: 4,
      status: 'succeeded',
      attemptCount: 1,
      confirmationConsumedAt: '2026-08-25T00:00:00Z',
    });
    second.close();
    f.outbox.close();
  });

  it('rejects a different owner and a changed payload hash before submission', async () => {
    const f = await fixture();
    const prepared = f.outbox.prepare(draft());
    expect(() => f.outbox.confirm(prepared.requestId, SENDER_ID, 'f'.repeat(64))).toThrowError(
      expect.objectContaining({ code: 'payload_changed' }),
    );
    f.outbox.confirm(prepared.requestId, SENDER_ID, prepared.payloadHash);
    await expect(f.outbox.submit(prepared.requestId, '740999999')).rejects.toMatchObject({
      code: 'confirmation_owner_mismatch',
    });
    expect(f.api.calls).toHaveLength(0);
    expect(f.outbox.get(prepared.requestId)).toMatchObject({ status: 'confirmed', version: 1 });
    f.outbox.close();
  });

  it('preserves numeric sender IDs through the JavaScript safe integer range', async () => {
    const f = await fixture();
    const senderId = String(Number.MAX_SAFE_INTEGER);
    const prepared = f.outbox.prepare(draft());
    expect(f.outbox.confirm(prepared.requestId, senderId, prepared.payloadHash)).toMatchObject({
      confirmedBy: senderId,
    });
    await expect(f.outbox.submit(prepared.requestId, senderId)).resolves.toMatchObject({ status: 'succeeded' });
    f.outbox.close();
  });

  it('fails with a stable error instead of overflowing the CAS version', async () => {
    const f = await fixture();
    const prepared = f.outbox.prepare(draft());
    f.outbox.close();
    const database = new DatabaseSync(join(f.stateDir, 'calendar-outbox.sqlite3'));
    database.prepare('UPDATE calendar_requests SET version = ? WHERE request_id = ?')
      .run(BigInt(Number.MAX_SAFE_INTEGER), prepared.requestId);
    database.close();
    const reopened = f.create();
    expect(() => reopened.confirm(prepared.requestId, SENDER_ID, prepared.payloadHash)).toThrowError(
      expect.objectContaining({ code: 'outbox_version_overflow' }),
    );
    reopened.close();
  });

  it('expires confirmation at the exact ten-minute boundary and permits renewal', async () => {
    const f = await fixture();
    const prepared = f.outbox.prepare(draft());
    f.outbox.confirm(prepared.requestId, SENDER_ID, prepared.payloadHash);
    f.advance(10 * 60 * 1_000);
    await expect(f.outbox.submit(prepared.requestId, SENDER_ID)).rejects.toMatchObject({
      code: 'confirmation_expired',
    });
    expect(f.api.calls).toHaveLength(0);
    expect(f.outbox.confirm(prepared.requestId, SENDER_ID, prepared.payloadHash)).toMatchObject({
      status: 'confirmed',
      version: 2,
      confirmationExpiresAt: '2026-08-25T00:20:00Z',
    });
    await expect(f.outbox.submit(prepared.requestId, SENDER_ID)).resolves.toMatchObject({ status: 'succeeded' });
    f.outbox.close();
  });

  it('requires a new confirmation before a failed request can be submitted again', async () => {
    const f = await fixture();
    f.api.outcomes.push({ type: 'error', code: 'naver_auth' }, { type: 'success' });
    const prepared = f.outbox.prepare(draft());
    await expect(f.outbox.confirmAndSubmit(prepared.requestId, SENDER_ID, prepared.payloadHash)).resolves.toMatchObject({
      status: 'failed', errorCode: 'naver_auth', attemptCount: 1,
    });
    await expect(f.outbox.submit(prepared.requestId, SENDER_ID)).rejects.toMatchObject({
      code: 'confirmation_consumed',
    });
    expect(f.outbox.confirm(prepared.requestId, SENDER_ID, prepared.payloadHash)).toMatchObject({
      status: 'confirmed', attemptCount: 0,
    });
    await expect(f.outbox.submit(prepared.requestId, SENDER_ID)).resolves.toMatchObject({
      status: 'succeeded', attemptCount: 1,
    });
    expect(f.api.calls).toHaveLength(2);
    f.outbox.close();
  });
});

describe('CalendarOutbox submission recovery', () => {
  it('retries only proven pre-send failures with bounded exponential backoff', async () => {
    const f = await fixture();
    f.api.outcomes.push(
      { type: 'error', code: 'request_pre_send' },
      { type: 'error', code: 'request_pre_send' },
      { type: 'success' },
    );
    const prepared = f.outbox.prepare(draft());
    const result = await f.outbox.confirmAndSubmit(prepared.requestId, SENDER_ID, prepared.payloadHash);
    expect(result).toMatchObject({ status: 'succeeded', attemptCount: 3 });
    expect(f.api.calls).toHaveLength(3);
    expect(f.delays).toEqual([100, 200]);
    f.outbox.close();
  });

  it('stops after three proven pre-send attempts', async () => {
    const f = await fixture();
    f.api.outcomes.push(...Array.from({ length: 4 }, () => ({
      type: 'error' as const, code: 'request_pre_send',
    })));
    const prepared = f.outbox.prepare(draft());
    const result = await f.outbox.confirmAndSubmit(prepared.requestId, SENDER_ID, prepared.payloadHash);
    expect(result).toMatchObject({ status: 'failed', attemptCount: 3, errorCode: 'request_pre_send' });
    expect(f.api.calls).toHaveLength(3);
    expect(f.delays).toEqual([100, 200]);
    f.outbox.close();
  });

  it.each(['request_maybe_sent', 'naver_invalid_response']) (
    'moves %s directly to reconciliation without retry',
    async code => {
      const f = await fixture();
      f.api.outcomes.push({ type: 'error', code });
      const prepared = f.outbox.prepare(draft());
      const result = await f.outbox.confirmAndSubmit(prepared.requestId, SENDER_ID, prepared.payloadHash);
      expect(result).toMatchObject({ status: 'pending_reconcile', attemptCount: 1, errorCode: code });
      expect(f.api.calls).toHaveLength(1);
      expect(f.delays).toEqual([]);
      f.outbox.close();
    },
  );

  it.each(['naver_auth', 'naver_rate_limited', 'naver_http', 'naver_invalid_request'])(
    'maps proven %s rejection to failed without retry',
    async code => {
      const f = await fixture();
      f.api.outcomes.push({ type: 'error', code });
      const prepared = f.outbox.prepare(draft());
      await expect(f.outbox.confirmAndSubmit(prepared.requestId, SENDER_ID, prepared.payloadHash)).resolves
        .toMatchObject({ status: 'failed', attemptCount: 1, errorCode: code });
      expect(f.api.calls).toHaveLength(1);
      expect(f.delays).toEqual([]);
      f.outbox.close();
    },
  );

  it('maps a server response to uncertain reconciliation without retry', async () => {
    const f = await fixture();
    f.api.outcomes.push({ type: 'error', code: 'naver_server' });
    const prepared = f.outbox.prepare(draft());
    await expect(f.outbox.confirmAndSubmit(prepared.requestId, SENDER_ID, prepared.payloadHash)).resolves
      .toMatchObject({ status: 'pending_reconcile', attemptCount: 1, errorCode: 'naver_server' });
    expect(f.api.calls).toHaveLength(1);
    expect(f.delays).toEqual([]);
    f.outbox.close();
  });

  it('moves a modify response directly to reconciliation', async () => {
    const f = await fixture();
    f.api.outcomes.push({ type: 'success', processType: 'modify' });
    const prepared = f.outbox.prepare(draft());
    const result = await f.outbox.confirmAndSubmit(prepared.requestId, SENDER_ID, prepared.payloadHash);
    expect(result).toMatchObject({
      status: 'pending_reconcile', processType: 'modify', returnedIcalUid: prepared.uid,
    });
    expect(f.api.calls).toHaveLength(1);
    f.outbox.close();
  });

  it('moves a stale submitting row to reconciliation after restart without another API call', async () => {
    let crash = true;
    const f = await fixture({
      checkpoint: phase => {
        if (crash && phase === 'afterAcquire') throw new Error('simulated process exit');
      },
    });
    const prepared = f.outbox.prepare(draft());
    f.outbox.confirm(prepared.requestId, SENDER_ID, prepared.payloadHash);
    await expect(f.outbox.submit(prepared.requestId, SENDER_ID)).rejects.toThrow('simulated process exit');
    expect(f.outbox.get(prepared.requestId)).toMatchObject({ status: 'submitting', attemptCount: 0 });
    f.outbox.close();

    crash = false;
    f.advance(15_001);
    const reopened = f.create();
    await expect(reopened.recover()).resolves.toEqual([]);
    f.advance(999);
    await expect(reopened.recover()).resolves.toEqual([expect.objectContaining({
      requestId: prepared.requestId, status: 'pending_reconcile', errorCode: 'stale_submitting',
    })]);
    expect(f.api.calls).toHaveLength(0);
    reopened.close();
  });
});

describe('CalendarOutbox reconciliation and retention', () => {
  it('succeeds only for one exact calendar ID and UID with the Task 4 semantic hash', async () => {
    const f = await fixture();
    const pending = await makePending(f);
    const local = parseIcal(pending.payloadIcal, pending.calendarId)[0];
    f.caldav.outcomes.push([
      { ...local, calendarId: 'other' },
      { ...local, uid: 'other-uid' },
      local,
    ]);
    const [result] = await f.outbox.reconcile(pending.requestId);
    expect(result).toMatchObject({ status: 'succeeded', requestId: pending.requestId });
    expect(result.processType).toBeUndefined();
    expect(result.returnedIcalUid).toBe(pending.uid);
    expect(f.caldav.calls).toHaveLength(1);
    expect(f.warnings).toEqual([]);
    f.outbox.close();
  });

  it('reconciles a recurring master without counting its exceptions as duplicate matches', async () => {
    const f = await fixture();
    const input = draft({ rrule: { freq: 'WEEKLY', interval: 1 } });
    f.api.outcomes.push({ type: 'error', code: 'request_maybe_sent' });
    const prepared = f.outbox.prepare(input);
    await f.outbox.confirmAndSubmit(prepared.requestId, SENDER_ID, prepared.payloadHash);
    const master = parseIcal(prepared.payloadIcal, prepared.calendarId)[0];
    const exception = (recurrenceId: string, summary: string) => parseIcal(buildIcal({
      calendarId: prepared.calendarId,
      uid: prepared.uid,
      recurrenceId,
      dtstart: recurrenceId,
      dtend: new Date(Date.parse(recurrenceId) + 60 * 60 * 1_000).toISOString(),
      summary,
    }), prepared.calendarId)[0];
    f.caldav.outcomes.push([
      master,
      exception('2026-09-01T00:00:00Z', 'First exception'),
      exception('2026-09-08T00:00:00Z', 'Second exception'),
    ]);
    await expect(f.outbox.reconcile(prepared.requestId)).resolves.toEqual([
      expect.objectContaining({ status: 'succeeded' }),
    ]);
    f.outbox.close();
  });

  it('reconciles only the exact recurrence exception identity', async () => {
    const f = await fixture();
    const recurrenceId = '2026-09-01T00:00:00Z';
    const input = draft({
      recurrenceId,
      dtstart: recurrenceId,
      dtend: '2026-09-01T01:00:00Z',
      summary: 'Moved occurrence',
    });
    f.api.outcomes.push({ type: 'error', code: 'request_maybe_sent' });
    const prepared = f.outbox.prepare(input);
    await f.outbox.confirmAndSubmit(prepared.requestId, SENDER_ID, prepared.payloadHash);
    const exact = parseIcal(prepared.payloadIcal, prepared.calendarId)[0];
    const master = { ...exact, recurrenceId: undefined };
    const otherException = { ...exact, recurrenceId: '2026-09-08T00:00:00.000Z', summary: 'Other occurrence' };
    f.caldav.outcomes.push([master, otherException, exact]);
    await expect(f.outbox.reconcile(prepared.requestId)).resolves.toEqual([
      expect.objectContaining({ status: 'succeeded' }),
    ]);
    f.outbox.close();
  });

  it('fails and requests confirmation when the one exact match has a semantic mismatch', async () => {
    const f = await fixture();
    const pending = await makePending(f);
    const local = parseIcal(pending.payloadIcal, pending.calendarId)[0];
    f.caldav.outcomes.push([{ ...local, summary: 'Changed on server' }]);
    const [result] = await f.outbox.reconcile(pending.requestId);
    expect(result).toMatchObject({ status: 'failed', errorCode: 'reconcile_payload_mismatch' });
    expect(f.warnings).toEqual([expect.objectContaining({
      requestId: pending.requestId, reason: 'confirmation_required', idempotencyKey: expect.any(String),
    })]);
    f.outbox.close();
  });

  it('fails and requests confirmation when multiple exact matches exist', async () => {
    const f = await fixture();
    const pending = await makePending(f);
    const local = parseIcal(pending.payloadIcal, pending.calendarId)[0];
    f.caldav.outcomes.push([local, { ...local }]);
    const [result] = await f.outbox.reconcile(pending.requestId);
    expect(result).toMatchObject({ status: 'failed', errorCode: 'reconcile_multiple_matches' });
    expect(f.warnings).toEqual([expect.objectContaining({
      requestId: pending.requestId, reason: 'confirmation_required', idempotencyKey: expect.any(String),
    })]);
    f.outbox.close();
  });

  it('keeps zero matches or unavailable CalDAV pending and warns only once', async () => {
    const f = await fixture();
    const pending = await makePending(f);
    f.caldav.outcomes.push(new Error('CalDAV offline'), [], []);
    await f.outbox.reconcile(pending.requestId);
    await f.outbox.reconcile(pending.requestId);
    const [result] = await f.outbox.reconcile(pending.requestId);
    expect(result).toMatchObject({ status: 'pending_reconcile', errorCode: 'reconcile_not_found' });
    expect(f.warnings).toEqual([expect.objectContaining({
      requestId: pending.requestId, reason: 'reconcile_unavailable', idempotencyKey: expect.any(String),
    })]);
    f.outbox.close();
  });

  it('retries a failed warning after restart with the same idempotency key and stops after delivery', async () => {
    const attempts: CalendarOutboxWarning[] = [];
    let fail = true;
    const f = await fixture({
      warn: warning => {
        attempts.push(warning);
        if (fail) throw new Error('warning sink unavailable');
      },
    });
    const pending = await makePending(f);
    f.caldav.outcomes.push(new Error('CalDAV offline'));
    await expect(f.outbox.reconcile(pending.requestId)).rejects.toThrow('warning sink unavailable');
    f.outbox.close();

    fail = false;
    const reopened = f.create();
    await reopened.recover();
    await reopened.recover();
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ reason: 'reconcile_unavailable' });
    expect(attempts[1].idempotencyKey).toBe(attempts[0].idempotencyKey);
    reopened.close();
  });

  it('rejects plain retention evidence and deletes only payload-covered rows from a verified snapshot', async () => {
    const f = await fixture();
    const prepared = f.outbox.prepare(draft());
    await f.outbox.confirmAndSubmit(prepared.requestId, SENDER_ID, prepared.payloadHash);
    const unresolved = f.outbox.prepare(draft({ uid: 'unresolved' }));
    f.outbox.close();
    const backupRoot = await backupSnapshotFixture(f.stateDir);
    const evidence = VerifiedOutboxBackupEvidence.verifySnapshot(backupRoot);
    const reopened = f.create();
    f.advance(30 * 24 * 60 * 60 * 1_000);
    expect(() => reopened.pruneSucceeded({
      manifestId: evidence.manifestId,
      manifestHash: evidence.manifestHash,
      coveredRequests: [[prepared.requestId, prepared.payloadHash]],
    } as never)).toThrowError(expect.objectContaining({ code: 'invalid_backup_evidence' }));
    expect(reopened.pruneSucceeded(evidence)).toEqual([]);
    f.advance(1_000);
    expect(reopened.pruneSucceeded(evidence)).toEqual([prepared.requestId]);
    expect(reopened.get(prepared.requestId)).toBeUndefined();
    expect(reopened.get(unresolved.requestId)).toMatchObject({ status: 'draft' });
    expect(reopened.auditEntries()).toEqual([expect.objectContaining({
      requestId: prepared.requestId,
      payloadHash: prepared.payloadHash,
      backupManifestId: evidence.manifestId,
      backupManifestHash: evidence.manifestHash,
    })]);
    reopened.close();
  });

  it('rechecks the live payload hash before pruning a covered request', async () => {
    const f = await fixture();
    const prepared = f.outbox.prepare(draft());
    await f.outbox.confirmAndSubmit(prepared.requestId, SENDER_ID, prepared.payloadHash);
    f.outbox.close();
    const evidence = VerifiedOutboxBackupEvidence.verifySnapshot(await backupSnapshotFixture(f.stateDir));
    const database = new DatabaseSync(join(f.stateDir, 'calendar-outbox.sqlite3'));
    database.prepare('UPDATE calendar_requests SET payload_hash = ? WHERE request_id = ?')
      .run('f'.repeat(64), prepared.requestId);
    database.close();
    const reopened = f.create();
    f.advance(31 * 24 * 60 * 60 * 1_000);
    const prototype = VerifiedOutboxBackupEvidence.prototype as unknown as { covers?: () => boolean };
    const originalCovers = prototype.covers;
    prototype.covers = () => true;
    try {
      expect(reopened.pruneSucceeded(evidence)).toEqual([]);
    } finally {
      if (originalCovers) prototype.covers = originalCovers;
      else delete prototype.covers;
    }
    expect(reopened.get(prepared.requestId)).toBeDefined();
    reopened.close();
  });

  it('rejects a manifest whose SQLite coverage hash does not match the actual snapshot', async () => {
    const f = await fixture();
    f.outbox.prepare(draft());
    f.outbox.close();
    const backupRoot = await backupSnapshotFixture(f.stateDir);
    const manifestPath = join(backupRoot, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { files: Array<{ sha256: string }> };
    manifest.files[0].sha256 = 'f'.repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
    expect(() => VerifiedOutboxBackupEvidence.verifySnapshot(backupRoot)).toThrowError(
      expect.objectContaining({ code: 'invalid_backup_evidence' }),
    );
  });
});

describe('CalendarOutbox validation', () => {
  it('rejects invalid payload identity before persisting a request', async () => {
    const f = await fixture();
    const input = draft();
    expect(() => f.outbox.prepare({ ...input, uid: 'different' })).toThrowError(CalendarOutboxError);
    expect(() => f.outbox.prepare({ ...input, payloadHash: '0'.repeat(64) })).toThrowError(
      expect.objectContaining({ code: 'payload_changed' }),
    );
    f.outbox.close();
  });
});
