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
      PRAGMA user_version = 2;
      CREATE TABLE subsystem_health (target TEXT PRIMARY KEY, unexpected TEXT) STRICT;
    `);
    database.close();
    expect(() => new SubsystemHealthStore(stateDir)).toThrowError(expect.objectContaining({
      code: 'health_schema_mismatch',
    }));
  });

  it('fails closed when version-correct health SQL omits checks and the active index', async () => {
    const stateDir = await stateDirectory();
    const database = new DatabaseSync(join(stateDir, 'subsystem-health.sqlite3'));
    database.exec(`
      CREATE TABLE subsystem_health (
        target TEXT PRIMARY KEY,
        error_code TEXT NOT NULL,
        message TEXT NOT NULL,
        active INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      PRAGMA user_version = 2;
    `);
    database.close();
    expect(() => new SubsystemHealthStore(stateDir)).toThrowError(expect.objectContaining({
      code: 'health_schema_mismatch',
    }));
  });

  it('fails closed on unexpected executable health schema objects', async () => {
    const stateDir = await stateDirectory();
    const store = new SubsystemHealthStore(stateDir);
    store.close();
    const database = new DatabaseSync(join(stateDir, 'subsystem-health.sqlite3'));
    database.exec(`
      CREATE TRIGGER unexpected_health_trigger AFTER UPDATE ON subsystem_health
      BEGIN
        SELECT 1;
      END;
    `);
    database.close();
    expect(() => new SubsystemHealthStore(stateDir)).toThrowError(expect.objectContaining({
      code: 'health_schema_mismatch',
    }));
  });

  it('migrates the exact v1 health table and preserves active errors', async () => {
    const stateDir = await stateDirectory();
    const database = new DatabaseSync(join(stateDir, 'subsystem-health.sqlite3'));
    database.exec(`
      CREATE TABLE subsystem_health (
        target TEXT PRIMARY KEY CHECK(length(target) > 0),
        error_code TEXT NOT NULL CHECK(length(error_code) > 0),
        message TEXT NOT NULL CHECK(length(message) > 0),
        active INTEGER NOT NULL CHECK(active IN (0, 1)),
        updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO subsystem_health VALUES ('daily-backup', 'backup_failed', 'Backup unavailable', 1, 1000);
      PRAGMA user_version = 1;
    `);
    database.close();

    const migrated = new SubsystemHealthStore(stateDir);
    expect(migrated.listActive()).toEqual([{
      errorCode: 'backup_failed', target: 'daily-backup', message: 'Backup unavailable',
    }]);
    migrated.close();
    const inspected = new DatabaseSync(join(stateDir, 'subsystem-health.sqlite3'));
    expect((inspected.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2);
    expect(inspected.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'health_active_idx'").get())
      .toBeDefined();
    inspected.close();
  });
});
