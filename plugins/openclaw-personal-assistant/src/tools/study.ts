import type { AgentTool } from 'openclaw/plugin-sdk/agent-core';
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from 'openclaw/plugin-sdk/plugin-entry';
import { jsonResult } from 'openclaw/plugin-sdk/tool-results';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import type { ParsedRecord } from '../domain.js';
import { StudyStore } from '../study/store.js';
import type {
  StudyDayStatus,
  StudyPlanBlockInput,
  StudyPlanResult,
  StudySettings,
  StudyTransitionAction,
  StudyTransitionResult,
} from '../study/types.js';
import { WorkspaceRepository } from '../workspace/repository.js';
import {
  AssistantToolError,
  assertOwner,
  loadConfigFromApi,
  type AssistantToolConfig,
} from './trust.js';

const operationIdSchema = Type.String({
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', minLength: 1, maxLength: 128,
});
const studyIdSchema = Type.String({
  pattern: '^S-[0-9]{8}-[0-9]{3}$', minLength: 14, maxLength: 14,
});
const blockIdSchema = Type.String({
  pattern: '^B-[0-9]{8}-[0-9]{3}$', minLength: 14, maxLength: 14,
});
const blockSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  startAt: Type.String({ minLength: 25, maxLength: 25 }),
  durationMinutes: Type.Optional(Type.Integer({ minimum: 10, maximum: 180 })),
}, { additionalProperties: false });

export const studyParameters = Type.Union([
  Type.Object({
    action: Type.Literal('plan'),
    operationId: operationIdSchema,
    studyId: studyIdSchema,
    blocks: Type.Array(blockSchema, { minItems: 1, maxItems: 64 }),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal('replace_future'),
    operationId: operationIdSchema,
    studyId: studyIdSchema,
    blocks: Type.Array(blockSchema, { minItems: 1, maxItems: 64 }),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal('done'),
    operationId: operationIdSchema,
    blockId: blockIdSchema,
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal('skip'),
    operationId: operationIdSchema,
    blockId: blockIdSchema,
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal('snooze'),
    operationId: operationIdSchema,
    blockId: blockIdSchema,
    minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
  }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('status') }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('settings_get') }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal('settings_set'),
    operationId: operationIdSchema,
    focusMinutes: Type.Optional(Type.Integer({ minimum: 10, maximum: 180 })),
    breakMinutes: Type.Optional(Type.Integer({ minimum: 0, maximum: 60 })),
    followUpMinutes: Type.Optional(Type.Integer({ minimum: 5, maximum: 60 })),
    maxFollowUps: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
  }, { additionalProperties: false }),
]);

type StudyParameters = Static<typeof studyParameters>;

export interface StudyRecordRepository {
  query(criteria: { kind?: 'study'; id?: string; includeArchived?: boolean }): Promise<ParsedRecord[]>;
  close(): void;
}

export interface StudyStorePort {
  plan(operationId: string, studyId: string, blocks: StudyPlanBlockInput[]): StudyPlanResult;
  replaceFuture(
    operationId: string,
    studyId: string,
    blocks: StudyPlanBlockInput[],
    now: Date,
  ): StudyPlanResult;
  transition(
    operationId: string,
    blockId: string,
    action: StudyTransitionAction,
    now: Date,
  ): StudyTransitionResult;
  current(now: Date): StudyDayStatus;
  settings(): StudySettings;
  setSettings(
    operationId: string,
    patch: Partial<Pick<StudySettings,
      'focusMinutes' | 'breakMinutes' | 'followUpMinutes' | 'maxFollowUps'>>,
  ): { operationId: string; replayed: boolean; settings: StudySettings };
  close(): void;
}

export interface StudyToolDependencies {
  openRepository?: (config: AssistantToolConfig) => StudyRecordRepository;
  openStore?: (config: AssistantToolConfig) => StudyStorePort;
  now?: () => Date;
}

type StudyToolResult =
  | ({ action: 'plan' | 'replace_future' } & StudyPlanResult)
  | ({ action: 'done' | 'skip' | 'snooze' } & StudyTransitionResult)
  | { action: 'status'; status: StudyDayStatus }
  | { action: 'settings_get'; settings: StudySettings }
  | { action: 'settings_set'; operationId: string; replayed: boolean; settings: StudySettings };

export function createStudyTool(
  api: OpenClawPluginApi,
  toolContext: Pick<OpenClawPluginToolContext, 'requesterSenderId'>,
  dependencies: StudyToolDependencies = {},
): AgentTool<typeof studyParameters, StudyToolResult> {
  return {
    name: 'assistant_study_manage',
    label: 'Assistant Study Manage',
    description: 'Manage owner-provided local study blocks, progress actions, and coach settings.',
    parameters: studyParameters,
    async execute(_toolCallId, params, signal) {
      const config = loadConfigFromApi(api);
      assertOwner(toolContext, config);
      if (!Value.Check(studyParameters, params)) {
        throw new AssistantToolError('invalid_parameters', 'Study parameters do not match the tool schema');
      }
      if (params.action === 'settings_set'
        && params.focusMinutes === undefined
        && params.breakMinutes === undefined
        && params.followUpMinutes === undefined
        && params.maxFollowUps === undefined) {
        throw new AssistantToolError('invalid_parameters', 'At least one study setting is required');
      }
      signal?.throwIfAborted();
      const now = (dependencies.now ?? (() => new Date()))();

      if (params.action === 'plan' || params.action === 'replace_future') {
        const repository = (dependencies.openRepository ?? openRepository)(config);
        try {
          const records = await repository.query({ kind: 'study', id: params.studyId });
          const record = records.length === 1 ? records[0] : undefined;
          if (!record || record.fields.type !== 'study' || record.fields.status === 'archived') {
            throw new AssistantToolError(
              'study_not_found',
              'Study blocks require one existing active user study record',
            );
          }
        } finally {
          repository.close();
        }
        const store = (dependencies.openStore ?? openStore)(config);
        try {
          const result = params.action === 'plan'
            ? store.plan(params.operationId, params.studyId, params.blocks)
            : store.replaceFuture(params.operationId, params.studyId, params.blocks, now);
          return jsonResult({ action: params.action, ...result });
        } finally {
          store.close();
        }
      }

      const store = (dependencies.openStore ?? openStore)(config);
      try {
        if (params.action === 'status') {
          return jsonResult({ action: 'status', status: store.current(now) });
        }
        if (params.action === 'settings_get') {
          return jsonResult({ action: 'settings_get', settings: store.settings() });
        }
        if (params.action === 'settings_set') {
          const result = store.setSettings(params.operationId, {
            ...(params.focusMinutes === undefined ? {} : { focusMinutes: params.focusMinutes }),
            ...(params.breakMinutes === undefined ? {} : { breakMinutes: params.breakMinutes }),
            ...(params.followUpMinutes === undefined ? {} : { followUpMinutes: params.followUpMinutes }),
            ...(params.maxFollowUps === undefined ? {} : { maxFollowUps: params.maxFollowUps }),
          });
          return jsonResult({ action: 'settings_set', ...result });
        }
        const transition: StudyTransitionAction = params.action === 'snooze'
          ? { type: 'snooze', ...(params.minutes === undefined ? {} : { minutes: params.minutes }) }
          : { type: params.action };
        const result = store.transition(params.operationId, params.blockId, transition, now);
        return jsonResult({ action: params.action, ...result });
      } finally {
        store.close();
      }
    },
  };
}

function openRepository(config: AssistantToolConfig): StudyRecordRepository {
  return new WorkspaceRepository(config);
}

function openStore(config: AssistantToolConfig): StudyStorePort {
  return new StudyStore(config.stateDir);
}

export type { StudyParameters };
