import type { OpenClawPluginCommandDefinition } from 'openclaw/plugin-sdk/plugin-entry';
import { describe, expect, it, vi } from 'vitest';

import type { AddRecordInput } from '../../src/domain.js';
import { registerAssistantCommands } from '../../src/commands/register.js';

const config = {
  workspaceDir: '/home/user/.openclaw/workspace',
  stateDir: '/home/user/.openclaw/state',
  backupDir: '/mnt/d/openclaw_setting/backups',
  telegramUserId: '123456789',
  timezone: 'Asia/Seoul',
} as const;

function context(args = '') {
  return {
    senderId: config.telegramUserId,
    channel: 'telegram',
    channelId: 'telegram',
    isAuthorizedSender: true,
    senderIsOwner: true,
    args,
    commandBody: args ? `/command ${args}` : '/command',
    config: {},
  } as never;
}

function registrations(overrides: Record<string, unknown> = {}) {
  const commands: OpenClawPluginCommandDefinition[] = [];
  let savedInput: AddRecordInput | undefined;
  const repository = {
    async addRecord(_operationId: string, input: AddRecordInput) {
      savedInput = input;
      return {
        operationId: 'memo-op', id: 'N-20260827-001', replayed: false,
        record: { id: 'N-20260827-001', title: input.title, fields: {}, orderedFields: [], body: input.body ?? '' },
      };
    },
    async listResources() { return []; },
    close() {},
  };
  const api = {
    config: {},
    pluginConfig: config,
    registerCommand(command: OpenClawPluginCommandDefinition) { commands.push(command); },
  } as never;
  registerAssistantCommands(api, {
    openRepository: () => repository,
    openCatalog: () => ({ sync() {}, search() { return []; }, close() {} }),
    openStore: () => ({
      current: () => ({
        dayKey: '2026-08-27', blocks: [],
        counts: { planned: 0, active: 0, snoozed: 0, completed: 0, skipped: 0, missed: 0 },
        completionRate: 0,
      }),
      transition: vi.fn(), settings: () => ({}), close() {},
    }),
    operationId: () => 'memo-op',
    ...overrides,
  });
  return {
    commands,
    command: (name: string) => commands.find(item => item.name === name)!,
    savedInput: () => savedInput,
  };
}

describe('personal assistant commands', () => {
  it('registers the four owner-only Telegram commands', () => {
    const { commands } = registrations();
    expect(commands.map(command => ({
      name: command.name,
      channels: command.channels,
      acceptsArgs: command.acceptsArgs,
      requireAuth: command.requireAuth,
      exposeSenderIsOwner: command.exposeSenderIsOwner,
    }))).toEqual(['save', 'find', 'memo', 'study'].map(name => ({
      name, channels: ['telegram'], acceptsArgs: true, requireAuth: true, exposeSenderIsOwner: true,
    })));
  });

  it('continues /save and /study add into the agent only after validation', async () => {
    const { command } = registrations();
    expect(await command('save').handler(context('https://example.test/a')))
      .toMatchObject({ continueAgent: true });
    expect(await command('save').handler(context('file:///etc/passwd')))
      .not.toHaveProperty('continueAgent', true);
    expect(await command('study').handler(context('add 수학 2시간')))
      .toMatchObject({ continueAgent: true });
  });

  it('stores /memo deterministically without model continuation', async () => {
    const registration = registrations();
    const result = await registration.command('memo').handler(
      context('핵심 아이디어입니다. 자세한 내용 #AI #공부 #AI'),
    );

    expect(result.continueAgent).not.toBe(true);
    expect(registration.savedInput()).toMatchObject({
      kind: 'note', title: '핵심 아이디어입니다', tags: ['AI', '공부'], source: 'telegram',
    });
    expect(registration.savedInput()?.body).not.toContain('#AI');
  });

  it('rejects non-owner and overlong command input before local state', async () => {
    const openRepository = vi.fn();
    const { command } = registrations({ openRepository });
    const nonOwner = { ...context('메모'), senderId: '999' };
    const denied = await command('memo').handler(nonOwner as never);
    const oversized = await command('memo').handler(context('x'.repeat(4_097)));

    expect(denied.text).toContain('권한');
    expect(oversized.text).toContain('4096');
    expect(openRepository).not.toHaveBeenCalled();
  });
});
