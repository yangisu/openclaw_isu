import type { AnyAgentTool } from 'openclaw/plugin-sdk/core';
import { createHash, randomUUID } from 'node:crypto';
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
  GoogleCalendarApi,
  GoogleCalendarError,
  validateGoogleCalendarBinding,
  type GoogleCalendarEvent,
  type GoogleEventMutation,
  type GoogleEventPatch,
} from '../calendar/google-api.js';
import {
  GoogleCalendarLedger,
  GoogleCalendarLedgerError,
  type MutationRecord,
} from '../calendar/google-ledger.js';
import {
  GoogleOAuth,
  validateGoogleOAuthClientCredentials,
  type GoogleOAuthClientCredentials,
  type GoogleTokenSet,
} from '../calendar/google-oauth.js';
import {
  AssistantToolError,
  assertOwner,
  loadConfigFromApi,
  requireGoogleCalendarConfig,
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
): AnyAgentTool {
  return {
    name: 'assistant_calendar_prepare',
    label: 'Assistant Calendar Prepare',
    description: 'Prepare one Naver calendar event locally and return its content-bound confirmation identifiers.',
    parameters: calendarPrepareParameters,
    async execute(_toolCallId: string, params: Static<typeof calendarPrepareParameters>, signal?: AbortSignal) {
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
): AnyAgentTool {
  return {
    name: 'assistant_calendar_confirm',
    label: 'Assistant Calendar Confirm',
    description: 'Create one prepared Naver event after explicit owner confirmation.',
    parameters: calendarConfirmParameters,
    async execute(_toolCallId: string, params: Static<typeof calendarConfirmParameters>, signal?: AbortSignal) {
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

const googleEventIdSchema = Type.String({ pattern: '^[A-Za-z0-9_-]{1,1024}$', maxLength: 1024 });
const googleEtagSchema = Type.String({ pattern: '^"[^"\\r\\n]{1,1022}"$', maxLength: 1024 });

const calendarCreateParameters = Type.Object({
  action: Type.Literal('create'),
  requestId: Type.Optional(uuidSchema),
  summary: Type.String({ minLength: 1, maxLength: 1000 }),
  dtstart: eventDateSchema,
  dtend: eventDateSchema,
  location: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
  rrule: Type.Optional(recurrenceSchema),
}, { additionalProperties: false });

const calendarUpdateParameters = Type.Object({
  action: Type.Literal('update'),
  requestId: Type.Optional(uuidSchema),
  eventId: googleEventIdSchema,
  etag: googleEtagSchema,
  summary: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  dtstart: Type.Optional(eventDateSchema),
  dtend: Type.Optional(eventDateSchema),
  location: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 1000 }), Type.Null()])),
  description: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 8000 }), Type.Null()])),
  rrule: Type.Optional(Type.Union([recurrenceSchema, Type.Null()])),
}, { additionalProperties: false });

const calendarDeleteParameters = Type.Object({
  action: Type.Literal('delete'),
  requestId: Type.Optional(uuidSchema),
  eventId: googleEventIdSchema,
  etag: googleEtagSchema,
}, { additionalProperties: false });

export const calendarManageParameters = Type.Union([
  calendarCreateParameters, calendarUpdateParameters, calendarDeleteParameters,
]);

type CalendarManageParameters = Static<typeof calendarManageParameters>;

export interface CalendarManageApi {
  createEvent(input: GoogleEventMutation, signal?: AbortSignal): Promise<GoogleCalendarEvent>;
  getEvent(eventId: string, signal?: AbortSignal): Promise<GoogleCalendarEvent>;
  updateEvent(eventId: string, etag: string, patch: GoogleEventPatch, signal?: AbortSignal): Promise<GoogleCalendarEvent>;
  deleteEvent(eventId: string, etag: string, signal?: AbortSignal): Promise<{ deleted: true }>;
}

export interface CalendarManageDependencies {
  openLedger?: (config: AssistantToolConfig) => GoogleCalendarLedger;
  openApi?: (config: AssistantToolConfig) => Promise<CalendarManageApi>;
  closeLedger?: boolean;
}

interface CalendarManageResult {
  action: 'create' | 'update' | 'delete';
  status: 'succeeded';
  replayed: boolean;
  eventId: string;
  event?: GoogleCalendarEvent;
  deleted?: true;
}

export function createCalendarManageTool(
  api: OpenClawPluginApi,
  toolContext: Pick<OpenClawPluginToolContext, 'requesterSenderId'>,
  dependencies: CalendarManageDependencies = {},
): AnyAgentTool {
  return {
    name: 'assistant_calendar_manage',
    label: 'Assistant Google Calendar Manage',
    description: 'Create, update, or delete one event in the owner-only app-created Google calendar.',
    parameters: calendarManageParameters,
    async execute(_toolCallId: string, params: Static<typeof calendarManageParameters>, signal?: AbortSignal) {
      const config = loadConfigFromApi(api);
      assertOwner(toolContext, config);
      if (!Value.Check(calendarManageParameters, params)) {
        throw new AssistantToolError('invalid_parameters', 'Calendar mutation parameters do not match the tool schema');
      }
      validateManageParameters(params);
      signal?.throwIfAborted();
      const requestId = params.requestId ?? randomUUID();
      const eventId = params.action === 'create'
        ? `oc${requestId.replaceAll('-', '')}`
        : params.eventId;
      const payloadHash = hashManageParameters(params, eventId);
      const ledger = (dependencies.openLedger ?? openGoogleLedger)(config);
      let record: MutationRecord;
      try {
        record = ledger.claim({
          requestId,
          action: params.action,
          eventId,
          payloadHash,
          ...(params.action === 'create' ? {} : { etag: params.etag }),
        });
        if (record.status === 'succeeded') {
          return jsonResult({
            action: params.action,
            status: 'succeeded',
            replayed: true,
            eventId,
            ...(params.action === 'delete' ? { deleted: true as const } : {}),
          });
        }
        if (record.status === 'failed' || record.status === 'unknown') {
          throw new AssistantToolError(
            record.errorCode ?? 'calendar_result_unknown',
            'A previous calendar mutation with this request ID did not complete safely',
          );
        }
        ledger.markSubmitting(requestId);
        const calendar = await (dependencies.openApi ?? openGoogleApi)(config);
        try {
          if (params.action === 'create') {
            const created = await calendar.createEvent({
              eventId,
              summary: params.summary,
              dtstart: params.dtstart,
              dtend: params.dtend,
              ...(params.location === undefined ? {} : { location: params.location }),
              ...(params.description === undefined ? {} : { description: params.description }),
              ...(params.rrule === undefined ? {} : { rrule: params.rrule as RecurrenceRule }),
            }, signal);
            ledger.finish(requestId, { status: 'succeeded', resultEtag: created.etag, errorCode: null });
            return jsonResult({ action: 'create', status: 'succeeded', replayed: false, eventId, event: created });
          }

          const current = await calendar.getEvent(eventId, signal);
          if (current.recurringEventId) {
            throw new AssistantToolError(
              'calendar_recurring_instance_unsupported',
              'Individual recurring event instances are not supported',
            );
          }
          if (current.etag !== params.etag) {
            throw new AssistantToolError('calendar_conflict', 'Calendar event changed; query it again before mutation');
          }
          if (params.action === 'update') {
            const patch = googlePatch(params);
            const updated = await calendar.updateEvent(eventId, params.etag, patch, signal);
            ledger.finish(requestId, { status: 'succeeded', resultEtag: updated.etag, errorCode: null });
            return jsonResult({ action: 'update', status: 'succeeded', replayed: false, eventId, event: updated });
          }
          await calendar.deleteEvent(eventId, params.etag, signal);
          ledger.finish(requestId, { status: 'succeeded', errorCode: null });
          return jsonResult({ action: 'delete', status: 'succeeded', replayed: false, eventId, deleted: true });
        } catch (error) {
          if (error instanceof GoogleCalendarLedgerError) {
            throw new AssistantToolError(
              error.code,
              userFriendlyCalendarError(error.code),
            );
          }
          const code = calendarErrorCode(error);
          const uncertain = ['calendar_timeout', 'calendar_request_failed', 'calendar_server'].includes(code);
          try {
            ledger.finish(requestId, {
              status: uncertain ? 'unknown' : 'failed',
              errorCode: uncertain ? 'calendar_result_unknown' : code,
            });
          } catch { /* retain the original operation error */ }
          if (error instanceof AssistantToolError) throw error;
          throw new AssistantToolError(code, userFriendlyCalendarError(code));
        }
      } catch (error) {
        if (error instanceof GoogleCalendarLedgerError) {
          throw new AssistantToolError(
            error.code,
            userFriendlyCalendarError(error.code),
          );
        }
        throw error;
      } finally {
        if (dependencies.closeLedger !== false) ledger.close();
      }
    },
  };
}

function userFriendlyCalendarError(code: string): string {
  switch (code) {
    case 'invalid_claim':
    case 'invalid_parameters':
      return '캘린더 등록/수정 요청 검증에 실패했습니다. 다시 시도해 주세요.';
    case 'calendar_conflict':
      return '캘린더 일정이 변경되었습니다. 다시 조회 후 수정해 주세요.';
    case 'calendar_binding_invalid':
      return '구글 캘린더 설정(바인딩)이 올바르지 않습니다.';
    case 'google_oauth_account_mismatch':
    case 'calendar_auth':
      return '구글 캘린더 계정 인증에 실패했습니다.';
    case 'calendar_not_found':
      return '해당 캘린더 일정을 찾을 수 없습니다.';
    case 'calendar_rate_limited':
      return '구글 캘린더 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.';
    case 'calendar_timeout':
      return '구글 캘린더 요청 시간이 초과되었습니다.';
    default:
      return '구글 캘린더 요청 처리에 실패했습니다.';
  }
}

function validateManageParameters(params: CalendarManageParameters): void {
  if (params.action !== 'update') return;
  const patchKeys = ['summary', 'dtstart', 'dtend', 'location', 'description', 'rrule'] as const;
  if (!patchKeys.some(key => params[key] !== undefined)
    || ((params.dtstart === undefined) !== (params.dtend === undefined))) {
    throw new AssistantToolError('invalid_parameters', 'Calendar update must contain a complete change');
  }
}

function googlePatch(params: Extract<CalendarManageParameters, { action: 'update' }>): GoogleEventPatch {
  return {
    ...(params.summary === undefined ? {} : { summary: params.summary }),
    ...(params.dtstart === undefined ? {} : { dtstart: params.dtstart }),
    ...(params.dtend === undefined ? {} : { dtend: params.dtend }),
    ...(params.location === undefined ? {} : { location: params.location }),
    ...(params.description === undefined ? {} : { description: params.description }),
    ...(params.rrule === undefined ? {} : { rrule: params.rrule as RecurrenceRule | null }),
  };
}

function hashManageParameters(params: CalendarManageParameters, eventId: string): string {
  const canonical: Record<string, unknown> = {
    action: params.action,
    eventId,
  };
  if (params.action !== 'create') {
    canonical.etag = params.etag;
  }
  if ('summary' in params && params.summary !== undefined) canonical.summary = params.summary;
  if ('dtstart' in params && params.dtstart !== undefined) canonical.dtstart = params.dtstart;
  if ('dtend' in params && params.dtend !== undefined) canonical.dtend = params.dtend;
  if ('location' in params && params.location !== undefined) canonical.location = params.location;
  if ('description' in params && params.description !== undefined) canonical.description = params.description;
  if ('rrule' in params && params.rrule !== undefined) canonical.rrule = params.rrule;

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function calendarErrorCode(error: unknown): string {
  if (error instanceof GoogleCalendarError || error instanceof AssistantToolError) return error.code;
  return 'calendar_request_failed';
}

function openGoogleLedger(config: AssistantToolConfig): GoogleCalendarLedger {
  return new GoogleCalendarLedger(join(config.stateDir, 'google-calendar-mutations.sqlite3'));
}

async function openGoogleApi(config: AssistantToolConfig): Promise<CalendarManageApi> {
  const calendar = requireGoogleCalendarConfig(config);
  const credentials = validateGoogleOAuthClientCredentials(
    await new SecretFileStore<unknown>(calendar.googleOAuthClientFile, 16_384).read(),
  );
  const tokenStore = new SecretFileStore<GoogleTokenSet>(calendar.googleTokenFile, 32_768);
  const binding = validateGoogleCalendarBinding(
    await new SecretFileStore<unknown>(calendar.googleCalendarBindingFile, 16_384).read(),
  );
  const oauth = new GoogleOAuth({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    expectedAccount: calendar.expectedAccount,
    stateDbPath: join(config.stateDir, 'google-oauth-state.sqlite3'),
    tokenStore,
  });
  return new GoogleCalendarApi({ binding, accessToken: () => oauth.getValidAccessToken() });
}
