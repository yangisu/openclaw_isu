import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { canonicalizeCalDavHref, loadCalendarMappings } from '../config.js';
import { CalDavError, type CalDavErrorCode } from './errors.js';
import { type CalendarEvent, parseIcal } from './ical.js';
import { readCalDavCredentials } from './secret.js';

export { CalDavError };
export type { CalDavErrorCode };

export interface CalDavCalendar {
  id: string;
  href: string;
  displayName: string;
}

export interface EventRange {
  start: string | Date;
  end: string | Date;
}

export interface CalDavCalendarMapping {
  apiCalendarId: string;
  caldavHref: string;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface CalDavClientOptions {
  baseUrl: string;
  secretFile: string;
  fetch?: FetchLike;
  /** Defaults to the fixed production request bound of 15 seconds. */
  timeoutMs?: number;
  calendarMappings?: readonly CalDavCalendarMapping[];
  signal?: AbortSignal;
}

interface CycleBudget {
  remainingBytes: number;
  remainingRequests: number;
  events: number;
  deadline: number;
  signal?: AbortSignal;
}

const DAV_HEADERS = { 'content-type': 'application/xml; charset=utf-8' };
const CALDAV_RESPONSE_MAX_BYTES = 2_097_152;
const CALDAV_XML_MAX_DEPTH = 32;
const CALDAV_XML_MAX_NODES = 10_000;
const CALDAV_MULTISTATUS_MAX_RESPONSES = 1_000;
const CALDAV_HREF_MAX_BYTES = 4_096;
const CALDAV_DISPLAY_NAME_MAX_BYTES = 1_024;
const CALDAV_DATA_MAX_BYTES = 1_048_576;
const CALDAV_ICAL_MAX_CALENDARS = 8;
const CALDAV_ICAL_MAX_EVENTS = 1_000;
const CALDAV_ICAL_UID_MAX_BYTES = 1_024;
const CALDAV_ICAL_TEXT_MAX_BYTES = 16_384;
const CALDAV_MAX_RANGE_MS = 31 * 86_400_000;
const CALDAV_MAX_REQUESTS_PER_CYCLE = 11;

export class CalDavClient {
  readonly #baseUrl: URL;
  readonly #secretFile: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #calendarMappings: ReadonlyMap<string, URL>;
  readonly #signal?: AbortSignal;

  constructor(options: CalDavClientOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    if (this.#baseUrl.protocol !== 'https:') {
      throw new CalDavError('CALDAV_TLS_REQUIRED', 'CalDAV endpoint must use HTTPS');
    }
    this.#secretFile = options.secretFile;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#signal = options.signal;
    try {
      const mappings = options.calendarMappings === undefined
        ? [] : loadCalendarMappings(this.#baseUrl.href, options.calendarMappings);
      this.#calendarMappings = new Map(mappings.map(mapping => [
        mapping.apiCalendarId,
        new URL(mapping.caldavHref),
      ]));
    } catch {
      throw new CalDavError('CALDAV_MAPPING', 'CalDAV calendar mapping is invalid');
    }
  }

  async listCalendars(signal?: AbortSignal): Promise<CalDavCalendar[]> {
    return this.#listCalendars(this.#budget(signal));
  }

  async #listCalendars(budget: CycleBudget): Promise<CalDavCalendar[]> {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:displayname/><d:resourcetype/></d:prop>
</d:propfind>`;
    const xml = await this.#request('PROPFIND', body, '1', this.#baseUrl, budget);
    const responses = responseList(parseXml(xml));
    return responses.flatMap(response => {
      const prop = successfulProperty(response);
      const resourceType = objectValue(prop?.resourcetype);
      if (!prop || !Object.prototype.hasOwnProperty.call(resourceType, 'calendar')) return [];
      const id = boundedText(response.href, CALDAV_HREF_MAX_BYTES).trim();
      let href: URL;
      try { href = canonicalizeCalDavHref(this.#baseUrl, id); }
      catch { throw new CalDavError('CALDAV_MAPPING', 'CalDAV discovery returned an unsafe collection href'); }
      return [{
        id,
        href: href.href,
        displayName: boundedText(prop.displayname, CALDAV_DISPLAY_NAME_MAX_BYTES).trim(),
      }];
    });
  }

  async validateCalendarMappings(signal?: AbortSignal): Promise<CalDavCalendar[]> {
    if (this.#calendarMappings.size === 0) {
      throw new CalDavError('CALDAV_MAPPING', 'CalDAV calendar mapping is unavailable');
    }
    const discovered = await this.#listCalendars(this.#budget(signal));
    this.#assertCalendarMappings(discovered);
    return discovered;
  }

  #assertCalendarMappings(discovered: readonly CalDavCalendar[]): void {
    for (const target of this.#calendarMappings.values()) {
      const ambiguous = discovered.some(calendar => calendar.href !== target.href && (
        new URL(calendar.href).pathname.startsWith(target.pathname) ||
        target.pathname.startsWith(new URL(calendar.href).pathname)
      ));
      if (discovered.filter(calendar => calendar.href === target.href).length !== 1 || ambiguous) {
        throw new CalDavError('CALDAV_MAPPING', 'CalDAV calendar mapping did not match discovery');
      }
    }
  }

  async listMappedEvents(range: EventRange, signal?: AbortSignal): Promise<CalendarEvent[]> {
    assertRange(range);
    if (this.#calendarMappings.size === 0) {
      throw new CalDavError('CALDAV_MAPPING', 'CalDAV calendar mapping is unavailable');
    }
    const budget = this.#budget(signal);
    this.#assertCalendarMappings(await this.#listCalendars(budget));
    const events: CalendarEvent[] = [];
    for (const [apiCalendarId, target] of this.#calendarMappings) {
      events.push(...await this.#listEventsValidated(range, apiCalendarId, target, budget));
    }
    return events;
  }

  async listEvents(range: EventRange, apiCalendarId: string, signal?: AbortSignal): Promise<CalendarEvent[]> {
    assertRange(range);
    const mappedApiCalendarId = apiCalendarId;
    const target = this.#calendarMappings.get(mappedApiCalendarId);
    if (!target) throw new CalDavError('CALDAV_MAPPING', 'CalDAV calendar mapping is unavailable');
    const budget = this.#budget(signal);
    this.#assertCalendarMappings(await this.#listCalendars(budget));
    return this.#listEventsValidated(range, mappedApiCalendarId, target, budget);
  }

  async #listEventsValidated(
    range: EventRange, mappedApiCalendarId: string, target: URL, budget: CycleBudget,
  ): Promise<CalendarEvent[]> {
    const start = calDavTimestamp(range.start);
    const end = calDavTimestamp(range.end);
    const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
    <c:time-range start="${start}" end="${end}"/>
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;
    const xml = await this.#request('REPORT', body, '1', target, budget);
    const events: CalendarEvent[] = [];
    const seenIdentities = new Set<string>();
    for (const response of responseList(parseXml(xml))) {
      const prop = successfulProperty(response);
      const calendarData = decodeNumericEntities(boundedText(prop?.['calendar-data'], CALDAV_DATA_MAX_BYTES));
      if (!calendarData.trim()) continue;
      assertIcalStructureBounded(calendarData);
      let parsed: CalendarEvent[];
      try {
        parsed = parseIcal(calendarData, mappedApiCalendarId);
      } catch {
        throw new CalDavError('CALDAV_XML', 'CalDAV response contains invalid iCalendar data');
      }
      for (const event of parsed) {
        if (events.length >= CALDAV_ICAL_MAX_EVENTS || budget.events >= CALDAV_ICAL_MAX_EVENTS) {
          throw new CalDavError('CALDAV_XML_LIMIT', 'CalDAV iCalendar exceeded structural limits');
        }
        assertEventFieldsBounded(event);
        const identity = JSON.stringify([event.uid, event.recurrenceId ?? null]);
        if (seenIdentities.has(identity)) {
          throw new CalDavError('CALDAV_DUPLICATE_UID', 'CalDAV response contains a duplicate event UID');
        }
        seenIdentities.add(identity);
        events.push(event);
        budget.events += 1;
      }
    }
    return events;
  }

  #budget(signal?: AbortSignal): CycleBudget {
    return {
      remainingBytes: CALDAV_RESPONSE_MAX_BYTES,
      remainingRequests: CALDAV_MAX_REQUESTS_PER_CYCLE,
      events: 0,
      deadline: Date.now() + this.#timeoutMs,
      ...((signal ?? this.#signal) ? { signal: signal ?? this.#signal } : {}),
    };
  }

  async #request(
    method: 'PROPFIND' | 'REPORT', body: string, depth: string, target: URL, budget: CycleBudget,
  ): Promise<string> {
    const remainingMs = budget.deadline - Date.now();
    if (remainingMs <= 0 || budget.signal?.aborted) throw new CalDavError('CALDAV_TIMEOUT', 'CalDAV request timed out');
    if (budget.remainingRequests < 1) {
      throw new CalDavError('CALDAV_REQUEST_LIMIT', 'CalDAV request budget was exhausted');
    }
    budget.remainingRequests -= 1;
    const credentials = await readCalDavCredentials(this.#secretFile);
    const timeout = AbortSignal.timeout(remainingMs);
    const signal = budget.signal ? AbortSignal.any([timeout, budget.signal]) : timeout;
    let response: Response;
    try {
      response = await this.#fetch(target, {
        method,
        body,
        signal,
        headers: {
          ...DAV_HEADERS,
          authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`,
          depth,
        },
      });
    } catch {
      if (signal.aborted) throw new CalDavError('CALDAV_TIMEOUT', 'CalDAV request timed out');
      throw new CalDavError('CALDAV_HTTP', 'CalDAV request failed');
    }
    if (response.status === 401 || response.status === 403) {
      throw new CalDavError('CALDAV_AUTH', 'CalDAV authentication failed');
    }
    if (!response.ok) throw new CalDavError('CALDAV_HTTP', `CalDAV request failed with HTTP ${response.status}`);
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > CALDAV_RESPONSE_MAX_BYTES) {
      throw new CalDavError('CALDAV_RESPONSE_TOO_LARGE', 'CalDAV response exceeded the allowed size');
    }
    try {
      const { text, byteLength } = await readBoundedResponseBody(
        response, Math.min(CALDAV_RESPONSE_MAX_BYTES, budget.remainingBytes),
      );
      budget.remainingBytes -= byteLength;
      return text;
    } catch (error) {
      if (error instanceof CalDavError) throw error;
      if (signal.aborted) throw new CalDavError('CALDAV_TIMEOUT', 'CalDAV request timed out');
      throw new CalDavError('CALDAV_HTTP', 'CalDAV response body failed');
    }
  }
}

function assertRange(range: EventRange): void {
  const start = range.start instanceof Date ? range.start.valueOf() : Date.parse(range.start);
  const end = range.end instanceof Date ? range.end.valueOf() : Date.parse(range.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > CALDAV_MAX_RANGE_MS) {
    throw new CalDavError('CALDAV_RANGE', 'CalDAV query range is invalid or too large');
  }
}

function assertEventFieldsBounded(event: CalendarEvent): void {
  if (Buffer.byteLength(event.uid) > CALDAV_ICAL_UID_MAX_BYTES ||
      Buffer.byteLength(event.summary) > CALDAV_ICAL_TEXT_MAX_BYTES ||
      Buffer.byteLength(event.location ?? '') > CALDAV_ICAL_TEXT_MAX_BYTES) {
    throw new CalDavError('CALDAV_XML_LIMIT', 'CalDAV iCalendar exceeded field limits');
  }
}

function assertIcalStructureBounded(source: string): void {
  let calendars = 0;
  let events = 0;
  const component = /^BEGIN:(VCALENDAR|VEVENT)\r?$/gim;
  let match: RegExpExecArray | null;
  while ((match = component.exec(source)) !== null) {
    if (match[1].toUpperCase() === 'VCALENDAR') calendars += 1;
    else events += 1;
    if (calendars > CALDAV_ICAL_MAX_CALENDARS || events > CALDAV_ICAL_MAX_EVENTS) {
      throw new CalDavError('CALDAV_XML_LIMIT', 'CalDAV iCalendar exceeded structural limits');
    }
  }
}

async function readBoundedResponseBody(
  response: Response, maxBytes: number,
): Promise<{ text: string; byteLength: number }> {
  if (!response.body) return { text: '', byteLength: 0 };
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let result = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { text: result + decoder.decode(), byteLength: total };
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new CalDavError('CALDAV_RESPONSE_TOO_LARGE', 'CalDAV response exceeded the allowed size');
      }
      result += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function parseXml(xml: string): Record<string, unknown> {
  assertXmlStructureBounded(xml);
  if (XMLValidator.validate(xml) !== true) {
    throw new CalDavError('CALDAV_XML', 'Malformed CalDAV XML response');
  }
  try {
    return new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, trimValues: false }).parse(xml) as Record<string, unknown>;
  } catch {
    throw new CalDavError('CALDAV_XML', 'Malformed CalDAV XML response');
  }
}

function assertXmlStructureBounded(xml: string): void {
  let depth = 0;
  let nodes = 0;
  let offset = 0;
  while (true) {
    const start = xml.indexOf('<', offset);
    if (start < 0) return;
    if (xml.startsWith('<![CDATA[', start)) {
      const end = xml.indexOf(']]>', start + 9);
      if (end < 0) return;
      offset = end + 3;
      continue;
    }
    const end = xml.indexOf('>', start + 1);
    if (end < 0) return;
    const markup = xml.slice(start + 1, end).trim();
    offset = end + 1;
    if (!markup || markup.startsWith('?') || markup.startsWith('!')) continue;
    if (markup.startsWith('/')) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    nodes += 1;
    depth += 1;
    if (nodes > CALDAV_XML_MAX_NODES || depth > CALDAV_XML_MAX_DEPTH) {
      throw new CalDavError('CALDAV_XML_LIMIT', 'CalDAV XML exceeded structural limits');
    }
    if (markup.endsWith('/')) depth -= 1;
  }
}

function responseList(document: Record<string, unknown>): Array<Record<string, unknown>> {
  const multistatus = objectValue(document.multistatus);
  const responses = multistatus.response;
  if (responses === undefined) return [];
  const list = Array.isArray(responses) ? responses : [responses];
  if (list.length > CALDAV_MULTISTATUS_MAX_RESPONSES) {
    throw new CalDavError('CALDAV_XML_LIMIT', 'CalDAV XML exceeded structural limits');
  }
  return list.map(objectValue);
}

function successfulProperty(response: Record<string, unknown>): Record<string, unknown> | undefined {
  const values = response.propstat === undefined ? [] :
    (Array.isArray(response.propstat) ? response.propstat : [response.propstat]);
  const candidates = values.map(objectValue);
  const successful = candidates.find(item => isSuccessfulHttpStatus(textValue(item.status)));
  return successful ? objectValue(successful.prop) : undefined;
}

function isSuccessfulHttpStatus(value: string): boolean {
  const match = /^HTTP\/\d+(?:\.\d+)?\s+(\d{3})(?:\s+.*)?$/.exec(value.trim());
  if (!match) return false;
  const status = Number(match[1]);
  return status >= 200 && status < 300;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return '';
}

function boundedText(value: unknown, maxBytes: number): string {
  const text = textValue(value);
  if (Buffer.byteLength(text) > maxBytes) {
    throw new CalDavError('CALDAV_XML_LIMIT', 'CalDAV XML exceeded field limits');
  }
  return text;
}

function decodeNumericEntities(value: string): string {
  return value.replace(/&#(?:x([\da-f]+)|(\d+));/gi, (_match, hexadecimal: string | undefined, decimal: string | undefined) =>
    String.fromCodePoint(Number.parseInt(hexadecimal ?? decimal ?? '0', hexadecimal ? 16 : 10)));
}

function calDavTimestamp(source: string | Date): string {
  const date = source instanceof Date ? source : new Date(source);
  if (Number.isNaN(date.valueOf())) throw new CalDavError('CALDAV_HTTP', 'Invalid CalDAV event range');
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
