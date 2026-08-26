import { normalizeTelegramUserId } from './telegram-user-id.js';

export interface AssistantConfig {
  workspaceDir: string;
  stateDir: string;
  backupDir: string;
  telegramUserId: string;
  timezone: 'Asia/Seoul';
}

export interface CalendarCollectionMapping {
  apiCalendarId: string;
  caldavHref: string;
}

export function canonicalizeCalDavHref(baseUrl: string | URL, rawHref: string): URL {
  const base = new URL(String(baseUrl));
  let decodedHref = rawHref;
  try {
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const decoded = decodeURIComponent(decodedHref);
      if (decoded === decodedHref) break;
      decodedHref = decoded;
    }
  } catch { throw new Error('invalid calendarMappings'); }
  if (/%[0-9a-f]{2}/i.test(decodedHref)) throw new Error('invalid calendarMappings');
  decodedHref = decodedHref.replaceAll('\\', '/');
  if (decodedHref.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error('invalid calendarMappings');
  }
  const href = new URL(rawHref, base);
  if (href.protocol !== 'https:' || href.origin !== base.origin || href.username || href.password ||
      href.search || href.hash || !href.pathname.endsWith('/') || href.href === base.href) {
    throw new Error('invalid calendarMappings');
  }
  return href;
}

export function loadCalendarMappings(baseUrl: string, raw: unknown): CalendarCollectionMapping[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10) throw new Error('invalid calendarMappings');
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('invalid calendarMappings');
  }
  const apiIds = new Set<string>();
  const hrefs = new Set<string>();
  return raw.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid calendarMappings');
    const value = item as Record<string, unknown>;
    if (Object.keys(value).sort().join(',') !== 'apiCalendarId,caldavHref' ||
        typeof value.apiCalendarId !== 'string' || !value.apiCalendarId.trim() || value.apiCalendarId.length > 1_024 ||
        typeof value.caldavHref !== 'string' || !value.caldavHref.trim() || value.caldavHref.length > 4_096) {
      throw new Error('invalid calendarMappings');
    }
    const href = canonicalizeCalDavHref(base, value.caldavHref);
    if (apiIds.has(value.apiCalendarId) || hrefs.has(href.href)) throw new Error('invalid calendarMappings');
    for (const existing of hrefs) {
      const existingPath = new URL(existing).pathname;
      if (existingPath.startsWith(href.pathname) || href.pathname.startsWith(existingPath)) {
        throw new Error('invalid calendarMappings');
      }
    }
    apiIds.add(value.apiCalendarId);
    hrefs.add(href.href);
    return { apiCalendarId: value.apiCalendarId, caldavHref: href.href };
  });
}

export function loadConfig(raw: unknown): AssistantConfig {
  const value = raw as Partial<AssistantConfig>;
  for (const key of ['workspaceDir', 'stateDir', 'backupDir'] as const) {
    const path = value[key];
    if (!path?.startsWith('/') || path.includes('/../')) throw new Error(`invalid ${key}`);
  }
  let telegramUserId: string;
  try {
    telegramUserId = normalizeTelegramUserId(value.telegramUserId);
  } catch {
    throw new Error('invalid telegramUserId');
  }
  if (value.timezone !== 'Asia/Seoul') throw new Error('timezone must be Asia/Seoul');
  return {
    workspaceDir: value.workspaceDir!,
    stateDir: value.stateDir!,
    backupDir: value.backupDir!,
    telegramUserId,
    timezone: value.timezone,
  };
}
