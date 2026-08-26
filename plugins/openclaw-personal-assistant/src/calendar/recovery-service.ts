import type { OpenClawPluginApi, OpenClawPluginService } from 'openclaw/plugin-sdk/plugin-entry';

import { CalDavClient } from './caldav.js';
import { CalendarOutbox, type CalendarOutboxWarning } from './outbox.js';
import { SubsystemHealthStore, type SubsystemHealthJournal } from '../state/health.js';
import {
  loadConfigFromApi, requireCalendarReadConfig, type AssistantToolConfig,
} from '../tools/trust.js';

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAX_PER_CYCLE = 20;
const MAX_INTERVAL_MS = 60 * 60_000;

interface RecoveryOutbox {
  recover(): Promise<unknown[]>;
  pendingReconcileIds(limit: number): string[];
  reconcile(requestId: string): Promise<Array<{ requestId: string; status: string }>>;
  close(): void;
}

export interface CalendarRecoveryDependencies {
  intervalMs?: number;
  maxPerCycle?: number;
  openHealth?: (config: AssistantToolConfig) => SubsystemHealthJournal;
  openOutbox?: (
    config: AssistantToolConfig,
    warn: (warning: CalendarOutboxWarning) => void | Promise<void>,
  ) => RecoveryOutbox;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export function createCalendarRecoveryService(
  api: OpenClawPluginApi,
  dependencies: CalendarRecoveryDependencies = {},
): OpenClawPluginService {
  const intervalMs = boundedPositive(dependencies.intervalMs ?? DEFAULT_INTERVAL_MS, 'intervalMs', MAX_INTERVAL_MS);
  const maxPerCycle = boundedPositive(dependencies.maxPerCycle ?? DEFAULT_MAX_PER_CYCLE, 'maxPerCycle', 100);
  const schedule = dependencies.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = dependencies.cancel ?? (handle => clearTimeout(handle as NodeJS.Timeout));
  let stopped = true;
  let outbox: RecoveryOutbox | undefined;
  let health: SubsystemHealthJournal | undefined;
  let timer: unknown;
  let cycle: Promise<void> | undefined;
  let consecutiveFailures = 0;

  const requestTarget = (requestId: string) => `calendar-reconcile:${requestId}`;
  const safeReport = (entry: Parameters<SubsystemHealthJournal['report']>[0]) => {
    try { health?.report(entry); } catch { /* keep recovery isolated from health failures */ }
  };
  const reportWarning = (warning: CalendarOutboxWarning) => {
    safeReport({
      target: requestTarget(warning.requestId),
      errorCode: warning.reason,
      message: 'Calendar reconciliation requires owner attention',
    });
  };

  const runCycle = async () => {
    await outbox!.recover();
    const requestIds = outbox!.pendingReconcileIds(maxPerCycle);
    for (const requestId of requestIds) {
      try {
        const [result] = await outbox!.reconcile(requestId);
        if (result?.status === 'succeeded') health!.recover(requestTarget(requestId));
      } catch {
        safeReport({
          target: requestTarget(requestId),
          errorCode: 'recovery_cycle_failed',
          message: 'Calendar reconciliation requires owner attention',
        });
      }
    }
    health!.recover('calendar-recovery');
  };

  const queueNext = () => {
    if (stopped) return;
    const multiplier = Math.min(2 ** consecutiveFailures, 12);
    const delay = Math.min(intervalMs * multiplier, MAX_INTERVAL_MS);
    timer = schedule(() => {
      timer = undefined;
      if (stopped || cycle) return;
      cycle = runCycle().then(() => { consecutiveFailures = 0; }, () => {
        consecutiveFailures += 1;
        safeReport({
          target: 'calendar-recovery', errorCode: 'recovery_cycle_failed',
          message: 'Calendar recovery service is unavailable',
        });
      }).finally(() => {
        cycle = undefined;
        queueNext();
      });
    }, delay);
  };

  return {
    id: 'openclaw-personal-assistant-calendar-recovery',
    async start() {
      if (!stopped) return;
      stopped = false;
      let config: AssistantToolConfig;
      try {
        config = loadConfigFromApi(api);
        health = (dependencies.openHealth ?? (scoped => new SubsystemHealthStore(scoped.stateDir)))(config);
        outbox = (dependencies.openOutbox ?? openRecoveryOutbox)(config, reportWarning);
        cycle = runCycle();
        await cycle;
        cycle = undefined;
        queueNext();
      } catch {
        safeReport({
          target: 'calendar-recovery', errorCode: 'recovery_start_failed',
          message: 'Calendar recovery service is unavailable',
        });
        try { outbox?.close(); } catch { /* startup remains isolated */ }
        try { health?.close(); } catch { /* startup remains isolated */ }
        outbox = undefined;
        health = undefined;
        cycle = undefined;
        stopped = true;
      }
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) {
        cancel(timer);
        timer = undefined;
      }
      await cycle;
      cycle = undefined;
      outbox?.close();
      health?.close();
      outbox = undefined;
      health = undefined;
    },
  };
}

function openRecoveryOutbox(
  config: AssistantToolConfig,
  warn: (warning: CalendarOutboxWarning) => void | Promise<void>,
): CalendarOutbox {
  const calendar = requireCalendarReadConfig(config);
  const caldav = new CalDavClient({
    baseUrl: calendar.caldavBaseUrl,
    secretFile: calendar.caldavSecretFile,
    calendarMappings: calendar.calendarMappings,
  });
  return new CalendarOutbox({
    stateDir: config.stateDir,
    api: { async createSchedule() { throw new Error('calendar_recovery_write_forbidden'); } },
    caldav: { listEvents: range => caldav.listMappedEvents(range) },
    warn,
  });
}

function boundedPositive(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} is outside the supported range`);
  }
  return value;
}
