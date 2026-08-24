import { mkdtemp, open, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  WorkspaceLockCoordinator,
  type CoordinatorDatabase,
} from '../../src/workspace/lock-coordinator.js';

class InjectedDatabase implements CoordinatorDatabase {
  private transaction = false;

  constructor(
    private readonly failure: 'commit' | 'close' | undefined,
  ) {}

  exec(sql: string): void {
    if (sql === 'BEGIN IMMEDIATE;') this.transaction = true;
    if (sql === 'COMMIT;') {
      this.transaction = false;
      if (this.failure === 'commit') throw new Error('injected coordinator commit failure');
    }
    if (sql === 'ROLLBACK;') this.transaction = false;
  }

  close(): void {
    if (this.failure === 'close') throw new Error('injected coordinator close failure');
  }
}

async function realFileAcquisition(path: string) {
  const handle = await open(path, 'wx', 0o600);
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await handle.close();
    await unlink(path);
  };
  return { value: { release }, cleanup: release };
}

describe('WorkspaceLockCoordinator failure cleanup', () => {
  it.each(['commit', 'close'] as const)(
    'removes an acquired main lock after an injected %s failure and permits the next attempt',
    async failure => {
      const stateDir = await mkdtemp(join(tmpdir(), 'assistant-coordinator-'));
      const lockPath = join(stateDir, '.assistant.lock');
      let attempts = 0;
      const coordinator = new WorkspaceLockCoordinator(stateDir, {
        openDatabase: () => new InjectedDatabase(attempts++ === 0 ? failure : undefined),
      });

      await expect(coordinator.attempt(
        Date.now() + 10_000,
        () => realFileAcquisition(lockPath),
      )).rejects.toThrow(`injected coordinator ${failure} failure`);

      const acquired = await coordinator.attempt(
        Date.now() + 10_000,
        () => realFileAcquisition(lockPath),
      );
      expect(acquired).toBeDefined();
      await acquired!.release();
    },
  );
});
