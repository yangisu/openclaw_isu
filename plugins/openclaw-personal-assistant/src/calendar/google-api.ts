import { BoundedBodyError, readBoundedJson } from './bounded-json.js';
import {
  validateCalendarEventDraft,
  type CalendarEvent,
  type RecurrenceRule,
} from './ical.js';
import type { SecretStore } from './oauth.js';

const API_ROOT = 'https://www.googleapis.com/calendar/v3';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_PAGES = 10;
const MAX_EVENTS = 2_500;
const CREATED_EVENT_ID = /^[a-v0-9]{5,1024}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/;
const ETAG = /^"[^"\r\n]{1,1022}"$/;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface GoogleCalendarBinding {
  version: 1;
  calendarId: string;
  summary: 'openclaw_cal';
  timeZone: 'Asia/Seoul';
  createdAt: string;
}

export interface GoogleEventMutation {
  eventId: string;
  summary: string;
  dtstart: string;
  dtend: string;
  location?: string;
  description?: string;
  rrule?: RecurrenceRule;
}

export interface GoogleEventPatch {
  summary?: string;
  dtstart?: string;
  dtend?: string;
  location?: string | null;
  description?: string | null;
  rrule?: RecurrenceRule | null;
}

export interface GoogleCalendarEvent extends CalendarEvent {
  eventId: string;
  etag: string;
  description?: string;
  recurringEventId?: string;
}

export type GoogleCalendarErrorCode =
  | 'calendar_binding_invalid'
  | 'calendar_invalid_event'
  | 'calendar_invalid_range'
  | 'calendar_conflict'
  | 'calendar_not_found'
  | 'calendar_auth'
  | 'calendar_rate_limited'
  | 'calendar_server'
  | 'calendar_timeout'
  | 'calendar_invalid_response'
  | 'calendar_request_failed';

export class GoogleCalendarError extends Error {
  constructor(public readonly code: GoogleCalendarErrorCode, message: string) {
    super(message);
    this.name = 'GoogleCalendarError';
  }
}

export interface GoogleCalendarApiOptions {
  binding: GoogleCalendarBinding;
  accessToken: () => Promise<string>;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface GoogleCalendarBootstrapOptions {
  bindingStore: SecretStore<GoogleCalendarBinding>;
  existingBinding?: unknown;
  accessToken: () => Promise<string>;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

export class GoogleCalendarApi {
  readonly binding: GoogleCalendarBinding;
  readonly #accessToken: () => Promise<string>;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: GoogleCalendarApiOptions) {
    this.binding = validateGoogleCalendarBinding(options.binding);
    this.#accessToken = options.accessToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  static async bootstrap(options: GoogleCalendarBootstrapOptions): Promise<GoogleCalendarApi> {
    const common = {
      accessToken: options.accessToken,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    };
    if (options.existingBinding !== undefined) {
      const binding = validateGoogleCalendarBinding(options.existingBinding);
      const api = new GoogleCalendarApi({ binding, ...common });
      const remote = objectValue(await api.#request(
        `/calendars/${encodeURIComponent(binding.calendarId)}`, { method: 'GET' }, true,
      ));
      if (remote.id !== binding.calendarId || remote.summary !== 'openclaw_cal' || remote.timeZone !== 'Asia/Seoul') {
        throw new GoogleCalendarError('calendar_binding_invalid', 'Google calendar binding no longer matches');
      }
      return api;
    }

    const temporaryBinding: GoogleCalendarBinding = {
      version: 1,
      calendarId: 'bootstrap@group.calendar.google.com',
      summary: 'openclaw_cal',
      timeZone: 'Asia/Seoul',
      createdAt: new Date(options.now?.() ?? Date.now()).toISOString(),
    };
    const api = new GoogleCalendarApi({ binding: temporaryBinding, ...common });
    const remote = objectValue(await api.#request('/calendars', {
      method: 'POST', body: { summary: 'openclaw_cal', timeZone: 'Asia/Seoul' },
    }, true));
    const binding = validateGoogleCalendarBinding({
      version: 1,
      calendarId: remote.id,
      summary: remote.summary,
      timeZone: remote.timeZone,
      createdAt: temporaryBinding.createdAt,
    });
    await options.bindingStore.write(binding);
    return new GoogleCalendarApi({ binding, ...common });
  }

  async listEvents(
    range: { start: string; end: string },
    signal?: AbortSignal,
  ): Promise<GoogleCalendarEvent[]> {
    validateRange(range);
    const events: GoogleCalendarEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = new URLSearchParams({
        timeMin: new Date(range.start).toISOString(),
        timeMax: new Date(range.end).toISOString(),
        singleEvents: 'false',
        showDeleted: 'false',
        maxResults: '250',
      });
      if (pageToken) query.set('pageToken', pageToken);
      const response = objectValue(await this.#request(
        `/calendars/${encodeURIComponent(this.binding.calendarId)}/events?${query}`,
        { method: 'GET', signal },
      ));
      if (!Array.isArray(response.items)) {
        throw new GoogleCalendarError('calendar_invalid_response', 'Google Calendar returned invalid events');
      }
      for (const item of response.items) {
        events.push(parseEvent(item, this.binding.calendarId));
        if (events.length > MAX_EVENTS) {
          throw new GoogleCalendarError('calendar_invalid_response', 'Google Calendar returned too many events');
        }
      }
      if (response.nextPageToken === undefined) return events;
      if (typeof response.nextPageToken !== 'string' || response.nextPageToken.length < 1
        || response.nextPageToken.length > 4_096) {
        throw new GoogleCalendarError('calendar_invalid_response', 'Google Calendar returned an invalid page token');
      }
      pageToken = response.nextPageToken;
    }
    throw new GoogleCalendarError('calendar_invalid_response', 'Google Calendar pagination limit exceeded');
  }

  async getEvent(eventId: string, signal?: AbortSignal): Promise<GoogleCalendarEvent> {
    validateEventId(eventId);
    return parseEvent(await this.#request(
      `/calendars/${encodeURIComponent(this.binding.calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: 'GET', signal },
    ), this.binding.calendarId);
  }

  async createEvent(input: GoogleEventMutation, signal?: AbortSignal): Promise<GoogleCalendarEvent> {
    if (!CREATED_EVENT_ID.test(input.eventId)) {
      throw new GoogleCalendarError('calendar_invalid_event', 'Google Calendar event ID is invalid');
    }
    validateMutation(input);
    return parseEvent(await this.#request(
      `/calendars/${encodeURIComponent(this.binding.calendarId)}/events`,
      { method: 'POST', body: eventBody(input), signal },
    ), this.binding.calendarId);
  }

  async updateEvent(
    eventId: string,
    etag: string,
    patch: GoogleEventPatch,
    signal?: AbortSignal,
  ): Promise<GoogleCalendarEvent> {
    validateEventId(eventId);
    validateEtag(etag);
    validatePatch(patch);
    return parseEvent(await this.#request(
      `/calendars/${encodeURIComponent(this.binding.calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: 'PATCH', body: patchBody(patch), headers: { 'if-match': etag }, signal },
    ), this.binding.calendarId);
  }

  async deleteEvent(eventId: string, etag: string, signal?: AbortSignal): Promise<{ deleted: true }> {
    validateEventId(eventId);
    validateEtag(etag);
    await this.#request(
      `/calendars/${encodeURIComponent(this.binding.calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: 'DELETE', headers: { 'if-match': etag }, signal },
    );
    return { deleted: true };
  }

  async #request(
    path: string,
    options: {
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    },
    bootstrap = false,
  ): Promise<unknown> {
    let token = await this.#accessToken();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const timeout = AbortSignal.timeout(this.#timeoutMs);
      const combined = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
      let response: Response;
      try {
        response = await this.#fetch(`${API_ROOT}${path}`, {
          method: options.method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(options.body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }),
            ...options.headers,
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          signal: combined,
        });
      } catch {
        if (combined.aborted) throw new GoogleCalendarError('calendar_timeout', 'Google Calendar request timed out');
        throw new GoogleCalendarError('calendar_request_failed', 'Google Calendar request failed');
      }
      if (response.status === 401 && attempt === 0) {
        token = await this.#accessToken();
        continue;
      }
      if (!response.ok) throw calendarHttpError(response.status, bootstrap);
      if (options.method === 'DELETE' || response.status === 204) return undefined;
      try {
        return await readBoundedJson(response, MAX_RESPONSE_BYTES);
      } catch (error) {
        if (error instanceof BoundedBodyError && error.code !== 'body_failed') {
          throw new GoogleCalendarError('calendar_invalid_response', 'Google Calendar returned an invalid response');
        }
        throw new GoogleCalendarError('calendar_request_failed', 'Google Calendar response failed');
      }
    }
    throw new GoogleCalendarError('calendar_auth', 'Google Calendar authentication failed');
  }
}

export function validateGoogleCalendarBinding(value: unknown): GoogleCalendarBinding {
  const record = objectValue(value);
  if (Object.keys(record).sort().join('\0') !== ['calendarId', 'createdAt', 'summary', 'timeZone', 'version'].join('\0')
    || record.version !== 1
    || typeof record.calendarId !== 'string' || record.calendarId === 'primary'
    || record.calendarId.length < 10 || record.calendarId.length > 1_024
    || !/^[A-Za-z0-9._%+@-]+$/.test(record.calendarId)
    || !record.calendarId.endsWith('@group.calendar.google.com')
    || record.summary !== 'openclaw_cal' || record.timeZone !== 'Asia/Seoul'
    || typeof record.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.createdAt)
    || !Number.isFinite(Date.parse(record.createdAt))) {
    throw new GoogleCalendarError('calendar_binding_invalid', 'Google calendar binding is invalid');
  }
  return {
    version: 1, calendarId: record.calendarId, summary: 'openclaw_cal',
    timeZone: 'Asia/Seoul', createdAt: record.createdAt,
  };
}

function parseEvent(value: unknown, calendarId: string): GoogleCalendarEvent {
  const record = objectValue(value);
  const start = parseEventTime(record.start);
  const end = parseEventTime(record.end);
  const eventId = typeof record.id === 'string' ? record.id : '';
  const etag = typeof record.etag === 'string' ? record.etag : '';
  const summary = typeof record.summary === 'string' ? record.summary.normalize('NFC') : '';
  if (!EVENT_ID.test(eventId) || !ETAG.test(etag) || !summary || summary.length > 1_000
    || start.dateOnly !== end.dateOnly) {
    throw new GoogleCalendarError('calendar_invalid_response', 'Google Calendar returned an invalid event');
  }
  const recurrence = parseRecurrence(record.recurrence);
  const recurringEventId = typeof record.recurringEventId === 'string' ? record.recurringEventId : undefined;
  return {
    calendarId,
    uid: eventId,
    eventId,
    etag,
    dtstart: start.value,
    dtend: end.value,
    summary,
    ...(typeof record.location === 'string' ? { location: record.location.normalize('NFC') } : {}),
    ...(typeof record.description === 'string' ? { description: record.description.normalize('NFC') } : {}),
    ...(recurrence === undefined ? {} : { rrule: recurrence }),
    ...(recurringEventId === undefined ? {} : { recurringEventId }),
    kind: start.dateOnly ? 'all-day' : recurrence || recurringEventId ? 'recurring' : 'timed',
    status: typeof record.status === 'string' ? record.status.toUpperCase() : 'CONFIRMED',
  };
}

function eventBody(input: GoogleEventMutation): Record<string, unknown> {
  const normalized = validateCalendarEventDraft({
    calendarId: 'google', uid: input.eventId, summary: input.summary,
    dtstart: input.dtstart, dtend: input.dtend,
    ...(input.location === undefined ? {} : { location: input.location }),
    ...(input.rrule === undefined ? {} : { rrule: input.rrule }),
  });
  return {
    id: input.eventId,
    summary: input.summary.normalize('NFC'),
    ...(input.description === undefined ? {} : { description: input.description.normalize('NFC') }),
    ...(input.location === undefined ? {} : { location: input.location.normalize('NFC') }),
    start: normalized.kind === 'all-day'
      ? { date: input.dtstart }
      : { dateTime: input.dtstart, timeZone: 'Asia/Seoul' },
    end: normalized.kind === 'all-day'
      ? { date: input.dtend }
      : { dateTime: input.dtend, timeZone: 'Asia/Seoul' },
    ...(input.rrule === undefined ? {} : { recurrence: [`RRULE:${formatRecurrence(input.rrule)}`] }),
  };
}

function patchBody(patch: GoogleEventPatch): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (patch.summary !== undefined) body.summary = patch.summary.normalize('NFC');
  if (patch.description !== undefined) body.description = patch.description?.normalize('NFC') ?? null;
  if (patch.location !== undefined) body.location = patch.location?.normalize('NFC') ?? null;
  if (patch.rrule !== undefined) body.recurrence = patch.rrule ? [`RRULE:${formatRecurrence(patch.rrule)}`] : [];
  if (patch.dtstart !== undefined) body.start = eventTimeBody(patch.dtstart);
  if (patch.dtend !== undefined) body.end = eventTimeBody(patch.dtend);
  return body;
}

function eventTimeBody(value: string): Record<string, string> {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? { date: value }
    : { dateTime: value, timeZone: 'Asia/Seoul' };
}

function validateMutation(input: GoogleEventMutation): void {
  if (!input.summary || input.summary.length > 1_000
    || (input.location !== undefined && input.location.length > 1_000)
    || (input.description !== undefined && input.description.length > 8_000)) {
    throw new GoogleCalendarError('calendar_invalid_event', 'Google Calendar event is invalid');
  }
  try {
    validateCalendarEventDraft({
      calendarId: 'google', uid: input.eventId, summary: input.summary,
      dtstart: input.dtstart, dtend: input.dtend,
    });
  } catch {
    throw new GoogleCalendarError('calendar_invalid_event', 'Google Calendar event is invalid');
  }
}

function validatePatch(patch: GoogleEventPatch): void {
  const keys = Object.keys(patch);
  const allowed = new Set(['summary', 'dtstart', 'dtend', 'location', 'description', 'rrule']);
  if (keys.length === 0 || keys.some(key => !allowed.has(key))
    || (patch.summary !== undefined && (!patch.summary || patch.summary.length > 1_000))
    || (patch.location !== undefined && patch.location !== null && patch.location.length > 1_000)
    || (patch.description !== undefined && patch.description !== null && patch.description.length > 8_000)
    || ((patch.dtstart === undefined) !== (patch.dtend === undefined))) {
    throw new GoogleCalendarError('calendar_invalid_event', 'Google Calendar event patch is invalid');
  }
  if (patch.dtstart !== undefined && patch.dtend !== undefined) {
    try {
      validateCalendarEventDraft({ calendarId: 'google', uid: 'event', summary: 'event',
        dtstart: patch.dtstart, dtend: patch.dtend });
    } catch {
      throw new GoogleCalendarError('calendar_invalid_event', 'Google Calendar event patch is invalid');
    }
  }
}

function validateEventId(eventId: string): void {
  if (!EVENT_ID.test(eventId)) {
    throw new GoogleCalendarError('calendar_invalid_event', 'Google Calendar event ID is invalid');
  }
}

function validateEtag(etag: string): void {
  if (!ETAG.test(etag)) throw new GoogleCalendarError('calendar_invalid_event', 'Google Calendar ETag is invalid');
}

function validateRange(range: { start: string; end: string }): void {
  const start = Date.parse(range.start);
  const end = Date.parse(range.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 31 * 86_400_000) {
    throw new GoogleCalendarError('calendar_invalid_range', 'Google Calendar range is invalid');
  }
}

function parseEventTime(value: unknown): { value: string; dateOnly: boolean } {
  const record = objectValue(value);
  const keys = Object.keys(record).sort();
  if (keys.includes('date') && typeof record.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.date)) {
    return { value: record.date, dateOnly: true };
  }
  if (keys.includes('dateTime') && typeof record.dateTime === 'string') {
    const time = Date.parse(record.dateTime);
    if (Number.isFinite(time)) return { value: new Date(time).toISOString(), dateOnly: false };
  }
  throw new GoogleCalendarError('calendar_invalid_response', 'Google Calendar returned an invalid event time');
}

function parseRecurrence(value: unknown): RecurrenceRule | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'string'
    || !value[0].startsWith('RRULE:')) {
    throw new GoogleCalendarError('calendar_invalid_response', 'Google Calendar returned invalid recurrence');
  }
  const result: RecurrenceRule = {};
  for (const part of value[0].slice(6).split(';')) {
    const [rawKey, rawValue, ...extra] = part.split('=');
    if (!rawKey || rawValue === undefined || extra.length) {
      throw new GoogleCalendarError('calendar_invalid_response', 'Google Calendar returned invalid recurrence');
    }
    const key = rawKey.toLowerCase();
    result[key] = key === 'interval' || key === 'count' ? Number(rawValue)
      : key === 'byday' ? rawValue.split(',') : rawValue;
  }
  return result;
}

function formatRecurrence(rule: RecurrenceRule): string {
  const allowed = new Set(['freq', 'interval', 'count', 'until', 'byday']);
  const entries = Object.entries(rule);
  if (!entries.length || entries.some(([key]) => !allowed.has(key.toLowerCase()))) {
    throw new GoogleCalendarError('calendar_invalid_event', 'Google Calendar recurrence is invalid');
  }
  const normalized = Object.fromEntries(entries.map(([key, value]) => [key.toLowerCase(), value]));
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(String(normalized.freq))) {
    throw new GoogleCalendarError('calendar_invalid_event', 'Google Calendar recurrence is invalid');
  }
  const order = ['freq', 'interval', 'count', 'until', 'byday'];
  return order.filter(key => normalized[key] !== undefined).map(key => {
    const value = normalized[key];
    return `${key.toUpperCase()}=${Array.isArray(value) ? value.join(',') : String(value)}`;
  }).join(';');
}

function calendarHttpError(status: number, bootstrap: boolean): GoogleCalendarError {
  if (status === 401 || status === 403) return new GoogleCalendarError('calendar_auth', 'Google Calendar authorization failed');
  if (status === 404) return new GoogleCalendarError(
    bootstrap ? 'calendar_binding_invalid' : 'calendar_not_found',
    bootstrap ? 'Google calendar binding no longer exists' : 'Google Calendar event was not found',
  );
  if (status === 409 || status === 412) return new GoogleCalendarError('calendar_conflict', 'Google Calendar event changed');
  if (status === 429) return new GoogleCalendarError('calendar_rate_limited', 'Google Calendar rate limit exceeded');
  if (status >= 500) return new GoogleCalendarError('calendar_server', 'Google Calendar server failed');
  return new GoogleCalendarError('calendar_request_failed', `Google Calendar request failed with HTTP ${status}`);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
