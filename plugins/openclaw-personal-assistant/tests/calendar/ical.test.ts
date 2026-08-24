import { describe, expect, it } from 'vitest';
import { buildIcal, parseIcal, semanticEventHash } from '../../src/calendar/ical.js';

const localIcal = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:event-1\r
DTSTART;TZID=Asia/Seoul:20260825T090000\r
DTEND;TZID=Asia/Seoul:20260825T100000\r
SUMMARY:Cafe\u0301 planning\\, phase 1\r
LOCATION:Seoul\\; room 2\r
RRULE:FREQ=WEEKLY;BYDAY=TH,TU;INTERVAL=1\r
END:VEVENT\r
END:VCALENDAR\r
`;

const serverIcal = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
LAST-MODIFIED:20260824T020304Z\r
LOCATION:Seoul\\; room 2\r
DTEND;TZID=Asia/Seoul:20260825T100000\r
RRULE:INTERVAL=1;BYDAY=TH,TU;FREQ=WEEKLY\r
UID:event-1\r
SUMMARY:Caf\u00e9 planning\\, phase\r
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
    expect(semanticEventHash({ ...event, recurrenceId: '2026-09-01T00:00:00Z', status: 'CANCELLED' }))
      .toBe(semanticEventHash(event));
  });

  it('canonicalizes set-like RRULE lists independent of order', () => {
    const event = parseIcal(localIcal, 'personal')[0];
    const left = {
      ...event,
      rrule: {
        freq: 'YEARLY', interval: 2, bymonth: [12, 2, 1], bysetpos: [10, -1, 2],
        byday: ['2TU', '-1SU', 'MO'], bymonthday: [20, -1, 3],
      },
    };
    const right = {
      ...event,
      rrule: {
        byday: ['MO', '2TU', '-1SU'], bymonthday: [3, 20, -1], freq: 'YEARLY',
        bysetpos: [2, 10, -1], bymonth: [1, 12, 2], interval: 2,
      },
    };
    expect(semanticEventHash(left)).toBe(semanticEventHash(right));
    expect(semanticEventHash({ ...right, rrule: { ...right.rrule, interval: 3 } }))
      .not.toBe(semanticEventHash(right));
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
      rrule: { byday: ['TH', 'TU'], freq: 'WEEKLY', interval: 1 },
    });
  });

  it('normalizes local and UTC timed values to UTC', () => {
    const [local] = parseIcal(localIcal, 'personal');
    expect(local.dtstart).toBe('2026-08-25T00:00:00.000Z');
    expect(local.dtend).toBe('2026-08-25T01:00:00.000Z');
  });

  it('resolves foreign IANA zones in standard and daylight time', () => {
    const source = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:winter\r\nDTSTART;TZID=America/New_York:20260115T090000\r\nDTEND;TZID=America/New_York:20260115T100000\r\nSUMMARY:Winter\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:summer\r\nDTSTART;TZID=Europe/London:20260715T090000\r\nDTEND;TZID=Europe/London:20260715T100000\r\nSUMMARY:Summer\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    const events = parseIcal(source, 'foreign');
    expect(events.map(event => event.dtstart)).toEqual([
      '2026-01-15T14:00:00.000Z',
      '2026-07-15T08:00:00.000Z',
    ]);
  });

  it('uses the pre-gap offset and first repeated occurrence at DST boundaries', () => {
    const eventAt = (local: string, end: string) => `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:${local}\r\nDTSTART;TZID=America/New_York:${local}\r\nDTEND;TZID=America/New_York:${end}\r\nSUMMARY:DST\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    expect(parseIcal(eventAt('20260308T013000', '20260308T014500'), 'dst')[0].dtstart).toBe('2026-03-08T06:30:00.000Z');
    expect(parseIcal(eventAt('20260308T033000', '20260308T040000'), 'dst')[0].dtstart).toBe('2026-03-08T07:30:00.000Z');
    expect(parseIcal(eventAt('20260308T023000', '20260308T033000'), 'dst')[0].dtstart)
      .toBe('2026-03-08T07:30:00.000Z');
    expect(parseIcal(eventAt('20261101T013000', '20261101T023000'), 'dst')[0].dtstart)
      .toBe('2026-11-01T05:30:00.000Z');
  });

  it('uses embedded VTIMEZONE data for custom timezone identifiers', () => {
    const source = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:Custom/Fixed\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0530\r\nTZOFFSETTO:+0530\r\nTZNAME:CUSTOM\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:custom\r\nDTSTART;TZID=Custom/Fixed:20260825T090000\r\nDTEND;TZID=Custom/Fixed:20260825T100000\r\nSUMMARY:Custom zone\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    const [event] = parseIcal(source, 'custom');
    expect(event.dtstart).toBe('2026-08-25T03:30:00.000Z');
    expect(event.dtend).toBe('2026-08-25T04:30:00.000Z');
  });

  it('treats floating times as Asia/Seoul independent of the host timezone', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      const source = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:floating\r\nDTSTART:20260825T090000\r\nDTEND:20260825T100000\r\nSUMMARY:Floating\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
      expect(parseIcal(source, 'personal')[0].dtstart).toBe('2026-08-25T00:00:00.000Z');
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it('builds and hashes floating drafts as Asia/Seoul independent of host timezone', () => {
    const draft = {
      calendarId: 'personal', uid: 'floating-draft', dtstart: '2026-08-25T09:00:00',
      dtend: '2026-08-25T10:00:00', summary: 'Floating draft',
    };
    const previous = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const utcHost = { hash: semanticEventHash(draft), ical: buildIcal(draft) };
      process.env.TZ = 'America/Los_Angeles';
      const losAngelesHost = { hash: semanticEventHash(draft), ical: buildIcal(draft) };
      expect(losAngelesHost).toEqual(utcHost);
      expect(utcHost.ical).toContain('DTSTART:20260825T000000Z');
      expect(utcHost.ical).toContain('DTEND:20260825T010000Z');

      const spaced = { ...draft, dtstart: '2026-08-25 09:00:00', dtend: '2026-08-25 10:00:00' };
      process.env.TZ = 'UTC';
      const spacedUtcHost = { hash: semanticEventHash(spaced), ical: buildIcal(spaced) };
      process.env.TZ = 'America/Los_Angeles';
      expect({ hash: semanticEventHash(spaced), ical: buildIcal(spaced) }).toEqual(spacedUtcHost);
      expect(spacedUtcHost.ical).toContain('DTSTART:20260825T000000Z');
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it('emits RFC 5545 text escaping and folds every physical line at 75 UTF-8 octets', () => {
    const summary = `${'한'.repeat(35)}, semi; slash\\ line\nnext`;
    const output = buildIcal({
      calendarId: 'personal', uid: 'folded', dtstart: '2026-08-25T00:00:00Z',
      dtend: '2026-08-25T01:00:00Z', summary,
    });
    expect(output.replace(/\r\n[ \t]/g, '')).toContain(
      `SUMMARY:${'한'.repeat(35)}\\, semi\\; slash\\\\ line\\nnext`,
    );
    expect(output.split('\r\n').filter(Boolean).every(line => Buffer.byteLength(line, 'utf8') <= 75)).toBe(true);
    expect(output.replace(/\r\n/g, '')).not.toContain('\n');
  });
});
