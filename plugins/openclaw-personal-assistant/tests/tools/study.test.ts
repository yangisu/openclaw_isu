import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from 'typebox/value';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ParsedRecord } from '../../src/domain.js';
import { StudyStore } from '../../src/study/store.js';
import { createQueryTool } from '../../src/tools/query.js';
import { createStudyTool, studyParameters } from '../../src/tools/study.js';

const config = {
  workspaceDir: '/home/user/.openclaw/workspace',
  stateDir: '/home/user/.openclaw/state',
  backupDir: '/mnt/d/openclaw_setting/backups',
  telegramUserId: '123456789',
  timezone: 'Asia/Seoul',
} as const;
const owner = { requesterSenderId: config.telegramUserId };
const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function api() {
  return { config: {}, pluginConfig: config } as never;
}

function studyRecord(): ParsedRecord {
  return {
    id: 'S-20260827-001',
    title: '수학 공부',
    orderedFields: [],
    fields: { type: 'study', status: 'in_progress', subject: '수학' },
    body: '',
  };
}

function planParams() {
  return {
    action: 'plan' as const,
    operationId: 'study-plan-1',
    studyId: 'S-20260827-001',
    blocks: [{
      title: '수학 1회차',
      startAt: '2026-08-27T10:00:00+09:00',
      durationMinutes: 50,
    }],
  };
}

async function stateFixture(): Promise<{ stateDir: string; store: StudyStore }> {
  const stateDir = await mkdtemp(join(tmpdir(), 'assistant-study-tool-'));
  temporaryDirs.push(stateDir);
  return { stateDir, store: new StudyStore(stateDir) };
}

describe('assistant_study_manage', () => {
  it('rejects a block that does not reference an existing active user study record', async () => {
    const { stateDir, store } = await stateFixture();
    store.close();
    const tool = createStudyTool(api(), owner, {
      openRepository: () => ({ async query() { return []; }, close() {} }),
      openStore: () => new StudyStore(stateDir),
      now: () => new Date('2026-08-27T09:00:00+09:00'),
    });

    await expect(tool.execute('call-1', planParams(), undefined))
      .rejects.toMatchObject({ code: 'study_not_found' });
    const verification = new StudyStore(stateDir);
    expect(verification.current(new Date('2026-08-27T10:00:00+09:00')).blocks).toEqual([]);
    verification.close();
  });

  it('plans internal blocks without a calendar mutation dependency', async () => {
    const { stateDir, store } = await stateFixture();
    store.close();
    const tool = createStudyTool(api(), owner, {
      openRepository: () => ({ async query() { return [studyRecord()]; }, close() {} }),
      openStore: () => new StudyStore(stateDir),
      now: () => new Date('2026-08-27T09:00:00+09:00'),
    });

    const result = await tool.execute('call-1', planParams(), undefined);

    expect(result.details).toMatchObject({
      action: 'plan', blocks: [{ id: 'B-20260827-001', status: 'planned' }],
    });
    const verification = new StudyStore(stateDir);
    expect(verification.current(new Date('2026-08-27T10:00:00+09:00')).blocks).toHaveLength(1);
    verification.close();
  });

  it('rejects a non-owner and malformed input before opening local state', async () => {
    const openRepository = vi.fn();
    const openStore = vi.fn();
    const nonOwnerTool = createStudyTool(api(), { requesterSenderId: '999' }, {
      openRepository, openStore,
    });
    await expect(nonOwnerTool.execute('call-1', planParams(), undefined))
      .rejects.toMatchObject({ code: 'sender_not_allowed' });
    expect(openRepository).not.toHaveBeenCalled();
    expect(openStore).not.toHaveBeenCalled();
    expect(Value.Check(studyParameters, { ...planParams(), invented: true })).toBe(false);
  });

  it('returns study blocks and day status through assistant_query', async () => {
    const { stateDir, store } = await stateFixture();
    store.plan('query-plan', 'S-20260827-001', planParams().blocks);
    store.close();
    const query = createQueryTool(api(), owner, {
      openRepository: vi.fn(),
      openStudyStore: () => new StudyStore(stateDir),
      now: () => new Date('2026-08-27T10:00:00+09:00'),
    });

    const blocks = await query.execute('query-1', { kind: 'study_blocks' }, undefined);
    const status = await query.execute('query-2', { kind: 'study_day_status' }, undefined);

    expect(blocks.details).toMatchObject({ kind: 'study_blocks', items: [{ id: 'B-20260827-001' }] });
    expect(status.details).toMatchObject({
      kind: 'study_day_status', items: [{ dayKey: '2026-08-27', counts: { planned: 1 } }],
    });
  });
});
