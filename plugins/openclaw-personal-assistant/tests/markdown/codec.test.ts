import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseDocument,
  RecordValidationError,
  serializeDocument,
  validateRecord,
} from '../../src/markdown/codec.js';

const fixture = (name: string) => readFileSync(
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)),
  'utf8',
);

describe('typed markdown codec', () => {
  it('preserves unknown fields and body while updating known fields', () => {
    const parsed = parseDocument('task', fixture('TASKS.md'));
    parsed.records[0].fields.status = 'done';

    const serialized = serializeDocument(parsed);
    expect(serialized).toContain('- custom_field: "keep-me"');
    expect(serialized).toContain('사람이 쓴 본문');
    expect(serialized).toContain('- status: done');
  });

  it.each([
    ['task', 'TASKS.md'],
    ['study', 'STUDY.md'],
    ['note', 'NOTES.md'],
    ['preference', 'USER.md'],
    ['memory', 'MEMORY.md'],
    ['inbox', 'INBOX.md'],
    ['daily', 'DAILY.md'],
  ] as const)('parses a valid %s fixture', (kind, name) => {
    expect(parseDocument(kind, fixture(name)).records).toHaveLength(1);
  });

  it.each([
    ['task', 'INVALID-TASKS.md', 'invalid_priority'],
    ['study', 'INVALID-STUDY.md', 'invalid_progress'],
    ['note', 'INVALID-NOTES.md', 'invalid_status'],
    ['preference', 'INVALID-USER.md', 'invalid_boolean'],
    ['memory', 'INVALID-MEMORY.md', 'invalid_supersedes'],
    ['inbox', 'INVALID-INBOX.md', 'invalid_target_id'],
    ['daily', 'INVALID-DAILY.md', 'invalid_related_ids'],
  ] as const)('rejects an invalid %s fixture with %s', (kind, name, code) => {
    expect(() => parseDocument(kind, fixture(name))).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it.each([
    ['duplicate id', fixture('DUPLICATE-STUDY.md'), 'duplicate_id'],
    ['negative progress', fixture('NEGATIVE-PROGRESS.md'), 'invalid_progress'],
    ['invalid timestamp', fixture('INVALID-TIMESTAMP.md'), 'invalid_timestamp'],
  ])('rejects %s with a stable error code', (_name, text, code) => {
    expect(() => parseDocument('study', text)).toThrow(RecordValidationError);
    expect(() => parseDocument('study', text)).toThrow(expect.objectContaining({ code }));
  });

  it('rejects an ID already present in the active or archive index', () => {
    expect(() => parseDocument('task', fixture('TASKS.md'), ['T-20260825-001']))
      .toThrow(expect.objectContaining({ code: 'duplicate_id' }));
  });

  it('validates the current value of a changed known field before serializing', () => {
    const parsed = parseDocument('task', fixture('TASKS.md'));
    parsed.records[0].fields.type = 'unrecognised';

    expect(() => validateRecord(parsed.records[0])).toThrow(
      expect.objectContaining({ code: 'invalid_type' }),
    );
  });

  it('serializes added ID fields in their bare ID representation', () => {
    const parsed = parseDocument('inbox', fixture('INBOX.md'));
    parsed.records[0].fields.target_id = 'T-20260825-001';

    expect(serializeDocument(parsed)).toContain('- target_id: T-20260825-001');
  });

  it.each([
    ['a quoted enum', 'task', fixture('TASKS.md').replace('status: open', 'status: "open"'), 'invalid_status'],
    ['a quoted timestamp', 'study', fixture('STUDY.md').replace('created_at: 2026-08-25T09:03:00+09:00', 'created_at: "2026-08-25T09:03:00+09:00"'), 'invalid_timestamp'],
    ['a quoted date', 'study', fixture('STUDY.md').replace('recurrence: daily', 'recurrence: daily\n- target_date: "2026-08-31"'), 'invalid_date'],
    ['a quoted target ID', 'inbox', fixture('INBOX.md').replace('- created_at:', '- target_id: "T-20260825-001"\n- created_at:'), 'invalid_target_id'],
  ] as const)('rejects %s where the contract requires a bare value', (_name, kind, text, code) => {
    expect(() => parseDocument(kind, text)).toThrow(expect.objectContaining({ code }));
  });
});
