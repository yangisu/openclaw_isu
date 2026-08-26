import { Value } from 'typebox/value';
import { describe, expect, it, vi } from 'vitest';

import { createMutationTool, mutationParameters } from '../../src/tools/mutate.js';

const config = {
  workspaceDir: '/home/user/.openclaw/workspace',
  stateDir: '/home/user/.openclaw/state',
  backupDir: '/mnt/d/openclaw_setting/backups',
  telegramUserId: '123456789',
  timezone: 'Asia/Seoul',
} as const;

function api() {
  return {
    config: { channels: { telegram: { enabled: true } } },
    pluginConfig: config,
  } as never;
}

const ownerContext = { requesterSenderId: config.telegramUserId };

describe('assistant_mutate update integrity', () => {
  it.each([
    ['structural title', 'invalid_title', {
      operationId: 'bad-title', action: 'modify', recordType: 'task',
      targetId: 'T-20260825-001', title: 'Injected\n### T-20260825-999 Other',
    }],
    ['structural body', 'invalid_body', {
      operationId: 'bad-body', action: 'modify', recordType: 'note',
      targetId: 'N-20260825-001', body: 'Safe\n### N-20260825-999 Other',
    }],
    ['invalid civil date', 'invalid_date', {
      operationId: 'bad-date', action: 'modify', recordType: 'study',
      targetId: 'S-20260825-001', fields: { target_date: '2026-02-29' },
    }],
  ])('rejects %s before opening repository state', async (_label, code, params) => {
    const openRepository = vi.fn();
    const tool = createMutationTool(api(), ownerContext, { openRepository });

    await expect(tool.execute('call-invalid-update', params as never)).rejects.toMatchObject({ code });

    expect(openRepository).not.toHaveBeenCalled();
  });

  it('schema-rejects an unsafe study progress integer', () => {
    expect(Value.Check(mutationParameters, {
      operationId: 'unsafe-progress', action: 'modify', recordType: 'study',
      targetId: 'S-20260825-001', fields: { progress: 1e21 },
    })).toBe(false);
  });
});
