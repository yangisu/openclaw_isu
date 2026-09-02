import { createHash } from 'node:crypto';

const TELEGRAM_LIMIT = 4_096;
const MAX_SECTION_ITEMS = 3;
const MAX_DISPLAY_CHARACTERS = 480;
const SEOUL_TIMEZONE = 'Asia/Seoul';

export interface BriefingEvent {
  start: string;
  title: string;
  kind?: 'all-day' | 'recurring' | 'timed';
  status?: string;
}

export interface BriefingTask {
  id: string;
  title: string;
  status: 'open' | 'in_progress' | 'done' | 'archived';
  priority: 'high' | 'normal' | 'low';
  dueAt?: string;
}

export interface BriefingStudy {
  id: string;
  title: string;
  status: 'open' | 'in_progress' | 'done' | 'archived';
  category?: 'school' | 'personal';
  courseName?: string;
  subject: string;
  progress: number;
  targetAmount: number;
  unit: string;
  targetDate?: string;
  deadline?: string;
  isAssignment?: boolean;
  recurrence?: 'none' | 'daily' | 'weekly';
  reviewDates?: string[];
}

export interface ActiveSubsystemError {
  errorCode: string;
  target: string;
  message: string;
  fingerprint?: string;
}

export interface BriefingInput {
  now: string;
  events: BriefingEvent[];
  tasks: BriefingTask[];
  studies: BriefingStudy[];
  activeErrors: ActiveSubsystemError[];
}

export interface BriefingResult {
  trust: 'quoted_untrusted_data';
  allowed: boolean;
  send: boolean;
  messages: string[];
  includedErrorFingerprints: string[];
  messageErrorFingerprints: string[][];
}

interface Section {
  heading: string;
  entries: Array<{ text: string; fingerprint?: string }>;
}

export function alertFingerprint(errorCode: string, target: string): string {
  return createHash('sha256').update(`${errorCode}:${target}`, 'utf8').digest('hex');
}

export function buildBriefing(input: BriefingInput): BriefingResult {
  const now = new Date(input.now);
  if (!Number.isFinite(now.valueOf())) return emptyResult(false);
  const current = seoulParts(now);
  const allowed = Number(current.hour) >= 8 && Number(current.hour) <= 22;
  if (!allowed) return emptyResult(false);

  const today = `${current.year}-${current.month}-${current.day}`;
  const sections = selectSections(input, now, today).filter(section => section.entries.length > 0);
  if (sections.length === 0) return emptyResult(true);

  const renderedSections = sections.map(section => ({
    content: [
      section.heading,
      ...section.entries.slice(0, MAX_SECTION_ITEMS).map(entry => `• ${display(entry.text)}`),
    ].join('\n'),
    fingerprints: section.entries.slice(0, MAX_SECTION_ITEMS)
      .flatMap(entry => entry.fingerprint ? [entry.fingerprint] : []),
  }));
  const title = `🕘 ${current.hour}:${current.minute} briefing`;
  const chunks = splitAtSectionBoundaries(title, renderedSections);
  const messages = chunks.map(chunk => chunk.content);
  const messageErrorFingerprints = chunks.map(chunk => chunk.fingerprints);
  const includedErrorFingerprints = sections
    .flatMap(section => section.entries.slice(0, MAX_SECTION_ITEMS))
    .flatMap(entry => entry.fingerprint ? [entry.fingerprint] : []);

  return {
    trust: 'quoted_untrusted_data', allowed: true, send: true,
    messages, includedErrorFingerprints, messageErrorFingerprints,
  };
}

function selectSections(input: BriefingInput, now: Date, today: string): Section[] {
  const nextEvent = input.events
    .filter(event => event.status?.toUpperCase() !== 'CANCELLED')
    .filter(event => event.kind === 'all-day'
      ? /^\d{4}-\d{2}-\d{2}$/.test(event.start) && event.start >= today
      : Number.isFinite(Date.parse(event.start)) && finiteDate(event.start) >= now.valueOf())
    .sort((left, right) => eventSortTime(left) - eventSortTime(right)
      || left.title.localeCompare(right.title))[0];

  const priorityRank = { high: 0, normal: 1, low: 2 } as const;
  const dueToday = input.tasks
    .filter(task => activeStatus(task.status) && task.dueAt && seoulDate(task.dueAt) === today)
    .sort((left, right) => priorityRank[left.priority] - priorityRank[right.priority]
      || finiteDate(left.dueAt!) - finiteDate(right.dueAt!)
      || left.id.localeCompare(right.id));

  const activeStudies = input.studies.filter(study => activeStatus(study.status) && (
    study.targetDate === today
    || (study.deadline && seoulDate(study.deadline) === today)
    || study.recurrence === 'daily'
    || study.reviewDates?.includes(today)
  ));

  const schoolAssignments = activeStudies
    .filter(study => study.category === 'school' || study.isAssignment === true)
    .sort((left, right) => (left.deadline ? finiteDate(left.deadline) : Number.MAX_SAFE_INTEGER) - (right.deadline ? finiteDate(right.deadline) : Number.MAX_SAFE_INTEGER)
      || left.subject.localeCompare(right.subject) || left.id.localeCompare(right.id));

  const personalStudies = activeStudies
    .filter(study => study.category !== 'school' && study.isAssignment !== true)
    .sort((left, right) => left.subject.localeCompare(right.subject) || left.id.localeCompare(right.id));

  const overdue = [
    ...input.tasks
      .filter(task => activeStatus(task.status) && task.dueAt)
      .map(task => ({
        id: task.id,
        title: task.title,
        days: calendarDayDifference(seoulDate(task.dueAt!), today),
      })),
    ...input.studies
      .filter(study => activeStatus(study.status) && (study.targetDate || study.deadline))
      .map(study => ({
        id: study.id,
        title: study.subject,
        days: calendarDayDifference(study.targetDate ?? seoulDate(study.deadline!), today),
      })),
  ].filter(item => item.days >= 2)
    .sort((left, right) => right.days - left.days || left.id.localeCompare(right.id));

  const errors = [...input.activeErrors]
    .map(error => ({
      ...error,
      fingerprint: error.fingerprint ?? alertFingerprint(error.errorCode, error.target),
    }))
    .sort((left, right) => left.errorCode.localeCompare(right.errorCode)
      || left.target.localeCompare(right.target));

  return [
    {
      heading: 'Next event',
      entries: nextEvent ? [{
        text: `${nextEvent.kind === 'all-day' ? '종일' : seoulTime(nextEvent.start)} ${nextEvent.title}`,
      }] : [],
    },
    {
      heading: 'Due today',
      entries: dueToday.map(task => ({
        text: `[${task.priority}] ${task.title} — ${seoulTime(task.dueAt!)} due`,
      })),
    },
    {
      heading: '🏫 School & Assignments',
      entries: schoolAssignments.map(study => {
        const prefix = study.courseName ? `[${study.courseName}] ` : '';
        const deadlineText = study.deadline ? ` — ${seoulTime(study.deadline)} due` : '';
        return {
          text: `${prefix}${study.subject} ${study.progress}/${study.targetAmount} ${study.unit}${deadlineText}`
            + (study.reviewDates?.includes(today) ? ' · review today' : ''),
        };
      }),
    },
    {
      heading: '📚 Personal Study',
      entries: personalStudies.map(study => ({
        text: `${study.subject} ${study.progress}/${study.targetAmount} ${study.unit}`
          + (study.reviewDates?.includes(today) ? ' · review today' : ''),
      })),
    },
    {
      heading: 'Easy to miss',
      entries: overdue.map(item => ({ text: `${item.days} days overdue: ${item.title}` })),
    },
    {
      heading: 'Active errors',
      entries: errors.map(error => ({
        text: `${error.errorCode} (${error.target}): ${error.message}`,
        fingerprint: error.fingerprint,
      })),
    },
  ];
}

function emptyResult(allowed: boolean): BriefingResult {
  return {
    trust: 'quoted_untrusted_data', allowed, send: false,
    messages: [], includedErrorFingerprints: [], messageErrorFingerprints: [],
  };
}

function activeStatus(status: string): boolean {
  return status === 'open' || status === 'in_progress';
}

function finiteDate(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

function eventSortTime(event: BriefingEvent): number {
  if (event.kind === 'all-day' && /^\d{4}-\d{2}-\d{2}$/.test(event.start)) {
    return Date.parse(`${event.start}T00:00:00+09:00`);
  }
  return finiteDate(event.start);
}

function seoulParts(date: Date): { year: string; month: string; day: string; hour: string; minute: string } {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: SEOUL_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => values.find(value => value.type === type)!.value;
  return {
    year: part('year'), month: part('month'), day: part('day'),
    hour: part('hour'), minute: part('minute'),
  };
}

function seoulDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return '';
  const parts = seoulParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function seoulTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return '--:--';
  const parts = seoulParts(date);
  return `${parts.hour}:${parts.minute}`;
}

function calendarDayDifference(earlier: string, later: string): number {
  const parse = (value: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : Number.NaN;
  };
  return Math.floor((parse(later) - parse(earlier)) / 86_400_000);
}

function display(value: string): string {
  const flattened = value
    .replace(/\p{Cf}/gu, '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = [...flattened];
  if (characters.length <= MAX_DISPLAY_CHARACTERS) return flattened;
  return `${characters.slice(0, MAX_DISPLAY_CHARACTERS - 1).join('')}…`;
}

function splitAtSectionBoundaries(
  title: string,
  sections: Array<{ content: string; fingerprints: string[] }>,
): Array<{ content: string; fingerprints: string[] }> {
  const messages: Array<{ content: string; fingerprints: string[] }> = [];
  let current = { content: title, fingerprints: [] as string[] };
  for (const section of sections) {
    const candidate = `${current.content}\n\n${section.content}`;
    if (candidate.length <= TELEGRAM_LIMIT) {
      current = {
        content: candidate,
        fingerprints: [...current.fingerprints, ...section.fingerprints],
      };
    } else {
      messages.push(current);
      current = section;
    }
  }
  messages.push(current);
  return messages;
}
