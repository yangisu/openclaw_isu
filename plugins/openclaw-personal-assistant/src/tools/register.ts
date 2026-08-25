import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin';
import { Type } from 'typebox';

import { TELEGRAM_USER_ID_PATTERN } from '../telegram-user-id.js';
import {
  calendarConfirmParameters,
  calendarPrepareParameters,
  createCalendarConfirmTool,
  createCalendarPrepareTool,
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
    caldavBaseUrl: Type.Optional(Type.String({ pattern: '^https://' })),
    caldavSecretFile: Type.Optional(absoluteWslPath),
    naverTokenFile: Type.Optional(absoluteWslPath),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export default defineToolPlugin({
  id: 'openclaw-personal-assistant',
  name: 'OpenClaw Personal Assistant',
  description: 'Owner-scoped local records, Naver calendar, and briefings.',
  configSchema,
  tools: tool => [
    tool({
      name: 'assistant_query',
      label: 'Assistant Query',
      description: 'Read owner-scoped local records or Naver CalDAV events as quoted untrusted data.',
      parameters: queryParameters,
      optional: true,
      factory({ api, toolContext }) {
        return createQueryTool(api, toolContext);
      },
    }),
    tool({
      name: 'assistant_mutate',
      label: 'Assistant Mutate',
      description: 'Add, modify, or archive one owner-scoped local record with an idempotent operation ID.',
      parameters: mutationParameters,
      optional: true,
      factory({ api, toolContext }) {
        return createMutationTool(api, toolContext);
      },
    }),
    tool({
      name: 'assistant_calendar_prepare',
      label: 'Assistant Calendar Prepare',
      description: 'Prepare one Naver calendar event locally without writing to Naver.',
      parameters: calendarPrepareParameters,
      optional: true,
      factory({ api, toolContext }) {
        return createCalendarPrepareTool(api, toolContext);
      },
    }),
    tool({
      name: 'assistant_calendar_confirm',
      label: 'Assistant Calendar Confirm',
      description: 'Create one prepared Naver event after explicit owner confirmation.',
      parameters: calendarConfirmParameters,
      optional: true,
      factory({ api, toolContext }) {
        return createCalendarConfirmTool(api, toolContext);
      },
    }),
    tool({
      name: 'assistant_briefing',
      label: 'Assistant Briefing',
      description: 'Build one deterministic owner briefing from local records and fresh calendar state.',
      parameters: briefingParameters,
      optional: true,
      factory({ api, toolContext }) {
        return createBriefingTool(api, toolContext);
      },
    }),
  ],
});
