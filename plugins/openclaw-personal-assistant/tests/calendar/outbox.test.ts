import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { CalendarOutbox, CalendarOutboxError } from '../../src/calendar/outbox.js';
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
  warnings?: Array<{ requestId: string; reason: string }>;
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
      warn: warning => { warnings.push({ requestId: warning.requestId, reason: warning.reason }); },
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

  it('preserves the full signed SQLite range of numeric sender IDs', async () => {
    const f = await fixture();
    const senderId = '9007199254740993';
    const prepared = f.outbox.prepare(draft());
    expect(f.outbox.confirm(prepared.requestId, senderId, prepared.payloadHash)).toMatchObject({
      confirmedBy: senderId,
    });
    await expect(f.outbox.submit(prepared.requestId, senderId)).resolves.toMatchObject({ status: 'succeeded' });
    f.outbox.close();
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
    expect(reopened.recover()).toEqual([expect.objectContaining({
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

  it('fails and requests confirmation when the one exact match has a semantic mismatch', async () => {
    const f = await fixture();
    const pending = await makePending(f);
    const local = parseIcal(pending.payloadIcal, pending.calendarId)[0];
    f.caldav.outcomes.push([{ ...local, summary: 'Changed on server' }]);
    const [result] = await f.outbox.reconcile(pending.requestId);
    expect(result).toMatchObject({ status: 'failed', errorCode: 'reconcile_payload_mismatch' });
    expect(f.warnings).toEqual([{ requestId: pending.requestId, reason: 'confirmation_required' }]);
    f.outbox.close();
  });

  it('fails and requests confirmation when multiple exact matches exist', async () => {
    const f = await fixture();
    const pending = await makePending(f);
    const local = parseIcal(pending.payloadIcal, pending.calendarId)[0];
    f.caldav.outcomes.push([local, { ...local }]);
    const [result] = await f.outbox.reconcile(pending.requestId);
    expect(result).toMatchObject({ status: 'failed', errorCode: 'reconcile_multiple_matches' });
    expect(f.warnings).toEqual([{ requestId: pending.requestId, reason: 'confirmation_required' }]);
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
    expect(f.warnings).toEqual([{ requestId: pending.requestId, reason: 'reconcile_unavailable' }]);
    f.outbox.close();
  });

  it('deletes succeeded rows older than 30 days only with manifest inclusion evidence', async () => {
    const f = await fixture();
    const prepared = f.outbox.prepare(draft());
    await f.outbox.confirmAndSubmit(prepared.requestId, SENDER_ID, prepared.payloadHash);
    const unresolved = f.outbox.prepare(draft({ uid: 'unresolved' }));
    f.advance(30 * 24 * 60 * 60 * 1_000);
    expect(f.outbox.pruneSucceeded({ manifestId: 'backup-1', includedRequestIds: [prepared.requestId] })).toEqual([]);
    f.advance(1_000);
    expect(f.outbox.pruneSucceeded({ manifestId: 'backup-2', includedRequestIds: [] })).toEqual([]);
    expect(f.outbox.pruneSucceeded({
      manifestId: 'backup-3', includedRequestIds: [prepared.requestId, unresolved.requestId],
    })).toEqual([prepared.requestId]);
    expect(f.outbox.get(prepared.requestId)).toBeUndefined();
    expect(f.outbox.get(unresolved.requestId)).toMatchObject({ status: 'draft' });
    expect(f.outbox.auditEntries()).toEqual([expect.objectContaining({
      requestId: prepared.requestId,
      payloadHash: prepared.payloadHash,
      backupManifestId: 'backup-3',
    })]);
    f.outbox.close();
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
