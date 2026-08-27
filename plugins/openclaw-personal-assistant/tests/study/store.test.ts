import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { StudyStore } from '../../src/study/store.js';

const stores: StudyStore[] = [];
const temporaryDirs: string[] = [];

afterEach(async () => {
  while (stores.length > 0) stores.pop()?.close();
  await Promise.all(temporaryDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<StudyStore> {
  const stateDir = await mkdtemp(join(tmpdir(), 'assistant-study-store-'));
  temporaryDirs.push(stateDir);
  const store = new StudyStore(stateDir);
  stores.push(store);
  return store;
}

const at = (time: string) => new Date(`2026-08-27T${time}:00+09:00`);

function blockAt(time: string, title = '수학') {
  return {
    title,
    startAt: `2026-08-27T${time}:00+09:00`,
    durationMinutes: 50,
  };
}

describe('StudyStore', () => {
  it('sends only two unanswered follow-ups then marks the block missed', async () => {
    const store = await fixture();
    store.plan('p1', 'S-20260827-001', [blockAt('10:00')]);

    expect(store.consumeDue(at('10:00'))?.kind).toBe('start');
    expect(store.consumeDue(at('10:15'))?.kind).toBe('follow_up');
    expect(store.consumeDue(at('10:30'))?.kind).toBe('follow_up');
    expect(store.consumeDue(at('10:45'))).toMatchObject({ kind: 'missed' });
    expect(store.get('B-20260827-001')?.status).toBe('missed');
  });

  it('preserves completed history while replacing only future planned blocks', async () => {
    const store = await fixture();
    const planned = store.plan('plan-1', 'S-20260827-001', [
      blockAt('10:00', '완료할 블록'),
      blockAt('12:00', '교체할 블록'),
    ]);
    store.consumeDue(at('10:00'));
    store.transition('done-1', planned.blocks[0]!.id, { type: 'done' }, at('10:40'));

    store.replaceFuture(
      'replace-1',
      'S-20260827-001',
      [blockAt('13:00', '새 블록')],
      at('11:00'),
    );

    expect(store.get(planned.blocks[0]!.id)?.status).toBe('completed');
    expect(store.get(planned.blocks[1]!.id)).toBeUndefined();
    expect(store.current(at('13:00')).blocks.map(block => block.title))
      .toEqual(['완료할 블록', '새 블록']);
  });

  it('replays an identical operation and rejects changed payload reuse', async () => {
    const store = await fixture();
    const first = store.plan('plan-replay', 'S-20260827-001', [blockAt('10:00')]);
    const replay = store.plan('plan-replay', 'S-20260827-001', [blockAt('10:00')]);

    expect(replay).toMatchObject({ replayed: true, blocks: [{ id: first.blocks[0]!.id }] });
    expect(() => store.plan('plan-replay', 'S-20260827-001', [blockAt('11:00')]))
      .toThrow(expect.objectContaining({ code: 'study_operation_conflict' }));
  });

  it('marks a reminder stale after restart instead of replaying it', async () => {
    const store = await fixture();
    store.plan('stale-plan', 'S-20260827-001', [blockAt('10:00')]);

    const recovery = store.recover(at('10:40'));

    expect(recovery).toMatchObject({ missed: 1 });
    expect(store.consumeDue(at('10:40'))).toBeNull();
    expect(store.get('B-20260827-001')?.status).toBe('missed');
  });

  it('rejects overlaps and blocks outside 08:00 through next-day 02:00', async () => {
    const store = await fixture();
    expect(() => store.plan('outside', 'S-20260827-001', [{
      title: '너무 이른 공부', startAt: '2026-08-27T07:50:00+09:00', durationMinutes: 50,
    }])).toThrow(expect.objectContaining({ code: 'study_window_violation' }));

    expect(() => store.plan('overlap', 'S-20260827-001', [
      blockAt('10:00'), blockAt('10:40'),
    ])).toThrow(expect.objectContaining({ code: 'study_block_overlap' }));
  });
});
