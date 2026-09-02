import type { AddStudyRecordInput } from '../domain.js';
import type { AddTaskInput } from '../workspace/repository.js';

export interface AssignmentDecomposeInput {
  courseName: string;
  assignmentTitle: string;
  deadline: string;
  totalEstimatedMinutes?: number;
  blockDurationMinutes?: number;
  customSteps?: string[];
}

export interface DecomposedStep {
  stepIndex: number;
  title: string;
  description: string;
  durationMinutes: number;
}

export interface DecomposedAssignment {
  courseName: string;
  assignmentTitle: string;
  totalBlocks: number;
  totalEstimatedMinutes: number;
  steps: DecomposedStep[];
}

export interface ExistingEvent {
  start: string;
  end: string;
  title?: string;
}

export interface AssignmentScheduleInput extends AssignmentDecomposeInput {
  now?: Date;
  existingEvents?: ExistingEvent[];
}

export interface ScheduledBlock {
  title: string;
  start: string;
  end: string;
  stepIndex: number;
}

export interface AssignmentScheduleResult {
  decomposed: DecomposedAssignment;
  blocks: ScheduledBlock[];
  studyRecordInput: AddStudyRecordInput;
  subtaskInputs: AddTaskInput[];
}

const DEFAULT_BLOCK_MINUTES = 50;
const DEFAULT_TOTAL_MINUTES = 200;
const SEOUL_TZ = 'Asia/Seoul';

export function decomposeAssignment(input: AssignmentDecomposeInput): DecomposedAssignment {
  const blockDuration = input.blockDurationMinutes ?? DEFAULT_BLOCK_MINUTES;
  const totalMinutes = input.totalEstimatedMinutes ?? DEFAULT_TOTAL_MINUTES;
  const totalBlocks = Math.max(1, Math.ceil(totalMinutes / blockDuration));

  if (input.customSteps && input.customSteps.length > 0) {
    const steps: DecomposedStep[] = input.customSteps.map((step, idx) => ({
      stepIndex: idx + 1,
      title: `[${idx + 1}/${input.customSteps!.length}] [${input.courseName}] ${input.assignmentTitle}: ${step}`,
      description: `${input.courseName} 과제: ${input.assignmentTitle} - ${step}`,
      durationMinutes: blockDuration,
    }));
    return {
      courseName: input.courseName,
      assignmentTitle: input.assignmentTitle,
      totalBlocks: steps.length,
      totalEstimatedMinutes: steps.length * blockDuration,
      steps,
    };
  }

  const steps: DecomposedStep[] = [];
  for (let i = 1; i <= totalBlocks; i++) {
    let milestone = '';
    if (totalBlocks === 1) {
      milestone = '요구사항 분석 및 과제 수행/제출';
    } else if (totalBlocks === 2) {
      milestone = i === 1 ? '요구사항 분석 및 자료 수집 / 초안 작성' : '본문 작성 / 구현 및 최종 검토';
    } else if (totalBlocks === 3) {
      if (i === 1) milestone = '요구사항 분석 및 자료 조사';
      else if (i === 2) milestone = '핵심 설계 및 본문 작성 / 구현';
      else milestone = '결과 정리 및 최종 검토 / 제출';
    } else {
      if (i === 1) milestone = '요구사항 분석 및 자료 수집';
      else if (i === totalBlocks) milestone = '최종 검토 및 제출 준비';
      else if (i === totalBlocks - 1) milestone = '결과 종합 및 초안 정리';
      else milestone = `본문 작성 및 세부 문제 풀이 / 구현 (Part ${i - 1})`;
    }

    steps.push({
      stepIndex: i,
      title: `[${i}/${totalBlocks}] [${input.courseName}] ${input.assignmentTitle}: ${milestone}`,
      description: `${input.courseName} 과제: ${input.assignmentTitle} (${i}/${totalBlocks} 블록)`,
      durationMinutes: blockDuration,
    });
  }

  return {
    courseName: input.courseName,
    assignmentTitle: input.assignmentTitle,
    totalBlocks,
    totalEstimatedMinutes: totalBlocks * blockDuration,
    steps,
  };
}

export function scheduleAssignmentBlocks(input: AssignmentScheduleInput): AssignmentScheduleResult {
  const decomposed = decomposeAssignment(input);
  const deadlineDate = new Date(input.deadline);
  const now = input.now ?? new Date();
  const existing = (input.existingEvents ?? []).map(ev => ({
    startMs: new Date(ev.start).getTime(),
    endMs: new Date(ev.end).getTime(),
  }));

  const blockMinutes = input.blockDurationMinutes ?? DEFAULT_BLOCK_MINUTES;
  const breakMinutes = 10;
  const slotDurationMs = (blockMinutes + breakMinutes) * 60 * 1000;

  // Candidate preferred time windows each day (in KST hours)
  const candidateWindows = [
    { startHour: 19, endHour: 22 }, // Evening
    { startHour: 14, endHour: 18 }, // Afternoon
    { startHour: 9, endHour: 12 },  // Morning
  ];

  const blocks: ScheduledBlock[] = [];
  const assignedSlots: Array<{ startMs: number; endMs: number }> = [...existing];

  // We allocate slots working backward from deadline (leaving at least 2h buffer before deadline)
  const maxEndMs = deadlineDate.getTime() - 2 * 60 * 60 * 1000;
  const minStartMs = now.getTime() + 15 * 60 * 1000; // start at least 15m after now

  // Search candidate slots backwards day by day
  const candidateSlots: Array<{ start: Date; end: Date }> = [];
  const targetEnd = new Date(maxEndMs);

  // Iterate backwards day-by-day for up to 14 days
  for (let dayOffset = 0; dayOffset <= 14; dayOffset++) {
    const day = new Date(targetEnd.getTime() - dayOffset * 24 * 60 * 60 * 1000);
    const dateStr = formatSeoulDate(day);

    for (const win of candidateWindows) {
      // Create slot candidates within this window in reverse order
      for (let h = win.endHour - 1; h >= win.startHour; h--) {
        const slotStart = parseSeoulDateTime(`${dateStr}T${String(h).padStart(2, '0')}:00:00+09:00`);
        const slotEnd = new Date(slotStart.getTime() + blockMinutes * 60 * 1000);

        if (slotStart.getTime() >= minStartMs && slotEnd.getTime() <= maxEndMs) {
          const overlaps = assignedSlots.some(slot =>
            Math.max(slotStart.getTime(), slot.startMs) < Math.min(slotEnd.getTime(), slot.endMs)
          );
          if (!overlaps) {
            candidateSlots.push({ start: slotStart, end: slotEnd });
          }
        }
      }
    }
  }

  // Sort candidate slots chronologically forward
  candidateSlots.sort((a, b) => a.start.getTime() - b.start.getTime());

  // Pick totalBlocks slots (spread out if possible, or earliest available before deadline)
  const selectedSlots = candidateSlots.slice(0, decomposed.totalBlocks);

  // If candidate windows were too restricted, fallback to simple slot finder
  if (selectedSlots.length < decomposed.totalBlocks) {
    let currentMs = minStartMs;
    while (selectedSlots.length < decomposed.totalBlocks && currentMs + slotDurationMs <= maxEndMs) {
      const candidateStart = new Date(currentMs);
      const candidateEnd = new Date(currentMs + blockMinutes * 60 * 1000);
      const startHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: SEOUL_TZ, hour: 'numeric', hourCycle: 'h23' }).format(candidateStart));

      // Check quiet window (02:00 - 08:00)
      if (startHour >= 8 && startHour < 24) {
        const overlaps = assignedSlots.some(slot =>
          Math.max(candidateStart.getTime(), slot.startMs) < Math.min(candidateEnd.getTime(), slot.endMs)
        );
        const alreadySelected = selectedSlots.some(s =>
          Math.max(candidateStart.getTime(), s.start.getTime()) < Math.min(candidateEnd.getTime(), s.end.getTime())
        );

        if (!overlaps && !alreadySelected) {
          selectedSlots.push({ start: candidateStart, end: candidateEnd });
        }
      }
      currentMs += slotDurationMs;
    }
    selectedSlots.sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  // Assign steps to selected slots
  for (let i = 0; i < decomposed.steps.length; i++) {
    const step = decomposed.steps[i];
    const slot = selectedSlots[i] ?? {
      start: new Date(minStartMs + i * slotDurationMs),
      end: new Date(minStartMs + i * slotDurationMs + blockMinutes * 60 * 1000),
    };

    blocks.push({
      title: step.title,
      start: formatSeoulTimestamp(slot.start),
      end: formatSeoulTimestamp(slot.end),
      stepIndex: step.stepIndex,
    });
  }

  const studyRecordInput: AddStudyRecordInput = {
    kind: 'study',
    title: `[${input.courseName}] ${input.assignmentTitle}`,
    subject: input.assignmentTitle,
    category: 'school',
    courseName: input.courseName,
    targetAmount: decomposed.totalBlocks,
    unit: '블록',
    progress: 0,
    isAssignment: true,
    deadline: input.deadline,
    targetDate: formatSeoulDate(deadlineDate),
    body: `${input.courseName} 과제: ${input.assignmentTitle}\n총 예상 시간: ${decomposed.totalEstimatedMinutes}분 (${decomposed.totalBlocks}블록)\n마감일: ${input.deadline}`,
    source: 'telegram',
  };

  const subtaskInputs: AddTaskInput[] = blocks.map((block, idx) => ({
    title: block.title,
    body: `과제: ${input.assignmentTitle}\n단계: ${decomposed.steps[idx].description}\n집중 시간: ${block.start} ~ ${block.end}`,
    priority: 'high',
    dueAt: block.end,
    source: 'telegram',
  }));

  return {
    decomposed,
    blocks,
    studyRecordInput,
    subtaskInputs,
  };
}

function formatSeoulDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SEOUL_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function formatSeoulTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SEOUL_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}+09:00`;
}

function parseSeoulDateTime(isoWithTz: string): Date {
  return new Date(isoWithTz);
}
