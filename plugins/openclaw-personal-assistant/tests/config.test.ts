import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('accepts absolute WSL paths and one Telegram sender', () => {
    expect(loadConfig({
      workspaceDir: '/home/user/.openclaw/workspace',
      stateDir: '/home/user/.openclaw/state',
      backupDir: '/mnt/d/openclaw_setting/backups',
      telegramUserId: '123456789',
      timezone: 'Asia/Seoul',
    }).telegramUserId).toBe('123456789');
  });

  it.each(['../workspace', '', '/tmp/../etc'])(
    'rejects unsafe workspace path %s',
    workspaceDir => expect(() => loadConfig({ workspaceDir })).toThrow(),
  );
});
