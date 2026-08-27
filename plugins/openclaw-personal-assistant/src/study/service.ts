import { sendDurableMessageBatch } from 'openclaw/plugin-sdk/channel-message-runtime';
import type { OpenClawPluginApi, OpenClawPluginService } from 'openclaw/plugin-sdk/plugin-entry';
import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';

import { SubsystemHealthStore, type SubsystemHealthJournal } from '../state/health.js';
import { loadConfigFromApi, type AssistantToolConfig } from '../tools/trust.js';
import { addCivilDays, studyDayKey } from './clock.js';
import { buildStudyReminder, buildStudyReport } from './delivery.js';
import { subscribeStudyScheduleChanged } from './signal.js';
import { StudyStore } from './store.js';
import type { StudyDayStatus, StudyDueAction, StudySettings } from './types.js';

const MAX_WAIT_MS = 60 * 60_000;
const FAILURE_RETRY_MS = 5 * 60_000;

interface StudyServiceStore {
  recover(now: Date): { missed: number };
  nextDue(now: Date): StudyDueAction | null;
  consumeDue(now: Date): StudyDueAction | null;
  current(now: Date): StudyDayStatus;
  settings(): StudySettings;
  isReportDelivered(dayKey: string, kind: 'interim' | 'final'): boolean;
  markReportDelivered(dayKey: string, kind: 'interim' | 'final', at: Date): void;
  close(): void;
}

type DurableParams = Parameters<typeof sendDurableMessageBatch>[0];
type DurableResult = Awaited<ReturnType<typeof sendDurableMessageBatch>>;

export interface StudyCoachDependencies {
  now?: () => Date;
  openStore?: (config: AssistantToolConfig) => StudyServiceStore;
  openHealth?: (config: AssistantToolConfig) => SubsystemHealthJournal;
  send?: (params: DurableParams) => Promise<DurableResult>;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}

type ReportDue = { type: 'report'; kind: 'interim' | 'final'; dayKey: string; dueAt: string };
type BlockDue = { type: 'block'; action: StudyDueAction };
type DueItem = ReportDue | BlockDue;

export function createStudyCoachService(
  api: OpenClawPluginApi,
  dependencies: StudyCoachDependencies = {},
): OpenClawPluginService {
  const now = dependencies.now ?? (() => new Date());
  const schedule = dependencies.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = dependencies.cancel ?? (handle => clearTimeout(handle as NodeJS.Timeout));
  let stopped = true;
  let config: AssistantToolConfig | undefined;
  let store: StudyServiceStore | undefined;
  let health: SubsystemHealthJournal | undefined;
  let timer: unknown;
  let cycle: Promise<void> | undefined;
  let retryAt: number | undefined;
  let rescheduleRequested = false;
  let unsubscribe: (() => void) | undefined;

  const safeReportFailure = () => {
    try {
      health?.report({
        target: 'study-delivery', errorCode: 'study_delivery_failed',
        message: 'Study reminder delivery is unavailable',
      });
    } catch { /* delivery remains isolated from health journal failures */ }
  };

  const delivered = async (payload: ReplyPayload): Promise<boolean> => {
    try {
      const result = await (dependencies.send ?? sendDurableMessageBatch)({
        cfg: api.config,
        channel: 'telegram',
        to: config!.telegramUserId,
        payloads: [payload],
        durability: 'required',
      });
      const success = result.status === 'sent'
        || result.payloadOutcomes?.some(outcome => outcome.index === 0 && outcome.status === 'sent') === true;
      if (!success) safeReportFailure();
      return success;
    } catch {
      safeReportFailure();
      return false;
    }
  };

  const reportDue = (at: Date): ReportDue | null => {
    const dayKey = studyDayKey(at);
    const candidates: ReportDue[] = [
      { type: 'report', kind: 'interim', dayKey, dueAt: `${dayKey}T22:00:00+09:00` },
      { type: 'report', kind: 'final', dayKey, dueAt: `${addCivilDays(dayKey, 1)}T02:00:00+09:00` },
    ];
    const priorDayKey = addCivilDays(dayKey, -1);
    const priorFinal: ReportDue = {
      type: 'report', kind: 'final', dayKey: priorDayKey, dueAt: `${dayKey}T02:00:00+09:00`,
    };
    const priorAge = at.getTime() - new Date(priorFinal.dueAt).getTime();
    if (priorAge >= 0 && priorAge <= 6 * 60 * 60_000) candidates.push(priorFinal);
    return candidates
      .filter(candidate => !store!.isReportDelivered(candidate.dayKey, candidate.kind))
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt))[0] ?? null;
  };

  const nextItem = (at: Date): DueItem | null => {
    const block = store!.nextDue(at);
    const report = reportDue(at);
    if (!block) return report;
    if (!report || block.dueAt.localeCompare(report.dueAt) <= 0) return { type: 'block', action: block };
    return report;
  };

  const arm = (delayMs: number) => {
    if (stopped) return;
    if (timer !== undefined) cancel(timer);
    timer = schedule(() => {
      timer = undefined;
      if (stopped || cycle) return;
      cycle = runCycle().finally(() => {
        cycle = undefined;
        if (rescheduleRequested && !stopped) {
          rescheduleRequested = false;
          arm(0);
        }
      });
    }, Math.max(0, Math.min(delayMs, MAX_WAIT_MS)));
  };

  const queueNext = (at: Date) => {
    if (retryAt !== undefined) {
      arm(retryAt - at.getTime());
      return;
    }
    const item = nextItem(at);
    if (!item) { arm(MAX_WAIT_MS); return; }
    const dueAt = item.type === 'block' ? item.action.dueAt : item.dueAt;
    arm(new Date(dueAt).getTime() - at.getTime());
  };

  const runCycle = async () => {
    if (stopped || !store) return;
    const at = now();
    store.recover(at);
    if (retryAt !== undefined && at.getTime() < retryAt) { queueNext(at); return; }
    retryAt = undefined;
    const item = nextItem(at);
    if (!item) { queueNext(at); return; }
    const dueAt = item.type === 'block' ? item.action.dueAt : item.dueAt;
    if (new Date(dueAt).getTime() > at.getTime()) { queueNext(at); return; }

    if (item.type === 'block') {
      if (item.action.kind === 'missed') {
        store.consumeDue(at);
      } else if (await delivered(buildStudyReminder(item.action.block, item.action.kind))) {
        store.consumeDue(at);
        try { health?.recover('study-delivery'); } catch { /* isolated */ }
      } else {
        const reminderExpiry = new Date(item.action.dueAt).getTime()
          + store.settings().followUpMinutes * 60_000;
        retryAt = Math.min(at.getTime() + FAILURE_RETRY_MS, reminderExpiry + 1_000);
      }
    } else {
      const reportStatusAt = item.kind === 'final'
        ? new Date(new Date(item.dueAt).getTime() - 1_000)
        : at;
      if (await delivered(buildStudyReport(store.current(reportStatusAt), item.kind))) {
        store.markReportDelivered(item.dayKey, item.kind, at);
        try { health?.recover('study-delivery'); } catch { /* isolated */ }
      } else {
        retryAt = at.getTime() + FAILURE_RETRY_MS;
      }
    }
    queueNext(at);
  };

  return {
    id: 'openclaw-personal-assistant-study-coach',
    async start() {
      if (!stopped) return;
      stopped = false;
      try {
        config = loadConfigFromApi(api);
        store = (dependencies.openStore ?? (scoped => new StudyStore(scoped.stateDir)))(config);
        health = (dependencies.openHealth ?? (scoped => new SubsystemHealthStore(scoped.stateDir)))(config);
        unsubscribe = subscribeStudyScheduleChanged(() => {
          if (stopped) return;
          retryAt = undefined;
          if (cycle) { rescheduleRequested = true; return; }
          arm(0);
        });
        cycle = runCycle();
        await cycle;
        cycle = undefined;
      } catch {
        safeReportFailure();
        unsubscribe?.();
        unsubscribe = undefined;
        try { store?.close(); } catch { /* startup cleanup */ }
        try { health?.close(); } catch { /* startup cleanup */ }
        store = undefined;
        health = undefined;
        cycle = undefined;
        stopped = true;
      }
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) { cancel(timer); timer = undefined; }
      unsubscribe?.();
      unsubscribe = undefined;
      await cycle;
      cycle = undefined;
      store?.close();
      health?.close();
      store = undefined;
      health = undefined;
      retryAt = undefined;
      rescheduleRequested = false;
    },
  };
}
