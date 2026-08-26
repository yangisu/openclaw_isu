export type RecordKind =
  | 'task'
  | 'study'
  | 'note'
  | 'preference'
  | 'memory'
  | 'inbox'
  | 'daily';

export interface OrderedField {
  key: string;
  rawValue: string;
}

export interface ParsedRecord {
  id: string;
  title: string;
  orderedFields: OrderedField[];
  fields: Record<string, unknown>;
  body: string;
}

export interface ParsedDocument {
  kind: RecordKind;
  preamble: string;
  records: ParsedRecord[];
}

interface CommonRecordFields {
  type: string;
  created_at: string;
  updated_at: string;
  source: string;
  archived_at?: string;
  archive_reason?: string;
}

export interface TaskRecord extends CommonRecordFields {
  type: 'task';
  status: 'open' | 'in_progress' | 'done' | 'archived';
  priority: 'high' | 'normal' | 'low';
  due_at?: string;
  completed_at?: string;
}

export interface StudyRecord extends CommonRecordFields {
  type: 'study';
  status: 'open' | 'in_progress' | 'done' | 'archived';
  subject: string;
  target_amount: number;
  unit: string;
  progress: number;
  target_date?: string;
  recurrence?: 'none' | 'daily' | 'weekly';
  review_dates?: string[];
}

export interface NoteRecord extends CommonRecordFields {
  type: 'note';
  status: 'active' | 'archived';
  url?: string;
  tags?: string[];
}

export interface PreferenceRecord extends CommonRecordFields {
  type: 'preference';
  active: boolean;
  supersedes?: string;
}

export interface MemoryRecord extends CommonRecordFields {
  type: 'memory';
  active: boolean;
  supersedes?: string;
  sensitivity?: 'normal' | 'sensitive';
}

export interface InboxRecord extends CommonRecordFields {
  type: 'inbox';
  status: 'pending' | 'resolved' | 'archived';
  reason: string;
  original_text: string;
  resolved_at?: string;
  target_id?: string;
}

export interface DailyRecord extends CommonRecordFields {
  type: 'daily';
  entry_at: string;
  related_ids?: string[];
}

interface AddRecordBase {
  title: string;
  body?: string;
  source: string;
}

export interface AddTaskRecordInput extends AddRecordBase {
  kind: 'task';
  status?: TaskRecord['status'];
  priority?: TaskRecord['priority'];
  dueAt?: string;
  completedAt?: string;
}

export interface AddStudyRecordInput extends AddRecordBase {
  kind: 'study';
  status?: StudyRecord['status'];
  subject: string;
  targetAmount: number;
  unit: string;
  progress?: number;
  targetDate?: string;
  recurrence?: StudyRecord['recurrence'];
  reviewDates?: string[];
}

export interface AddNoteRecordInput extends AddRecordBase {
  kind: 'note';
  status?: NoteRecord['status'];
  url?: string;
  tags?: string[];
}

export interface AddPreferenceRecordInput extends AddRecordBase {
  kind: 'preference';
  active?: boolean;
  supersedes?: string;
}

export interface AddMemoryRecordInput extends AddRecordBase {
  kind: 'memory';
  active?: boolean;
  supersedes?: string;
  sensitivity?: NonNullable<MemoryRecord['sensitivity']>;
}

export type AddRecordInput =
  | AddTaskRecordInput
  | AddStudyRecordInput
  | AddNoteRecordInput
  | AddPreferenceRecordInput
  | AddMemoryRecordInput;

export type AssistantRecord =
  | TaskRecord
  | StudyRecord
  | NoteRecord
  | PreferenceRecord
  | MemoryRecord
  | InboxRecord
  | DailyRecord;
