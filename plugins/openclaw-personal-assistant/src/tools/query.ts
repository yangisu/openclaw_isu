import type { AgentTool } from 'openclaw/plugin-sdk/agent-core';
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from 'openclaw/plugin-sdk/plugin-entry';
import { jsonResult } from 'openclaw/plugin-sdk/tool-results';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import { CalDavClient } from '../calendar/caldav.js';
import type { CalendarEvent } from '../calendar/ical.js';
import type { ParsedRecord, RecordKind } from '../domain.js';
import { WorkspaceRepository } from '../workspace/repository.js';
import { SubsystemHealthStore, type SubsystemHealthJournal } from '../state/health.js';
import {
  AssistantToolError,
  assertOwner,
  loadConfigFromApi,
  requireCalendarReadConfig,
  type AssistantToolConfig,
} from './trust.js';

const recordTypeSchema = Type.Union([
  Type.Literal('task'), Type.Literal('study'), Type.Literal('note'),
  Type.Literal('preference'), Type.Literal('memory'), Type.Literal('inbox'), Type.Literal('daily'),
]);

export const queryParameters = Type.Union([
  Type.Object({
    kind: Type.Literal('records'),
    recordType: Type.Optional(recordTypeSchema),
    targetId: Type.Optional(Type.String({
      pattern: '^(?:[TSNUMI]-[0-9]{8}-[0-9]{3}|D-[0-9]{6}-[0-9]{3})$',
      maxLength: 32,
    })),
    includeArchived: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal('calendar'),
    from: Type.String({ minLength: 20, maxLength: 40 }),
    to: Type.String({ minLength: 20, maxLength: 40 }),
  }, { additionalProperties: false }),
]);

type QueryParameters = Static<typeof queryParameters>;

export interface QueryRepository {
  query(criteria: { kind?: RecordKind; id?: string; includeArchived?: boolean }): Promise<ParsedRecord[]>;
  close(): void;
}

export interface CalendarReader {
  listEvents(range: { start: string; end: string }, signal?: AbortSignal): Promise<CalendarEvent[]>;
}

export interface QueryToolDependencies {
  openRepository?: (config: AssistantToolConfig) => QueryRepository;
  openCalendar?: (config: AssistantToolConfig) => CalendarReader;
  openHealth?: (config: AssistantToolConfig) => SubsystemHealthJournal;
}

interface QueryResult {
  kind: 'records' | 'calendar';
  trust: 'quoted_untrusted_data';
  items: ParsedRecord[] | CalendarEvent[];
}

export function createQueryTool(
  api: OpenClawPluginApi,
  toolContext: Pick<OpenClawPluginToolContext, 'requesterSenderId'>,
  dependencies: QueryToolDependencies = {},
): AgentTool<typeof queryParameters, QueryResult> {
  return {
    name: 'assistant_query',
    label: 'Assistant Query',
    description: 'Read owner-scoped local records or Naver CalDAV events as quoted untrusted data.',
    parameters: queryParameters,
    async execute(_toolCallId, params, signal) {
      const config = loadConfigFromApi(api);
      assertOwner(toolContext, config);
      if (!Value.Check(queryParameters, params)) {
        throw new AssistantToolError('invalid_parameters', 'Query parameters do not match the tool schema');
      }
      signal?.throwIfAborted();

      if (params.kind === 'calendar') {
        validateRange(params.from, params.to);
        let calendar: CalendarReader;
        try {
          calendar = (dependencies.openCalendar ?? openCalendar)(config);
        } catch (error) {
          if (error instanceof AssistantToolError && error.code === 'caldav_read_disabled') {
            const health = (dependencies.openHealth ?? (scoped => new SubsystemHealthStore(scoped.stateDir)))(config);
            try {
              health.report({ target: 'naver-caldav', errorCode: error.code,
                message: 'Calendar reads are disabled pending authorized live validation' });
            } finally { health.close(); }
          }
          throw error;
        }
        const items = await calendar.listEvents({ start: params.from, end: params.to }, signal);
        return jsonResult({ kind: 'calendar', trust: 'quoted_untrusted_data', items });
      }

      const repository = (dependencies.openRepository ?? openRepository)(config);
      try {
        const items = await repository.query({
          ...(params.recordType === undefined ? {} : { kind: params.recordType }),
          ...(params.targetId === undefined ? {} : { id: params.targetId }),
          ...(params.includeArchived === undefined ? {} : { includeArchived: params.includeArchived }),
        });
        return jsonResult({ kind: 'records', trust: 'quoted_untrusted_data', items });
      } finally {
        repository.close();
      }
    },
  };
}

function openRepository(config: AssistantToolConfig): QueryRepository {
  return new WorkspaceRepository(config);
}

function openCalendar(config: AssistantToolConfig): CalendarReader {
  const calendar = requireCalendarReadConfig(config);
  const client = new CalDavClient({
    baseUrl: calendar.caldavBaseUrl,
    secretFile: calendar.caldavSecretFile,
    calendarMappings: calendar.calendarMappings,
  });
  return { listEvents: (range, signal) => client.listMappedEvents(range, signal) };
}

function validateRange(from: string, to: string): void {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 31 * 86_400_000) {
    throw new AssistantToolError('invalid_calendar_range', 'Calendar range must contain valid increasing timestamps');
  }
}
