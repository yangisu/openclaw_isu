import { describe, expect, it } from 'vitest';
import {
  decomposeAssignment,
  scheduleAssignmentBlocks,
  type AssignmentScheduleInput,
} from '../../src/study/assignment-scheduler.js';

describe('assignment breakdown & scheduling engine', () => {
  it('decomposes assignment into 50-minute focused blocks with descriptive milestones', () => {
    const decomposed = decomposeAssignment({
      courseName: '운영체제',
      assignmentTitle: '가상메모리 페이징 구현',
      deadline: '2026-09-10T23:59:00+09:00',
      totalEstimatedMinutes: 200, // 4 blocks of 50m
      blockDurationMinutes: 50,
    });

    expect(decomposed.totalBlocks).toBe(4);
    expect(decomposed.steps).toHaveLength(4);
    expect(decomposed.steps[0].title).toContain('[1/4]');
    expect(decomposed.steps[0].title).toContain('요구사항 분석');
    expect(decomposed.steps[3].title).toContain('[4/4]');
    expect(decomposed.steps[3].title).toContain('최종 검토');
  });

  it('allocates slots backward before deadline avoiding sleep window (02:00-08:00) and existing events', () => {
    const input: AssignmentScheduleInput = {
      courseName: '자료구조',
      assignmentTitle: 'B-Tree 구현 과제',
      deadline: '2026-09-06T20:00:00+09:00',
      totalEstimatedMinutes: 150, // 3 blocks
      now: new Date('2026-09-04T09:00:00+09:00'),
      existingEvents: [
        {
          start: '2026-09-05T14:00:00+09:00',
          end: '2026-09-05T16:00:00+09:00',
          title: '팀 회의',
        },
      ],
    };

    const scheduled = scheduleAssignmentBlocks(input);
    expect(scheduled.blocks).toHaveLength(3);

    for (const block of scheduled.blocks) {
      const start = new Date(block.start);
      const end = new Date(block.end);
      const startHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', hour: 'numeric', hourCycle: 'h23' }).format(start));

      // Must not be in sleep window (02:00 - 08:00)
      expect(startHour).toBeGreaterThanOrEqual(8);
      expect(startHour).toBeLessThan(24);

      // Must be before deadline
      expect(end.getTime()).toBeLessThanOrEqual(new Date(input.deadline).getTime());

      // Must not overlap with existing event (2026-09-05 14:00 - 16:00)
      const eventStart = new Date('2026-09-05T14:00:00+09:00').getTime();
      const eventEnd = new Date('2026-09-05T16:00:00+09:00').getTime();
      const blockStart = start.getTime();
      const blockEnd = end.getTime();
      const overlaps = Math.max(blockStart, eventStart) < Math.min(blockEnd, eventEnd);
      expect(overlaps).toBe(false);
    }
  });

  it('generates study record and subtask inputs ready for workspace repository and calendar', () => {
    const input: AssignmentScheduleInput = {
      courseName: '인공지능',
      assignmentTitle: 'CNN 분류기 작성',
      deadline: '2026-09-08T18:00:00+09:00',
      totalEstimatedMinutes: 100, // 2 blocks
      now: new Date('2026-09-05T10:00:00+09:00'),
    };

    const result = scheduleAssignmentBlocks(input);
    expect(result.studyRecordInput).toMatchObject({
      kind: 'study',
      category: 'school',
      courseName: '인공지능',
      subject: 'CNN 분류기 작성',
      targetAmount: 2,
      unit: '블록',
      isAssignment: true,
      deadline: '2026-09-08T18:00:00+09:00',
    });

    expect(result.subtaskInputs).toHaveLength(2);
    expect(result.subtaskInputs[0].priority).toBe('high');
    expect(result.subtaskInputs[0].dueAt).toBeDefined();
  });
});
