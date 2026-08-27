import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { Type } from 'typebox';

import { TELEGRAM_USER_ID_PATTERN } from '../telegram-user-id.js';
import {
  createCalendarManageTool,
} from './calendar.js';
import { createMutationTool, mutationParameters } from './mutate.js';
import { createQueryTool, queryParameters } from './query.js';
import { briefingParameters, createBriefingTool } from './briefing.js';

const absoluteWslPath = Type.String({ pattern: '^/(?!.*(?:^|/)\\.\\.(?:/|$)).+' });

export const configSchema = Type.Object({
  workspaceDir: absoluteWslPath,
  stateDir: absoluteWslPath,
  backupDir: absoluteWslPath,
  telegramUserId: Type.String({ pattern: TELEGRAM_USER_ID_PATTERN, maxLength: 19 }),
  timezone: Type.Literal('Asia/Seoul'),
  calendar: Type.Optional(Type.Object({
    provider: Type.Literal('google'),
    googleOAuthClientFile: absoluteWslPath,
    googleTokenFile: absoluteWslPath,
    googleCalendarBindingFile: absoluteWslPath,
    expectedAccount: Type.Literal('yangisu12@gmail.com'),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export function registerAssistantTools(api: OpenClawPluginApi): void {
  api.registerTool(context => createQueryTool(api, context), { name: 'assistant_query', optional: true });
  api.registerTool(context => createMutationTool(api, context), { name: 'assistant_mutate', optional: true });
  api.registerTool(context => createCalendarManageTool(api, context), {
    name: 'assistant_calendar_manage', optional: true,
  });
  api.registerTool(context => createBriefingTool(api, context), { name: 'assistant_briefing', optional: true });
}
