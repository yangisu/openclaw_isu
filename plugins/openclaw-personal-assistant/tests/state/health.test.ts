import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { SubsystemHealthStore } from '../../src/state/health.js';

const directories: string[] = [];

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-health-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('durable subsystem health', () => {
  it('persists an active error and clears it only on explicit recovery', async () => {
    const stateDir = await stateDirectory();
    let store = new SubsystemHealthStore(stateDir, { now: () => 1_000 });
    store.report({ errorCode: 'backup_failed', target: 'daily-backup', message: 'Backup unavailable' });
    store.close();

    store = new SubsystemHealthStore(stateDir, { now: () => 2_000 });
    expect(store.listActive()).toEqual([{
      errorCode: 'backup_failed', target: 'daily-backup', message: 'Backup unavailable',
    }]);
    store.recover('daily-backup');
    expect(store.listActive()).toEqual([]);
    store.close();
  });

  it('fails closed on an unknown health schema version', async () => {
    const stateDir = await stateDirectory();
    const database = new DatabaseSync(join(stateDir, 'subsystem-health.sqlite3'));
    database.exec('PRAGMA user_version = 77');
    database.close();
    expect(() => new SubsystemHealthStore(stateDir)).toThrowError(expect.objectContaining({
      code: 'health_schema_mismatch',
    }));
  });

  it('fails closed when a known-version table shape is incompatible', async () => {
    const stateDir = await stateDirectory();
    const database = new DatabaseSync(join(stateDir, 'subsystem-health.sqlite3'));
    database.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE subsystem_health (target TEXT PRIMARY KEY, unexpected TEXT) STRICT;
    `);
    database.close();
    expect(() => new SubsystemHealthStore(stateDir)).toThrowError(expect.objectContaining({
      code: 'health_schema_mismatch',
    }));
  });
});
