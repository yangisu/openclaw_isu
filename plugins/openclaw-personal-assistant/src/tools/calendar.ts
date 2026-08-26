import type { AgentTool } from 'openclaw/plugin-sdk/agent-core';
import { join } from 'node:path';
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from 'openclaw/plugin-sdk/plugin-entry';
import { jsonResult } from 'openclaw/plugin-sdk/tool-results';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import {
  CALENDAR_EVENT_DATE_PATTERN,
  buildIcal,
  semanticEventHash,
  validateCalendarEventDraft,
  type CalendarEventDraft,
  type RecurrenceRule,
} from '../calendar/ical.js';
import { NaverCalendarApi } from '../calendar/naver-api.js';
import {
  NaverOAuth, validateNaverOAuthClientCredentials,
  type NaverOAuthClientCredentials, type NaverTokenSet, type SecretStore,
} from '../calendar/oauth.js';
import type { SubsystemHealthJournal } from '../state/health.js';
import {
  CalendarOutbox,
  type CalendarRequest,
  type PrepareCalendarRequest,
} from '../calendar/outbox.js';
import { SecretFileStore } from '../secrets/file-store.js';
import {
  AssistantToolError,
  assertOwner,
  loadConfigFromApi,
  requireCalendarWriteConfig,
  type AssistantToolConfig,
} from './trust.js';

const uuidSchema = Type.String({
  format: 'uuid',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
});
const payloadHashSchema = Type.String({ pattern: '^[a-f0-9]{64}$', minLength: 64, maxLength: 64 });
const eventDateSchema = Type.String({
  pattern: CALENDAR_EVENT_DATE_PATTERN,
  maxLength: 40,
});
const recurrenceSchema = Type.Object({
  freq: Type.Union([
    Type.Literal('DAILY'), Type.Literal('WEEKLY'), Type.Literal('MONTHLY'), Type.Literal('YEARLY'),
  ]),
  interval: Type.Optional(Type.Integer({ minimum: 1, maximum: 999 })),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 9999 })),
  until: Type.Optional(eventDateSchema),
  byday: Type.Optional(Type.Array(Type.Union([
    Type.Literal('MO'), Type.Literal('TU'), Type.Literal('WE'), Type.Literal('TH'),
    Type.Literal('FR'), Type.Literal('SA'), Type.Literal('SU'),
  ]), { maxItems: 7, uniqueItems: true })),
}, { additionalProperties: false });

export const calendarPrepareParameters = Type.Object({
  requestId: Type.Optional(uuidSchema),
  calendarId: Type.String({ minLength: 1, maxLength: 512 }),
  uid: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._@-]{0,254}$', maxLength: 255 }),
  dtstart: eventDateSchema,
  dtend: eventDateSchema,
  summary: Type.String({ minLength: 1, maxLength: 1000 }),
  location: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  rrule: Type.Optional(recurrenceSchema),
}, { additionalProperties: false });

export const calendarConfirmParameters = Type.Object({
  requestId: uuidSchema,
  payloadHash: payloadHashSchema,
}, { additionalProperties: false });

type CalendarPrepareParameters = Static<typeof calendarPrepareParameters>;
type CalendarConfirmParameters = Static<typeof calendarConfirmParameters>;

interface PreparedOutbox {
  prepare(input: PrepareCalendarRequest): CalendarRequest;
  close(): void;
}

interface ConfirmingOutbox {
  confirmAndSubmit(requestId: string, senderId: string, payloadHash: string): Promise<CalendarRequest>;
  close(): void;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface CalendarWriteApiDependencies {
  credentialStore?: SecretStore<unknown>;
  tokenStore?: SecretStore<NaverTokenSet>;
  oauthFetch?: FetchLike;
  calendarFetch?: FetchLike;
  now?: () => number;
  health?: Pick<SubsystemHealthJournal, 'report' | 'recover'>;
}

export interface CalendarPrepareDependencies {
  openOutbox?: (config: AssistantToolConfig) => PreparedOutbox;
}

export interface CalendarConfirmDependencies {
  openOutbox?: (config: AssistantToolConfig) => Promise<ConfirmingOutbox>;
}

interface CalendarPrepareResult {
  requestId: string;
  payloadHash: string;
  status: 'draft';
  confirmationRequired: true;
  externalWrite: false;
  event: CalendarEventDraft;
}

interface CalendarConfirmResult {
  requestId: string;
  payloadHash: string;
  status: 'confirmation_unavailable';
  externalWrite: false;
  errorCode: 'host_provenance_unavailable';
}

export function createCalendarPrepareTool(
  api: OpenClawPluginApi,
  toolContext: Pick<OpenClawPluginToolContext, 'requesterSenderId'>,
  dependencies: CalendarPrepareDependencies = {},
): AgentTool<typeof calendarPrepareParameters, CalendarPrepareResult> {
  return {
    name: 'assistant_calendar_prepare',
    label: 'Assistant Calendar Prepare',
    description: 'Prepare one Naver calendar event locally and return its content-bound confirmation identifiers.',
    parameters: calendarPrepareParameters,
    async execute(_toolCallId, params, signal) {
      const config = loadConfigFromApi(api);
      assertOwner(toolContext, config);
      if (!Value.Check(calendarPrepareParameters, params)) {
        throw new AssistantToolError('invalid_parameters', 'Calendar draft parameters do not match the tool schema');
      }
      signal?.throwIfAborted();
      const event = calendarDraft(params);
      try {
        validateCalendarEventDraft(event);
      } catch (error) {
        throw new AssistantToolError(
          'invalid_calendar_event',
          error instanceof Error ? error.message : 'Calendar event is invalid',
        );
      }
      const payloadIcal = buildIcal(event);
      const payloadHash = semanticEventHash(event);
      const outbox = (dependencies.openOutbox ?? openPrepareOutbox)(config);
      try {
        const request = outbox.prepare({
          ...(params.requestId === undefined ? {} : { requestId: params.requestId }),
          calendarId: event.calendarId,
          uid: event.uid,
          payloadIcal,
          payloadHash,
        });
        return jsonResult({
          requestId: request.requestId,
          payloadHash: request.payloadHash,
          status: 'draft',
          confirmationRequired: true,
          externalWrite: false,
          event,
        });
      } finally {
        outbox.close();
      }
    },
  };
}

export function createCalendarConfirmTool(
  api: OpenClawPluginApi,
  toolContext: Pick<OpenClawPluginToolContext, 'requesterSenderId'>,
  dependencies: CalendarConfirmDependencies = {},
): AgentTool<typeof calendarConfirmParameters, CalendarConfirmResult> {
  return {
    name: 'assistant_calendar_confirm',
    label: 'Assistant Calendar Confirm',
    description: 'Create one prepared Naver event after explicit owner confirmation.',
    parameters: calendarConfirmParameters,
    async execute(_toolCallId, params, signal) {
      const config = loadConfigFromApi(api);
      const senderId = assertOwner(toolContext, config);
      if (!Value.Check(calendarConfirmParameters, params)) {
        throw new AssistantToolError('invalid_parameters', 'Calendar confirmation parameters do not match the tool schema');
      }
      signal?.throwIfAborted();
      void senderId;
      void dependencies;
      return jsonResult({
        requestId: params.requestId,
        payloadHash: params.payloadHash,
        status: 'confirmation_unavailable',
        externalWrite: false,
        errorCode: 'host_provenance_unavailable',
      });
    },
  };
}

function calendarDraft(params: CalendarPrepareParameters): CalendarEventDraft {
  return {
    calendarId: params.calendarId,
    uid: params.uid,
    dtstart: params.dtstart,
    dtend: params.dtend,
    summary: params.summary,
    ...(params.location === undefined ? {} : { location: params.location }),
    ...(params.rrule === undefined ? {} : { rrule: params.rrule as RecurrenceRule }),
  };
}

function openPrepareOutbox(config: AssistantToolConfig): PreparedOutbox {
  return new CalendarOutbox({
    stateDir: config.stateDir,
    api: {
      async createSchedule() {
        throw new AssistantToolError('external_write_forbidden', 'Calendar prepare cannot write externally');
      },
    },
    caldav: {
      async listEvents() {
        throw new AssistantToolError('external_read_forbidden', 'Calendar prepare cannot read externally');
      },
    },
  });
}

export async function createCalendarWriteApi(
  config: AssistantToolConfig,
  dependencies: CalendarWriteApiDependencies = {},
): Promise<NaverCalendarApi> {
  const { naverOAuthClientFile, naverTokenFile } = requireCalendarWriteConfig(config);
  const credentialStore = dependencies.credentialStore ?? new SecretFileStore<unknown>(naverOAuthClientFile, 16_384);
  const tokenStore = dependencies.tokenStore ?? new SecretFileStore<NaverTokenSet>(naverTokenFile, 32_768);
  const credentials: NaverOAuthClientCredentials = validateNaverOAuthClientCredentials(await credentialStore.read());
  const oauth = new NaverOAuth({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri: credentials.redirectUri,
    stateDbPath: join(config.stateDir, 'naver-oauth-state.sqlite3'),
    tokenStore,
    ...(dependencies.oauthFetch === undefined ? {} : { fetch: dependencies.oauthFetch }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(dependencies.health === undefined ? {} : { health: dependencies.health }),
    healthStateDir: config.stateDir,
  });
  const accessToken = await oauth.getValidAccessToken();
  return new NaverCalendarApi({
    accessToken,
    ...(dependencies.calendarFetch === undefined ? {} : { fetch: dependencies.calendarFetch }),
  });
}
