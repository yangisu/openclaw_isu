import { describe, expect, it, vi } from 'vitest';

import {
  GoogleCalendarApi,
  GoogleCalendarError,
  validateGoogleCalendarBinding,
  type GoogleCalendarBinding,
} from '../../src/calendar/google-api.js';

const binding: GoogleCalendarBinding = {
  version: 1,
  calendarId: 'app-created-calendar@group.calendar.google.com',
  summary: 'openclaw_cal',
  timeZone: 'Asia/Seoul',
  createdAt: '2026-08-27T00:00:00.000Z',
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('Google Calendar API', () => {
  it('creates and verifies only the app-created secondary calendar', async () => {
    const store = new MemoryStore<GoogleCalendarBinding>();
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://www.googleapis.com/calendar/v3/calendars');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ summary: 'openclaw_cal', timeZone: 'Asia/Seoul' });
      return json({ id: binding.calendarId, summary: 'openclaw_cal', timeZone: 'Asia/Seoul' });
    });

    const created = await GoogleCalendarApi.bootstrap({
      accessToken: async () => 'access-token', bindingStore: store, fetch,
      now: () => Date.parse('2026-08-27T00:00:00.000Z'),
    });
    expect(created.binding).toEqual(binding);
    expect(store.value).toEqual(binding);
    expect(fetch).toHaveBeenCalledTimes(1);

    const verifyFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(decodeURIComponent(String(input))).toContain(`/calendars/${binding.calendarId}`);
      expect(init?.method).toBe('GET');
      return json({ id: binding.calendarId, summary: 'openclaw_cal', timeZone: 'Asia/Seoul' });
    });
    await expect(GoogleCalendarApi.bootstrap({
      accessToken: async () => 'access-token', bindingStore: store, existingBinding: store.value,
      fetch: verifyFetch,
    })).resolves.toMatchObject({ binding });
  });

  it('lists timed, all-day and recurring events from the pinned calendar with IDs and ETags', async () => {
    const fetch = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      expect(decodeURIComponent(url.pathname)).toContain(`/calendars/${binding.calendarId}/events`);
      expect(url.searchParams.get('singleEvents')).toBe('false');
      expect(url.searchParams.get('showDeleted')).toBe('false');
      expect(url.searchParams.get('timeMin')).toBe('2026-08-27T00:00:00.000Z');
      return json({ items: [
        {
          id: 'timed1', etag: '"etag-timed"', status: 'confirmed', summary: '회의', location: '서울',
          start: { dateTime: '2026-08-27T10:00:00+09:00' }, end: { dateTime: '2026-08-27T11:00:00+09:00' },
        },
        {
          id: 'allday1', etag: '"etag-all-day"', status: 'confirmed', summary: '휴가',
          start: { date: '2026-08-28' }, end: { date: '2026-08-29' },
        },
        {
          id: 'repeat1', etag: '"etag-repeat"', status: 'confirmed', summary: '수업',
          start: { dateTime: '2026-08-29T09:00:00+09:00' }, end: { dateTime: '2026-08-29T10:00:00+09:00' },
          recurrence: ['RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE'],
        },
      ] });
    });
    const api = new GoogleCalendarApi({ binding, accessToken: async () => 'access-token', fetch });

    await expect(api.listEvents({
      start: '2026-08-27T00:00:00.000Z', end: '2026-09-01T00:00:00.000Z',
    })).resolves.toEqual([
      expect.objectContaining({ eventId: 'timed1', uid: 'timed1', etag: '"etag-timed"', kind: 'timed', summary: '회의' }),
      expect.objectContaining({ eventId: 'allday1', dtstart: '2026-08-28', dtend: '2026-08-29', kind: 'all-day' }),
      expect.objectContaining({ eventId: 'repeat1', kind: 'recurring', rrule: { freq: 'WEEKLY', interval: 1, byday: ['MO', 'WE'] } }),
    ]);
  });

  it('sends deterministic create and conditional update/delete without invitation fields', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const event = {
      eventId: 'oc1234567890abcdef1234567890abcdef', summary: '병원',
      dtstart: '2026-08-27T10:00:00+09:00', dtend: '2026-08-27T11:00:00+09:00',
      description: '정기 검진', location: '서울',
    };
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      const body = JSON.parse(String(init?.body));
      return json({
        id: event.eventId, summary: body.summary ?? event.summary,
        description: body.description ?? event.description, location: body.location ?? event.location,
        start: body.start ?? { dateTime: event.dtstart }, end: body.end ?? { dateTime: event.dtend },
        etag: init?.method === 'PATCH' ? '"etag-2"' : '"etag-1"', status: 'confirmed',
      });
    });
    const api = new GoogleCalendarApi({ binding, accessToken: async () => 'access-token', fetch });

    await expect(api.createEvent(event)).resolves.toMatchObject({ eventId: event.eventId, etag: '"etag-1"' });
    await expect(api.updateEvent(event.eventId, '"etag-1"', { summary: '병원 변경' }))
      .resolves.toMatchObject({ eventId: event.eventId, etag: '"etag-2"', summary: '병원 변경' });
    await expect(api.deleteEvent(event.eventId, '"etag-2"')).resolves.toEqual({ deleted: true });

    const createBody = JSON.parse(String(requests[0]!.init?.body));
    expect(createBody).toEqual({
      id: event.eventId, summary: '병원', description: '정기 검진', location: '서울',
      start: { dateTime: '2026-08-27T10:00:00+09:00', timeZone: 'Asia/Seoul' },
      end: { dateTime: '2026-08-27T11:00:00+09:00', timeZone: 'Asia/Seoul' },
    });
    expect(createBody).not.toHaveProperty('attendees');
    expect(requests[1]!.init?.headers).toMatchObject({ 'if-match': '"etag-1"' });
    expect(requests[2]!.init?.headers).toMatchObject({ 'if-match': '"etag-2"' });
  });

  it('maps stale ETags and rejects malformed bindings and event IDs before fetch', async () => {
    const fetch = vi.fn(async () => json({ error: { code: 412 } }, 412));
    const api = new GoogleCalendarApi({ binding, accessToken: async () => 'access-token', fetch });
    await expect(api.updateEvent('event1', '"stale"', { summary: '변경' }))
      .rejects.toMatchObject({ code: 'calendar_conflict' });
    await expect(api.deleteEvent('primary/../event', '"etag"'))
      .rejects.toMatchObject({ code: 'calendar_invalid_event' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(() => validateGoogleCalendarBinding({ ...binding, calendarId: 'primary' }))
      .toThrowError(GoogleCalendarError);
  });
});

class MemoryStore<T> {
  constructor(public value?: T) {}
  async read(): Promise<T> {
    if (this.value === undefined) throw new Error('missing');
    return this.value;
  }
  async write(value: T): Promise<void> { this.value = value; }
  async delete(): Promise<void> { this.value = undefined; }
}
