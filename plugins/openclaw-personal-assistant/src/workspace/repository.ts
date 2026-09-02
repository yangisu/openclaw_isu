/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { AssistantConfig } from '../config.js';
import type {
  AddRecordInput,
  AssistantRecord,
  MemoryRecord,
  NoteRecord,
  ParsedDocument,
  ParsedRecord,
  PreferenceRecord,
  RecordKind,
  StudyRecord,
  TaskRecord,
} from '../domain.js';
import { parseDocument, serializeDocument, validateRecord } from '../markdown/codec.js';
import { OperationLedger, type LedgerOperation } from '../state/operations.js';
import {
  WorkspaceLockCoordinator,
  type CoordinatedAcquisition,
} from './lock-coordinator.js';

export type RepositoryCheckpoint = 'beforeRename' | 'afterRename' | 'afterGitCommit';

export interface AddTaskInput {
  title: string;
  body?: string;
  status?: TaskRecord['status'];
  priority?: TaskRecord['priority'];
  dueAt?: string;
  completedAt?: string;
  source: string;
}

export interface RecordPatch {
  title?: string;
  body?: string;
  fields?: Partial<AssistantRecord>;
}

export interface QueryCriteria {
  kind?: RecordKind;
  id?: string;
  includeArchived?: boolean;
}

export interface MutationResult {
  operationId: string;
  id: string;
  replayed: boolean;
  record: ParsedRecord;
  gitCommit?: string;
}

export interface RepositoryOptions {
  now?: () => Date;
  checkpoint?: (phase: RepositoryCheckpoint) => void | Promise<void>;
}

export class WorkspaceRepositoryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
    this.name = 'WorkspaceRepositoryError';
  }
}

interface PreparedFile {
  relativePath: string;
  beforeHash: string | null;
  afterHash: string;
  contents: string;
}

interface PreparedMutation {
  version: 1;
  action: 'add-task' | 'add-record' | 'update-record' | 'archive-record';
  result: MutationResult;
  files: PreparedFile[];
}

interface WorkspaceRecordLocation {
  kind: RecordKind;
  relativePath: string;
  archived: boolean;
  record: ParsedRecord;
}

interface WorkspaceIdIndex {
  ids: Set<string>;
  locations: WorkspaceRecordLocation[];
  byId: Map<string, WorkspaceRecordLocation>;
}

interface WorkspaceLockMetadata {
  version: 1;
  pid: number;
  createdAt: string;
  ownerId: string;
  operationId?: string;
}

interface LockSnapshot {
  contents: string;
  dev: number | bigint;
  ino: number | bigint;
  size: number | bigint;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}

interface HeldWorkspaceLock {
  handle: FileHandle;
  metadata: WorkspaceLockMetadata;
  snapshot: LockSnapshot;
}

const KIND_FILE: Readonly<Partial<Record<RecordKind, string>>> = {
  task: 'TASKS.md',
  study: 'STUDY.md',
  note: 'NOTES.md',
  preference: 'USER.md',
  memory: 'MEMORY.md',
  inbox: 'INBOX.md',
};

const PREFIX_KIND: Readonly<Record<string, RecordKind>> = {
  T: 'task',
  S: 'study',
  N: 'note',
  U: 'preference',
  M: 'memory',
  I: 'inbox',
  D: 'daily',
};

const KIND_PREFIX: Readonly<Record<RecordKind, string>> = {
  task: 'T',
  study: 'S',
  note: 'N',
  preference: 'U',
  memory: 'M',
  inbox: 'I',
  daily: 'D',
};

const ALL_KINDS: readonly RecordKind[] = [
  'task', 'study', 'note', 'preference', 'memory', 'inbox', 'daily',
];

const DEFAULT_PREAMBLE: Readonly<Record<RecordKind, string>> = {
  task: '# Tasks\n\n',
  study: '# Study\n\n',
  note: '# Notes\n\n',
  preference: '# User\n\n',
  memory: '# Memory\n\n',
  inbox: '# Inbox\n\n',
  daily: '# Daily Memory\n\n',
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function operationPayloadHash(value: unknown): string {
  return sha256(stableJson(value));
}

function cloneRecord(record: ParsedRecord): ParsedRecord {
  return {
    id: record.id,
    title: record.title,
    orderedFields: record.orderedFields.map(field => ({ ...field })),
    fields: { ...record.fields },
    body: record.body,
  };
}

function recordSemantics(record: ParsedRecord): unknown {
  return {
    id: record.id,
    title: record.title,
    fields: record.fields,
    body: record.body,
  };
}

function isPrepared(value: unknown): value is PreparedMutation {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<PreparedMutation>;
  return candidate.version === 1 && Array.isArray(candidate.files) && candidate.result !== undefined;
}

function timestampInSeoul(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}+09:00`;
}

function dateInSeoul(date: Date): string {
  return timestampInSeoul(date).slice(0, 10).replaceAll('-', '');
}

function ensureAppendBoundary(document: ParsedDocument): void {
  if (document.records.length === 0) {
    if (!document.preamble.endsWith('\n\n')) {
      document.preamble = `${document.preamble.replace(/\n*$/, '')}\n\n`;
    }
    return;
  }
  const last = document.records.at(-1)!;
  if (!last.body.endsWith('\n\n')) last.body = `${last.body.replace(/\n*$/, '')}\n\n`;
}

function kindFromId(id: string): RecordKind {
  const kind = PREFIX_KIND[id.slice(0, 1)];
  if (!kind) throw new WorkspaceRepositoryError('invalid_record_id', `unknown record ID: ${id}`);
  return kind;
}

function managedFile(kind: RecordKind): string {
  const path = KIND_FILE[kind];
  if (!path) {
    throw new WorkspaceRepositoryError(
      'unsupported_record_kind',
      `repository mutation does not support ${kind} records`,
    );
  }
  return path;
}

function relativeToFs(workspaceDir: string, relativePath: string): string {
  return join(workspaceDir, ...relativePath.split('/'));
}

function validateOperationId(operationId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId)) {
    throw new WorkspaceRepositoryError(
      'invalid_operation_id',
      'operation ID must be 1-128 safe ASCII characters',
    );
  }
}

const UPDATE_FIELDS: Readonly<Record<RecordKind, ReadonlySet<string>>> = {
  task: new Set(['type', 'created_at', 'source', 'status', 'priority', 'due_at', 'completed_at']),
  study: new Set([
    'type', 'created_at', 'source', 'status', 'category', 'course_name', 'subject',
    'target_amount', 'unit', 'progress', 'target_date', 'deadline', 'is_assignment',
    'subtask_ids', 'recurrence', 'review_dates',
  ]),
  note: new Set(['type', 'created_at', 'source', 'status', 'url', 'tags']),
  preference: new Set(['type', 'created_at', 'source', 'active', 'supersedes']),
  memory: new Set(['type', 'created_at', 'source', 'active', 'supersedes', 'sensitivity']),
  inbox: new Set([
    'type', 'created_at', 'source', 'status', 'reason', 'original_text', 'resolved_at', 'target_id',
  ]),
  daily: new Set(['type', 'created_at', 'source', 'entry_at', 'related_ids']),
};

/** Validates patch-only constraints that do not depend on the current record. */
export function validateRecordPatch(kind: RecordKind, patch: RecordPatch): void {
  if (typeof patch !== 'object' || patch === null) {
    throw new WorkspaceRepositoryError('invalid_patch', 'record patch must be an object');
  }
  if (patch.title !== undefined) {
    if (typeof patch.title !== 'string' || patch.title.length === 0
      || /[\r\n\u0000-\u001f\u007f]/.test(patch.title)) {
      throw new WorkspaceRepositoryError('invalid_title', 'record title must be one printable line');
    }
    if (patch.title.length > 500) {
      throw new WorkspaceRepositoryError('input_too_long', 'record title exceeds 500 characters');
    }
  }
  if (patch.body !== undefined) {
    if (typeof patch.body !== 'string') {
      throw new WorkspaceRepositoryError('invalid_body', 'record body must be text');
    }
    if (patch.body.length > 16_000) {
      throw new WorkspaceRepositoryError('input_too_long', 'record body exceeds 16000 characters');
    }
    if (/[\r\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(patch.body)
      || /(?:^|\n)### [^\n]*/.test(patch.body)) {
      throw new WorkspaceRepositoryError(
        'invalid_body',
        'record body cannot contain carriage returns, controls, or level-three record headings',
      );
    }
  }
  if (patch.fields !== undefined) {
    if (typeof patch.fields !== 'object' || patch.fields === null || Array.isArray(patch.fields)) {
      throw new WorkspaceRepositoryError('invalid_patch_fields', 'patch fields must be an object');
    }
    const fields = patch.fields as Record<string, unknown>;
    const unexpected = Object.keys(fields).filter(key => !UPDATE_FIELDS[kind].has(key));
    if (unexpected.length > 0) {
      throw new WorkspaceRepositoryError(
        'invalid_patch_fields',
        `fields are not mutable for ${kind}: ${unexpected.join(', ')}`,
      );
    }
    if ('source' in fields
      && (typeof fields.source !== 'string'
        || !/^[a-z][a-z0-9_-]{0,99}$/.test(fields.source))) {
      throw new WorkspaceRepositoryError('invalid_source', 'record source is invalid');
    }
    for (const [key, value] of [
      ['target_amount', fields.target_amount],
      ['progress', fields.progress],
    ] as const) {
      if (value !== undefined && !Number.isSafeInteger(value)) {
        throw new WorkspaceRepositoryError(
          key === 'progress' ? 'invalid_progress' : 'invalid_target_amount',
          `${key} must be a safe decimal integer`,
        );
      }
    }
    for (const key of ['due_at', 'completed_at', 'resolved_at', 'entry_at', 'deadline'] as const) {
      const value = fields[key];
      if (value !== undefined && !isStrictTimestamp(value)) {
        throw new WorkspaceRepositoryError('invalid_timestamp', `${key} must be RFC 3339 with +09:00`);
      }
    }
    if (fields.category !== undefined && fields.category !== 'school' && fields.category !== 'personal') {
      throw new WorkspaceRepositoryError('invalid_category', 'category must be school or personal');
    }
    if (fields.is_assignment !== undefined && typeof fields.is_assignment !== 'boolean') {
      throw new WorkspaceRepositoryError('invalid_boolean', 'is_assignment must be boolean');
    }
    if (fields.target_date !== undefined && !isStrictDate(fields.target_date)) {
      throw new WorkspaceRepositoryError('invalid_date', 'target_date must be a valid YYYY-MM-DD value');
    }
    for (const [key, maximum, itemMaximum] of [
      ['review_dates', 64, undefined],
      ['tags', 64, 100],
      ['related_ids', 64, undefined],
      ['subtask_ids', 64, undefined],
    ] as const) {
      const value = fields[key];
      if (value !== undefined
        && (!Array.isArray(value) || value.length > maximum || new Set(value).size !== value.length)) {
        throw new WorkspaceRepositoryError(`invalid_${key}`, `${key} must contain unique items`);
      }
      if (Array.isArray(value) && itemMaximum !== undefined
        && value.some(item => typeof item !== 'string' || item.length === 0 || item.length > itemMaximum)) {
        throw new WorkspaceRepositoryError(`invalid_${key}`, `${key} contains an invalid item`);
      }
      if (key === 'review_dates' && Array.isArray(value)
        && value.some(item => !isStrictDate(item))) {
        throw new WorkspaceRepositoryError('invalid_date', 'review_dates must contain valid dates');
      }
    }
    for (const [key, maximum] of [
      ['subject', 500], ['course_name', 500], ['unit', 100], ['url', 2_048], ['reason', 1_000], ['original_text', 4_000],
    ] as const) {
      const value = fields[key];
      if (value !== undefined
        && (typeof value !== 'string' || value.length === 0 || value.length > maximum)) {
        throw new WorkspaceRepositoryError(
          value !== undefined && typeof value === 'string' && value.length > maximum
            ? 'input_too_long'
            : 'invalid_string',
          `${key} must be a non-empty string of at most ${maximum} characters`,
        );
      }
    }
  }
}

function isStrictDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1
    && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isStrictTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?\+09:00$/
    .exec(value);
  return match !== null && isStrictDate(`${match[1]}-${match[2]}-${match[3]}`);
}

function addRecordFields(input: AddRecordInput, timestamp: string): AssistantRecord {
  const common = {
    created_at: timestamp,
    updated_at: timestamp,
    source: input.source,
  };
  switch (input.kind) {
    case 'task':
      return {
        ...common,
        type: 'task',
        status: input.status ?? 'open',
        priority: input.priority ?? 'normal',
        ...(input.dueAt === undefined ? {} : { due_at: input.dueAt }),
        ...(input.completedAt === undefined ? {} : { completed_at: input.completedAt }),
      } satisfies TaskRecord;
    case 'study':
      return {
        ...common,
        type: 'study',
        status: input.status ?? 'open',
        ...(input.category === undefined ? {} : { category: input.category }),
        ...(input.courseName === undefined ? {} : { course_name: input.courseName }),
        subject: input.subject,
        target_amount: input.targetAmount,
        unit: input.unit,
        progress: input.progress ?? 0,
        ...(input.targetDate === undefined ? {} : { target_date: input.targetDate }),
        ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
        ...(input.isAssignment === undefined ? {} : { is_assignment: input.isAssignment }),
        ...(input.subtaskIds === undefined ? {} : { subtask_ids: input.subtaskIds }),
        ...(input.recurrence === undefined ? {} : { recurrence: input.recurrence }),
        ...(input.reviewDates === undefined ? {} : { review_dates: input.reviewDates }),
      } satisfies StudyRecord;
    case 'note':
      return {
        ...common,
        type: 'note',
        status: input.status ?? 'active',
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.tags === undefined ? {} : { tags: input.tags }),
      } satisfies NoteRecord;
    case 'preference':
      return {
        ...common,
        type: 'preference',
        active: input.active ?? true,
        ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
      } satisfies PreferenceRecord;
    case 'memory':
      return {
        ...common,
        type: 'memory',
        active: input.active ?? true,
        ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
        sensitivity: input.sensitivity ?? 'normal',
      } satisfies MemoryRecord;
  }
}

export function validateAddRecordInput(input: AddRecordInput): void {
  if (typeof input !== 'object' || input === null
    || !['task', 'study', 'note', 'preference', 'memory'].includes(input.kind)) {
    throw new WorkspaceRepositoryError(
      'unsupported_record_kind',
      'public record add supports task, study, note, preference, or memory',
    );
  }
  if (typeof input.source !== 'string' || !/^[a-z][a-z0-9_-]{0,99}$/.test(input.source)) {
    throw new WorkspaceRepositoryError(
      'invalid_source',
      'record source must be a 1-100 character lowercase identifier',
    );
  }
  if (typeof input.title !== 'string' || /[\r\n\u0000-\u001f\u007f]/.test(input.title)) {
    throw new WorkspaceRepositoryError(
      'invalid_title',
      'record title must be one printable line',
    );
  }
  if (input.title.length > 500) {
    throw new WorkspaceRepositoryError('input_too_long', 'record title exceeds 500 characters');
  }
  if (input.body !== undefined
    && (typeof input.body !== 'string' || input.body.length > 16_000)) {
    throw new WorkspaceRepositoryError('input_too_long', 'record body exceeds 16000 characters');
  }
  if (/[\r\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.body ?? '')
    || /(?:^|\n)### [^\n]*/.test(input.body ?? '')) {
    throw new WorkspaceRepositoryError(
      'invalid_body',
      'record body cannot contain carriage returns or level-three record headings',
    );
  }
  if (input.kind === 'study') {
    assertAddStringLimit(input.subject, 500, 'study subject');
    if (input.courseName !== undefined) assertAddStringLimit(input.courseName, 500, 'courseName');
    assertAddStringLimit(input.unit, 100, 'study unit');
    if (input.category !== undefined && input.category !== 'school' && input.category !== 'personal') {
      throw new WorkspaceRepositoryError('invalid_category', 'category must be school or personal');
    }
    if (input.deadline !== undefined && !isStrictTimestamp(input.deadline)) {
      throw new WorkspaceRepositoryError('invalid_timestamp', 'deadline must be RFC 3339 with +09:00');
    }
    if (input.isAssignment !== undefined && typeof input.isAssignment !== 'boolean') {
      throw new WorkspaceRepositoryError('invalid_boolean', 'isAssignment must be boolean');
    }
    if (input.subtaskIds !== undefined) {
      assertAddArray(input.subtaskIds, 64, 'invalid_subtask_ids', 'subtaskIds');
    }
    if (!Number.isSafeInteger(input.targetAmount)) {
      throw new WorkspaceRepositoryError(
        'invalid_target_amount',
        'targetAmount must be a safe decimal integer',
      );
    }
    if (input.progress !== undefined && !Number.isSafeInteger(input.progress)) {
      throw new WorkspaceRepositoryError(
        'invalid_progress',
        'progress must be a safe decimal integer',
      );
    }
    if (input.reviewDates !== undefined) {
      assertAddArray(input.reviewDates, 64, 'invalid_review_dates', 'reviewDates');
    }
  } else if (input.kind === 'note') {
    if (input.url !== undefined) assertAddStringLimit(input.url, 2_048, 'note URL');
    if (input.tags !== undefined) {
      assertAddArray(input.tags, 64, 'invalid_tags', 'tags');
      for (const tag of input.tags) assertAddStringLimit(tag, 100, 'note tag');
    }
  }
  const id = `${KIND_PREFIX[input.kind]}-20000101-001`;
  validateRecord({
    id,
    title: input.title,
    orderedFields: [],
    fields: { ...addRecordFields(input, '2000-01-01T00:00:00+09:00') },
    body: input.body ?? '',
  });
}

function assertAddStringLimit(value: unknown, maximum: number, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new WorkspaceRepositoryError('invalid_string', `${label} must be a non-empty string`);
  }
  if (value.length > maximum) {
    throw new WorkspaceRepositoryError('input_too_long', `${label} exceeds ${maximum} characters`);
  }
}

function assertAddArray(
  value: readonly unknown[],
  maximum: number,
  code: string,
  label: string,
): void {
  if (!Array.isArray(value) || value.length > maximum || new Set(value).size !== value.length) {
    throw new WorkspaceRepositoryError(
      code,
      `${label} must contain at most ${maximum} unique items`,
    );
  }
}

function isWorkspaceLockMetadata(value: unknown): value is WorkspaceLockMetadata {
  if (value === null || typeof value !== 'object') return false;
  const metadata = value as Partial<WorkspaceLockMetadata>;
  return metadata.version === 1
    && Number.isSafeInteger(metadata.pid)
    && (metadata.pid ?? 0) > 0
    && typeof metadata.createdAt === 'string'
    && Number.isFinite(Date.parse(metadata.createdAt))
    && typeof metadata.ownerId === 'string'
    && metadata.ownerId.length >= 16
    && (metadata.operationId === undefined
      || /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(metadata.operationId));
}

function sameLockSnapshot(left: LockSnapshot, right: LockSnapshot): boolean {
  return left.contents === right.contents
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

function isWindowsUnsupportedDirectoryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return process.platform === 'win32'
    && ['EACCES', 'EINVAL', 'EISDIR', 'EPERM'].includes(code ?? '');
}

export class WorkspaceRepository {
  public readonly ledger: OperationLedger;
  private readonly now: () => Date;
  private readonly lockCoordinator: WorkspaceLockCoordinator;
  private closed = false;

  constructor(
    private readonly config: AssistantConfig,
    private readonly options: RepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.lockCoordinator = new WorkspaceLockCoordinator(config.stateDir);
    this.ledger = new OperationLedger(config.stateDir);
  }

  async addTask(operationId: string, input: AddTaskInput): Promise<MutationResult> {
    const safeInput: AddTaskInput = {
      title: input.title,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
      ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
      source: input.source,
    };
    const typedInput: AddRecordInput = { kind: 'task', ...safeInput };
    validateOperationId(operationId);
    validateAddRecordInput(typedInput);
    return this.mutate(
      operationId,
      { action: 'add-task', input: safeInput },
      'add-task',
      async index => this.prepareAddRecord(operationId, typedInput, index, 'add-task'),
    );
  }

  async addRecord(operationId: string, input: AddRecordInput): Promise<MutationResult> {
    validateOperationId(operationId);
    validateAddRecordInput(input);
    if (input.kind === 'memory' && input.sensitivity === 'sensitive') {
      throw new WorkspaceRepositoryError(
        'confirmation_unavailable',
        'sensitive memory requires authoritative owner confirmation that is unavailable',
      );
    }
    return this.mutate(
      operationId,
      { action: 'add-record', input },
      'add-record',
      async index => this.prepareAddRecord(operationId, input, index, 'add-record'),
    );
  }

  async updateRecord(
    operationId: string,
    targetId: string,
    patch: RecordPatch,
  ): Promise<MutationResult> {
    return this.mutate(
      operationId,
      { action: 'update-record', targetId, patch },
      'update-record',
      async index => this.prepareUpdate(operationId, targetId, patch, index),
    );
  }

  async archiveRecord(
    operationId: string,
    targetId: string,
    reason: string,
  ): Promise<MutationResult> {
    return this.mutate(
      operationId,
      { action: 'archive-record', targetId, reason },
      'archive-record',
      async index => this.prepareArchive(operationId, targetId, reason, index),
    );
  }

  async query(criteria: QueryCriteria = {}): Promise<ParsedRecord[]> {
    return this.withLock(async () => {
      const index = await this.buildWorkspaceIdIndex();
      return index.locations
        .filter(location => criteria.kind === undefined || location.kind === criteria.kind)
        .filter(location => criteria.includeArchived || !location.archived)
        .map(location => cloneRecord(location.record))
        .filter(record => criteria.id === undefined || record.id === criteria.id);
    });
  }

  /** Runs a read-side snapshot while holding the same single-writer boundary as mutations. */
  async quiesce<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new WorkspaceRepositoryError('repository_closed', 'repository is closed');
    }
    return this.withLock(work);
  }

  close(): void {
    if (this.closed) return;
    this.ledger.close();
    this.closed = true;
  }

  private async mutate(
    operationId: string,
    payload: unknown,
    action: PreparedMutation['action'],
    prepare: (index: WorkspaceIdIndex) => Promise<PreparedMutation>,
  ): Promise<MutationResult> {
    validateOperationId(operationId);
    return this.withLock(async () => {
      const index = await this.buildWorkspaceIdIndex();
      const existing = this.ledger.get<PreparedMutation>(operationId);
      let prepared: PreparedMutation;
      if (existing === undefined) {
        prepared = await this.prepareMutation(operationId, index, prepare);
        this.ledger.begin(
          operationId,
          this.config.telegramUserId,
          operationPayloadHash(payload),
        );
        this.ledger.setPreparedResult(operationId, prepared);
      } else {
        const operation = this.ledger.begin(
          operationId,
          this.config.telegramUserId,
          operationPayloadHash(payload),
        ) as LedgerOperation<PreparedMutation>;
        if (operation.phase === 'committed' || operation.phase === 'replied') {
          return this.replayedResult(operation);
        }
        if (isPrepared(operation.result)) {
          prepared = operation.result;
          if (prepared.action !== action) {
            throw new WorkspaceRepositoryError(
              'operation_id_conflict',
              `operation ${operationId} has different mutation metadata`,
            );
          }
        } else {
          prepared = await this.prepareMutation(operationId, index, prepare);
          this.ledger.setPreparedResult(operationId, prepared);
        }
      }
      return this.reconcileOperation(operationId, prepared, existing !== undefined, false);
    }, operationId);
  }

  private async prepareMutation(
    operationId: string,
    index: WorkspaceIdIndex,
    prepare: (index: WorkspaceIdIndex) => Promise<PreparedMutation>,
  ): Promise<PreparedMutation> {
    try {
      return await prepare(index);
    } catch (error) {
      if (error instanceof WorkspaceRepositoryError && error.code === 'workspace_conflict') {
        await this.appendConflictInbox(operationId, error.message).catch(nested => {
          error.detail = { inboxAppendError: String(nested) };
        });
      }
      throw error;
    }
  }

  private async reconcileOperation(
    operationId: string,
    prepared: PreparedMutation,
    replayed: boolean,
    recovering: boolean,
  ): Promise<MutationResult> {
    let current = this.ledger.get<PreparedMutation>(operationId)!;
    if (current.phase === 'committed' || current.phase === 'replied') {
      return this.replayedResult(current);
    }
    if (current.phase === 'begun') {
      try {
        await this.applyPrepared(operationId, prepared);
      } catch (error) {
        if (error instanceof WorkspaceRepositoryError && error.code === 'workspace_conflict') {
          const conflict = recovering
            ? new WorkspaceRepositoryError(
              'operation_reconcile_conflict',
              `begun operation ${operationId} cannot be safely resumed: ${error.message}`,
              error,
            )
            : error;
          await this.appendConflictInbox(operationId, conflict.message).catch(nested => {
            conflict.detail = { cause: error, inboxAppendError: String(nested) };
          });
          throw conflict;
        }
        throw error;
      }
      this.ledger.markApplied(operationId, prepared);
      current = this.ledger.get<PreparedMutation>(operationId)!;
    }
    if (current.phase !== 'applied') {
      throw new WorkspaceRepositoryError(
        'invalid_operation_phase',
        `cannot reconcile operation ${operationId} in phase ${current.phase}`,
      );
    }
    try {
      await this.verifyApplied(prepared);
    } catch (error) {
      if (error instanceof WorkspaceRepositoryError
        && error.code === 'operation_reconcile_conflict') {
        await this.appendConflictInbox(operationId, error.message).catch(nested => {
          error.detail = { inboxAppendError: String(nested) };
        });
      }
      throw error;
    }

    let gitCommit = this.findOperationCommit(operationId, prepared);
    if (!gitCommit) {
      gitCommit = this.commitPrepared(operationId, prepared);
      await this.options.checkpoint?.('afterGitCommit');
    }
    const committed: PreparedMutation = {
      ...prepared,
      result: { ...prepared.result, gitCommit },
    };
    this.ledger.markCommitted(operationId, committed);
    return { ...committed.result, replayed };
  }

  private replayedResult(operation: LedgerOperation<PreparedMutation>): MutationResult {
    if (!isPrepared(operation.result)) {
      throw new WorkspaceRepositoryError(
        'operation_reconcile_conflict',
        `operation ${operation.operationId} has no recoverable result`,
      );
    }
    return { ...operation.result.result, replayed: true };
  }

  private async prepareAddRecord(
    operationId: string,
    input: AddRecordInput,
    index: WorkspaceIdIndex,
    action: 'add-task' | 'add-record',
  ): Promise<PreparedMutation> {
    const relativePath = managedFile(input.kind);
    this.assertGitPathClean(relativePath);
    const loaded = await this.readDocument(input.kind, relativePath);
    const date = dateInSeoul(this.now());
    const used = index.ids;
    let sequence = 1;
    let id = `${KIND_PREFIX[input.kind]}-${date}-${String(sequence).padStart(3, '0')}`;
    while (used.has(id)) {
      sequence += 1;
      if (sequence > 999) {
        throw new WorkspaceRepositoryError(
          'id_exhausted',
          `${input.kind} IDs exhausted for ${date}`,
        );
      }
      id = `${KIND_PREFIX[input.kind]}-${date}-${String(sequence).padStart(3, '0')}`;
    }
    const timestamp = timestampInSeoul(this.now());
    const record: ParsedRecord = {
      id,
      title: input.title,
      orderedFields: [],
      fields: { ...addRecordFields(input, timestamp) },
      body: input.body ?? '',
    };
    validateRecord(record);
    ensureAppendBoundary(loaded.document);
    loaded.document.records.push(record);
    const contents = serializeDocument(loaded.document);
    return this.preparedMutation(operationId, action, record, [
      this.preparedFile(relativePath, loaded.text, contents),
    ]);
  }

  private async prepareUpdate(
    operationId: string,
    targetId: string,
    patch: RecordPatch,
    index: WorkspaceIdIndex,
  ): Promise<PreparedMutation> {
    const kind = kindFromId(targetId);
    validateRecordPatch(kind, patch);
    const relativePath = this.activeRecordPath(index, kind, targetId);
    this.assertGitPathClean(relativePath);
    const loaded = await this.readDocument(kind, relativePath);
    const record = loaded.document.records.find(candidate => candidate.id === targetId);
    if (!record) {
      throw new WorkspaceRepositoryError('record_not_found', `record ${targetId} was not found`);
    }
    if (patch.fields?.type !== undefined && patch.fields.type !== record.fields.type) {
      throw new WorkspaceRepositoryError('immutable_record_type', 'record type cannot be changed');
    }
    if (patch.fields?.created_at !== undefined
      && patch.fields.created_at !== record.fields.created_at) {
      throw new WorkspaceRepositoryError('immutable_created_at', 'created_at cannot be changed');
    }
    if (kind === 'memory' && record.fields.sensitivity === 'sensitive') {
      throw new WorkspaceRepositoryError(
        'confirmation_unavailable',
        'Sensitive memory confirmation is unavailable for direct mutations',
      );
    }
    if (patch.title !== undefined) record.title = patch.title;
    if (patch.body !== undefined) record.body = patch.body;
    Object.assign(record.fields, patch.fields ?? {});
    record.fields.updated_at = timestampInSeoul(this.now());
    if (kind === 'memory' && record.fields.sensitivity === 'sensitive') {
      throw new WorkspaceRepositoryError(
        'confirmation_unavailable',
        'Sensitive memory confirmation is unavailable for direct mutations',
      );
    }
    validateRecord(record);
    const contents = serializeDocument(loaded.document);
    const roundTrip = parseDocument(kind, contents);
    const roundTripTargets = roundTrip.records.filter(candidate => candidate.id === targetId);
    if (roundTrip.records.length !== loaded.document.records.length
      || roundTripTargets.length !== 1
      || stableJson(recordSemantics(roundTripTargets[0]!)) !== stableJson(recordSemantics(record))) {
      throw new WorkspaceRepositoryError(
        'update_roundtrip_failed',
        `updated record ${targetId} did not survive Markdown round-trip`,
      );
    }
    return this.preparedMutation(operationId, 'update-record', record, [
      this.preparedFile(relativePath, loaded.text, contents),
    ]);
  }

  private async prepareArchive(
    operationId: string,
    targetId: string,
    reason: string,
    index: WorkspaceIdIndex,
  ): Promise<PreparedMutation> {
    if (reason.length === 0) {
      throw new WorkspaceRepositoryError('invalid_archive_reason', 'archive reason cannot be empty');
    }
    const kind = kindFromId(targetId);
    const relativePath = this.activeRecordPath(index, kind, targetId);
    const archivePath = kind === 'daily'
      ? `archive/${basename(relativePath)}`
      : `archive/${relativePath}`;
    this.assertGitPathClean(relativePath);
    this.assertGitPathClean(archivePath);
    const active = await this.readDocument(kind, relativePath);
    const archived = await this.readDocument(kind, archivePath);
    const recordIndex = active.document.records.findIndex(record => record.id === targetId);
    if (recordIndex < 0) {
      throw new WorkspaceRepositoryError('record_not_found', `record ${targetId} was not found`);
    }
    if (kind === 'memory'
      && active.document.records[recordIndex]!.fields.sensitivity === 'sensitive') {
      throw new WorkspaceRepositoryError(
        'confirmation_unavailable',
        'Sensitive memory confirmation is unavailable for direct mutations',
      );
    }
    const [record] = active.document.records.splice(recordIndex, 1);
    record.fields.updated_at = timestampInSeoul(this.now());
    record.fields.archived_at = timestampInSeoul(this.now());
    record.fields.archive_reason = reason;
    if ('status' in record.fields) record.fields.status = 'archived';
    if ('active' in record.fields) record.fields.active = false;
    ensureAppendBoundary(archived.document);
    archived.document.records.push(record);
    return this.preparedMutation(operationId, 'archive-record', record, [
      this.preparedFile(archivePath, archived.text, serializeDocument(archived.document)),
      this.preparedFile(relativePath, active.text, serializeDocument(active.document)),
    ]);
  }

  private preparedMutation(
    operationId: string,
    action: PreparedMutation['action'],
    record: ParsedRecord,
    files: PreparedFile[],
  ): PreparedMutation {
    return {
      version: 1,
      action,
      result: { operationId, id: record.id, replayed: false, record: cloneRecord(record) },
      files,
    };
  }

  private preparedFile(relativePath: string, before: string | null, contents: string): PreparedFile {
    return {
      relativePath,
      beforeHash: before === null ? null : sha256(before),
      afterHash: sha256(contents),
      contents,
    };
  }

  private async applyPrepared(operationId: string, prepared: PreparedMutation): Promise<void> {
    const pending: PreparedFile[] = [];
    for (const file of prepared.files) {
      const current = await this.readText(file.relativePath);
      const currentHash = current === null ? null : sha256(current);
      if (currentHash === file.afterHash) continue;
      if (currentHash !== file.beforeHash) {
        throw new WorkspaceRepositoryError(
          'workspace_conflict',
          `${file.relativePath} changed after the operation read it`,
        );
      }
      pending.push(file);
    }
    for (const file of pending) {
      await this.atomicReplace(file.relativePath, file.contents, operationId, file.beforeHash);
    }
  }

  private async verifyApplied(prepared: PreparedMutation): Promise<void> {
    for (const file of prepared.files) {
      const current = await this.readText(file.relativePath);
      if (current === null || sha256(current) !== file.afterHash) {
        throw new WorkspaceRepositoryError(
          'operation_reconcile_conflict',
          `applied operation does not match ${file.relativePath}`,
        );
      }
    }
  }

  private async atomicReplace(
    relativePath: string,
    contents: string,
    operationId: string,
    expectedHash: string | null,
  ): Promise<void> {
    const target = relativeToFs(this.config.workspaceDir, relativePath);
    const parent = dirname(target);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = join(parent, `${basename(target)}.tmp-${operationId}`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;

      await this.options.checkpoint?.('beforeRename');
      const latest = await this.readText(relativePath);
      const latestHash = latest === null ? null : sha256(latest);
      if (latestHash !== expectedHash) {
        throw new WorkspaceRepositoryError(
          'workspace_conflict',
          `${relativePath} changed immediately before atomic replacement`,
        );
      }
      await rename(temporary, target);
      await this.options.checkpoint?.('afterRename');
      await this.syncDirectory(parent);
    } finally {
      if (handle) await handle.close();
      await unlink(temporary).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    let handle;
    try {
      handle = await open(path, 'r');
      await handle.sync();
    } catch (error) {
      if (!isWindowsUnsupportedDirectoryError(error)) throw error;
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch (error) {
          if (!isWindowsUnsupportedDirectoryError(error)) throw error;
        }
      }
    }
  }

  private async readDocument(
    kind: RecordKind,
    relativePath: string,
  ): Promise<{ text: string | null; document: ParsedDocument }> {
    const text = await this.readText(relativePath);
    return {
      text,
      document: parseDocument(kind, text ?? DEFAULT_PREAMBLE[kind]),
    };
  }

  private async documentPaths(kind: RecordKind, archived: boolean): Promise<string[]> {
    if (kind !== 'daily') {
      return [`${archived ? 'archive/' : ''}${managedFile(kind)}`];
    }
    const relativeDirectory = archived ? 'archive' : 'memory';
    const directory = relativeToFs(this.config.workspaceDir, relativeDirectory);
    try {
      return (await readdir(directory))
        .filter(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
        .sort()
        .map(name => `${relativeDirectory}/${name}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async buildWorkspaceIdIndex(): Promise<WorkspaceIdIndex> {
    const locations: WorkspaceRecordLocation[] = [];
    const byId = new Map<string, WorkspaceRecordLocation>();
    for (const kind of ALL_KINDS) {
      for (const archived of [false, true]) {
        for (const relativePath of await this.documentPaths(kind, archived)) {
          let loaded: { text: string | null; document: ParsedDocument };
          try {
            loaded = await this.readDocument(kind, relativePath);
          } catch (error) {
            if ((error as { code?: string }).code === 'duplicate_id') {
              throw new WorkspaceRepositoryError(
                'workspace_duplicate_id',
                `workspace document ${relativePath} contains a duplicate ID`,
                error,
              );
            }
            throw error;
          }
          for (const record of loaded.document.records) {
            const location = { kind, relativePath, archived, record };
            const existing = byId.get(record.id);
            if (existing !== undefined) {
              throw new WorkspaceRepositoryError(
                'workspace_duplicate_id',
                `record ID ${record.id} occurs in both ${existing.relativePath} and ${relativePath}`,
                { id: record.id, paths: [existing.relativePath, relativePath] },
              );
            }
            byId.set(record.id, location);
            locations.push(location);
          }
        }
      }
    }
    return { ids: new Set(byId.keys()), locations, byId };
  }

  private activeRecordPath(
    index: WorkspaceIdIndex,
    kind: RecordKind,
    targetId: string,
  ): string {
    const location = index.byId.get(targetId);
    if (location !== undefined && location.kind === kind && !location.archived) {
      return location.relativePath;
    }
    throw new WorkspaceRepositoryError('record_not_found', `record ${targetId} was not found`);
  }

  private async readText(relativePath: string): Promise<string | null> {
    try {
      return await readFile(relativeToFs(this.config.workspaceDir, relativePath), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async withLock<T>(work: () => Promise<T>, operationId?: string): Promise<T> {
    const lockPath = join(this.config.workspaceDir, '.assistant.lock');
    const deadline = Date.now() + 10_000;
    let lock: HeldWorkspaceLock | undefined;
    while (lock === undefined) {
      lock = await this.coordinatedLockAttempt(lockPath, operationId, deadline);
      if (lock !== undefined) break;
      if (Date.now() >= deadline) {
        throw new WorkspaceRepositoryError(
          'workspace_lock_timeout',
          'workspace lock was not acquired within 10 seconds',
        );
      }
      await new Promise(resolve => setTimeout(resolve, 25 + Math.floor(Math.random() * 51)));
    }
    try {
      await this.quarantineTemporaryFiles();
      await this.reconcilePendingOperations();
      return await work();
    } finally {
      await this.releaseHeldLock(lockPath, lock);
    }
  }

  private async coordinatedLockAttempt(
    lockPath: string,
    operationId: string | undefined,
    deadline: number,
  ): Promise<HeldWorkspaceLock | undefined> {
    return this.lockCoordinator.attempt(deadline, async () => {
      let lock: HeldWorkspaceLock | undefined;
      try {
        lock = await this.createWorkspaceLock(lockPath, operationId);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const sharingRace = process.platform === 'win32'
          && (code === 'EACCES' || code === 'EPERM');
        if (code !== 'EEXIST' && !sharingRace) throw error;
        if (await this.tryRecoverStaleLock(lockPath, deadline)) {
          lock = await this.createWorkspaceLock(lockPath, operationId);
        }
      }

      if (lock === undefined) return undefined;
      const acquisition: CoordinatedAcquisition<HeldWorkspaceLock> = {
        value: lock,
        cleanup: () => this.releaseHeldLock(lockPath, lock!),
      };
      return acquisition;
    });
  }

  private async releaseHeldLock(
    lockPath: string,
    lock: HeldWorkspaceLock,
  ): Promise<void> {
    let closeError: unknown;
    try {
      await lock.handle.close();
    } catch (error) {
      closeError = error;
    }
    let removed = false;
    let unlinkError: unknown;
    try {
      removed = await this.unlinkUnchangedLock(lockPath, lock.snapshot, 1_000);
    } catch (error) {
      unlinkError = error;
    }
    if (closeError !== undefined && unlinkError !== undefined) {
      throw new AggregateError(
        [closeError, unlinkError],
        'workspace lock close and unlink both failed',
      );
    }
    if (unlinkError !== undefined) throw unlinkError;
    if (!removed) {
      throw new WorkspaceRepositoryError(
        'workspace_lock_ownership_lost',
        `workspace lock ${lock.metadata.ownerId} changed before release`,
        closeError,
      );
    }
    if (closeError !== undefined) throw closeError;
  }

  private async createWorkspaceLock(
    lockPath: string,
    operationId?: string,
  ): Promise<HeldWorkspaceLock> {
    const handle = await open(lockPath, 'wx', 0o600);
    const metadata: WorkspaceLockMetadata = {
      version: 1,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      ownerId: randomUUID(),
      ...(operationId === undefined ? {} : { operationId }),
    };
    const contents = `${JSON.stringify(metadata)}\n`;
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      const info = await handle.stat();
      return {
        handle,
        metadata,
        snapshot: {
          contents,
          dev: info.dev,
          ino: info.ino,
          size: info.size,
          mtimeMs: info.mtimeMs,
          ctimeMs: info.ctimeMs,
          birthtimeMs: info.birthtimeMs,
        },
      };
    } catch (error) {
      try {
        await handle.close();
      } finally {
        await this.unlinkWithSharingRetry(lockPath, 1_000);
      }
      throw error;
    }
  }

  private async readLockSnapshot(lockPath: string): Promise<LockSnapshot> {
    const handle = await open(lockPath, 'r');
    try {
      const contents = await handle.readFile('utf8');
      const info = await handle.stat();
      return {
        contents,
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
        birthtimeMs: info.birthtimeMs,
      };
    } finally {
      await handle.close();
    }
  }

  private async tryRecoverStaleLock(lockPath: string, deadline: number): Promise<boolean> {
    let snapshot: LockSnapshot;
    try {
      snapshot = await this.readLockSnapshot(lockPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return true;
      if (process.platform === 'win32' && (code === 'EACCES' || code === 'EPERM')) return false;
      throw error;
    }
    let metadata: unknown;
    try {
      metadata = JSON.parse(snapshot.contents);
    } catch {
      return false;
    }
    if (!isWorkspaceLockMetadata(metadata) || !this.isProcessProvenDead(metadata.pid)) return false;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    return this.unlinkUnchangedLock(lockPath, snapshot, Math.min(1_000, remaining));
  }

  private isProcessProvenDead(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }

  private async unlinkUnchangedLock(
    lockPath: string,
    expected: LockSnapshot,
    retryMilliseconds: number,
  ): Promise<boolean> {
    const deadline = Date.now() + retryMilliseconds;
    while (true) {
      let current: LockSnapshot;
      try {
        current = await this.readLockSnapshot(lockPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return true;
        const sharingRace = process.platform === 'win32'
          && (code === 'EACCES' || code === 'EPERM');
        if (!sharingRace || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 20 + Math.floor(Math.random() * 31)));
        continue;
      }
      if (!sameLockSnapshot(current, expected)) return false;
      try {
        await unlink(lockPath);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return true;
        const sharingRace = process.platform === 'win32'
          && (code === 'EACCES' || code === 'EPERM');
        if (!sharingRace || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 20 + Math.floor(Math.random() * 31)));
      }
    }
  }

  private async unlinkWithSharingRetry(path: string, retryMilliseconds: number): Promise<void> {
    const deadline = Date.now() + retryMilliseconds;
    while (true) {
      try {
        await unlink(path);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return;
        const sharingRace = process.platform === 'win32'
          && (code === 'EACCES' || code === 'EPERM');
        if (!sharingRace || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 20 + Math.floor(Math.random() * 31)));
      }
    }
  }

  private unfinishedOperationIds(): string[] {
    const database = new DatabaseSync(join(this.config.stateDir, 'operations.sqlite3'), {
      readOnly: true,
    });
    try {
      return (database.prepare(`
        SELECT operation_id FROM operations
        WHERE phase IN ('begun', 'applied') ORDER BY created_at, operation_id
      `).all() as unknown as Array<{ operation_id: string }>)
        .map(row => row.operation_id);
    } finally {
      database.close();
    }
  }

  private async reconcilePendingOperations(): Promise<void> {
    for (const operationId of this.unfinishedOperationIds()) {
      const operation = this.ledger.get<PreparedMutation>(operationId);
      if (!operation || operation.phase === 'committed' || operation.phase === 'replied') continue;
      if (!isPrepared(operation.result)) {
        if (operation.phase === 'begun') continue;
        throw new WorkspaceRepositoryError(
          'operation_reconcile_conflict',
          `operation ${operationId} has no prepared recovery metadata`,
        );
      }
      await this.reconcileOperation(operationId, operation.result, true, true);
    }
  }

  private async quarantineTemporaryFiles(): Promise<void> {
    const directories: Array<{ path: string; target: RegExp }> = [
      {
        path: this.config.workspaceDir,
        target: /^(?:TASKS|STUDY|NOTES|USER|MEMORY|INBOX)\.md$/,
      },
      {
        path: join(this.config.workspaceDir, 'archive'),
        target: /^(?:(?:TASKS|STUDY|NOTES|USER|MEMORY|INBOX)\.md|\d{4}-\d{2}-\d{2}\.md)$/,
      },
      {
        path: join(this.config.workspaceDir, 'memory'),
        target: /^\d{4}-\d{2}-\d{2}\.md$/,
      },
    ];
    for (const directory of directories) {
      let names: string[];
      try {
        names = await readdir(directory.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const name of names) {
        const marker = name.lastIndexOf('.tmp-');
        if (marker < 0 || !directory.target.test(name.slice(0, marker))) continue;
        const suffix = name.slice(marker + '.tmp-'.length);
        const candidates = suffix.endsWith('-conflict')
          ? [suffix, suffix.slice(0, -'-conflict'.length)]
          : [suffix];
        const knownNonterminal = candidates.some(candidate => {
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidate)) return false;
          const operation = this.ledger.get(candidate);
          return operation?.phase === 'begun' || operation?.phase === 'applied';
        });
        if (!knownNonterminal) continue;
        const source = join(directory.path, name);
        const quarantineDir = join(this.config.stateDir, 'quarantine');
        await mkdir(quarantineDir, { recursive: true, mode: 0o700 });
        const destination = join(
          quarantineDir,
          `${Date.now()}-${createHash('sha256').update(source).digest('hex').slice(0, 12)}-${name}`,
        );
        try {
          await rename(source, destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
          await copyFile(source, destination);
          await unlink(source);
        }
      }
    }
  }

  private git(args: readonly string[]): string {
    return this.gitRaw(args).trim();
  }

  private gitRaw(args: readonly string[]): string {
    try {
      return execFileSync('git', [...args], {
        cwd: this.config.workspaceDir,
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      throw new WorkspaceRepositoryError('git_failed', `git ${args[0]} failed`, error);
    }
  }

  private assertGitPathClean(relativePath: string): void {
    const status = this.git(['status', '--porcelain=v1', '--untracked-files=all', '--', relativePath]);
    if (status.length > 0) {
      throw new WorkspaceRepositoryError(
        'workspace_conflict',
        `${relativePath} has pre-existing Git changes`,
      );
    }
  }

  private findOperationCommit(
    operationId: string,
    prepared: PreparedMutation,
  ): string | undefined {
    const output = this.git([
      'log', '--all', '--format=%H%x1f%B%x1e', '--fixed-strings',
      `--grep=Assistant-Operation-Id: ${operationId}`,
    ]);
    const trailer = `Assistant-Operation-Id: ${operationId}`;
    const recoveryProof = 'Assistant-Recovery-Proof: exact-tree';
    const candidates: Array<{ commit: string; body: string }> = [];
    for (const entry of output.split('\x1e')) {
      const [commit, body = ''] = entry.trim().split('\x1f', 2);
      if (commit && body.split(/\r?\n/).includes(trailer)) candidates.push({ commit, body });
    }
    const preparedPaths = new Set(prepared.files.map(file => file.relativePath));
    const validCandidates: string[] = [];
    for (const candidate of candidates) {
      try {
        this.git(['merge-base', '--is-ancestor', candidate.commit, 'HEAD']);
        const changedPaths = new Set(this.git([
          'diff-tree', '--no-commit-id', '--name-only', '-r', `${candidate.commit}^!`,
        ]).split(/\r?\n/).filter(Boolean));
        const exactPreparedChange = changedPaths.size === preparedPaths.size
          && [...preparedPaths].every(path => changedPaths.has(path));
        const exactTreeRecoveryProof = changedPaths.size === 0
          && candidate.body.split(/\r?\n/).includes(recoveryProof);
        if (!exactPreparedChange && !exactTreeRecoveryProof) continue;
        let blobsMatch = true;
        for (const file of prepared.files) {
          const contents = this.gitRaw(['show', `${candidate.commit}:${file.relativePath}`]);
          if (sha256(contents) !== file.afterHash) {
            blobsMatch = false;
            break;
          }
        }
        if (blobsMatch) validCandidates.push(candidate.commit);
      } catch {
        // Unreachable commits and missing/mismatched blobs are not valid recovery proof.
      }
    }
    if (validCandidates.length !== 1) return undefined;
    const [candidate] = validCandidates;
    try {
      const status = this.git([
        'status', '--porcelain=v1', '--untracked-files=all', '--', ...preparedPaths,
      ]);
      return status.length === 0 ? candidate : undefined;
    } catch {
      return undefined;
    }
  }

  private commitPrepared(operationId: string, prepared: PreparedMutation): string {
    const paths = prepared.files.map(file => file.relativePath);
    const status = this.git(['status', '--porcelain=v1', '--untracked-files=all', '--', ...paths]);
    if (status.length > 0) this.git(['add', '--', ...paths]);
    this.git([
      'commit', '--quiet', '--only', ...(status.length === 0 ? ['--allow-empty'] : []),
      '-m', `assistant: ${prepared.action} ${prepared.result.id}`,
      '-m', `Assistant-Operation-Id: ${operationId}`,
      ...(status.length === 0 ? ['-m', 'Assistant-Recovery-Proof: exact-tree'] : []),
      '--', ...paths,
    ]);
    return this.git(['rev-parse', 'HEAD']);
  }

  private async appendConflictInbox(operationId: string, message: string): Promise<void> {
    const relativePath = 'INBOX.md';
    const loaded = await this.readDocument('inbox', relativePath);
    if (loaded.document.records.some(record => record.fields.operation_id === operationId)) return;
    this.assertGitPathClean(relativePath);
    const date = dateInSeoul(this.now());
    const used = new Set(loaded.document.records.map(record => record.id));
    let sequence = 1;
    let id = `${KIND_PREFIX.inbox}-${date}-${String(sequence).padStart(3, '0')}`;
    while (used.has(id)) {
      sequence += 1;
      id = `${KIND_PREFIX.inbox}-${date}-${String(sequence).padStart(3, '0')}`;
    }
    const timestamp = timestampInSeoul(this.now());
    const record: ParsedRecord = {
      id,
      title: 'Workspace conflict',
      orderedFields: [{ key: 'operation_id', rawValue: JSON.stringify(operationId) }],
      fields: {
        operation_id: operationId,
        type: 'inbox',
        status: 'pending',
        reason: 'workspace_conflict',
        original_text: `Operation ${operationId}: ${message}`,
        created_at: timestamp,
        updated_at: timestamp,
        source: 'assistant',
      },
      body: '',
    };
    ensureAppendBoundary(loaded.document);
    loaded.document.records.push(record);
    await this.atomicReplace(
      relativePath,
      serializeDocument(loaded.document),
      `${operationId}-conflict`,
      loaded.text === null ? null : sha256(loaded.text),
    );
  }
}

export async function openRepository(
  config: AssistantConfig,
  options: RepositoryOptions = {},
): Promise<WorkspaceRepository> {
  await mkdir(config.workspaceDir, { recursive: true, mode: 0o700 });
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  return new WorkspaceRepository(config, options);
}
