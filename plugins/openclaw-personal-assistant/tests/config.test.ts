import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const validConfig = {
  workspaceDir: '/home/user/.openclaw/workspace',
  stateDir: '/home/user/.openclaw/state',
  backupDir: '/mnt/d/openclaw_setting/backups',
  telegramUserId: '123456789',
  timezone: 'Asia/Seoul',
} as const;

describe('loadConfig', () => {
  it('accepts absolute WSL paths and one Telegram sender', () => {
    expect(loadConfig(validConfig).telegramUserId).toBe('123456789');
  });

  it('preserves the signed SQLite int64 maximum Telegram ID exactly', () => {
    expect(loadConfig({
      ...validConfig,
      telegramUserId: '9223372036854775807',
    }).telegramUserId).toBe('9223372036854775807');
  });

  it.each(['0', '00123', '9223372036854775808'])(
    'rejects non-canonical or overflowing Telegram ID %s',
    telegramUserId => expect(() => loadConfig({ ...validConfig, telegramUserId })).toThrow(/telegramUserId/),
  );

  it.each(['../workspace', '', '/tmp/../etc'])(
    'rejects unsafe workspace path %s',
    workspaceDir => expect(() => loadConfig({ ...validConfig, workspaceDir })).toThrow(/workspaceDir/),
  );
});
