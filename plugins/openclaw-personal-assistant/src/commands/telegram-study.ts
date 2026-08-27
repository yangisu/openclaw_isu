import { createHash } from 'node:crypto';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import { StudyStore } from '../study/store.js';
import { notifyStudyScheduleChanged } from '../study/signal.js';
import type { StudyBlock, StudyTransitionAction } from '../study/types.js';
import { assertOwner, loadConfigFromApi, type AssistantToolConfig } from '../tools/trust.js';

interface TelegramStudyContext {
  channel: 'telegram';
  accountId: string;
  callbackId: string;
  conversationId: string;
  senderId?: string;
  threadId?: number;
  isGroup: boolean;
  isForum: boolean;
  auth: { isAuthorizedSender: boolean };
  callback: {
    data: string;
    namespace: string;
    payload: string;
    messageId: number;
    chatId: string;
    messageText?: string;
  };
  respond: {
    reply(params: { text: string; buttons?: unknown[] }): Promise<void>;
    editMessage(params: { text: string; buttons?: unknown[] }): Promise<void>;
    editButtons(params: { buttons: unknown[] }): Promise<void>;
    clearButtons(): Promise<void>;
    deleteMessage(): Promise<void>;
  };
}

interface CallbackStudyStore {
  transition(
    operationId: string,
    blockId: string,
    action: StudyTransitionAction,
    now: Date,
  ): { block: StudyBlock };
  get(blockId: string): StudyBlock | undefined;
  close(): void;
}

export interface StudyInteractiveDependencies {
  openStore?: (config: AssistantToolConfig) => CallbackStudyStore;
  now?: () => Date;
}

export function registerStudyInteractiveHandler(
  api: OpenClawPluginApi,
  dependencies: StudyInteractiveDependencies = {},
): void {
  api.registerInteractiveHandler({
    channel: 'telegram',
    namespace: 'ocstudy',
    handler: async rawContext => handleStudyCallback(
      api,
      rawContext as TelegramStudyContext,
      dependencies,
    ),
  });
}

async function handleStudyCallback(
  api: OpenClawPluginApi,
  context: TelegramStudyContext,
  dependencies: StudyInteractiveDependencies,
): Promise<{ handled: true }> {
  let config: AssistantToolConfig;
  try {
    config = loadConfigFromApi(api);
    assertOwner({ requesterSenderId: context.senderId }, config);
    if (!context.auth.isAuthorizedSender
      || context.isGroup
      || context.isForum
      || context.threadId !== undefined
      || context.conversationId !== config.telegramUserId
      || context.callback.chatId !== config.telegramUserId
      || context.callback.namespace !== 'ocstudy') {
      throw new Error('unauthorized callback');
    }
  } catch {
    await context.respond.clearButtons().catch(() => undefined);
    return { handled: true };
  }

  const match = /^(done|snooze|skip):(B-\d{8}-\d{3})$/u.exec(context.callback.payload);
  if (!match) {
    await context.respond.clearButtons().catch(() => undefined);
    return { handled: true };
  }
  const action: StudyTransitionAction = match[1] === 'snooze'
    ? { type: 'snooze' }
    : { type: match[1] as 'done' | 'skip' };
  const operationId = `telegram-callback-${createHash('sha256')
    .update(context.callbackId, 'utf8').digest('hex').slice(0, 40)}`;
  const store = (dependencies.openStore ?? openStore)(config);
  try {
    let block: StudyBlock | undefined;
    try {
      block = store.transition(
        operationId,
        match[2]!,
        action,
        (dependencies.now ?? (() => new Date()))(),
      ).block;
      notifyStudyScheduleChanged();
    } catch (error) {
      if ((error as { code?: unknown }).code === 'invalid_study_transition') {
        block = store.get(match[2]!);
      } else {
        throw error;
      }
    }
    await context.respond.editMessage({
      text: block
        ? `${block.title}\n상태: ${statusLabel(block.status)}\n${block.id}`
        : '이 공부 블록은 더 이상 존재하지 않습니다.',
    });
  } catch {
    await context.respond.editMessage({ text: '공부 상태를 변경하지 못했습니다. /study status로 확인해 주세요.' })
      .catch(() => undefined);
  } finally {
    await context.respond.clearButtons().catch(() => undefined);
    store.close();
  }
  return { handled: true };
}

function statusLabel(status: StudyBlock['status']): string {
  return ({
    planned: '예정', active: '진행 중', snoozed: '미룸', completed: '완료',
    skipped: '건너뜀', missed: '미응답',
  } as const)[status];
}

function openStore(config: AssistantToolConfig): CallbackStudyStore {
  return new StudyStore(config.stateDir);
}
