/// <reference types="node" />

import { chmodSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface CoordinatorDatabase {
  exec(sql: string): void;
  close(): void;
}

export interface CoordinatedAcquisition<T> {
  value: T;
  cleanup: () => Promise<void>;
}

interface WorkspaceLockCoordinatorOptions {
  openDatabase?: (path: string) => CoordinatorDatabase;
}

const LOCAL_COORDINATOR_TAILS = new Map<string, Promise<void>>();

function canonicalNativePath(path: string): string {
  const absolute = normalize(isAbsolute(path) ? path : resolve(path));
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

async function withLocalCoordinator<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = LOCAL_COORDINATOR_TAILS.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  const tail = previous.then(() => gate);
  LOCAL_COORDINATOR_TAILS.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (LOCAL_COORDINATOR_TAILS.get(key) === tail) LOCAL_COORDINATOR_TAILS.delete(key);
  }
}

function isSqliteBusy(error: unknown): boolean {
  const sqlite = error as { code?: string; errcode?: number; message?: string };
  return sqlite.errcode === 5
    || (sqlite.code === 'ERR_SQLITE_ERROR' && /busy|locked/i.test(sqlite.message ?? ''));
}

function failure(errors: unknown[], message: string): unknown {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, message);
}

/**
 * Serializes inspection and replacement of the filesystem workspace lock.
 * The database contains no durable application data; its transaction exists
 * only to make stale-lock recovery and lock creation one cross-process decision.
 */
export class WorkspaceLockCoordinator {
  private readonly databasePath: string;
  private readonly gateKey: string;
  private readonly openDatabase: (path: string) => CoordinatorDatabase;

  constructor(stateDir: string, options: WorkspaceLockCoordinatorOptions = {}) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const canonicalStateDir = realpathSync.native(stateDir);
    this.databasePath = join(canonicalStateDir, 'workspace-lock-coordinator.sqlite3');
    this.gateKey = canonicalNativePath(this.databasePath);
    this.openDatabase = options.openDatabase ?? (path => new DatabaseSync(path));
  }

  async attempt<T>(
    deadline: number,
    acquire: () => Promise<CoordinatedAcquisition<T> | undefined>,
  ): Promise<T | undefined> {
    return withLocalCoordinator(this.gateKey, async () => {
      if (deadline - Date.now() <= 0) return undefined;

      let database: CoordinatorDatabase | undefined;
      let transactionOpen = false;
      let acquired: CoordinatedAcquisition<T> | undefined;
      let primaryError: unknown;
      let deadlineExpired = false;
      const lifecycleErrors: unknown[] = [];

      try {
        database = this.openDatabase(this.databasePath);
        if (existsSync(this.databasePath)) chmodSync(this.databasePath, 0o600);
        database.exec(`PRAGMA busy_timeout = ${Math.max(1, deadline - Date.now())};`);
        database.exec(`
          CREATE TABLE IF NOT EXISTS lock_coordination (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
          ) STRICT;
        `);
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          deadlineExpired = true;
        } else {
          database.exec(`PRAGMA busy_timeout = ${remaining};`);
          database.exec('BEGIN IMMEDIATE;');
          transactionOpen = true;
          acquired = await acquire();
          database.exec('COMMIT;');
          transactionOpen = false;
        }
      } catch (error) {
        primaryError = error;
      }

      if (transactionOpen && database !== undefined) {
        try {
          database.exec('ROLLBACK;');
          transactionOpen = false;
        } catch (error) {
          lifecycleErrors.push(error);
        }
      }
      if (database !== undefined) {
        try {
          database.close();
        } catch (error) {
          lifecycleErrors.push(error);
        }
      }

      const unsuccessful = primaryError !== undefined || lifecycleErrors.length > 0;
      if (unsuccessful && acquired !== undefined) {
        try {
          await acquired.cleanup();
        } catch (error) {
          lifecycleErrors.push(error);
        }
      }

      if (primaryError !== undefined) {
        if (isSqliteBusy(primaryError) && acquired === undefined && lifecycleErrors.length === 0) {
          return undefined;
        }
        throw failure(
          [primaryError, ...lifecycleErrors],
          'workspace lock coordinator and cleanup failed',
        );
      }
      if (lifecycleErrors.length > 0) {
        throw failure(lifecycleErrors, 'workspace lock coordinator cleanup failed');
      }
      if (deadlineExpired) return undefined;
      return acquired?.value;
    });
  }
}
