import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';

import type { StudyBlock, StudyDayStatus } from './types.js';

export function buildStudyReminder(
  block: StudyBlock,
  kind: 'start' | 'follow_up',
): ReplyPayload {
  const heading = kind === 'start' ? '공부 시작 시간입니다' : '아직 공부 중인가요?';
  const text = [
    `${heading}: ${block.title}`,
    `${block.durationMinutes}분 집중 · ${block.id}`,
    '',
    `완료: /study done ${block.id}`,
    `10분 미루기: /study snooze ${block.id}`,
    `건너뛰기: /study skip ${block.id}`,
  ].join('\n');
  return {
    text,
    presentation: {
      title: heading,
      tone: kind === 'start' ? 'info' : 'warning',
      blocks: [
        { type: 'text', text: `${block.title}\n${block.durationMinutes}분 집중 · ${block.id}` },
        {
          type: 'buttons',
          buttons: [
            {
              label: '완료', style: 'success', priority: 3,
              action: { type: 'callback', value: `ocstudy:done:${block.id}` },
            },
            {
              label: '10분 미루기', style: 'secondary', priority: 2,
              action: { type: 'callback', value: `ocstudy:snooze:${block.id}` },
            },
            {
              label: '건너뛰기', style: 'danger', priority: 1,
              action: { type: 'callback', value: `ocstudy:skip:${block.id}` },
            },
          ],
        },
        { type: 'context', text: `버튼이 안 보이면 /study done ${block.id}` },
      ],
    },
  };
}

export function buildStudyReport(
  status: StudyDayStatus,
  kind: 'interim' | 'final',
): ReplyPayload {
  const title = kind === 'interim' ? '22시 중간 정리' : '02시 마감 정리';
  const percent = Math.round(status.completionRate * 100);
  const text = [
    `${title} · ${status.dayKey}`,
    `달성률 ${percent}%`,
    `완료 ${status.counts.completed} · 진행 ${status.counts.active + status.counts.snoozed}`,
    `예정 ${status.counts.planned} · 건너뜀 ${status.counts.skipped} · 놓침 ${status.counts.missed}`,
  ].join('\n');
  return {
    text,
    presentation: {
      title,
      tone: kind === 'final' ? 'neutral' : 'info',
      blocks: [
        { type: 'text', text: `달성률 ${percent}%` },
        { type: 'context', text: text.split('\n').slice(2).join('\n') },
      ],
    },
  };
}
