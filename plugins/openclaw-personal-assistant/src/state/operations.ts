/// <reference types="node" />

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type OperationPhase = 'begun' | 'applied' | 'committed' | 'replied';

export interface LedgerOperation<TResult = unknown> {
  operationId: string;
  senderId: string;
  payloadHash: string;
  phase: OperationPhase;
  result?: TResult;
  createdAt: string;
  updatedAt: string;
}

export class OperationLedgerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OperationLedgerError';
  }
}

interface OperationRow {
  operation_id: string;
  sender_id: string;
  payload_hash: string;
  phase: OperationPhase;
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

interface OperationLedgerOptions {
  checkpoint?: (phase: 'beforeReply') => void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('begun','applied','committed','replied')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
`;

export const OPERATION_SCHEMA_VERSION = 0;
export const OPERATION_SCHEMA_FINGERPRINT = createHash('sha256')
  .update(normalizeSchemaSql(SCHEMA)).digest('hex');

export function validateOperationBackupDatabase(path: string): {
  userVersion: number;
  schemaFingerprint: string;
} {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const version = Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    const rows = database.prepare(`
      SELECT type, name, sql FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ type: string; name: string; sql: string }>;
    const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown };
    if (version !== OPERATION_SCHEMA_VERSION || rows.length !== 1
      || rows[0]?.type !== 'table' || rows[0]?.name !== 'operations'
      || normalizeSchemaSql(rows[0].sql) !== normalizeSchemaSql(SCHEMA)
      || integrity.integrity_check !== 'ok') {
      throw new OperationLedgerError('operation_schema_mismatch', 'Operation backup schema is incompatible');
    }
    return { userVersion: version, schemaFingerprint: OPERATION_SCHEMA_FINGERPRINT };
  } finally { database.close(); }
}

function normalizeSchemaSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim().toLowerCase()
    .replace(/^create table if not exists /, 'create table ');
}

function parseRow<TResult>(row: OperationRow | undefined): LedgerOperation<TResult> | undefined {
  if (!row) return undefined;
  return {
    operationId: row.operation_id,
    senderId: row.sender_id,
    payloadHash: row.payload_hash,
    phase: row.phase,
    ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as TResult }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class OperationLedger {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(
    stateDir: string,
    private readonly options: OperationLedgerOptions = {},
  ) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const databasePath = join(stateDir, 'operations.sqlite3');
    this.database = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.database.exec('PRAGMA busy_timeout = 10000;');
    this.database.exec(SCHEMA);
  }

  begin(operationId: string, senderId: string, payloadHash: string): LedgerOperation {
    const existing = this.get(operationId);
    if (existing) {
      if (existing.senderId !== senderId || existing.payloadHash !== payloadHash) {
        throw new OperationLedgerError(
          'operation_id_conflict',
          `operation ${operationId} was already used for a different request`,
        );
      }
      return existing;
    }

    const now = new Date().toISOString();
    try {
      this.database.prepare(`
        INSERT INTO operations (
          operation_id, sender_id, payload_hash, phase, result_json, created_at, updated_at
        ) VALUES (?, ?, ?, 'begun', NULL, ?, ?)
      `).run(operationId, senderId, payloadHash, now, now);
    } catch (error) {
      const raced = this.get(operationId);
      if (raced && raced.senderId === senderId && raced.payloadHash === payloadHash) return raced;
      throw error;
    }
    return this.get(operationId)!;
  }

  get<TResult = unknown>(operationId: string): LedgerOperation<TResult> | undefined {
    const row = this.database.prepare(`
      SELECT operation_id, sender_id, payload_hash, phase, result_json, created_at, updated_at
      FROM operations WHERE operation_id = ?
    `).get(operationId) as unknown as OperationRow | undefined;
    return parseRow<TResult>(row);
  }

  /** Stores deterministic mutation metadata while an operation remains resumable as begun. */
  setPreparedResult(operationId: string, result: unknown): void {
    this.transition(operationId, ['begun'], 'begun', result);
  }

  markApplied(operationId: string, result: unknown): void {
    this.transition(operationId, ['begun', 'applied'], 'applied', result);
  }

  markCommitted(operationId: string, result: unknown): void {
    this.transition(operationId, ['applied', 'committed'], 'committed', result);
  }

  markReplied(operationId: string): void {
    this.options.checkpoint?.('beforeReply');
    const operation = this.require(operationId);
    this.transition(operationId, ['committed', 'replied'], 'replied', operation.result);
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  private require(operationId: string): LedgerOperation {
    const operation = this.get(operationId);
    if (!operation) {
      throw new OperationLedgerError('operation_not_found', `operation ${operationId} does not exist`);
    }
    return operation;
  }

  private transition(
    operationId: string,
    allowed: readonly OperationPhase[],
    next: OperationPhase,
    result: unknown,
  ): void {
    const operation = this.require(operationId);
    if (!allowed.includes(operation.phase)) {
      throw new OperationLedgerError(
        'invalid_operation_phase',
        `cannot move operation ${operationId} from ${operation.phase} to ${next}`,
      );
    }
    const updatedAt = new Date().toISOString();
    this.database.prepare(`
      UPDATE operations SET phase = ?, result_json = ?, updated_at = ? WHERE operation_id = ?
    `).run(next, JSON.stringify(result), updatedAt, operationId);
  }
}
