import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildIcal, semanticEventHash, type CalendarEventDraft } from '../../src/calendar/ical.js';
import { CalendarOutbox } from '../../src/calendar/outbox.js';
import { createCalendarRecoveryService } from '../../src/calendar/recovery-service.js';
import { NaverCalendarError } from '../../src/calendar/naver-api.js';
import { SubsystemHealthStore } from '../../src/state/health.js';
import { createBriefingTool } from '../../src/tools/briefing.js';

const OWNER = '123456789';
const START = new Date('2026-08-25T00:00:00.000Z');
const config = {
  workspaceDir: '/tmp/assistant-workspace', stateDir: '/tmp/assistant-state',
  backupDir: '/tmp/assistant-backup', telegramUserId: OWNER, timezone: 'Asia/Seoul',
  calendar: {
    caldavReadEnabled: true,
    caldavBaseUrl: 'https://caldav.example.test/',
    caldavSecretFile: '/tmp/assistant-secrets/caldav',
    calendarMappings: [{ apiCalendarId: 'personal', caldavHref: 'https://caldav.example.test/personal/' }],
  },
} as const;

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 20,
  })));
});

async function stateDir(): Promise<string> {
  const path = `/tmp/assistant-recovery-${randomUUID()}`;
  directories.push(path);
  return path;
}

function event(requestId = randomUUID()): CalendarEventDraft & { requestId: string } {
  return {
    requestId, calendarId: 'personal', uid: `event-${requestId}@example.test`,
    dtstart: '2026-08-25T10:00:00+09:00', dtend: '2026-08-25T11:00:00+09:00',
    summary: 'Owner appointment',
  };
}

function prepare(outbox: CalendarOutbox, draft: CalendarEventDraft & { requestId: string }) {
  return outbox.prepare({
    requestId: draft.requestId, calendarId: draft.calendarId, uid: draft.uid,
    payloadIcal: buildIcal(draft), payloadHash: semanticEventHash(draft),
  });
}

function apiFor(state: string, calendar: Record<string, unknown> = config.calendar) {
  return { config: {}, pluginConfig: { ...config, stateDir: state, calendar } } as never;
}

function serviceContext(state: string) {
  return { config: {}, stateDir: state, logger: { debug() {}, info() {}, warn() {}, error() {} } } as never;
}

describe('calendar recovery plugin service', () => {
  it('reports durable limited mode and performs zero network work while CalDAV reads are disabled', async () => {
    const state = await stateDir();
    const fetch = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetch;
    const service = createCalendarRecoveryService(apiFor(state, { ...config.calendar, caldavReadEnabled: false }));
    try {
      await service.start(serviceContext(state));
      const health = new SubsystemHealthStore(state);
      expect(health.listActive()).toContainEqual({
        target: 'naver-caldav', errorCode: 'caldav_read_disabled',
        message: 'Calendar reads are disabled pending authorized live validation',
      });
      health.close();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await service.stop?.(serviceContext(state));
      globalThis.fetch = originalFetch;
    }
  });

  it('recovers a real stale submission and records its durable warning while disabled without network', async () => {
    const state = await stateDir();
    const draft = event('44444444-4444-4444-8444-444444444444');
    const initial = new CalendarOutbox({
      stateDir: state, now: () => START,
      api: { async createSchedule() { throw new Error('create must not run'); } },
      caldav: { async listEvents() { throw new Error('CalDAV must not run'); } },
      checkpoint(phase) { if (phase === 'afterAcquire') throw new Error('simulated crash'); },
    });
    const request = prepare(initial, draft);
    await expect(initial.confirmAndSubmit(request.requestId, OWNER, request.payloadHash)).rejects.toThrow('simulated crash');
    initial.close();
    const fetch = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetch;
    const service = createCalendarRecoveryService(apiFor(state, {
      ...config.calendar, caldavReadEnabled: false, caldavSecretFile: '/must-not-read/caldav',
    }));
    try {
      await service.start(serviceContext(state));
      const inspect = new CalendarOutbox({
        stateDir: state,
        api: { async createSchedule() { throw new Error('create must not run'); } },
        caldav: { async listEvents() { throw new Error('CalDAV must not run'); } },
      });
      expect(inspect.get(request.requestId)).toMatchObject({ status: 'pending_reconcile', errorCode: 'stale_submitting' });
      inspect.close();
      const health = new SubsystemHealthStore(state);
      expect(health.listActive()).toContainEqual({
        target: `calendar-reconcile:${request.requestId}`,
        errorCode: 'stale_submitting',
        message: 'Calendar reconciliation requires owner attention',
      });
      health.close();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await service.stop?.(serviceContext(state));
      globalThis.fetch = originalFetch;
    }
  });

  it('closes health when the disabled local outbox cannot be opened', async () => {
    const state = await stateDir();
    const report = vi.fn();
    const close = vi.fn();
    const service = createCalendarRecoveryService(apiFor(state, { ...config.calendar, caldavReadEnabled: false }), {
      openHealth: () => ({ report, recover() {}, listActive: () => [], close }),
      openOutbox() { throw new Error('local outbox unavailable'); },
    });
    await expect(service.start(serviceContext(state))).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledWith({
      target: 'calendar-recovery', errorCode: 'recovery_start_failed',
      message: 'Calendar recovery service is unavailable',
    });
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('recovers a stale submitting request and reconciles an exact CalDAV match without create', async () => {
    const state = await stateDir();
    const draft = event('11111111-1111-4111-8111-111111111111');
    const initial = new CalendarOutbox({
      stateDir: state, now: () => START,
      api: { async createSchedule() { throw new Error('create must not run in fixture'); } },
      caldav: { async listEvents() { return []; } },
      checkpoint(phase) { if (phase === 'afterAcquire') throw new Error('simulated crash'); },
    });
    const request = prepare(initial, draft);
    await expect(initial.confirmAndSubmit(request.requestId, OWNER, request.payloadHash))
      .rejects.toThrow('simulated crash');
    initial.close();

    const createSchedule = vi.fn();
    const service = createCalendarRecoveryService(apiFor(state), {
      intervalMs: 60_000,
      openOutbox(scoped, warn) {
        return new CalendarOutbox({
          stateDir: scoped.stateDir, now: () => new Date(START.valueOf() + 20_000),
          api: { async createSchedule(input) { createSchedule(input); throw new Error('forbidden'); } },
          caldav: { async listEvents() { return [draft]; } }, warn,
        });
      },
    });

    await service.start(serviceContext(state));
    const inspect = new CalendarOutbox({
      stateDir: state, api: { async createSchedule() { throw new Error('forbidden'); } },
      caldav: { async listEvents() { return []; } },
    });
    expect(inspect.get(request.requestId)).toMatchObject({ status: 'succeeded' });
    inspect.close();
    expect(createSchedule).not.toHaveBeenCalled();
    await service.stop?.(serviceContext(state));
  });

  it('writes an ambiguous request-specific warning visible through the durable health journal', async () => {
    const state = await stateDir();
    const draft = event('22222222-2222-4222-8222-222222222222');
    const initial = new CalendarOutbox({
      stateDir: state, now: () => START,
      api: { async createSchedule() { throw new NaverCalendarError('naver_server', 'unknown'); } },
      caldav: { async listEvents() { return []; } },
    });
    const request = prepare(initial, draft);
    await initial.confirmAndSubmit(request.requestId, OWNER, request.payloadHash);
    initial.close();

    const service = createCalendarRecoveryService(apiFor(state), {
      openOutbox(scoped, warn) {
        return new CalendarOutbox({
          stateDir: scoped.stateDir,
          api: { async createSchedule() { throw new Error('forbidden'); } },
          caldav: { async listEvents() { return [draft, draft]; } }, warn,
        });
      },
    });
    await service.start(serviceContext(state));

    const health = new SubsystemHealthStore(state);
    expect(health.listActive()).toContainEqual({
      target: `calendar-reconcile:${request.requestId}`,
      errorCode: 'confirmation_required',
      message: 'Calendar reconciliation requires owner attention',
    });
    health.close();
    let briefingText = '';
    const briefing = createBriefingTool(apiFor(state), {
      requesterSenderId: OWNER, senderIsOwner: true, sessionKey: 'owner-session',
      deliveryContext: { channel: 'telegram', to: OWNER },
    }, {
      now: () => new Date('2026-08-25T09:00:00+09:00'),
      openRepository: () => ({ async query() { return []; }, close() {} }),
      openCalendar: () => ({ async listEvents() { return []; } }),
      send: async params => {
        briefingText = params.payloads.map(payload => payload.text ?? '').join('\n');
        return {
          status: 'sent',
          payloadOutcomes: params.payloads.map((_payload, index) => ({ index, status: 'sent' as const })),
        };
      },
    });
    await briefing.execute('recovery-warning-briefing', {});
    expect(briefingText).toContain(`confirmation_required (calendar-reconcile:${request.requestId})`);
    await service.stop?.(serviceContext(state));
  });

  it('recovers the exact request warning after verified reconciliation succeeds', async () => {
    const state = await stateDir();
    const draft = event('33333333-3333-4333-8333-333333333333');
    const initial = new CalendarOutbox({
      stateDir: state,
      api: { async createSchedule() { throw new NaverCalendarError('naver_server', 'unknown'); } },
      caldav: { async listEvents() { return []; } },
    });
    const request = prepare(initial, draft);
    await initial.confirmAndSubmit(request.requestId, OWNER, request.payloadHash);
    initial.close();
    const health = new SubsystemHealthStore(state);
    health.report({
      target: `calendar-reconcile:${request.requestId}`, errorCode: 'reconcile_unavailable',
      message: 'Calendar reconciliation requires owner attention',
    });
    health.close();

    const service = createCalendarRecoveryService(apiFor(state), {
      openOutbox(scoped, warn) {
        return new CalendarOutbox({
          stateDir: scoped.stateDir,
          api: { async createSchedule() { throw new Error('forbidden'); } },
          caldav: { async listEvents() { return [draft]; } }, warn,
        });
      },
    });
    await service.start(serviceContext(state));
    const reopened = new SubsystemHealthStore(state);
    expect(reopened.listActive().map(item => item.target)).not.toContain(`calendar-reconcile:${request.requestId}`);
    reopened.close();
    await service.stop?.(serviceContext(state));
  });

  it('cancels periodic work on stop and does not run a queued cycle afterward', async () => {
    const state = await stateDir();
    let queued: (() => void) | undefined;
    const listEvents = vi.fn(async () => []);
    const service = createCalendarRecoveryService(apiFor(state), {
      intervalMs: 10,
      schedule(callback) { queued = callback; return 1; },
      cancel() {},
      openOutbox(scoped, warn) {
        return new CalendarOutbox({
          stateDir: scoped.stateDir,
          api: { async createSchedule() { throw new Error('forbidden'); } },
          caldav: { listEvents }, warn,
        });
      },
    });
    await service.start(serviceContext(state));
    await service.stop?.(serviceContext(state));
    queued?.();
    await Promise.resolve();
    expect(listEvents).not.toHaveBeenCalled();
  });

  it('backs off after a periodic failure and never overlaps cycles', async () => {
    const state = await stateDir();
    const delays: number[] = [];
    const queued: Array<() => void> = [];
    let recoverCalls = 0;
    let active = 0;
    let maximumActive = 0;
    const service = createCalendarRecoveryService(apiFor(state), {
      intervalMs: 10,
      openHealth: () => ({ report() {}, recover() {}, listActive: () => [], close() {} }),
      openOutbox: () => ({
        async recover() {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          recoverCalls += 1;
          active -= 1;
          if (recoverCalls > 1) throw new Error('periodic failure');
          return [];
        },
        pendingReconcileIds: () => [], async reconcile() { return []; }, close() {},
      }),
      schedule(callback, delay) { queued.push(callback); delays.push(delay); return callback; },
      cancel() {},
    });
    await service.start(serviceContext(state));
    queued.shift()?.();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(delays).toEqual([10, 20]);
    expect(maximumActive).toBe(1);
    await service.stop?.(serviceContext(state));
  });

  it('caps recovery reconciliation to one request per network cycle', async () => {
    const state = await stateDir();
    const reconcile = vi.fn(async (requestId: string) => [{ requestId, status: 'pending' }]);
    const pendingReconcileIds = vi.fn((limit: number) => Array.from({ length: limit }, (_, index) => `pending-${index}`));
    const service = createCalendarRecoveryService(apiFor(state), {
      openHealth: () => ({ report() {}, recover() {}, listActive: () => [], close() {} }),
      openOutbox: () => ({ async recover() { return []; }, pendingReconcileIds, reconcile, close() {} }),
      schedule() { return undefined; }, cancel() {},
    });
    await service.start(serviceContext(state));
    await service.stop?.(serviceContext(state));
    expect(pendingReconcileIds).toHaveBeenCalledWith(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('waits for an active periodic cycle before closing resources', async () => {
    const state = await stateDir();
    let queued: (() => void) | undefined;
    let release: (() => void) | undefined;
    let calls = 0;
    const close = vi.fn();
    const service = createCalendarRecoveryService(apiFor(state), {
      intervalMs: 10,
      openHealth: () => ({ report() {}, recover() {}, listActive: () => [], close }),
      openOutbox: () => ({
        async recover() {
          calls += 1;
          if (calls > 1) await new Promise<void>(resolve => { release = resolve; });
          return [];
        },
        pendingReconcileIds: () => [], async reconcile() { return []; }, close,
      }),
      schedule(callback) { queued = callback; return callback; }, cancel() {},
    });
    await service.start(serviceContext(state));
    queued?.();
    await Promise.resolve();
    const stopping = service.stop?.(serviceContext(state));
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    release?.();
    await stopping;
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('aborts an active reconciliation cycle promptly when the service stops', async () => {
    const state = await stateDir();
    let observedSignal: AbortSignal | undefined;
    let queued: (() => void) | undefined;
    let cycle = 0;
    const service = createCalendarRecoveryService(apiFor(state, { ...config.calendar, caldavReadEnabled: true }), {
      intervalMs: 10,
      openHealth: () => ({ report() {}, recover() {}, listActive: () => [], close() {} }),
      openOutbox: (_config, _warn, signal) => ({
        async recover() { cycle += 1; return []; },
        pendingReconcileIds: () => cycle > 1 ? ['pending'] : [],
        async reconcile() {
          observedSignal = signal;
          await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
          return [];
        },
        close() {},
      }),
      schedule(callback) { queued = callback; return callback; }, cancel() {},
    });
    await service.start(serviceContext(state));
    queued?.();
    await new Promise(resolve => setTimeout(resolve, 0));
    await expect(service.stop?.(serviceContext(state))).resolves.toBeUndefined();
    expect(observedSignal?.aborted).toBe(true);
  });

  it('reports and closes a startup failure without rejecting service start', async () => {
    const state = await stateDir();
    const report = vi.fn();
    const close = vi.fn();
    const service = createCalendarRecoveryService(apiFor(state), {
      openHealth: () => ({ report, recover() {}, listActive: () => [], close }),
      openOutbox() { throw new Error('outbox unavailable'); },
    });
    await expect(service.start(serviceContext(state))).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledWith({
      target: 'calendar-recovery', errorCode: 'recovery_start_failed',
      message: 'Calendar recovery service is unavailable',
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('still closes and does not reject when the startup warning sink itself fails', async () => {
    const state = await stateDir();
    const close = vi.fn();
    const service = createCalendarRecoveryService(apiFor(state), {
      openHealth: () => ({
        report() { throw new Error('health unavailable'); }, recover() {}, listActive: () => [], close,
      }),
      openOutbox() { throw new Error('outbox unavailable'); },
    });

    await expect(service.start(serviceContext(state))).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
