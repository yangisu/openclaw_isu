import { describe, expect, it, vi } from 'vitest';

import { createStudyCoachService } from '../../src/study/service.js';
import type { StudyBlock, StudyDayStatus, StudyDueAction } from '../../src/study/types.js';

const config = {
  workspaceDir: '/private/workspace', stateDir: '/private/state', backupDir: '/private/backups',
  telegramUserId: '6520016662', timezone: 'Asia/Seoul',
} as const;

const block: StudyBlock = {
  id: 'B-20260827-001', studyId: 'S-20260827-001', dayKey: '2026-08-27', title: '영어 독해',
  startAt: '2026-08-27T10:00:00+09:00', endAt: '2026-08-27T10:50:00+09:00',
  durationMinutes: 50, status: 'planned', followUpCount: 0,
  nextDueAt: '2026-08-27T10:00:00+09:00', createdAt: '2026-08-27T09:00:00+09:00',
  updatedAt: '2026-08-27T09:00:00+09:00',
};

function harness(options: { sendStatus?: 'sent' | 'failed'; initialNow?: string } = {}) {
  let now = new Date(options.initialNow ?? '2026-08-27T09:59:00+09:00');
  let due: StudyDueAction | null = { kind: 'start', dueAt: block.startAt, block };
  const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
  const store = {
    recover: vi.fn(() => ({ missed: 0 })),
    nextDue: vi.fn(() => due),
    consumeDue: vi.fn(() => { due = null; return { kind: 'start', dueAt: block.startAt, block }; }),
    current: vi.fn((): StudyDayStatus => ({
      dayKey: '2026-08-27', blocks: [block], completionRate: 0,
      counts: { planned: 1, active: 0, snoozed: 0, completed: 0, skipped: 0, missed: 0 },
    })),
    settings: vi.fn(() => ({
      timezone: 'Asia/Seoul' as const, windowStartHour: 8 as const, windowEndHour: 2 as const,
      focusMinutes: 50, breakMinutes: 10, followUpMinutes: 15, maxFollowUps: 2,
      interimReportHour: 22 as const,
    })),
    isReportDelivered: vi.fn(() => false), markReportDelivered: vi.fn(), close: vi.fn(),
  };
  const health = { report: vi.fn(), recover: vi.fn(), listActive: vi.fn(() => []), close: vi.fn() };
  const send = vi.fn(async () => ({
    status: options.sendStatus ?? 'sent',
    payloadOutcomes: [{ index: 0, status: options.sendStatus ?? 'sent' }],
  }));
  const service = createStudyCoachService({ pluginConfig: config, config: {} } as never, {
    now: () => now, openStore: () => store, openHealth: () => health, send,
    schedule(callback, delay) {
      const timer = { callback: () => { timer.cancelled = true; callback(); }, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel(handle) { (handle as typeof timers[number]).cancelled = true; },
  });
  return {
    service, store, health, send, timers,
    setNow(value: string) { now = new Date(value); },
    setDue(value: StudyDueAction | null) { due = value; },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
}

describe('study coach service', () => {
  it('keeps one timer, delivers the earliest reminder, and advances only after success', async () => {
    const h = harness();
    await h.service.start({} as never);
    expect(h.store.recover).toHaveBeenCalledTimes(1);
    expect(h.timers.filter(timer => !timer.cancelled)).toHaveLength(1);
    expect(h.timers[0]?.delay).toBe(60_000);

    h.setNow('2026-08-27T10:00:00+09:00');
    h.timers[0]?.callback();
    await flush();

    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'telegram', to: '6520016662', durability: 'required',
    }));
    expect(h.store.consumeDue).toHaveBeenCalledTimes(1);
    expect(h.health.recover).toHaveBeenCalledWith('study-delivery');
    expect(h.timers.filter(timer => !timer.cancelled)).toHaveLength(1);
    await h.service.stop?.({} as never);
  });

  it('does not consume a failed reminder and retries it after five minutes', async () => {
    const h = harness({ sendStatus: 'failed', initialNow: '2026-08-27T10:00:00+09:00' });
    await h.service.start({} as never);
    await flush();

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.store.consumeDue).not.toHaveBeenCalled();
    expect(h.health.report).toHaveBeenCalledWith(expect.objectContaining({
      target: 'study-delivery', errorCode: 'study_delivery_failed',
    }));
    expect(h.timers.filter(timer => !timer.cancelled).at(-1)?.delay).toBe(300_000);
    await h.service.stop?.({} as never);
  });

  it('caps long waits at one hour and cancels its sole timer on stop', async () => {
    const h = harness({ initialNow: '2026-08-27T10:40:00+09:00' });
    h.setDue(null);
    await h.service.start({} as never);

    expect(h.timers[0]?.delay).toBe(3_600_000);
    await h.service.stop?.({} as never);
    expect(h.timers[0]?.cancelled).toBe(true);
    expect(h.store.close).toHaveBeenCalledTimes(1);
    expect(h.health.close).toHaveBeenCalledTimes(1);
  });

  it('delivers the prior study day final report across the 02:00 day boundary', async () => {
    const h = harness({ initialNow: '2026-08-28T02:00:00+09:00' });
    h.setDue(null);
    await h.service.start({} as never);

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.store.current).toHaveBeenCalledWith(new Date('2026-08-28T01:59:59+09:00'));
    expect(h.store.markReportDelivered).toHaveBeenCalledWith(
      '2026-08-27', 'final', new Date('2026-08-28T02:00:00+09:00'),
    );
    await h.service.stop?.({} as never);
  });
});
