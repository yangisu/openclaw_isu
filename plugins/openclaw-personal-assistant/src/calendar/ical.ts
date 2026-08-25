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
const DATE_ONLY = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const DRAFT_DATE_TIME = /^([0-9]{4})-([0-9]{2})-([0-9]{2})[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?(Z|[+-]([0-9]{2}):?([0-9]{2}))?$/i;

export const CALENDAR_EVENT_DATE_PATTERN = '^(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\\.0{1,3})?)?(?:Z|[+-][0-9]{2}:[0-9]{2})?)$';

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
  const localAsUtc = validateWallTime(value);
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
  const normalized = validateCalendarEventDraft(event);
  const stable = {
    calendarId: event.calendarId,
    uid: event.uid,
    dtstart: normalized.dtstart,
    dtend: normalized.dtend,
    summary: event.summary.normalize('NFC'),
    location: event.location?.normalize('NFC') ?? '',
    rrule: sortRecurrence(event.rrule ?? {}),
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function normalizeDraftDate(value: string): string {
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    validateWallTime({
      year: Number(dateOnly[1]), month: Number(dateOnly[2]), day: Number(dateOnly[3]),
      hour: 0, minute: 0, second: 0,
    });
    return value;
  }

  const dateTime = DRAFT_DATE_TIME.exec(value);
  if (!dateTime) throw new Error('invalid event date');
  const fraction = dateTime[7];
  if (fraction && (fraction.length > 3 || /[1-9]/.test(fraction))) {
    throw new Error('fractional seconds must be zero');
  }
  const wallTime = {
    year: Number(dateTime[1]), month: Number(dateTime[2]), day: Number(dateTime[3]),
    hour: Number(dateTime[4]), minute: Number(dateTime[5]), second: Number(dateTime[6] ?? 0),
  };
  validateWallTime(wallTime);

  const zone = dateTime[8];
  if (!zone) return ianaLocalDateToUtc(wallTime, APPLICATION_TIMEZONE).toISOString();
  if (zone.toUpperCase() !== 'Z' && (Number(dateTime[9]) > 23 || Number(dateTime[10]) > 59)) {
    throw new Error('invalid event timezone offset');
  }
  const canonicalZone = zone.toUpperCase() === 'Z'
    ? 'Z'
    : `${zone[0]}${dateTime[9]}:${dateTime[10]}`;
  const parsed = new Date(
    `${dateTime[1]}-${dateTime[2]}-${dateTime[3]}T${dateTime[4]}:${dateTime[5]}:${dateTime[6] ?? '00'}${canonicalZone}`,
  );
  if (Number.isNaN(parsed.valueOf())) throw new Error('invalid event date');
  return parsed.toISOString();
}

export function validateCalendarEventDraft(event: CalendarEventDraft): {
  kind: 'all-day' | 'timed';
  dtstart: string;
  dtend: string;
} {
  const startIsDate = DATE_ONLY.test(event.dtstart);
  const endIsDate = DATE_ONLY.test(event.dtend);
  if (startIsDate !== endIsDate) {
    throw new Error('DTSTART and DTEND must both be all-day dates or timed values');
  }
  const dtstart = normalizeDraftDate(event.dtstart);
  const dtend = normalizeDraftDate(event.dtend);
  if (dtend <= dtstart) throw new Error('DTEND must be strictly after DTSTART');
  return { kind: startIsDate ? 'all-day' : 'timed', dtstart, dtend };
}

export function buildIcal(draft: CalendarEventDraft): string {
  validateCalendarEventDraft(draft);
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
  const dateOnly = DATE_ONLY.test(source);
  const value = dateOnly ? ICAL.Time.fromDateString(source) : ICAL.Time.fromJSDate(new Date(normalizeDraftDate(source)), true);
  component.addPropertyWithValue(name, value);
}

function validateWallTime(value: WallTime): number {
  const validation = new Date(0);
  validation.setUTCFullYear(value.year, value.month - 1, value.day);
  validation.setUTCHours(value.hour, value.minute, value.second, value.millisecond ?? 0);
  if (validation.getUTCFullYear() !== value.year || validation.getUTCMonth() !== value.month - 1 ||
      validation.getUTCDate() !== value.day || validation.getUTCHours() !== value.hour ||
      validation.getUTCMinutes() !== value.minute || validation.getUTCSeconds() !== value.second ||
      validation.getUTCMilliseconds() !== (value.millisecond ?? 0)) {
    throw new Error('invalid local event date');
  }
  return validation.valueOf();
}
