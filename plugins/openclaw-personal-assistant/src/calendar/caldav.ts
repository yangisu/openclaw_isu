import { readFile, stat } from 'node:fs/promises';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { type CalendarEvent, parseIcal } from './ical.js';

export type CalDavErrorCode =
  | 'CALDAV_AUTH'
  | 'CALDAV_TIMEOUT'
  | 'CALDAV_XML'
  | 'CALDAV_DUPLICATE_UID'
  | 'CALDAV_SECRET_PERMISSIONS'
  | 'CALDAV_SECRET'
  | 'CALDAV_TLS_REQUIRED'
  | 'CALDAV_HTTP';

export class CalDavError extends Error {
  constructor(public readonly code: CalDavErrorCode, message: string) {
    super(message);
    this.name = 'CalDavError';
  }
}

export interface CalDavCalendar {
  id: string;
  href: string;
  displayName: string;
}

export interface EventRange {
  start: string | Date;
  end: string | Date;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface CalDavClientOptions {
  baseUrl: string;
  secretFile: string;
  fetch?: FetchLike;
  /** Defaults to the fixed production request bound of 15 seconds. */
  timeoutMs?: number;
}

interface Credentials {
  username: string;
  password: string;
}

const DAV_HEADERS = { 'content-type': 'application/xml; charset=utf-8' };

export class CalDavClient {
  readonly #baseUrl: URL;
  readonly #secretFile: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: CalDavClientOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    if (this.#baseUrl.protocol !== 'https:') {
      throw new CalDavError('CALDAV_TLS_REQUIRED', 'CalDAV endpoint must use HTTPS');
    }
    this.#secretFile = options.secretFile;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async listCalendars(): Promise<CalDavCalendar[]> {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:displayname/><d:resourcetype/></d:prop>
</d:propfind>`;
    const xml = await this.#request('PROPFIND', body, '1');
    const responses = responseList(parseXml(xml));
    return responses.flatMap(response => {
      const prop = successfulProperty(response);
      const resourceType = objectValue(prop?.resourcetype);
      if (!prop || !Object.prototype.hasOwnProperty.call(resourceType, 'calendar')) return [];
      const id = textValue(response.href).trim();
      return [{
        id,
        href: new URL(id, this.#baseUrl).href,
        displayName: textValue(prop.displayname).trim(),
      }];
    });
  }

  async listEvents(range: EventRange): Promise<CalendarEvent[]> {
    const start = calDavTimestamp(range.start);
    const end = calDavTimestamp(range.end);
    const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
    <c:time-range start="${start}" end="${end}"/>
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;
    const xml = await this.#request('REPORT', body, '1');
    const events: CalendarEvent[] = [];
    const seenUids = new Set<string>();
    for (const response of responseList(parseXml(xml))) {
      const prop = successfulProperty(response);
      const calendarData = decodeNumericEntities(textValue(prop?.['calendar-data']));
      if (!calendarData.trim()) continue;
      let parsed: CalendarEvent[];
      try {
        parsed = parseIcal(calendarData, this.#baseUrl.pathname);
      } catch {
        throw new CalDavError('CALDAV_XML', 'CalDAV response contains invalid iCalendar data');
      }
      for (const event of parsed) {
        if (seenUids.has(event.uid)) {
          throw new CalDavError('CALDAV_DUPLICATE_UID', 'CalDAV response contains a duplicate event UID');
        }
        seenUids.add(event.uid);
        events.push(event);
      }
    }
    return events;
  }

  async #request(method: 'PROPFIND' | 'REPORT', body: string, depth: string): Promise<string> {
    const credentials = await readCredentials(this.#secretFile);
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(this.#baseUrl, {
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
    try {
      return await response.text();
    } catch {
      if (signal.aborted) throw new CalDavError('CALDAV_TIMEOUT', 'CalDAV request timed out');
      throw new CalDavError('CALDAV_HTTP', 'CalDAV response body failed');
    }
  }
}

async function readCredentials(path: string): Promise<Credentials> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    throw new CalDavError('CALDAV_SECRET', 'Unable to read CalDAV secret file');
  }
  // Windows exposes synthesized POSIX modes (normally 0666); production runs
  // under WSL/Linux, where the mode-600 contract can be enforced directly.
  if (!metadata.isFile() || (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600)) {
    throw new CalDavError('CALDAV_SECRET_PERMISSIONS', 'CalDAV secret file must have mode 600');
  }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<Credentials>;
    if (typeof parsed.username !== 'string' || !parsed.username ||
        typeof parsed.password !== 'string' || !parsed.password) throw new Error('invalid');
    return { username: parsed.username, password: parsed.password };
  } catch {
    throw new CalDavError('CALDAV_SECRET', 'Invalid CalDAV secret file');
  }
}

function parseXml(xml: string): Record<string, unknown> {
  if (XMLValidator.validate(xml) !== true) {
    throw new CalDavError('CALDAV_XML', 'Malformed CalDAV XML response');
  }
  try {
    return new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, trimValues: false }).parse(xml) as Record<string, unknown>;
  } catch {
    throw new CalDavError('CALDAV_XML', 'Malformed CalDAV XML response');
  }
}

function responseList(document: Record<string, unknown>): Array<Record<string, unknown>> {
  const multistatus = objectValue(document.multistatus);
  const responses = multistatus.response;
  if (responses === undefined) return [];
  return (Array.isArray(responses) ? responses : [responses]).map(objectValue);
}

function successfulProperty(response: Record<string, unknown>): Record<string, unknown> | undefined {
  const values = response.propstat === undefined ? [] :
    (Array.isArray(response.propstat) ? response.propstat : [response.propstat]);
  const candidates = values.map(objectValue);
  const successful = candidates.find(item => !item.status || textValue(item.status).includes(' 200 '));
  return successful ? objectValue(successful.prop) : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return '';
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
