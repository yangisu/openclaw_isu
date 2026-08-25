import type { AgentTool } from 'openclaw/plugin-sdk/agent-core';
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from 'openclaw/plugin-sdk/plugin-entry';
import { jsonResult } from 'openclaw/plugin-sdk/tool-results';
import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';

import type { AssistantRecord, ParsedRecord, RecordKind } from '../domain.js';
import {
  WorkspaceRepository,
  type MutationResult,
  type RecordPatch,
} from '../workspace/repository.js';
import {
  AssistantToolError,
  assertOwner,
  loadConfigFromApi,
  type AssistantToolConfig,
} from './trust.js';

const operationIdSchema = Type.String({
  pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$',
  minLength: 1,
  maxLength: 128,
});
const taskIdSchema = recordIdSchema('T', '[0-9]{8}');
const studyIdSchema = recordIdSchema('S', '[0-9]{8}');
const noteIdSchema = recordIdSchema('N', '[0-9]{8}');
const preferenceIdSchema = recordIdSchema('U', '[0-9]{8}');
const memoryIdSchema = recordIdSchema('M', '[0-9]{8}');
const inboxIdSchema = recordIdSchema('I', '[0-9]{8}');
const dailyIdSchema = recordIdSchema('D', '[0-9]{6}');
const targetIdSchema = Type.Union([
  taskIdSchema, studyIdSchema, noteIdSchema, preferenceIdSchema,
  memoryIdSchema, inboxIdSchema, dailyIdSchema,
]);
const timestampSchema = Type.String({ minLength: 20, maxLength: 40 });
const dateSchema = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' });

const workStatusSchema = Type.Union([
  Type.Literal('open'), Type.Literal('in_progress'), Type.Literal('done'), Type.Literal('archived'),
]);
const taskFieldsSchema = Type.Object({
  status: Type.Optional(workStatusSchema),
  priority: Type.Optional(Type.Union([Type.Literal('high'), Type.Literal('normal'), Type.Literal('low')])),
  due_at: Type.Optional(timestampSchema),
  completed_at: Type.Optional(timestampSchema),
}, { additionalProperties: false, minProperties: 1 });
const studyFieldsSchema = Type.Object({
  status: Type.Optional(workStatusSchema),
  subject: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  target_amount: Type.Optional(Type.Integer({ minimum: 1 })),
  unit: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  progress: Type.Optional(Type.Integer({ minimum: 0 })),
  target_date: Type.Optional(dateSchema),
  recurrence: Type.Optional(Type.Union([
    Type.Literal('none'), Type.Literal('daily'), Type.Literal('weekly'),
  ])),
  review_dates: Type.Optional(Type.Array(dateSchema, { maxItems: 64, uniqueItems: true })),
}, { additionalProperties: false, minProperties: 1 });
const noteFieldsSchema = Type.Object({
  status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('archived')])),
  url: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
    maxItems: 64,
    uniqueItems: true,
  })),
}, { additionalProperties: false, minProperties: 1 });
const preferenceFieldsSchema = Type.Object({
  active: Type.Optional(Type.Boolean()),
  supersedes: Type.Optional(preferenceIdSchema),
}, { additionalProperties: false, minProperties: 1 });
const memoryFieldsSchema = Type.Object({
  active: Type.Optional(Type.Boolean()),
  supersedes: Type.Optional(memoryIdSchema),
  sensitivity: Type.Optional(Type.Union([Type.Literal('normal'), Type.Literal('sensitive')])),
}, { additionalProperties: false, minProperties: 1 });
const inboxFieldsSchema = Type.Object({
  status: Type.Optional(Type.Union([
    Type.Literal('pending'), Type.Literal('resolved'), Type.Literal('archived'),
  ])),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  original_text: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  resolved_at: Type.Optional(timestampSchema),
  target_id: Type.Optional(targetIdSchema),
}, { additionalProperties: false, minProperties: 1 });
const dailyFieldsSchema = Type.Object({
  entry_at: Type.Optional(timestampSchema),
  related_ids: Type.Optional(Type.Array(targetIdSchema, { maxItems: 64, uniqueItems: true })),
}, { additionalProperties: false, minProperties: 1 });

const modifySchemas = [
  modifySchema('task', taskIdSchema, taskFieldsSchema),
  modifySchema('study', studyIdSchema, studyFieldsSchema),
  modifySchema('note', noteIdSchema, noteFieldsSchema),
  modifySchema('preference', preferenceIdSchema, preferenceFieldsSchema),
  modifySchema('memory', memoryIdSchema, memoryFieldsSchema),
  modifySchema('inbox', inboxIdSchema, inboxFieldsSchema),
  modifySchema('daily', dailyIdSchema, dailyFieldsSchema),
] as const;

const archiveSchemas = [
  archiveSchema('task', taskIdSchema),
  archiveSchema('study', studyIdSchema),
  archiveSchema('note', noteIdSchema),
  archiveSchema('preference', preferenceIdSchema),
  archiveSchema('memory', memoryIdSchema),
  archiveSchema('inbox', inboxIdSchema),
  archiveSchema('daily', dailyIdSchema),
] as const;

export const mutationParameters = Type.Union([
  Type.Object({
    operationId: operationIdSchema,
    action: Type.Literal('add'),
    recordType: Type.Literal('task'),
    title: Type.String({ minLength: 1, maxLength: 500 }),
    body: Type.Optional(Type.String({ maxLength: 16_000 })),
    priority: Type.Optional(Type.Union([Type.Literal('high'), Type.Literal('normal'), Type.Literal('low')])),
    dueAt: Type.Optional(timestampSchema),
  }, { additionalProperties: false }),
  ...modifySchemas,
  ...archiveSchemas,
]);

type MutationParameters = Static<typeof mutationParameters>;

export interface MutationRepository {
  addTask(operationId: string, input: {
    title: string;
    body?: string;
    priority?: 'high' | 'normal' | 'low';
    dueAt?: string;
    source: string;
  }): Promise<MutationResult>;
  updateRecord(operationId: string, targetId: string, patch: RecordPatch): Promise<MutationResult>;
  archiveRecord(operationId: string, targetId: string, reason: string): Promise<MutationResult>;
  close(): void;
}

export interface MutationToolDependencies {
  openRepository?: (config: AssistantToolConfig) => MutationRepository;
}

export function createMutationTool(
  api: OpenClawPluginApi,
  toolContext: Pick<OpenClawPluginToolContext, 'requesterSenderId'>,
  dependencies: MutationToolDependencies = {},
): AgentTool<typeof mutationParameters, MutationResult> {
  return {
    name: 'assistant_mutate',
    label: 'Assistant Mutate',
    description: 'Add, modify, or archive one owner-scoped local record with an idempotent operation ID.',
    parameters: mutationParameters,
    async execute(_toolCallId, params, signal) {
      const config = loadConfigFromApi(api);
      assertOwner(toolContext, config);
      if (params.action !== 'add') assertTargetMatchesRecordType(params.targetId, params.recordType);
      if (!Value.Check(mutationParameters, params)) {
        throw new AssistantToolError('invalid_parameters', 'Mutation parameters do not match the tool schema');
      }
      signal?.throwIfAborted();

      const repository = (dependencies.openRepository ?? openRepository)(config);
      try {
        let result: MutationResult;
        if (params.action === 'add') {
          result = await repository.addTask(params.operationId, {
            title: params.title,
            ...(params.body === undefined ? {} : { body: params.body }),
            ...(params.priority === undefined ? {} : { priority: params.priority }),
            ...(params.dueAt === undefined ? {} : { dueAt: params.dueAt }),
            source: 'telegram',
          });
        } else if (params.action === 'modify') {
          const patch: RecordPatch = {
            ...(params.title === undefined ? {} : { title: params.title }),
            ...(params.body === undefined ? {} : { body: params.body }),
            ...(params.fields === undefined
              ? {}
              : { fields: params.fields as Partial<AssistantRecord> }),
          };
          result = await repository.updateRecord(params.operationId, params.targetId, patch);
        } else {
          result = await repository.archiveRecord(params.operationId, params.targetId, params.reason);
        }
        return jsonResult(result);
      } finally {
        repository.close();
      }
    },
  };
}

function openRepository(config: AssistantToolConfig): MutationRepository {
  return new WorkspaceRepository(config);
}

function assertTargetMatchesRecordType(targetId: string, recordType: RecordKind): void {
  const prefix: Readonly<Record<RecordKind, string>> = {
    task: 'T-', study: 'S-', note: 'N-', preference: 'U-', memory: 'M-', inbox: 'I-', daily: 'D-',
  };
  if (!targetId.startsWith(prefix[recordType])) {
    throw new AssistantToolError(
      'target_type_mismatch',
      `Target ID does not identify a ${recordType} record`,
    );
  }
}

function recordIdSchema(prefix: string, datePattern: string) {
  return Type.String({ pattern: `^${prefix}-${datePattern}-[0-9]{3}$`, maxLength: 32 });
}

function modifySchema<TRecordType extends RecordKind, TFields extends TSchema>(
  recordType: TRecordType,
  idSchema: ReturnType<typeof recordIdSchema>,
  fieldsSchema: TFields,
) {
  return Type.Object({
    operationId: operationIdSchema,
    action: Type.Literal('modify'),
    recordType: Type.Literal(recordType),
    targetId: idSchema,
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    body: Type.Optional(Type.String({ maxLength: 16_000 })),
    fields: Type.Optional(fieldsSchema),
  }, { additionalProperties: false, minProperties: 5 });
}

function archiveSchema<TRecordType extends RecordKind>(
  recordType: TRecordType,
  idSchema: ReturnType<typeof recordIdSchema>,
) {
  return Type.Object({
    operationId: operationIdSchema,
    action: Type.Literal('archive'),
    recordType: Type.Literal(recordType),
    targetId: idSchema,
    reason: Type.String({ minLength: 1, maxLength: 1000 }),
  }, { additionalProperties: false });
}
