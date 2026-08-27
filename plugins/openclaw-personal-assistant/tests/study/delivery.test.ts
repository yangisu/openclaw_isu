import { describe, expect, it } from 'vitest';

import { buildStudyReminder, buildStudyReport } from '../../src/study/delivery.js';
import type { StudyBlock, StudyDayStatus } from '../../src/study/types.js';

const block: StudyBlock = {
  id: 'B-20260827-001', studyId: 'S-20260827-001', dayKey: '2026-08-27',
  title: '수학 문제 풀이', startAt: '2026-08-27T10:00:00+09:00',
  endAt: '2026-08-27T10:50:00+09:00', durationMinutes: 50,
  status: 'planned', followUpCount: 0, nextDueAt: '2026-08-27T10:00:00+09:00',
  createdAt: '2026-08-27T09:00:00+09:00', updatedAt: '2026-08-27T09:00:00+09:00',
};

describe('study delivery payloads', () => {
  it.each(['start', 'follow_up'] as const)('includes native actions and text fallback for %s', kind => {
    const payload = buildStudyReminder(block, kind);

    expect(payload.text).toContain('/study done B-20260827-001');
    expect(payload.text).toContain('/study snooze B-20260827-001');
    expect(payload.text).toContain('/study skip B-20260827-001');
    expect(payload.presentation?.blocks).toContainEqual({
      type: 'buttons',
      buttons: [
        expect.objectContaining({ action: { type: 'callback', value: 'ocstudy:done:B-20260827-001' } }),
        expect.objectContaining({ action: { type: 'callback', value: 'ocstudy:snooze:B-20260827-001' } }),
        expect.objectContaining({ action: { type: 'callback', value: 'ocstudy:skip:B-20260827-001' } }),
      ],
    });
  });

  it('builds compact interim and final reports from deterministic local status', () => {
    const status: StudyDayStatus = {
      dayKey: '2026-08-27', blocks: [block], completionRate: 0.5,
      counts: { planned: 0, active: 0, snoozed: 0, completed: 1, skipped: 0, missed: 1 },
    };

    expect(buildStudyReport(status, 'interim').text).toContain('22시 중간 정리');
    expect(buildStudyReport(status, 'final').text).toContain('02시 마감 정리');
    expect(buildStudyReport(status, 'final').text).toContain('달성률 50%');
  });
});
