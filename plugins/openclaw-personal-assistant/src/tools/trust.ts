import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from 'openclaw/plugin-sdk/plugin-entry';
import { isCronSessionKey } from 'openclaw/plugin-sdk/routing';

import {
  loadCalendarMappings, loadConfig, type AssistantConfig, type CalendarCollectionMapping,
} from '../config.js';
import { normalizeTelegramUserId } from '../telegram-user-id.js';

export interface CalendarToolConfig {
  caldavReadEnabled?: boolean;
  caldavBaseUrl?: string;
  caldavSecretFile?: string;
  naverOAuthClientFile?: string;
  naverTokenFile?: string;
  calendarMappings?: CalendarCollectionMapping[];
}

export interface AssistantToolConfig extends AssistantConfig {
  calendar?: CalendarToolConfig;
}

export class AssistantToolError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AssistantToolError';
  }
}

export function loadConfigFromApi(api: OpenClawPluginApi): AssistantToolConfig {
  const config = loadConfig(api.pluginConfig);
  const rawCalendar = (api.pluginConfig as { calendar?: unknown } | undefined)?.calendar;
  if (rawCalendar === undefined) return config;
  if (!rawCalendar || typeof rawCalendar !== 'object' || Array.isArray(rawCalendar)) {
    throw new AssistantToolError('invalid_calendar_config', 'Calendar configuration must be an object');
  }
  const value = rawCalendar as Record<string, unknown>;
  const allowed = new Set(['caldavReadEnabled', 'caldavBaseUrl', 'caldavSecretFile', 'naverOAuthClientFile', 'naverTokenFile', 'calendarMappings']);
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new AssistantToolError('invalid_calendar_config', 'Calendar configuration contains an unknown field');
  }
  const calendar: CalendarToolConfig = {};
  if (value.caldavReadEnabled !== undefined) {
    if (typeof value.caldavReadEnabled !== 'boolean') {
      throw new AssistantToolError('invalid_calendar_config', 'Invalid caldavReadEnabled');
    }
    calendar.caldavReadEnabled = value.caldavReadEnabled;
  }
  for (const key of ['caldavSecretFile', 'naverOAuthClientFile', 'naverTokenFile'] as const) {
    const path = value[key];
    if (path !== undefined) {
      if (typeof path !== 'string' || !isSafeAbsoluteWslPath(path)) {
        throw new AssistantToolError('invalid_calendar_config', `Invalid ${key}`);
      }
      calendar[key] = path;
    }
  }
  if (value.caldavBaseUrl !== undefined) {
    if (typeof value.caldavBaseUrl !== 'string' || !isHttpsUrl(value.caldavBaseUrl)) {
      throw new AssistantToolError('invalid_calendar_config', 'CalDAV base URL must use HTTPS');
    }
    calendar.caldavBaseUrl = value.caldavBaseUrl;
  }
  if (value.calendarMappings !== undefined) {
    if (!calendar.caldavBaseUrl) {
      throw new AssistantToolError('invalid_calendar_config', 'Calendar mappings require a CalDAV base URL');
    }
    try {
      calendar.calendarMappings = loadCalendarMappings(calendar.caldavBaseUrl, value.calendarMappings);
    } catch {
      throw new AssistantToolError('invalid_calendar_config', 'Invalid calendarMappings');
    }
  }
  return { ...config, calendar };
}

export function assertOwner(
  toolContext: Pick<OpenClawPluginToolContext, 'requesterSenderId'>,
  config: AssistantConfig,
): string {
  let senderId: string;
  let ownerId: string;
  try {
    senderId = normalizeTelegramUserId(toolContext.requesterSenderId);
    ownerId = normalizeTelegramUserId(config.telegramUserId);
  } catch {
    throw new AssistantToolError('sender_not_allowed', 'This tool is restricted to the configured owner');
  }
  if (senderId !== ownerId) {
    throw new AssistantToolError('sender_not_allowed', 'This tool is restricted to the configured owner');
  }
  return senderId;
}

export function assertOwnerOrTrustedBriefingCron(
  toolContext: Pick<OpenClawPluginToolContext,
    'requesterSenderId' | 'senderIsOwner' | 'sessionKey' | 'deliveryContext'>,
  config: AssistantConfig,
): string {
  if (toolContext.requesterSenderId !== undefined) return assertOwner(toolContext, config);

  let ownerId: string;
  try {
    ownerId = normalizeTelegramUserId(config.telegramUserId);
  } catch {
    throw new AssistantToolError('sender_not_allowed', 'This tool is restricted to the configured owner');
  }
  const delivery = toolContext.deliveryContext;
  if (toolContext.senderIsOwner === false
    || !isCronSessionKey(toolContext.sessionKey)
    || delivery?.channel !== 'telegram'
    || delivery.to !== ownerId
    || delivery.threadId != null) {
    throw new AssistantToolError('sender_not_allowed', 'This tool is restricted to the configured owner');
  }
  return ownerId;
}

export function requireCalendarReadConfig(config: AssistantToolConfig): {
  caldavBaseUrl: string;
  caldavSecretFile: string;
  calendarMappings: CalendarCollectionMapping[];
} {
  const { caldavReadEnabled, caldavBaseUrl, caldavSecretFile, calendarMappings } = config.calendar ?? {};
  if (caldavReadEnabled !== true) {
    throw new AssistantToolError('caldav_read_disabled', 'CalDAV reads are disabled pending authorized live validation');
  }
  if (!caldavBaseUrl || !caldavSecretFile || !calendarMappings?.length) {
    throw new AssistantToolError('calendar_not_configured', 'CalDAV read access is not configured');
  }
  return { caldavBaseUrl, caldavSecretFile, calendarMappings };
}

export function requireCalendarWriteConfig(config: AssistantToolConfig): {
  naverOAuthClientFile: string;
  naverTokenFile: string;
} {
  const { naverOAuthClientFile, naverTokenFile } = config.calendar ?? {};
  if (!naverOAuthClientFile || !naverTokenFile) {
    throw new AssistantToolError('calendar_not_configured', 'Naver calendar write access is not configured');
  }
  if (naverOAuthClientFile === naverTokenFile
    || [naverOAuthClientFile, naverTokenFile].some(secretPath =>
      [config.workspaceDir, config.stateDir, config.backupDir].some(root => isWithinRoot(root, secretPath)))) {
    throw new AssistantToolError('invalid_calendar_config', 'Naver OAuth stores must be separate from data and backup roots');
  }
  return { naverOAuthClientFile, naverTokenFile };
}

function isWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = root.replace(/\/+$/, '');
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}

function isSafeAbsoluteWslPath(path: string): boolean {
  return path.startsWith('/') && !path.split('/').some(part => part === '..');
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
