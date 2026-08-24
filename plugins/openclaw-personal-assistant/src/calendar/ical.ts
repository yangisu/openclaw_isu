import { createHash } from 'node:crypto';
import ICAL from 'ical.js';

export type EventKind = 'all-day' | 'recurring' | 'timed';
export type RecurrenceRule = Record<string, string | number | Array<string | number>>;

export interface CalendarEventDraft {
  calendarId: string;
  uid: string;
  recurrenceId?: string;
  dtstart: string;
  dtend: string;
  summary: string;
  location?: string;
  rrule?: RecurrenceRule;
  kind?: EventKind;
  status?: string;
}

export interface CalendarEvent extends CalendarEventDraft {
  kind: EventKind;
  status: string;
}

const APPLICATION_TIMEZONE = 'Asia/Seoul';
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond?: number;
}

function recurrenceData(value: ICAL.Recur): RecurrenceRule {
  const data = value.toJSON() as Record<string, unknown>;
  const result: RecurrenceRule = {};
  for (const [key, item] of Object.entries(data)) {
    if (typeof item === 'string' || typeof item === 'number' ||
        (Array.isArray(item) && item.every(part => typeof part === 'string' || typeof part === 'number'))) {
      result[key.toLowerCase()] = item as string | number | Array<string | number>;
    }
  }
  if (result.freq && result.interval === undefined) result.interval = value.interval;
  return sortRecurrence(result);
}

function sortRecurrence(rule: RecurrenceRule): RecurrenceRule {
  return Object.fromEntries(Object.entries(rule)
    .map(([key, value]) => [key.toLowerCase(), canonicalRecurrenceValue(value)] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function canonicalRecurrenceValue(value: RecurrenceRule[string]): RecurrenceRule[string] {
  if (!Array.isArray(value)) return value;
  const sorted = [...value].sort((left, right) => {
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    if (typeof left === 'number') return -1;
    if (typeof right === 'number') return 1;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return sorted.filter((item, index) => index === 0 ||
    typeof item !== typeof sorted[index - 1] || item !== sorted[index - 1]);
}

function requireText(component: ICAL.Component, name: string): string {
  const value = component.getFirstPropertyValue(name);
  if (typeof value !== 'string' || value.length === 0) throw new Error(`VEVENT is missing ${name.toUpperCase()}`);
  return value;
}

function normalizeTime(component: ICAL.Component, name: 'dtstart' | 'dtend' | 'recurrence-id'): string {
  const property = component.getFirstProperty(name);
  const value = property?.getFirstValue();
  if (!property || !(value instanceof ICAL.Time)) throw new Error(`VEVENT is missing ${name.toUpperCase()}`);
  if (value.isDate) return `${pad(value.year, 4)}-${pad(value.month)}-${pad(value.day)}`;

  const tzid = property.getFirstParameter('tzid');
  if (!tzid && value.zone.tzid === 'UTC') {
    return new Date(Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second)).toISOString();
  }
  if (tzid && component.parent?.getTimeZoneByID(tzid)) {
    return new Date(value.toUnixTime() * 1_000).toISOString();
  }
  return ianaLocalDateToUtc(value, tzid || APPLICATION_TIMEZONE).toISOString();
}

function ianaLocalDateToUtc(value: WallTime, timeZone: string): Date {
  const localAsUtc = Date.UTC(
    value.year, value.month - 1, value.day, value.hour, value.minute, value.second, value.millisecond ?? 0,
  );
  const validation = new Date(localAsUtc);
  if (validation.getUTCFullYear() !== value.year || validation.getUTCMonth() !== value.month - 1 ||
      validation.getUTCDate() !== value.day || validation.getUTCHours() !== value.hour ||
      validation.getUTCMinutes() !== value.minute || validation.getUTCSeconds() !== value.second) {
    throw new Error('invalid local event date');
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    throw new Error(`unsupported iCalendar timezone: ${timeZone}`);
  }

  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const probe = localAsUtc + hours * 3_600_000;
    const represented = formattedUtcMilliseconds(formatter, probe);
    offsets.add(represented - probe);
  }
  const candidates = [...offsets]
    .map(offset => localAsUtc - offset)
    .filter(candidate => formattedUtcMilliseconds(formatter, candidate) === localAsUtc);
  const unique = [...new Set(candidates)];
  if (unique.length === 1) return new Date(unique[0]);
  if (unique.length > 1) return new Date(Math.min(...unique));
  if (offsets.size > 1) return new Date(localAsUtc - Math.min(...offsets));
  throw new Error(`unable to resolve local time in ${timeZone}`);
}

function formattedUtcMilliseconds(formatter: Intl.DateTimeFormat, instant: number): number {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instant))
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  const millisecond = ((instant % 1_000) + 1_000) % 1_000;
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, millisecond);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

export function parseIcal(source: string, calendarId: string): CalendarEvent[] {
  const calendar = new ICAL.Component(ICAL.parse(source));
  const components = calendar.name === 'vevent' ? [calendar] : calendar.getAllSubcomponents('vevent');
  return components.map(component => {
    const rruleValue = component.getFirstPropertyValue('rrule');
    const rrule = rruleValue instanceof ICAL.Recur ? recurrenceData(rruleValue) : undefined;
    const dtstart = normalizeTime(component, 'dtstart');
    const recurrenceId = component.hasProperty('recurrence-id') ? normalizeTime(component, 'recurrence-id') : undefined;
    return {
      calendarId,
      uid: requireText(component, 'uid'),
      recurrenceId,
      dtstart,
      dtend: normalizeTime(component, 'dtend'),
      summary: requireText(component, 'summary').normalize('NFC'),
      location: (component.getFirstPropertyValue('location') as string | null)?.normalize('NFC') ?? undefined,
      rrule,
      kind: dtstart.length === 10 ? 'all-day' : rrule || recurrenceId ? 'recurring' : 'timed',
      status: ((component.getFirstPropertyValue('status') as string | null) ?? 'CONFIRMED').toUpperCase(),
    };
  });
}

export function semanticEventHash(event: CalendarEventDraft): string {
  const stable = {
    calendarId: event.calendarId,
    uid: event.uid,
    dtstart: normalizeDraftDate(event.dtstart),
    dtend: normalizeDraftDate(event.dtend),
    summary: event.summary.normalize('NFC'),
    location: event.location?.normalize('NFC') ?? '',
    rrule: sortRecurrence(event.rrule ?? {}),
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function normalizeDraftDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const local = LOCAL_DATE_TIME.exec(value);
  if (local) {
    return ianaLocalDateToUtc({
      year: Number(local[1]), month: Number(local[2]), day: Number(local[3]),
      hour: Number(local[4]), minute: Number(local[5]), second: Number(local[6] ?? 0),
      millisecond: Number((local[7] ?? '').padEnd(3, '0') || 0),
    }, APPLICATION_TIMEZONE).toISOString();
  }
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) throw new Error('invalid local event date');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error('invalid event date');
  return parsed.toISOString();
}

export function buildIcal(draft: CalendarEventDraft): string {
  const calendar = new ICAL.Component('vcalendar');
  calendar.addPropertyWithValue('version', '2.0');
  calendar.addPropertyWithValue('prodid', '-//OpenClaw Personal Assistant//EN');
  calendar.addPropertyWithValue('calscale', 'GREGORIAN');

  const event = new ICAL.Component('vevent');
  event.addPropertyWithValue('uid', draft.uid);
  if (draft.recurrenceId) addDateProperty(event, 'recurrence-id', draft.recurrenceId);
  addDateProperty(event, 'dtstart', draft.dtstart);
  addDateProperty(event, 'dtend', draft.dtend);
  event.addPropertyWithValue('summary', draft.summary.normalize('NFC'));
  if (draft.location) event.addPropertyWithValue('location', draft.location.normalize('NFC'));
  if (draft.rrule) event.addPropertyWithValue('rrule', ICAL.Recur.fromData(draft.rrule as Parameters<typeof ICAL.Recur.fromData>[0]));
  if (draft.status) event.addPropertyWithValue('status', draft.status.toUpperCase());
  calendar.addSubcomponent(event);
  return calendar.toString();
}

function addDateProperty(component: ICAL.Component, name: string, source: string): void {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(source);
  const value = dateOnly ? ICAL.Time.fromDateString(source) : ICAL.Time.fromJSDate(new Date(normalizeDraftDate(source)), true);
  component.addPropertyWithValue(name, value);
}
