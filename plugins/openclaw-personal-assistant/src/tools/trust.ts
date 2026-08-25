import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from 'openclaw/plugin-sdk/plugin-entry';
import { isCronSessionKey } from 'openclaw/plugin-sdk/routing';

import { loadConfig, type AssistantConfig } from '../config.js';
import { normalizeTelegramUserId } from '../telegram-user-id.js';

export interface CalendarToolConfig {
  caldavBaseUrl?: string;
  caldavSecretFile?: string;
  naverTokenFile?: string;
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
  const allowed = new Set(['caldavBaseUrl', 'caldavSecretFile', 'naverTokenFile']);
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new AssistantToolError('invalid_calendar_config', 'Calendar configuration contains an unknown field');
  }
  const calendar: CalendarToolConfig = {};
  for (const key of ['caldavSecretFile', 'naverTokenFile'] as const) {
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
} {
  const { caldavBaseUrl, caldavSecretFile } = config.calendar ?? {};
  if (!caldavBaseUrl || !caldavSecretFile) {
    throw new AssistantToolError('calendar_not_configured', 'CalDAV read access is not configured');
  }
  return { caldavBaseUrl, caldavSecretFile };
}

export function requireCalendarWriteConfig(config: AssistantToolConfig): {
  naverTokenFile: string;
} {
  const { naverTokenFile } = config.calendar ?? {};
  if (!naverTokenFile) {
    throw new AssistantToolError('calendar_not_configured', 'Naver calendar write access is not configured');
  }
  return { naverTokenFile };
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
