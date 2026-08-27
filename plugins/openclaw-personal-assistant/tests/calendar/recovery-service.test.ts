import { describe, expect, it, vi } from 'vitest';

import entry from '../../src/index.js';

describe('retired CalDAV recovery surface', () => {
  it('registers no legacy recovery service or confirmation command', () => {
    const tools: string[] = [];
    const registerService = vi.fn();
    const registerCommand = vi.fn();
    entry.register({
      registrationMode: 'full',
      pluginConfig: {
        workspaceDir: '/private/workspace',
        stateDir: '/private/state',
        backupDir: '/private/backups',
        telegramUserId: '6520016662',
        timezone: 'Asia/Seoul',
        calendar: {
          provider: 'google',
          googleOAuthClientFile: '/private/secrets/google-oauth-client',
          googleTokenFile: '/private/secrets/google-oauth-token',
          googleCalendarBindingFile: '/private/secrets/google-calendar-binding',
          expectedAccount: 'yangisu12@gmail.com',
        },
      },
      registerTool(_tool: unknown, options: { name?: string }) {
        if (options.name) tools.push(options.name);
      },
      registerService,
      registerCommand,
      registerHook: vi.fn(),
    } as never);

    expect(tools.sort()).toEqual([
      'assistant_briefing',
      'assistant_calendar_manage',
      'assistant_mutate',
      'assistant_query',
    ]);
    expect(registerService).not.toHaveBeenCalled();
    expect(registerCommand).not.toHaveBeenCalled();
  });
});
