export type StudyBlockStatus =
  | 'planned'
  | 'active'
  | 'snoozed'
  | 'completed'
  | 'skipped'
  | 'missed';

export interface StudySettings {
  timezone: 'Asia/Seoul';
  windowStartHour: 8;
  windowEndHour: 2;
  focusMinutes: number;
  breakMinutes: number;
  followUpMinutes: number;
  maxFollowUps: number;
  interimReportHour: 22;
}

export const DEFAULT_STUDY_SETTINGS: StudySettings = Object.freeze({
  timezone: 'Asia/Seoul',
  windowStartHour: 8,
  windowEndHour: 2,
  focusMinutes: 50,
  breakMinutes: 10,
  followUpMinutes: 15,
  maxFollowUps: 2,
  interimReportHour: 22,
});

export interface StudyPlanBlockInput {
  title: string;
  startAt: string;
  durationMinutes?: number;
}

export interface StudyBlock {
  id: string;
  studyId: string;
  dayKey: string;
  title: string;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  status: StudyBlockStatus;
  followUpCount: number;
  nextDueAt?: string;
  snoozedUntil?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StudyPlanResult {
  operationId: string;
  replayed: boolean;
  blocks: StudyBlock[];
}

export type StudyTransitionAction =
  | { type: 'done' }
  | { type: 'skip' }
  | { type: 'snooze'; minutes?: number };

export interface StudyTransitionResult {
  operationId: string;
  replayed: boolean;
  block: StudyBlock;
}

export interface StudyDayStatus {
  dayKey: string;
  blocks: StudyBlock[];
  counts: Record<StudyBlockStatus, number>;
  completionRate: number;
}

export interface StudyDueAction {
  kind: 'start' | 'follow_up' | 'missed';
  dueAt: string;
  block: StudyBlock;
}

export interface StudyRecoveryResult {
  missed: number;
}

export class StudyStoreError extends Error {
  constructor(public readonly code: string, message: string, public detail?: unknown) {
    super(message);
    this.name = 'StudyStoreError';
  }
}
