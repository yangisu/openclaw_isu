import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from 'openclaw/plugin-sdk/plugin-entry';
import { isCronSessionKey } from 'openclaw/plugin-sdk/routing';

import { loadConfig, type AssistantConfig, type CalendarCollectionMapping } from '../config.js';
import { normalizeTelegramUserId } from '../telegram-user-id.js';

export interface CalendarToolConfig {
  provider?: 'google';
  googleOAuthClientFile?: string;
  googleTokenFile?: string;
  googleCalendarBindingFile?: string;
  expectedAccount?: 'yangisu12@gmail.com';
  // Dormant legacy fields remain typed for old migration helpers but are rejected by loadConfigFromApi.
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
  const allowed = [
    'expectedAccount', 'googleCalendarBindingFile', 'googleOAuthClientFile', 'googleTokenFile', 'provider',
  ];
  if (Object.keys(value).sort().join('\0') !== allowed.join('\0')) {
    throw new AssistantToolError('invalid_calendar_config', 'Calendar configuration contains an unknown field');
  }
  if (value.provider !== 'google' || value.expectedAccount !== 'yangisu12@gmail.com') {
    throw new AssistantToolError('invalid_calendar_config', 'Calendar provider or account is invalid');
  }
  const paths: Record<string, string> = {};
  for (const key of ['googleOAuthClientFile', 'googleTokenFile', 'googleCalendarBindingFile'] as const) {
    const path = value[key];
    if (typeof path !== 'string' || !isSafeAbsoluteWslPath(path)
      || [config.workspaceDir, config.stateDir, config.backupDir].some(root => isWithinRoot(root, path))) {
      throw new AssistantToolError('invalid_calendar_config', `Invalid ${key}`);
    }
    paths[key] = path;
  }
  if (new Set(Object.values(paths)).size !== 3) {
    throw new AssistantToolError('invalid_calendar_config', 'Google Calendar secret files must be distinct');
  }
  return {
    ...config,
    calendar: {
      provider: 'google',
      googleOAuthClientFile: paths.googleOAuthClientFile!,
      googleTokenFile: paths.googleTokenFile!,
      googleCalendarBindingFile: paths.googleCalendarBindingFile!,
      expectedAccount: 'yangisu12@gmail.com',
    },
  };
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

export function requireGoogleCalendarConfig(config: AssistantToolConfig): {
  provider: 'google';
  googleOAuthClientFile: string;
  googleTokenFile: string;
  googleCalendarBindingFile: string;
  expectedAccount: 'yangisu12@gmail.com';
} {
  const calendar = config.calendar;
  if (calendar?.provider !== 'google' || calendar.expectedAccount !== 'yangisu12@gmail.com'
    || !calendar.googleOAuthClientFile || !calendar.googleTokenFile || !calendar.googleCalendarBindingFile) {
    throw new AssistantToolError('calendar_not_configured', 'Google Calendar is not configured');
  }
  return {
    provider: 'google',
    googleOAuthClientFile: calendar.googleOAuthClientFile,
    googleTokenFile: calendar.googleTokenFile,
    googleCalendarBindingFile: calendar.googleCalendarBindingFile,
    expectedAccount: 'yangisu12@gmail.com',
  };
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
