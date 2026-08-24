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
      fetch: async (_url, init) => {
        expect(init?.method).toBe('REPORT');
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(String(init?.body)).toContain('20260825T000000Z');
        expect(String(init?.body)).toContain('20260826T000000Z');
        return new Response(xml, { status: 207 });
      },
    });
    const events = await client.listEvents({ start: '2026-08-25T00:00:00.000Z', end: '2026-08-26T00:00:00.000Z' });
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
      fetch: async (_url, init) => ({
        ok: true,
        status: 207,
        text: () => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
      }) as Response,
    });
    await expect(client.listCalendars()).rejects.toMatchObject({ code: 'CALDAV_TIMEOUT' });
  });

  it('maps malformed XML to a stable parse error', async () => {
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/', secretFile: await secretFile(),
      fetch: async () => new Response(await fixture('malformed.xml'), { status: 207 }),
    });
    await expect(client.listCalendars()).rejects.toMatchObject({ code: 'CALDAV_XML' });
  });

  it('rejects duplicate event UIDs with a stable error', async () => {
    const client = new CalDavClient({
      baseUrl: 'https://caldav.example.test/default/', secretFile: await secretFile(),
      fetch: async () => new Response(await fixture('duplicate-uid.xml'), { status: 207 }),
    });
    await expect(client.listEvents({ start: '2026-08-25T00:00:00Z', end: '2026-08-27T00:00:00Z' }))
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
      fetch: async () => new Response(await fixture('recurrence-exceptions.xml'), { status: 207 }),
    });
    const events = await client.listEvents({ start: '2026-08-25T00:00:00Z', end: '2026-09-30T00:00:00Z' });
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
      fetch: async () => new Response(xml, { status: 207 }),
    });
    const events = await client.listEvents({ start: '2026-01-01T00:00:00Z', end: '2027-01-01T00:00:00Z' });
    expect(events.map(event => event.dtstart)).toEqual([
      '2026-03-08T07:30:00.000Z',
      '2026-11-01T05:30:00.000Z',
    ]);
  });
});
