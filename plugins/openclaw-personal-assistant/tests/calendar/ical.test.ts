import { describe, expect, it } from 'vitest';
import { buildIcal, parseIcal, semanticEventHash } from '../../src/calendar/ical.js';

const localIcal = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:event-1\r
DTSTART;TZID=Asia/Seoul:20260825T090000\r
DTEND;TZID=Asia/Seoul:20260825T100000\r
SUMMARY:Cafe\u0301 planning\, phase 1\r
LOCATION:Seoul\; room 2\r
RRULE:FREQ=WEEKLY;BYDAY=TH,TU;INTERVAL=1\r
END:VEVENT\r
END:VCALENDAR\r
`;

const serverIcal = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
LAST-MODIFIED:20260824T020304Z\r
LOCATION:Seoul\; room 2\r
DTEND;TZID=Asia/Seoul:20260825T100000\r
RRULE:INTERVAL=1;BYDAY=TH,TU;FREQ=WEEKLY\r
UID:event-1\r
SUMMARY:Caf\u00e9 planning\, phase\r
  1\r
DTSTART;TZID=Asia/Seoul:20260825T090000\r
DTSTAMP:20260824T010203Z\r
BEGIN:VALARM\r
ACTION:DISPLAY\r
TRIGGER:-PT10M\r
END:VALARM\r
END:VEVENT\r
END:VCALENDAR\r
`;

describe('iCalendar canonicalization', () => {
  it('hashes equivalent server-normalized events identically', () => {
    const local = parseIcal(localIcal, 'personal')[0];
    const server = parseIcal(serverIcal, 'personal')[0];
    expect(semanticEventHash(local)).toBe(semanticEventHash(server));
  });

  it('includes the calendar identity and semantic fields in the hash', () => {
    const event = parseIcal(localIcal, 'personal')[0];
    expect(semanticEventHash({ ...event, calendarId: 'work' })).not.toBe(semanticEventHash(event));
    expect(semanticEventHash({ ...event, summary: 'Different' })).not.toBe(semanticEventHash(event));
  });

  it('builds parseable all-day, recurring, and timed events with escaped text', () => {
    const allDay = parseIcal(buildIcal({
      calendarId: 'personal', uid: 'day-1', dtstart: '2026-08-25', dtend: '2026-08-26',
      summary: '휴가, 가족', kind: 'all-day',
    }), 'personal')[0];
    const recurring = parseIcal(buildIcal({
      calendarId: 'personal', uid: 'repeat-1', dtstart: '2026-08-25T00:00:00.000Z',
      dtend: '2026-08-25T00:30:00.000Z', summary: 'Study; 집중', location: 'Room, 2',
      kind: 'recurring', rrule: { interval: 1, byday: ['TU', 'TH'], freq: 'WEEKLY' },
    }), 'personal')[0];
    expect(allDay).toMatchObject({ kind: 'all-day', dtstart: '2026-08-25', summary: '휴가, 가족' });
    expect(recurring).toMatchObject({
      kind: 'recurring', dtstart: '2026-08-25T00:00:00.000Z', summary: 'Study; 집중', location: 'Room, 2',
      rrule: { byday: ['TU', 'TH'], freq: 'WEEKLY', interval: 1 },
    });
  });

  it('normalizes local and UTC timed values to UTC', () => {
    const [local] = parseIcal(localIcal, 'personal');
    expect(local.dtstart).toBe('2026-08-25T00:00:00.000Z');
    expect(local.dtend).toBe('2026-08-25T01:00:00.000Z');
  });
});
