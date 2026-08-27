import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  isStudyWindow,
  studyDayKey,
  studyWindowBounds,
  toSeoulTimestamp,
} from './clock.js';
import {
  DEFAULT_STUDY_SETTINGS,
  type StudyBlock,
  type StudyBlockStatus,
  type StudyDayStatus,
  type StudyDueAction,
  type StudyPlanBlockInput,
  type StudyPlanResult,
  type StudyRecoveryResult,
  type StudySettings,
  StudyStoreError,
  type StudyTransitionAction,
  type StudyTransitionResult,
} from './types.js';

const SCHEMA_VERSION = 1;
const STATUS_SQL = "'planned','active','snoozed','completed','skipped','missed'";
const SCHEMA = `
CREATE TABLE study_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  timezone TEXT NOT NULL CHECK (timezone = 'Asia/Seoul'),
  window_start_hour INTEGER NOT NULL CHECK (window_start_hour = 8),
  window_end_hour INTEGER NOT NULL CHECK (window_end_hour = 2),
  focus_minutes INTEGER NOT NULL CHECK (focus_minutes BETWEEN 10 AND 180),
  break_minutes INTEGER NOT NULL CHECK (break_minutes BETWEEN 0 AND 60),
  follow_up_minutes INTEGER NOT NULL CHECK (follow_up_minutes BETWEEN 5 AND 60),
  max_follow_ups INTEGER NOT NULL CHECK (max_follow_ups BETWEEN 0 AND 5),
  interim_report_hour INTEGER NOT NULL CHECK (interim_report_hour = 22)
) STRICT;
CREATE TABLE study_blocks (
  id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL,
  day_key TEXT NOT NULL,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 10 AND 180),
  status TEXT NOT NULL CHECK (status IN (${STATUS_SQL})),
  follow_up_count INTEGER NOT NULL CHECK (follow_up_count BETWEEN 0 AND 5),
  next_due_at TEXT,
  snoozed_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX study_blocks_due ON study_blocks (next_due_at, id)
  WHERE next_due_at IS NOT NULL;
CREATE INDEX study_blocks_day ON study_blocks (day_key, start_at, id);
CREATE TABLE study_operations (
  operation_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE study_audit (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  block_id TEXT NOT NULL,
  action TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  occurred_at TEXT NOT NULL
) STRICT;
CREATE TABLE study_reports (
  day_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('interim','final')),
  delivered_at TEXT,
  PRIMARY KEY (day_key, kind)
) STRICT;
INSERT INTO study_settings VALUES (1, 'Asia/Seoul', 8, 2, 50, 10, 15, 2, 22);
PRAGMA user_version = 1;
`;

export const STUDY_BACKUP_SCHEMA_FINGERPRINT = (() => {
  const database = new DatabaseSync(':memory:');
  try { database.exec(SCHEMA); return studySchemaFingerprint(database); }
  finally { database.close(); }
})();

interface BlockRow {
  id: string;
  study_id: string;
  day_key: string;
  title: string;
  start_at: string;
  end_at: string;
  duration_minutes: number;
  status: StudyBlockStatus;
  follow_up_count: number;
  next_due_at: string | null;
  snoozed_until: string | null;
  created_at: string;
  updated_at: string;
}

interface OperationRow {
  payload_hash: string;
  result_json: string;
}

function fail(code: string, message: string, detail?: unknown): never {
  throw new StudyStoreError(code, message, detail);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function payloadHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function validateOperationId(operationId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(operationId)) {
    fail('invalid_study_operation_id', 'study operation ID is invalid');
  }
}

function validateStudyId(studyId: string): void {
  if (!/^S-\d{8}-\d{3}$/u.test(studyId)) fail('invalid_study_id', 'study ID is invalid');
}

function exactTimestamp(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\+09:00$/u.test(value)) {
    fail('invalid_study_timestamp', 'study timestamps must use whole seconds and +09:00');
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || toSeoulTimestamp(date) !== value) {
    fail('invalid_study_timestamp', 'study timestamp is not a real Seoul civil time');
  }
  return date;
}

function rowToBlock(row: BlockRow): StudyBlock {
  return {
    id: row.id,
    studyId: row.study_id,
    dayKey: row.day_key,
    title: row.title,
    startAt: row.start_at,
    endAt: row.end_at,
    durationMinutes: row.duration_minutes,
    status: row.status,
    followUpCount: row.follow_up_count,
    ...(row.next_due_at === null ? {} : { nextDueAt: row.next_due_at }),
    ...(row.snoozed_until === null ? {} : { snoozedUntil: row.snoozed_until }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function addMinutes(timestamp: string, minutes: number): string {
  return toSeoulTimestamp(new Date(exactTimestamp(timestamp).getTime() + minutes * 60_000));
}

function validateSettings(settings: StudySettings): void {
  if (settings.timezone !== 'Asia/Seoul' || settings.windowStartHour !== 8
    || settings.windowEndHour !== 2 || settings.interimReportHour !== 22
    || !Number.isInteger(settings.focusMinutes) || settings.focusMinutes < 10 || settings.focusMinutes > 180
    || !Number.isInteger(settings.breakMinutes) || settings.breakMinutes < 0 || settings.breakMinutes > 60
    || !Number.isInteger(settings.followUpMinutes) || settings.followUpMinutes < 5 || settings.followUpMinutes > 60
    || !Number.isInteger(settings.maxFollowUps) || settings.maxFollowUps < 0 || settings.maxFollowUps > 5) {
    fail('invalid_study_settings', 'study settings are outside supported bounds');
  }
}

export class StudyStore {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const path = join(stateDir, 'study.sqlite3');
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 10000;');
    const tables = this.database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).all() as unknown as Array<{ name: string }>;
    if (tables.length === 0) this.database.exec(SCHEMA);
    else this.assertSchema();
    chmodSync(path, 0o600);
  }

  settings(): StudySettings {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM study_settings WHERE singleton = 1').get() as {
      timezone: 'Asia/Seoul'; window_start_hour: 8; window_end_hour: 2;
      focus_minutes: number; break_minutes: number; follow_up_minutes: number;
      max_follow_ups: number; interim_report_hour: 22;
    };
    return {
      timezone: row.timezone,
      windowStartHour: row.window_start_hour,
      windowEndHour: row.window_end_hour,
      focusMinutes: row.focus_minutes,
      breakMinutes: row.break_minutes,
      followUpMinutes: row.follow_up_minutes,
      maxFollowUps: row.max_follow_ups,
      interimReportHour: row.interim_report_hour,
    };
  }

  setSettings(
    operationId: string,
    patch: Partial<Pick<StudySettings,
      'focusMinutes' | 'breakMinutes' | 'followUpMinutes' | 'maxFollowUps'>>,
  ): { operationId: string; replayed: boolean; settings: StudySettings } {
    const settings = { ...this.settings(), ...patch };
    validateSettings(settings);
    return this.operation(operationId, { action: 'settings', patch }, () => {
      this.database.prepare(`
        UPDATE study_settings SET focus_minutes = ?, break_minutes = ?,
          follow_up_minutes = ?, max_follow_ups = ? WHERE singleton = 1
      `).run(
        settings.focusMinutes, settings.breakMinutes,
        settings.followUpMinutes, settings.maxFollowUps,
      );
      return { operationId, replayed: false, settings };
    });
  }

  plan(operationId: string, studyId: string, blocks: StudyPlanBlockInput[]): StudyPlanResult {
    validateStudyId(studyId);
    const normalized = this.validateBlocks(blocks);
    return this.operation(operationId, { action: 'plan', studyId, blocks: normalized }, () => ({
      operationId,
      replayed: false,
      blocks: this.insertBlocks(studyId, normalized),
    }));
  }

  replaceFuture(
    operationId: string,
    studyId: string,
    blocks: StudyPlanBlockInput[],
    now: Date,
  ): StudyPlanResult {
    validateStudyId(studyId);
    const normalized = this.validateBlocks(blocks);
    const nowTimestamp = toSeoulTimestamp(now);
    return this.operation(
      operationId,
      { action: 'replace_future', studyId, blocks: normalized, now: nowTimestamp },
      () => {
        this.database.prepare(`
          DELETE FROM study_blocks
          WHERE study_id = ? AND start_at >= ? AND status IN ('planned','snoozed')
        `).run(studyId, nowTimestamp);
        return {
          operationId,
          replayed: false,
          blocks: this.insertBlocks(studyId, normalized),
        };
      },
    );
  }

  transition(
    operationId: string,
    blockId: string,
    action: StudyTransitionAction,
    now: Date,
  ): StudyTransitionResult {
    const nowTimestamp = toSeoulTimestamp(now);
    return this.operation(
      operationId,
      { action: 'transition', blockId, transition: action, now: nowTimestamp },
      () => {
        const current = this.requireBlock(blockId);
        let status: StudyBlockStatus;
        let nextDueAt: string | null = null;
        let snoozedUntil: string | null = null;
        if (action.type === 'done' && (current.status === 'active' || current.status === 'snoozed')) {
          status = 'completed';
        } else if (action.type === 'skip'
          && (current.status === 'planned' || current.status === 'active' || current.status === 'snoozed')) {
          status = 'skipped';
        } else if (action.type === 'snooze'
          && (current.status === 'active' || current.status === 'snoozed')) {
          const minutes = action.minutes ?? this.settings().breakMinutes;
          if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) {
            fail('invalid_study_snooze', 'snooze must be 1-120 minutes');
          }
          status = 'snoozed';
          nextDueAt = toSeoulTimestamp(new Date(now.getTime() + minutes * 60_000));
          snoozedUntil = nextDueAt;
        } else {
          fail('invalid_study_transition', `cannot ${action.type} a ${current.status} block`);
        }
        this.database.prepare(`
          UPDATE study_blocks SET status = ?, next_due_at = ?, snoozed_until = ?, updated_at = ?
          WHERE id = ?
        `).run(status, nextDueAt, snoozedUntil, nowTimestamp, blockId);
        this.audit(operationId, blockId, action.type, current.status, status, nowTimestamp);
        return { operationId, replayed: false, block: this.requireBlock(blockId) };
      },
    );
  }

  get(blockId: string): StudyBlock | undefined {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM study_blocks WHERE id = ?').get(blockId) as
      unknown as BlockRow | undefined;
    return row ? rowToBlock(row) : undefined;
  }

  current(now: Date): StudyDayStatus {
    this.assertOpen();
    const dayKey = studyDayKey(now);
    const rows = this.database.prepare(`
      SELECT * FROM study_blocks WHERE day_key = ? ORDER BY start_at, id
    `).all(dayKey) as unknown as BlockRow[];
    const blocks = rows.map(rowToBlock);
    const counts: Record<StudyBlockStatus, number> = {
      planned: 0, active: 0, snoozed: 0, completed: 0, skipped: 0, missed: 0,
    };
    blocks.forEach(block => { counts[block.status] += 1; });
    const terminal = counts.completed + counts.skipped + counts.missed;
    return {
      dayKey,
      blocks,
      counts,
      completionRate: terminal === 0 ? 0 : counts.completed / terminal,
    };
  }

  isReportDelivered(dayKey: string, kind: 'interim' | 'final'): boolean {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT delivered_at FROM study_reports WHERE day_key = ? AND kind = ?
    `).get(dayKey, kind) as { delivered_at: string | null } | undefined;
    return typeof row?.delivered_at === 'string';
  }

  markReportDelivered(dayKey: string, kind: 'interim' | 'final', at: Date): void {
    this.assertOpen();
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(dayKey)) fail('invalid_study_day_key', 'study day key is invalid');
    this.database.prepare(`
      INSERT INTO study_reports (day_key, kind, delivered_at) VALUES (?, ?, ?)
      ON CONFLICT(day_key, kind) DO UPDATE SET delivered_at = excluded.delivered_at
    `).run(dayKey, kind, toSeoulTimestamp(at));
  }

  nextDue(_now: Date): StudyDueAction | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT * FROM study_blocks
      WHERE next_due_at IS NOT NULL AND status IN ('planned','active','snoozed')
      ORDER BY next_due_at, id LIMIT 1
    `).get() as unknown as BlockRow | undefined;
    if (!row || row.next_due_at === null) return null;
    return {
      kind: this.dueKind(row),
      dueAt: row.next_due_at,
      block: rowToBlock(row),
    };
  }

  consumeDue(now: Date): StudyDueAction | null {
    this.assertOpen();
    const nowTimestamp = toSeoulTimestamp(now);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.database.prepare(`
        SELECT * FROM study_blocks
        WHERE next_due_at IS NOT NULL AND next_due_at <= ?
          AND status IN ('planned','active','snoozed')
        ORDER BY next_due_at, id LIMIT 1
      `).get(nowTimestamp) as unknown as BlockRow | undefined;
      if (!row || row.next_due_at === null) {
        this.database.exec('COMMIT');
        return null;
      }
      const dueAt = row.next_due_at;
      const kind = this.dueKind(row);
      const settings = this.settings();
      let status: StudyBlockStatus = row.status;
      let followUpCount = row.follow_up_count;
      let nextDueAt: string | null;
      if (kind === 'start') {
        status = 'active';
        nextDueAt = addMinutes(dueAt, settings.followUpMinutes);
      } else if (kind === 'follow_up') {
        status = 'active';
        followUpCount += 1;
        nextDueAt = addMinutes(dueAt, settings.followUpMinutes);
      } else {
        status = 'missed';
        nextDueAt = null;
      }
      this.database.prepare(`
        UPDATE study_blocks SET status = ?, follow_up_count = ?, next_due_at = ?,
          snoozed_until = NULL, updated_at = ? WHERE id = ?
      `).run(status, followUpCount, nextDueAt, nowTimestamp, row.id);
      this.audit(`due:${row.id}:${dueAt}`, row.id, kind, row.status, status, nowTimestamp);
      const block = this.requireBlock(row.id);
      this.database.exec('COMMIT');
      return { kind, dueAt, block };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  recover(now: Date): StudyRecoveryResult {
    this.assertOpen();
    const settings = this.settings();
    const threshold = toSeoulTimestamp(new Date(now.getTime() - settings.followUpMinutes * 60_000));
    const nowTimestamp = toSeoulTimestamp(now);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const stale = this.database.prepare(`
        SELECT * FROM study_blocks
        WHERE next_due_at IS NOT NULL AND next_due_at < ?
          AND status IN ('planned','active','snoozed')
        ORDER BY next_due_at, id
      `).all(threshold) as unknown as BlockRow[];
      for (const row of stale) {
        this.database.prepare(`
          UPDATE study_blocks SET status = 'missed', next_due_at = NULL,
            snoozed_until = NULL, updated_at = ? WHERE id = ?
        `).run(nowTimestamp, row.id);
        this.audit(
          `recovery:${row.id}:${row.next_due_at}`,
          row.id,
          'stale_missed',
          row.status,
          'missed',
          nowTimestamp,
        );
      }
      this.database.exec('COMMIT');
      return { missed: stale.length };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  private assertSchema(): void {
    assertStudyDatabase(this.database);
  }

  private assertOpen(): void {
    if (this.closed) fail('study_store_closed', 'study store is closed');
  }

  private validateBlocks(blocks: StudyPlanBlockInput[]): Required<StudyPlanBlockInput>[] {
    this.assertOpen();
    const settings = this.settings();
    if (!Array.isArray(blocks) || blocks.length === 0 || blocks.length > 64) {
      fail('invalid_study_plan', 'study plan must contain 1-64 blocks');
    }
    const normalized = blocks.map(block => {
      if (typeof block.title !== 'string' || block.title.length === 0 || block.title.length > 200
        || /[\r\n\u0000-\u001F\u007F]/u.test(block.title)) {
        fail('invalid_study_title', 'study block title is invalid');
      }
      const durationMinutes = block.durationMinutes ?? settings.focusMinutes;
      if (!Number.isInteger(durationMinutes) || durationMinutes < 10 || durationMinutes > 180) {
        fail('invalid_study_duration', 'study duration must be 10-180 minutes');
      }
      const start = exactTimestamp(block.startAt);
      const end = new Date(start.getTime() + durationMinutes * 60_000);
      const dayKey = studyDayKey(start);
      const bounds = studyWindowBounds(dayKey, settings);
      if (!isStudyWindow(start, settings)
        || start.getTime() < exactTimestamp(bounds.start).getTime()
        || end.getTime() > exactTimestamp(bounds.end).getTime()) {
        fail('study_window_violation', 'study block must stay within 08:00 through next-day 02:00');
      }
      return { title: block.title, startAt: block.startAt, durationMinutes };
    }).sort((left, right) => left.startAt.localeCompare(right.startAt));
    for (let index = 1; index < normalized.length; index += 1) {
      const previous = normalized[index - 1]!;
      const previousEnd = exactTimestamp(previous.startAt).getTime() + previous.durationMinutes * 60_000;
      if (previousEnd > exactTimestamp(normalized[index]!.startAt).getTime()) {
        fail('study_block_overlap', 'study blocks cannot overlap');
      }
    }
    return normalized;
  }

  private insertBlocks(
    studyId: string,
    blocks: Required<StudyPlanBlockInput>[],
  ): StudyBlock[] {
    const inserted: StudyBlock[] = [];
    for (const input of blocks) {
      const start = exactTimestamp(input.startAt);
      const dayKey = studyDayKey(start);
      const endAt = toSeoulTimestamp(new Date(start.getTime() + input.durationMinutes * 60_000));
      const overlap = this.database.prepare(`
        SELECT id FROM study_blocks
        WHERE start_at < ? AND end_at > ? LIMIT 1
      `).get(endAt, input.startAt) as { id: string } | undefined;
      if (overlap) fail('study_block_overlap', `study block overlaps ${overlap.id}`);
      const compactDay = dayKey.replaceAll('-', '');
      const row = this.database.prepare(`
        SELECT id FROM (
          SELECT id FROM study_blocks WHERE id LIKE ?
          UNION
          SELECT block_id AS id FROM study_audit WHERE block_id LIKE ?
        ) ORDER BY id DESC LIMIT 1
      `).get(`B-${compactDay}-%`, `B-${compactDay}-%`) as { id: string } | undefined;
      const sequence = row ? Number(row.id.slice(-3)) + 1 : 1;
      if (sequence > 999) fail('study_block_id_exhausted', `study block IDs exhausted for ${dayKey}`);
      const id = `B-${compactDay}-${String(sequence).padStart(3, '0')}`;
      const createdAt = toSeoulTimestamp(new Date());
      this.database.prepare(`
        INSERT INTO study_blocks (
          id, study_id, day_key, title, start_at, end_at, duration_minutes,
          status, follow_up_count, next_due_at, snoozed_until, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', 0, ?, NULL, ?, ?)
      `).run(
        id, studyId, dayKey, input.title, input.startAt, endAt, input.durationMinutes,
        input.startAt, createdAt, createdAt,
      );
      this.audit(`plan:${id}`, id, 'planned', 'planned', 'planned', createdAt);
      inserted.push(this.requireBlock(id));
    }
    return inserted;
  }

  private operation<T extends { replayed: boolean }>(
    operationId: string,
    payload: unknown,
    work: () => T,
  ): T {
    this.assertOpen();
    validateOperationId(operationId);
    const hash = payloadHash(payload);
    const existing = this.database.prepare(`
      SELECT payload_hash, result_json FROM study_operations WHERE operation_id = ?
    `).get(operationId) as unknown as OperationRow | undefined;
    if (existing) {
      if (existing.payload_hash !== hash) {
        fail('study_operation_conflict', `study operation ${operationId} has different input`);
      }
      return { ...(JSON.parse(existing.result_json) as T), replayed: true };
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.database.prepare(`
        INSERT INTO study_operations (operation_id, payload_hash, result_json, created_at)
        VALUES (?, ?, ?, ?)
      `).run(operationId, hash, JSON.stringify(result), new Date().toISOString());
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private requireBlock(blockId: string): StudyBlock {
    const block = this.get(blockId);
    if (!block) fail('study_block_not_found', `study block ${blockId} was not found`);
    return block;
  }

  private dueKind(row: BlockRow): StudyDueAction['kind'] {
    if (row.status === 'planned' || row.status === 'snoozed') return 'start';
    return row.follow_up_count < this.settings().maxFollowUps ? 'follow_up' : 'missed';
  }

  private audit(
    operationId: string,
    blockId: string,
    action: string,
    from: StudyBlockStatus,
    to: StudyBlockStatus,
    occurredAt: string,
  ): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO study_audit (
        operation_id, block_id, action, from_status, to_status, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(operationId, blockId, action, from, to, occurredAt);
  }
}

export function validateStudyBackupDatabase(path: string): {
  userVersion: number;
  schemaFingerprint: string;
} {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    assertStudyDatabase(database);
    return { userVersion: SCHEMA_VERSION, schemaFingerprint: STUDY_BACKUP_SCHEMA_FINGERPRINT };
  } finally {
    database.close();
  }
}

function assertStudyDatabase(database: DatabaseSync): void {
  const version = Number(
    (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
  );
  const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown };
  const names = (database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as unknown as Array<{ name: string }>).map(row => row.name).join(',');
  if (version !== SCHEMA_VERSION || integrity.integrity_check !== 'ok'
    || names !== 'study_audit,study_blocks,study_operations,study_reports,study_settings'
    || studySchemaFingerprint(database) !== STUDY_BACKUP_SCHEMA_FINGERPRINT) {
    fail('study_schema_mismatch', 'study database schema is incompatible');
  }
}

function studySchemaFingerprint(database: DatabaseSync): string {
  const rows = database.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
    ORDER BY type, name
  `).all() as unknown as Array<{ type: string; name: string; sql: string }>;
  return createHash('sha256').update(rows.map(row =>
    `${row.type}:${row.name}:${row.sql.replace(/\s+/gu, ' ').trim().toLowerCase()}`
  ).join('\n')).digest('hex');
}

export { DEFAULT_STUDY_SETTINGS };
