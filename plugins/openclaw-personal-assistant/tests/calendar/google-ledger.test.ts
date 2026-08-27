import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { GoogleCalendarLedger } from '../../src/calendar/google-ledger.js';

const first = {
  requestId: '12345678-1234-4234-8234-1234567890ab',
  action: 'create' as const,
  eventId: 'oc123456781234423482341234567890ab',
  payloadHash: 'a'.repeat(64),
};

describe('Google calendar mutation ledger', () => {
  it('replays the same claim and rejects a changed payload for one request ID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'google-ledger-'));
    const ledger = new GoogleCalendarLedger(join(root, 'ledger.sqlite3'), {
      now: () => Date.parse('2026-08-27T00:00:00.000Z'),
    });
    try {
      expect(ledger.claim(first)).toMatchObject({ ...first, status: 'pending' });
      expect(ledger.claim(first)).toMatchObject({ ...first, status: 'pending' });
      expect(() => ledger.claim({ ...first, payloadHash: 'b'.repeat(64) }))
        .toThrowError(/idempotency conflict/i);
      expect(() => ledger.claim({ ...first, action: 'delete', payloadHash: 'a'.repeat(64) }))
        .toThrowError(/idempotency conflict/i);
    } finally { ledger.close(); }
  });

  it('permits only durable submitting and terminal transitions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'google-ledger-state-'));
    const ledger = new GoogleCalendarLedger(join(root, 'ledger.sqlite3'), {
      now: () => Date.parse('2026-08-27T00:00:00.000Z'),
    });
    try {
      ledger.claim({ ...first, etag: '"etag-1"' });
      expect(ledger.markSubmitting(first.requestId)).toMatchObject({ status: 'submitting', attempts: 1 });
      expect(ledger.finish(first.requestId, {
        status: 'succeeded', resultEtag: '"etag-2"', errorCode: null,
      })).toMatchObject({ status: 'succeeded', resultEtag: '"etag-2"', errorCode: null });
      expect(() => ledger.markSubmitting(first.requestId)).toThrowError(/terminal/i);
      expect(ledger.get(first.requestId)).toMatchObject({ status: 'succeeded', attempts: 1 });
    } finally { ledger.close(); }
  });

  it('stores metadata only and no event body or OAuth secret columns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'google-ledger-schema-'));
    const path = join(root, 'ledger.sqlite3');
    const ledger = new GoogleCalendarLedger(path);
    ledger.claim(first);
    ledger.close();
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const columns = database.prepare('PRAGMA table_info(google_calendar_mutations)').all()
        .map(row => (row as { name: string }).name);
      expect(columns).toEqual([
        'request_id', 'action', 'event_id', 'etag', 'payload_hash', 'status', 'attempts',
        'result_etag', 'error_code', 'created_at', 'updated_at',
      ]);
      expect(columns).not.toEqual(expect.arrayContaining(['summary', 'description', 'access_token', 'refresh_token']));
    } finally { database.close(); }
  });
});
