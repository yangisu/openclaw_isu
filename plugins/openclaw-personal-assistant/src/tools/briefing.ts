import type { AgentTool } from 'openclaw/plugin-sdk/agent-core';
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from 'openclaw/plugin-sdk/plugin-entry';
import { jsonResult } from 'openclaw/plugin-sdk/tool-results';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import type {
  BriefingStudy,
  BriefingTask,
} from '../briefing/build.js';
import { deliverClaimedBriefing, type BriefingDurableSender } from '../briefing/delivery.js';
import { CalDavClient } from '../calendar/caldav.js';
import type { CalendarEvent } from '../calendar/ical.js';
import type { ParsedRecord, RecordKind } from '../domain.js';
import { AlertLedger, BriefingService, type AlertJournal } from '../state/alerts.js';
import { SubsystemHealthStore, type SubsystemHealthJournal } from '../state/health.js';
import { WorkspaceRepository } from '../workspace/repository.js';
import {
  AssistantToolError,
  assertOwnerOrTrustedBriefingCron,
  loadConfigFromApi,
  requireCalendarReadConfig,
  type AssistantToolConfig,
} from './trust.js';

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
): AgentTool<typeof briefingParameters> {
  return {
    name: 'assistant_briefing',
    label: 'Assistant Briefing',
    description: 'Build one deterministic owner briefing from local records and fresh calendar state.',
    parameters: briefingParameters,
    async execute(_toolCallId, params, signal) {
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
          const calendar = (dependencies.openCalendar ?? openCalendar)(config);
          events = await calendar.listEvents({
            start: now.toISOString(),
            end: new Date(now.valueOf() + 7 * 86_400_000).toISOString(),
          }, signal);
          health.recover('naver-caldav');
        } catch (error) {
          health.report({
            errorCode: publicErrorCode(error),
            target: 'naver-caldav',
            message: publicErrorCode(error) === 'caldav_read_disabled'
              ? 'Calendar reads are disabled pending authorized live validation'
              : 'Calendar synchronization is unavailable',
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

function openCalendar(config: AssistantToolConfig): BriefingCalendar {
  const calendar = requireCalendarReadConfig(config);
  const client = new CalDavClient({
    baseUrl: calendar.caldavBaseUrl,
    secretFile: calendar.caldavSecretFile,
    calendarMappings: calendar.calendarMappings,
  });
  return { listEvents: (range, signal) => client.listMappedEvents(range, signal) };
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
    ...(typeof fields.target_date === 'string' ? { targetDate: fields.target_date } : {}),
    ...(['none', 'daily', 'weekly'].includes(String(fields.recurrence))
      ? { recurrence: fields.recurrence as BriefingStudy['recurrence'] }
      : {}),
    ...(Array.isArray(fields.review_dates) && fields.review_dates.every(value => typeof value === 'string')
      ? { reviewDates: fields.review_dates as string[] }
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
