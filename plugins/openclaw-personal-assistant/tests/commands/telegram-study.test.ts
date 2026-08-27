import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerStudyInteractiveHandler } from '../../src/commands/telegram-study.js';
import { StudyStore } from '../../src/study/store.js';

const config = {
  workspaceDir: '/home/user/.openclaw/workspace',
  stateDir: '/home/user/.openclaw/state',
  backupDir: '/mnt/d/openclaw_setting/backups',
  telegramUserId: '123456789',
  timezone: 'Asia/Seoul',
} as const;
const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const stateDir = await mkdtemp(join(tmpdir(), 'assistant-study-callback-'));
  temporaryDirs.push(stateDir);
  const store = new StudyStore(stateDir);
  store.plan('plan-1', 'S-20260827-001', [{
    title: '수학', startAt: '2026-08-27T10:00:00+09:00', durationMinutes: 50,
  }]);
  store.consumeDue(new Date('2026-08-27T10:00:00+09:00'));
  store.close();
  let registration: { namespace: string; handler: (ctx: unknown) => Promise<unknown> } | undefined;
  const api = {
    config: {}, pluginConfig: config,
    registerInteractiveHandler(value: typeof registration) { registration = value; },
  } as never;
  registerStudyInteractiveHandler(api, {
    openStore: () => new StudyStore(stateDir),
    now: () => new Date('2026-08-27T10:40:00+09:00'),
  });
  return { stateDir, registration: () => registration! };
}

function callbackContext(senderId = config.telegramUserId) {
  const clearButtons = vi.fn(async () => {});
  const editMessage = vi.fn(async () => {});
  return {
    context: {
      channel: 'telegram', accountId: 'default', callbackId: 'callback-1',
      conversationId: config.telegramUserId, senderId, isGroup: false, isForum: false,
      auth: { isAuthorizedSender: true },
      callback: {
        data: 'ocstudy:done:B-20260827-001', namespace: 'ocstudy',
        payload: 'done:B-20260827-001', messageId: 1, chatId: config.telegramUserId,
      },
      respond: {
        reply: vi.fn(), editMessage, editButtons: vi.fn(), clearButtons, deleteMessage: vi.fn(),
      },
    },
    clearButtons,
    editMessage,
  };
}

describe('Telegram study callbacks', () => {
  it('claims an owner callback once and clears buttons after the committed transition', async () => {
    const setup = await fixture();
    const callback = callbackContext();
    expect(setup.registration().namespace).toBe('ocstudy');

    const first = await setup.registration().handler(callback.context);
    const retry = await setup.registration().handler(callback.context);

    expect(first).toEqual({ handled: true });
    expect(retry).toEqual({ handled: true });
    const verification = new StudyStore(setup.stateDir);
    expect(verification.get('B-20260827-001')?.status).toBe('completed');
    verification.close();
    expect(callback.clearButtons).toHaveBeenCalledTimes(2);
    expect(callback.editMessage).toHaveBeenCalledTimes(2);
  });

  it('rejects a forged sender without opening study state', async () => {
    const openStore = vi.fn();
    let handler: ((ctx: unknown) => Promise<unknown>) | undefined;
    registerStudyInteractiveHandler({
      config: {}, pluginConfig: config,
      registerInteractiveHandler(value: { handler: typeof handler }) { handler = value.handler; },
    } as never, { openStore });
    const callback = callbackContext('999');

    expect(await handler!(callback.context)).toEqual({ handled: true });
    expect(openStore).not.toHaveBeenCalled();
    expect(callback.clearButtons).toHaveBeenCalledOnce();
  });
});
