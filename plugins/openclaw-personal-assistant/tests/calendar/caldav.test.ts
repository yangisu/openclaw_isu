import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/calendar/secret.js', () => ({
  readCalDavCredentials: vi.fn(async () => ({ username: 'naver-user', password: 'top-secret' })),
}));

import { CalDavClient, CalDavError } from '../../src/calendar/caldav.js';

const fixtureDir = new URL('../fixtures/caldav/', import.meta.url);
const fixture = (name: string) => readFile(new URL(name, fixtureDir), 'utf8');
const temporaryDirectories: string[] = [];
const DEFAULT_API_CALENDAR_ID = 'api-default';
const DEFAULT_COLLECTION_HREF = 'https://caldav.example.test/collections/default/';
const defaultCalendarMappings = [{ apiCalendarId: DEFAULT_API_CALENDAR_ID, caldavHref: DEFAULT_COLLECTION_HREF }];
const defaultDiscovery = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/collections/default/</d:href><d:propstat><d:prop><d:displayname>Default</d:displayname><d:resourcetype><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

function afterDiscovery(report: (url: string | URL, init?: RequestInit) => Promise<Response>) {
  return async (url: string | URL, init?: RequestInit) => init?.method === 'PROPFIND'
    ? new Response(defaultDiscovery, { status: 207 })
    : report(url, init);
}

async function secretFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'caldav-test-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'credentials.json');
  await writeFile(path, JSON.stringify({ username: 'naver-user', password: 'top-secret' }), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('CalDavClient', () => {
  it('discovers two collections and REPORTs only the mapped API calendar target', async () => {
    const discovery = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/collections/personal/</d:href><d:propstat><d:prop><d:displayname>Personal</d:displayname><d:resourcetype><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/collections/work/</d:href><d:propstat><d:prop><d:displayname>Work</d:displayname><d:resourcetype><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    const report = await fixture('report.xml');
    const calls: Array<[string, string]> = [];
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: await secretFile(),
      calendarMappings: [
        { apiCalendarId: 'api-personal', caldavHref: 'https://caldav.example.test/collections/personal/' },
        { apiCalendarId: 'api-work', caldavHref: 'https://caldav.example.test/collections/work/' },
      ],
      fetch: async (url, init) => {
        calls.push([String(init?.method), String(url)]);
        return new Response(init?.method === 'PROPFIND' ? discovery : report, { status: 207 });
      },
    });

    const events = await client.listEvents(
      { start: '2026-08-25T00:00:00Z', end: '2026-08-26T00:00:00Z' },
      'api-work',
    );
    expect(calls).toEqual([
      ['PROPFIND', 'https://caldav.example.test/'],
      ['REPORT', 'https://caldav.example.test/collections/work/'],
    ]);
    expect(events.every(event => event.calendarId === 'api-work')).toBe(true);
  });

  it('lists every owner-approved mapping without a base-root REPORT', async () => {
    const discovery = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/collections/personal/</d:href><d:propstat><d:prop><d:resourcetype><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/collections/work/</d:href><d:propstat><d:prop><d:resourcetype><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    const report = await fixture('report.xml');
    const reportUrls: string[] = [];
    let discoveries = 0;
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: await secretFile(),
      calendarMappings: [
        { apiCalendarId: 'api-personal', caldavHref: '/collections/personal/' },
        { apiCalendarId: 'api-work', caldavHref: '/collections/work/' },
      ],
      fetch: async (url, init) => {
        if (init?.method === 'PROPFIND') { discoveries += 1; return new Response(discovery, { status: 207 }); }
        reportUrls.push(String(url));
        return new Response(report, { status: 207 });
      },
    });

    const events = await client.listMappedEvents({
      start: '2026-08-25T00:00:00Z', end: '2026-08-26T00:00:00Z',
    });
    expect(reportUrls).toEqual([
      'https://caldav.example.test/collections/personal/',
      'https://caldav.example.test/collections/work/',
    ]);
    expect(discoveries).toBe(1);
    expect(new Set(events.map(event => event.calendarId))).toEqual(new Set(['api-personal', 'api-work']));
  });

  it('rejects a calendar query longer than 31 days before credentials or network', async () => {
    const fetch = vi.fn();
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: 'must-not-read',
      calendarMappings: defaultCalendarMappings, fetch,
    });
    await expect(client.listMappedEvents({
      start: '2026-01-01T00:00:00Z', end: '2026-02-02T00:00:00Z',
    })).rejects.toMatchObject({ code: 'CALDAV_RANGE' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('enforces one global response-byte budget across every mapped collection', async () => {
    const discovery = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/collections/a/</d:href><d:propstat><d:prop><d:resourcetype><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/collections/b/</d:href><d:propstat><d:prop><d:resourcetype><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    const report = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><!--${'x'.repeat(1_100_000)}--></d:multistatus>`;
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: await secretFile(),
      calendarMappings: [
        { apiCalendarId: 'a', caldavHref: '/collections/a/' },
        { apiCalendarId: 'b', caldavHref: '/collections/b/' },
      ],
      fetch: async (_url, init) => new Response(init?.method === 'PROPFIND' ? discovery : report, { status: 207 }),
    });
    await expect(client.listMappedEvents({
      start: '2026-08-25T00:00:00Z', end: '2026-08-26T00:00:00Z',
    })).rejects.toMatchObject({ code: 'CALDAV_RESPONSE_TOO_LARGE' });
  });

  it('enforces one global event budget across every mapped collection', async () => {
    const discovery = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/collections/a/</d:href><d:propstat><d:prop><d:resourcetype><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/collections/b/</d:href><d:propstat><d:prop><d:resourcetype><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    const report = (prefix: string) => {
      const events = Array.from({ length: 501 }, (_, index) => `BEGIN:VEVENT\r\nUID:${prefix}-${index}\r\nDTSTART:20260825T000000Z\r\nDTEND:20260825T010000Z\r\nSUMMARY:Event\r\nEND:VEVENT\r\n`).join('');
      return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:propstat><d:prop><c:calendar-data><![CDATA[BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events}END:VCALENDAR\r\n]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    };
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: await secretFile(),
      calendarMappings: [
        { apiCalendarId: 'a', caldavHref: '/collections/a/' },
        { apiCalendarId: 'b', caldavHref: '/collections/b/' },
      ],
      fetch: async (url, init) => new Response(init?.method === 'PROPFIND' ? discovery : report(String(url).includes('/a/') ? 'a' : 'b'), { status: 207 }),
    });
    await expect(client.listMappedEvents({
      start: '2026-08-25T00:00:00Z', end: '2026-08-26T00:00:00Z',
    })).rejects.toMatchObject({ code: 'CALDAV_XML_LIMIT' });
  });

  it('uses one wall-clock deadline for discovery and every mapped REPORT', async () => {
    let clock = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => { clock += 6; return clock; });
    let requests = 0;
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: await secretFile(), timeoutMs: 10,
      calendarMappings: defaultCalendarMappings,
      fetch: async () => { requests += 1; return new Response(defaultDiscovery, { status: 207 }); },
    });
    try {
      await expect(client.listMappedEvents({
        start: '2026-08-25T00:00:00Z', end: '2026-08-26T00:00:00Z',
      })).rejects.toMatchObject({ code: 'CALDAV_TIMEOUT' });
      expect(requests).toBe(1);
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    ['missing collection', '<d:response><d:href>/collections/other/</d:href><d:propstat><d:prop><d:resourcetype><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'],
    ['drifted collection', '<d:response><d:href>/collections/work-renamed/</d:href><d:propstat><d:prop><d:resourcetype><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'],
    ['duplicate collection', '<d:response><d:href>/collections/work/</d:href><d:propstat><d:prop><d:resourcetype><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'.repeat(2)],
  ])('fails closed on a %s before REPORT', async (_case, responses) => {
    const discovery = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${responses}</d:multistatus>`;
    const methods: string[] = [];
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: await secretFile(),
      calendarMappings: [{ apiCalendarId: 'api-work', caldavHref: '/collections/work/' }],
      fetch: async (_url, init) => {
        methods.push(String(init?.method));
        return new Response(discovery, { status: 207 });
      },
    });

    await expect(client.listEvents(
      { start: '2026-08-25T00:00:00Z', end: '2026-08-26T00:00:00Z' }, 'api-work',
    )).rejects.toMatchObject({ code: 'CALDAV_MAPPING' });
    expect(methods).toEqual(['PROPFIND']);
  });

  it('fails closed when discovery returns a configured href and an ambiguous prefix', async () => {
    const response = (href: string) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
    const discovery = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${response('/collections/team/')}${response('/collections/team/private/')}</d:multistatus>`;
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: await secretFile(),
      calendarMappings: [{ apiCalendarId: 'api-team', caldavHref: '/collections/team/' }],
      fetch: async () => new Response(discovery, { status: 207 }),
    });

    await expect(client.listEvents(
      { start: '2026-08-25T00:00:00Z', end: '2026-08-26T00:00:00Z' }, 'api-team',
    )).rejects.toMatchObject({ code: 'CALDAV_MAPPING' });
  });

  it.each([
    ['cross-origin', 'https://other.example.test/collections/work/'],
    ['credentials', 'https://owner:secret@caldav.example.test/collections/work/'],
    ['query', '/collections/work/?view=all'],
    ['fragment', '/collections/work/#events'],
    ['traversal', '/collections/work/../admin/'],
  ])('rejects a discovered collection href with %s', async (_case, href) => {
    const discovery = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: await secretFile(),
      fetch: async () => new Response(discovery, { status: 207 }),
    });

    await expect(client.listCalendars()).rejects.toMatchObject({ code: 'CALDAV_MAPPING' });
  });

  it('rejects direct client mappings that bypass the plugin config validator', () => {
    expect(() => new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: 'unused',
      calendarMappings: [
        { apiCalendarId: 'same', caldavHref: '/collections/a/' },
        { apiCalendarId: 'same', caldavHref: '/collections/b/' },
      ],
    })).toThrowError(CalDavError);
  });

  it('forbids a base-root REPORT when no mapped API calendar target is supplied', async () => {
    let fetched = false;
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: 'unused',
      calendarMappings: defaultCalendarMappings,
      fetch: async () => { fetched = true; return new Response('', { status: 207 }); },
    });

    await expect(client.listEvents({ start: '2026-08-25T00:00:00Z', end: '2026-08-26T00:00:00Z' }, ''))
      .rejects.toMatchObject({ code: 'CALDAV_MAPPING' });
    expect(fetched).toBe(false);
  });

  it('discovers calendars with a depth-one PROPFIND across XML namespace prefixes', async () => {
    const xml = await fixture('propfind.xml');
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/calendars/me/', secretFile: await secretFile(),
      fetch: async (_url, init) => {
        expect(init?.method).toBe('PROPFIND');
        expect(new Headers(init?.headers).get('depth')).toBe('1');
        expect(new Headers(init?.headers).get('authorization')).toBe(`Basic ${Buffer.from('naver-user:top-secret').toString('base64')}`);
        return new Response(xml, { status: 207, headers: { 'content-type': 'application/xml' } });
      },
    });
    await expect(client.listCalendars()).resolves.toEqual([
      { id: '/calendars/me/default/', href: 'https://caldav.example.test/calendars/me/default/', displayName: 'Personal' },
    ]);
  });

  it('normalizes all-day, recurring, and UTC events from a bounded REPORT', async () => {
    const xml = await fixture('report.xml');
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/calendars/me/default/', secretFile: await secretFile(),
      calendarMappings: defaultCalendarMappings,
      fetch: afterDiscovery(async (_url, init) => {
        expect(init?.method).toBe('REPORT');
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(String(init?.body)).toContain('20260825T000000Z');
        expect(String(init?.body)).toContain('20260826T000000Z');
        return new Response(xml, { status: 207 });
      }),
    });
    const events = await client.listEvents(
      { start: '2026-08-25T00:00:00.000Z', end: '2026-08-26T00:00:00.000Z' }, DEFAULT_API_CALENDAR_ID,
    );
    expect(events.map(event => event.kind)).toEqual(['all-day', 'recurring', 'timed']);
    expect(events.map(event => event.dtstart)).toEqual([
      '2026-08-25', '2026-08-25T00:00:00.000Z', '2026-08-25T03:00:00.000Z',
    ]);
    expect(events[2].location).toBe('Seoul, Korea');
  });

  it.each([401, 403])('maps HTTP %s to a credential-free stable auth error', async status => {
    const path = await secretFile();
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: path,
      fetch: async () => new Response('top-secret', { status }),
    });
    await expect(client.listCalendars()).rejects.toMatchObject({ code: 'CALDAV_AUTH' });
    await expect(client.listCalendars()).rejects.not.toThrow(/top-secret|naver-user/);
  });

  it('maps request aborts to a stable timeout error', async () => {
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: await secretFile(), timeoutMs: 5,
      fetch: (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }),
    });
    await expect(client.listCalendars()).rejects.toMatchObject({ code: 'CALDAV_TIMEOUT' });
  });

  it('keeps the timeout active while reading the response body', async () => {
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: await secretFile(), timeoutMs: 5,
      fetch: async (_url, init) => new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
        },
      }), { status: 207 }),
    });
    await expect(client.listCalendars()).rejects.toMatchObject({ code: 'CALDAV_TIMEOUT' });
  });

  it('rejects an oversized declared response before reading its body', async () => {
    let bodyRead = false;
    const cancel = vi.fn().mockResolvedValue(undefined);
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: await secretFile(),
      fetch: async () => ({
        ok: true,
        status: 207,
        headers: new Headers({ 'content-length': '2097153' }),
        body: { cancel },
        text: async () => { bodyRead = true; throw new Error('body must not be read'); },
      }) as Response,
    });

    await expect(client.listCalendars()).rejects.toMatchObject({ code: 'CALDAV_RESPONSE_TOO_LARGE' });
    expect(bodyRead).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels a chunked response as soon as its streamed bytes exceed the bound', async () => {
    let cancelled = false;
    const chunks = [new Uint8Array(1_048_576), new Uint8Array(1_048_576), new Uint8Array([1])];
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: await secretFile(),
      fetch: async () => new Response(new ReadableStream({
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
        },
        cancel() { cancelled = true; },
      }), { status: 207 }),
    });

    await expect(client.listCalendars()).rejects.toMatchObject({ code: 'CALDAV_RESPONSE_TOO_LARGE' });
    expect(cancelled).toBe(true);
  });

  it('maps malformed XML to a stable parse error', async () => {
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: await secretFile(),
      fetch: async () => new Response(await fixture('malformed.xml'), { status: 207 }),
    });
    await expect(client.listCalendars()).rejects.toMatchObject({ code: 'CALDAV_XML' });
  });

  it('rejects XML nesting deeper than the parser boundary', async () => {
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${'<x>'.repeat(33)}${'</x>'.repeat(33)}</d:multistatus>`;
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: await secretFile(),
      fetch: async () => new Response(xml, { status: 207 }),
    });

    await expect(client.listCalendars()).rejects.toMatchObject({ code: 'CALDAV_XML_LIMIT' });
  });

  it('rejects an XML document with too many element nodes', async () => {
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${'<x/>'.repeat(10_001)}</d:multistatus>`;
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: await secretFile(),
      fetch: async () => new Response(xml, { status: 207 }),
    });

    await expect(client.listCalendars()).rejects.toMatchObject({ code: 'CALDAV_XML_LIMIT' });
  });

  it('rejects a multistatus with too many responses', async () => {
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${'<d:response/>'.repeat(1_001)}</d:multistatus>`;
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: await secretFile(),
      fetch: async () => new Response(xml, { status: 207 }),
    });

    await expect(client.listCalendars()).rejects.toMatchObject({ code: 'CALDAV_XML_LIMIT' });
  });

  it.each([
    ['href', `<d:href>/${'h'.repeat(4_097)}</d:href><d:propstat><d:prop><d:displayname>Calendar</d:displayname><d:resourcetype><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`, false],
    ['display name', `<d:href>/calendar/</d:href><d:propstat><d:prop><d:displayname>${'d'.repeat(1_025)}</d:displayname><d:resourcetype><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`, false],
    ['calendar data', `<d:href>/event.ics</d:href><d:propstat><d:prop><c:calendar-data><![CDATA[${'i'.repeat(1_048_577)}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`, true],
  ])('rejects an oversized %s string', async (_field, responseBody, events) => {
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response>${responseBody}</d:response></d:multistatus>`;
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: await secretFile(),
      calendarMappings: defaultCalendarMappings,
      fetch: async (_url, init) => new Response(events && init?.method === 'PROPFIND' ? defaultDiscovery : xml, { status: 207 }),
    });

    const operation = events
      ? client.listEvents({ start: '2026-08-25T00:00:00Z', end: '2026-08-26T00:00:00Z' }, DEFAULT_API_CALENDAR_ID)
      : client.listCalendars();
    await expect(operation).rejects.toMatchObject({ code: 'CALDAV_XML_LIMIT' });
  });

  it.each([
    ['VCALENDAR components', 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n'.repeat(9)],
    ['VEVENT components', `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${Array.from({ length: 1_001 }, (_, index) => `BEGIN:VEVENT\r\nUID:event-${index}\r\nDTSTART:20260825T000000Z\r\nDTEND:20260825T010000Z\r\nSUMMARY:Event\r\nEND:VEVENT\r\n`).join('')}END:VCALENDAR\r\n`],
  ])('rejects too many %s before iCalendar parsing', async (_kind, calendarData) => {
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:propstat><d:prop><c:calendar-data><![CDATA[${calendarData}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: await secretFile(),
      calendarMappings: defaultCalendarMappings,
      fetch: afterDiscovery(async () => new Response(xml, { status: 207 })),
    });

    await expect(client.listEvents({ start: '2026-08-25T00:00:00Z', end: '2026-08-26T00:00:00Z' }, DEFAULT_API_CALENDAR_ID))
      .rejects.toMatchObject({ code: 'CALDAV_XML_LIMIT' });
  });

  it('bounds the total event count across multistatus responses', async () => {
    const response = (prefix: string) => {
      const calendarData = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${Array.from({ length: 501 }, (_, index) => `BEGIN:VEVENT\r\nUID:${prefix}-${index}\r\nDTSTART:20260825T000000Z\r\nDTEND:20260825T010000Z\r\nSUMMARY:Event\r\nEND:VEVENT\r\n`).join('')}END:VCALENDAR\r\n`;
      return `<d:response><d:propstat><d:prop><c:calendar-data><![CDATA[${calendarData}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
    };
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${response('a')}${response('b')}</d:multistatus>`;
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: await secretFile(),
      calendarMappings: defaultCalendarMappings,
      fetch: afterDiscovery(async () => new Response(xml, { status: 207 })),
    });

    await expect(client.listEvents({ start: '2026-08-25T00:00:00Z', end: '2026-08-26T00:00:00Z' }, DEFAULT_API_CALENDAR_ID))
      .rejects.toMatchObject({ code: 'CALDAV_XML_LIMIT' });
  });

  it.each([
    ['UID', `UID:${'u'.repeat(1_025)}\r\nSUMMARY:Event\r\n`],
    ['SUMMARY', `UID:event-1\r\nSUMMARY:${'s'.repeat(16_385)}\r\n`],
    ['LOCATION', `UID:event-1\r\nSUMMARY:Event\r\nLOCATION:${'l'.repeat(16_385)}\r\n`],
  ])('rejects an oversized iCalendar %s field', async (_field, properties) => {
    const calendarData = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n${properties}DTSTART:20260825T000000Z\r\nDTEND:20260825T010000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:propstat><d:prop><c:calendar-data><![CDATA[${calendarData}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: await secretFile(),
      calendarMappings: defaultCalendarMappings,
      fetch: afterDiscovery(async () => new Response(xml, { status: 207 })),
    });

    await expect(client.listEvents({ start: '2026-08-25T00:00:00Z', end: '2026-08-26T00:00:00Z' }, DEFAULT_API_CALENDAR_ID))
      .rejects.toMatchObject({ code: 'CALDAV_XML_LIMIT' });
  });

  it('rejects duplicate event UIDs with a stable error', async () => {
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/default/', secretFile: await secretFile(),
      calendarMappings: defaultCalendarMappings,
      fetch: afterDiscovery(async () => new Response(await fixture('duplicate-uid.xml'), { status: 207 })),
    });
    await expect(client.listEvents({ start: '2026-08-25T00:00:00Z', end: '2026-08-27T00:00:00Z' }, DEFAULT_API_CALENDAR_ID))
      .rejects.toMatchObject({ code: 'CALDAV_DUPLICATE_UID' });
  });

  it('refuses cleartext endpoints', () => {
    expect(() => new CalDavClient({ baseUrl: 'http://caldav.example.test/', secretFile: 'unused' }))
      .toThrowError(CalDavError);
  });

  it('accepts only well-formed 2xx propstat statuses', async () => {
    const response = (status: string | undefined) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/calendar/</d:href><d:propstat><d:prop><d:displayname>Calendar</d:displayname><d:resourcetype><c:calendar/></d:resourcetype></d:prop>${status === undefined ? '' : `<d:status>${status}</d:status>`}</d:propstat></d:response></d:multistatus>`;
    const list = async (status: string | undefined) => new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: await secretFile(),
      fetch: async () => new Response(response(status), { status: 207 }),
    }).listCalendars();
    await expect(list('HTTP/1.1 201 Created')).resolves.toHaveLength(1);
    await expect(list('HTTP/1.1 404 Not Found')).resolves.toEqual([]);
    await expect(list(undefined)).resolves.toEqual([]);
    await expect(list('not an HTTP status')).resolves.toEqual([]);
  });

  it('accepts a master with modified and cancelled recurrence exceptions', async () => {
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/default/', secretFile: await secretFile(),
      calendarMappings: defaultCalendarMappings,
      fetch: afterDiscovery(async () => new Response(await fixture('recurrence-exceptions.xml'), { status: 207 })),
    });
    const events = await client.listEvents(
      { start: '2026-08-25T00:00:00Z', end: '2026-09-20T00:00:00Z' }, DEFAULT_API_CALENDAR_ID,
    );
    expect(events.map(event => [event.uid, event.recurrenceId, event.status])).toEqual([
      ['series-1', undefined, 'CONFIRMED'],
      ['series-1', '2026-09-01T00:00:00.000Z', 'CONFIRMED'],
      ['series-1', '2026-09-08T00:00:00.000Z', 'CANCELLED'],
    ]);
  });

  it('returns IANA gap and overlap events instead of classifying them as XML errors', async () => {
    const calendarData = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:gap\r\nDTSTART;TZID=America/New_York:20260308T023000\r\nDTEND;TZID=America/New_York:20260308T033000\r\nSUMMARY:Gap\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:overlap\r\nDTSTART;TZID=America/New_York:20261101T013000\r\nDTEND;TZID=America/New_York:20261101T023000\r\nSUMMARY:Overlap\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/dst.ics</d:href><d:propstat><d:prop><c:calendar-data><![CDATA[${calendarData}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/default/', secretFile: 'mocked-secret',
      calendarMappings: defaultCalendarMappings,
      fetch: afterDiscovery(async () => new Response(xml, { status: 207 })),
    });
    const events = await client.listEvents(
      { start: '2026-03-01T00:00:00Z', end: '2026-03-31T00:00:00Z' }, DEFAULT_API_CALENDAR_ID,
    );
    expect(events.map(event => event.dtstart)).toEqual([
      '2026-03-08T07:30:00.000Z',
      '2026-11-01T05:30:00.000Z',
    ]);
  });
});
