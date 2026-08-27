import type { StudySettings } from './types.js';

interface SeoulParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function seoulParts(date: Date): SeoulParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(
    parts.find(item => item.type === type)?.value,
  );
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
    second: part('second'),
  };
}

function civilDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function addCivilDays(dayKey: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(dayKey);
  if (!match) throw new TypeError('invalid study day key');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return civilDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function studyDayKey(now: Date): string {
  const parts = seoulParts(now);
  const today = civilDate(parts.year, parts.month, parts.day);
  return parts.hour < 2 ? addCivilDays(today, -1) : today;
}

export function isStudyWindow(now: Date, settings: StudySettings): boolean {
  const { hour } = seoulParts(now);
  return hour >= settings.windowStartHour || hour < settings.windowEndHour;
}

export function toSeoulTimestamp(date: Date): string {
  const parts = seoulParts(date);
  return `${civilDate(parts.year, parts.month, parts.day)}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}+09:00`;
}

export function studyWindowBounds(dayKey: string, settings: StudySettings): {
  start: string;
  end: string;
} {
  return {
    start: `${dayKey}T${String(settings.windowStartHour).padStart(2, '0')}:00:00+09:00`,
    end: `${addCivilDays(dayKey, 1)}T${String(settings.windowEndHour).padStart(2, '0')}:00:00+09:00`,
  };
}
