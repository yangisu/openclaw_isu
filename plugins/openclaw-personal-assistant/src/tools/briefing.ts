import type { AnyAgentTool } from 'openclaw/plugin-sdk/core';
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from 'openclaw/plugin-sdk/plugin-entry';
import { jsonResult } from 'openclaw/plugin-sdk/tool-results';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import type {
  BriefingStudy,
  BriefingTask,
} from '../briefing/build.js';
import { deliverClaimedBriefing, type BriefingDurableSender } from '../briefing/delivery.js';
import type { CalendarEvent } from '../calendar/ical.js';
import type { ParsedRecord, RecordKind } from '../domain.js';
import { AlertLedger, BriefingService, type AlertJournal } from '../state/alerts.js';
import { SubsystemHealthStore, type SubsystemHealthJournal } from '../state/health.js';
import { WorkspaceRepository } from '../workspace/repository.js';
import {
  AssistantToolError,
  assertOwnerOrTrustedBriefingCron,
  loadConfigFromApi,
  type AssistantToolConfig,
} from './trust.js';
import { openGoogleCalendarReader } from './query.js';

export const briefingParameters = Type.Object({}, { additionalProperties: false });

interface BriefingRepository {
  query(criteria: { kind?: RecordKind }): Promise<ParsedRecord[]>;
  close(): void;
}

interface BriefingCalendar {
  listEvents(range: { start: string; end: string }, signal?: AbortSignal): Promise<CalendarEvent[]>;
}

export interface BriefingToolDependencies {
  now?: () => Date;
  openRepository?: (config: AssistantToolConfig) => BriefingRepository;
  openCalendar?: (config: AssistantToolConfig) => BriefingCalendar;
  openAlerts?: (config: AssistantToolConfig) => AlertJournal;
  openHealth?: (config: AssistantToolConfig) => SubsystemHealthJournal;
  send?: BriefingDurableSender;
}

export function createBriefingTool(
  api: OpenClawPluginApi,
  toolContext: Pick<OpenClawPluginToolContext,
    'requesterSenderId' | 'senderIsOwner' | 'sessionKey' | 'deliveryContext'>,
  dependencies: BriefingToolDependencies = {},
): AnyAgentTool {
  return {
    name: 'assistant_briefing',
    label: 'Assistant Briefing',
    description: 'Build one deterministic owner briefing from local records and fresh calendar state.',
    parameters: briefingParameters,
    async execute(_toolCallId: string, params: Static<typeof briefingParameters>, signal?: AbortSignal) {
      const config = loadConfigFromApi(api);
      const deliveryTarget = assertOwnerOrTrustedBriefingCron(toolContext, config);
      if (!Value.Check(briefingParameters, params)) {
        throw new AssistantToolError('invalid_parameters', 'Briefing parameters do not match the tool schema');
      }
      signal?.throwIfAborted();

      const now = (dependencies.now ?? (() => new Date()))();
      const repository = (dependencies.openRepository ?? openRepository)(config);
      let alerts: AlertJournal | undefined;
      let health: SubsystemHealthJournal | undefined;
      try {
        const taskRecords = await repository.query({ kind: 'task' });
        const studyRecords = await repository.query({ kind: 'study' });
        signal?.throwIfAborted();

        health = (dependencies.openHealth ?? (scoped => new SubsystemHealthStore(scoped.stateDir)))(config);
        let events: CalendarEvent[] = [];
        try {
          const calendar = (dependencies.openCalendar ?? openGoogleCalendarReader)(config);
          events = await calendar.listEvents({
            start: now.toISOString(),
            end: new Date(now.valueOf() + 7 * 86_400_000).toISOString(),
          }, signal);
          health.recover('google-calendar');
        } catch (error) {
          health.report({
            errorCode: publicErrorCode(error),
            target: 'google-calendar',
            message: 'Google Calendar synchronization is unavailable',
          });
        }

        const activeErrors = health.listActive();
        alerts = (dependencies.openAlerts ?? (scoped => new AlertLedger(scoped.stateDir)))(config);
        const service = new BriefingService(alerts);
        const claim = service.run({
          now: now.toISOString(),
          events: events.map(event => ({
            start: event.dtstart, title: event.summary, kind: event.kind, status: event.status,
          })),
          tasks: taskRecords.flatMap(taskFromRecord),
          studies: studyRecords.flatMap(studyFromRecord),
          activeErrors,
        });
        const result = await deliverClaimedBriefing({
          cfg: api.config,
          target: deliveryTarget,
          claim,
          alerts,
          ...(signal ? { signal } : {}),
          ...(dependencies.send ? { send: dependencies.send } : {}),
        });
        return jsonResult(result);
      } finally {
        alerts?.close();
        health?.close();
        repository.close();
      }
    },
  };
}

function openRepository(config: AssistantToolConfig): BriefingRepository {
  return new WorkspaceRepository(config);
}

function taskFromRecord(record: ParsedRecord): BriefingTask[] {
  const fields = record.fields;
  const status = fields.status;
  const priority = fields.priority;
  if (!['open', 'in_progress', 'done', 'archived'].includes(String(status))) return [];
  if (!['high', 'normal', 'low'].includes(String(priority))) return [];
  return [{
    id: record.id,
    title: record.title,
    status: status as BriefingTask['status'],
    priority: priority as BriefingTask['priority'],
    ...(typeof fields.due_at === 'string' ? { dueAt: fields.due_at } : {}),
    ...(typeof fields.parent_id === 'string' ? { parentId: fields.parent_id } : {}),
    ...(typeof fields.study_id === 'string' ? { studyId: fields.study_id } : {}),
    ...(typeof fields.planned_date === 'string' ? { plannedDate: fields.planned_date } : {}),
    ...(typeof fields.scheduled_start === 'string' ? { scheduledStart: fields.scheduled_start } : {}),
    ...(typeof fields.scheduled_end === 'string' ? { scheduledEnd: fields.scheduled_end } : {}),
    ...(typeof fields.step_index === 'number' ? { stepIndex: fields.step_index } : {}),
    ...(typeof fields.total_steps === 'number' ? { totalSteps: fields.total_steps } : {}),
  }];
}

function studyFromRecord(record: ParsedRecord): BriefingStudy[] {
  const fields = record.fields;
  if (!['open', 'in_progress', 'done', 'archived'].includes(String(fields.status))) return [];
  if (typeof fields.subject !== 'string' || typeof fields.unit !== 'string'
    || typeof fields.progress !== 'number' || typeof fields.target_amount !== 'number') return [];
  return [{
    id: record.id,
    title: record.title,
    status: fields.status as BriefingStudy['status'],
    subject: fields.subject,
    progress: fields.progress,
    targetAmount: fields.target_amount,
    unit: fields.unit,
    ...(typeof fields.category === 'string' ? { category: fields.category as BriefingStudy['category'] } : {}),
    ...(typeof fields.course_name === 'string' ? { courseName: fields.course_name } : {}),
    ...(typeof fields.deadline === 'string' ? { deadline: fields.deadline } : {}),
    ...(typeof fields.is_assignment === 'boolean' ? { isAssignment: fields.is_assignment } : {}),
    ...(typeof fields.target_date === 'string' ? { targetDate: fields.target_date } : {}),
    ...(['none', 'daily', 'weekly'].includes(String(fields.recurrence))
      ? { recurrence: fields.recurrence as BriefingStudy['recurrence'] }
      : {}),
    ...(Array.isArray(fields.review_dates) && fields.review_dates.every(value => typeof value === 'string')
      ? { reviewDates: fields.review_dates as string[] }
      : {}),
    ...(Array.isArray(fields.subtask_ids) && fields.subtask_ids.every(value => typeof value === 'string')
      ? { subtaskIds: fields.subtask_ids as string[] }
      : {}),
  }];
}

function publicErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error
    && typeof error.code === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(error.code)) {
    return error.code;
  }
  return 'CALDAV_UNAVAILABLE';
}
