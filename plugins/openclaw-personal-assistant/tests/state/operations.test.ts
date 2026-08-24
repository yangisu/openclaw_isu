import { mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { OperationLedger } from '../../src/state/operations.js';

const ledgers: OperationLedger[] = [];

afterEach(() => {
  while (ledgers.length > 0) ledgers.pop()?.close();
});

async function openLedger(
  checkpoint?: (phase: 'beforeReply') => void,
): Promise<{ ledger: OperationLedger; stateDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-ledger-'));
  const stateDir = join(root, 'state');
  await mkdir(stateDir);
  const ledger = new OperationLedger(stateDir, { checkpoint });
  ledgers.push(ledger);
  return { ledger, stateDir };
}

describe('OperationLedger', () => {
  it('creates the exact operations table as a STRICT table', async () => {
    const { ledger, stateDir } = await openLedger();
    ledger.close();
    ledgers.pop();

    const database = new DatabaseSync(join(stateDir, 'operations.sqlite3'), { readOnly: true });
    const table = database.prepare(`
      SELECT sqlite_master.sql, pragma_table_list.strict
      FROM sqlite_master JOIN pragma_table_list ON pragma_table_list.name = sqlite_master.name
      WHERE sqlite_master.name = 'operations'
    `).get() as { sql: string; strict: number };
    database.close();

    expect(table.strict).toBe(1);
    expect(table.sql).toContain("CHECK (phase IN ('begun','applied','committed','replied'))");
    expect(table.sql).toContain('operation_id TEXT PRIMARY KEY');
    expect(table.sql).toContain('payload_hash TEXT NOT NULL');
  });

  it('persists every phase and its result across restart', async () => {
    const { ledger, stateDir } = await openLedger();
    expect(ledger.begin('op-1', '42', 'hash-1').phase).toBe('begun');
    const result = { operationId: 'op-1', id: 'T-20260825-001', replayed: false };
    ledger.markApplied('op-1', result);
    ledger.markCommitted('op-1', { ...result, gitCommit: 'abc123' });
    ledger.close();
    ledgers.pop();

    const restarted = new OperationLedger(stateDir);
    ledgers.push(restarted);
    expect(restarted.get('op-1')).toMatchObject({
      operationId: 'op-1',
      senderId: '42',
      payloadHash: 'hash-1',
      phase: 'committed',
      result: { id: 'T-20260825-001', gitCommit: 'abc123' },
    });
    restarted.markReplied('op-1');
    expect(restarted.get('op-1')?.phase).toBe('replied');
  });

  it('rejects reuse of an operation ID for a different sender or payload', async () => {
    const { ledger } = await openLedger();
    ledger.begin('op-1', '42', 'hash-1');

    expect(() => ledger.begin('op-1', '99', 'hash-1')).toThrowError(
      expect.objectContaining({ code: 'operation_id_conflict' }),
    );
    expect(() => ledger.begin('op-1', '42', 'hash-2')).toThrowError(
      expect.objectContaining({ code: 'operation_id_conflict' }),
    );
  });

  it('does not mark a reply when interrupted before reply and can retry it', async () => {
    let interrupt = true;
    const { ledger, stateDir } = await openLedger(phase => {
      if (phase === 'beforeReply' && interrupt) throw new Error('crash:beforeReply');
    });
    ledger.begin('op-1', '42', 'hash-1');
    ledger.markApplied('op-1', { id: 'T-20260825-001' });
    ledger.markCommitted('op-1', { id: 'T-20260825-001', gitCommit: 'abc123' });

    expect(() => ledger.markReplied('op-1')).toThrow('crash:beforeReply');
    expect(ledger.get('op-1')?.phase).toBe('committed');
    ledger.close();
    ledgers.pop();

    interrupt = false;
    const restarted = new OperationLedger(stateDir);
    ledgers.push(restarted);
    restarted.markReplied('op-1');
    expect(restarted.get('op-1')?.phase).toBe('replied');
  });

  it('stores owner-only database files', async () => {
    const { stateDir } = await openLedger();
    const databasePath = join(stateDir, 'operations.sqlite3');
    expect((await readFile(databasePath)).byteLength).toBeGreaterThan(0);
    if (process.platform !== 'win32') {
      expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    }
  });
});
