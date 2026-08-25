import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, readFile, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BriefingService } from '../../src/state/alerts.js';
import { AlertLedger } from '../../src/state/alerts.js';
import { SubsystemHealthStore } from '../../src/state/health.js';
import { CalendarOutbox } from '../../src/calendar/outbox.js';
import { buildIcal, semanticEventHash } from '../../src/calendar/ical.js';
import {
  applyRetention,
  createBackup,
  verifyBackup,
  type AgeRunner,
} from '../../src/ops/backup.js';
import { openRepository, type WorkspaceRepository } from '../../src/workspace/repository.js';

const roots: string[] = [];
const repositories: WorkspaceRepository[] = [];
const closeables: Array<{ close(): void }> = [];

class FakeAge implements AgeRunner {
  constructor(readonly key = 'test-key', readonly mutate?: (bundle: ArchiveBundle) => void) {}

  async encrypt(inputPath: string, outputPath: string, _recipient: string): Promise<void> {
    const bytes = await readFile(inputPath);
    await writeFile(outputPath, Buffer.concat([Buffer.from(`FAKEAGE:${this.key}:`), bytes.reverse()]));
  }

  async decrypt(inputPath: string, outputPath: string, identityFile: string): Promise<void> {
    const bytes = await readFile(inputPath);
    const prefix = Buffer.from(`FAKEAGE:${identityFile}:`);
    if (!bytes.subarray(0, prefix.length).equals(prefix)) throw Object.assign(new Error('wrong key'), { code: 'age_decrypt_failed' });
    const plaintext = Buffer.from(bytes.subarray(prefix.length)).reverse();
    if (!this.mutate) await writeFile(outputPath, plaintext);
    else {
      const bundle = JSON.parse(plaintext.toString('utf8')) as ArchiveBundle;
      this.mutate(bundle);
      await writeFile(outputPath, JSON.stringify(bundle));
    }
  }
}

interface ArchiveBundle {
  files: Array<{ path: string; size: number; sha256: string; data: string }>;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-backup-'));
  roots.push(root);
  const workspaceDir = join(root, 'workspace');
  const stateDir = join(root, 'state');
  const backupDir = join(root, 'backups');
  await mkdir(join(workspaceDir, 'memory'), { recursive: true });
  await mkdir(join(workspaceDir, 'archive'), { recursive: true });
  await mkdir(stateDir);
  for (const [name, title] of [
    ['TASKS.md', 'Tasks'], ['STUDY.md', 'Study'], ['NOTES.md', 'Notes'],
    ['USER.md', 'User'], ['MEMORY.md', 'Memory'], ['INBOX.md', 'Inbox'],
  ]) await writeFile(join(workspaceDir, name), `# ${title}\n\n`);
  await writeFile(join(workspaceDir, 'memory', '2026-08-25.md'), '# Daily\n\n');
  execFileSync('git', ['init', '--quiet'], { cwd: workspaceDir });
  execFileSync('git', ['config', 'user.name', 'Backup Tests'], { cwd: workspaceDir });
  execFileSync('git', ['config', 'user.email', 'backup@example.test'], { cwd: workspaceDir });
  execFileSync('git', ['add', '.'], { cwd: workspaceDir });
  execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: workspaceDir });
  const repository = await openRepository({
    workspaceDir, stateDir, backupDir, telegramUserId: '42', timezone: 'Asia/Seoul',
  });
  repositories.push(repository);
  const clock = { now: new Date('2026-08-25T00:00:00.000Z') };
  const outbox = new CalendarOutbox({
    stateDir,
    now: () => new Date(clock.now),
    api: { async createSchedule(request) { return { processType: 'create' as const, calendarId: request.calendarId, icalUid: 'backup-event' }; } },
    caldav: { async listEvents() { return []; } },
    requestId: () => '00000000-0000-4000-8000-000000000001',
  });
  const alerts = new AlertLedger(stateDir);
  const health = new SubsystemHealthStore(stateDir);
  closeables.push(outbox, alerts, health);
  return { root, workspaceDir, stateDir, backupDir, repository, outbox, alerts, health, clock, age: new FakeAge() };
}

function calendarDraft(uid = 'backup-event') {
  const event = {
    calendarId: 'personal', uid,
    dtstart: '2026-08-25T09:00:00+09:00', dtend: '2026-08-25T10:00:00+09:00',
    summary: 'Backup coverage',
  };
  return { calendarId: event.calendarId, uid, payloadIcal: buildIcal(event), payloadHash: semanticEventHash(event) };
}

afterEach(async () => {
  for (const closeable of closeables.splice(0)) {
    try { closeable.close(); } catch { /* already closed */ }
  }
  for (const repository of repositories.splice(0)) repository.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('encrypted verified backup', () => {
  it('holds the repository writer boundary through the snapshot and returns immutable outbox evidence', async () => {
    const f = await fixture();
    const first = f.outbox.prepare(calendarDraft());
    f.outbox.confirm(first.requestId, '42', first.payloadHash);
    await f.outbox.submit(first.requestId, '42');
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let snapshotEntered!: () => void;
    const entered = new Promise<void>(resolve => { snapshotEntered = resolve; });
    const backupPromise = createBackup({
      ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      snapshotCheckpoint: async phase => { if (phase === 'locked') { snapshotEntered(); await held; } },
    });
    await entered;
    let mutationDone = false;
    const mutation = f.repository.addTask('during-backup', { title: 'Later', source: 'telegram' })
      .then(() => { mutationDone = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(mutationDone).toBe(false);
    release();
    const backup = await backupPromise;
    await mutation;

    f.clock.now = new Date('2026-09-25T00:00:01.000Z');
    const secondOutbox = new CalendarOutbox({
      stateDir: f.stateDir, now: () => new Date(f.clock.now),
      api: { async createSchedule(request) { return { processType: 'create' as const, calendarId: request.calendarId, icalUid: 'later' }; } },
      caldav: { async listEvents() { return []; } },
      requestId: () => '00000000-0000-4000-8000-000000000002',
    });
    closeables.push(secondOutbox);
    const second = secondOutbox.prepare(calendarDraft('later'));
    secondOutbox.confirm(second.requestId, '42', second.payloadHash);
    await secondOutbox.submit(second.requestId, '42');
    expect(secondOutbox.pruneSucceeded(backup.outboxEvidence)).toEqual([first.requestId]);
    expect(secondOutbox.get(second.requestId)).toBeDefined();
    secondOutbox.close();
    f.outbox.close(); f.alerts.close(); f.health.close();
  }, 30_000);

  it('reports a backup failure to the real briefing source and clears it only after verified success', async () => {
    const f = await fixture();
    await writeFile(join(f.workspaceDir, 'NOTES.md'), '# Notes\n\nSECRET-CANARY-42\n');
    await expect(createBackup({
      ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      secretCanaries: ['SECRET-CANARY-42'], now: () => new Date('2026-08-25T00:00:00.000Z'),
    })).rejects.toMatchObject({ code: 'secret_material_detected' });
    const active = f.health.listActive();
    expect(new BriefingService(f.alerts).run({
      now: '2026-08-25T09:00:00+09:00', events: [], tasks: [], studies: [], activeErrors: active,
    }).result.messages.join('\n')).toContain('backup_failed (backup)');

    await writeFile(join(f.workspaceDir, 'NOTES.md'), '# Notes\n\n');
    await createBackup({
      ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      secretCanaries: ['SECRET-CANARY-42'], now: () => new Date('2026-08-25T00:00:00.000Z'),
    });
    expect(f.health.listActive()).toEqual([]);
    f.outbox.close(); f.alerts.close(); f.health.close();
  }, 30_000);

  it('rejects tampered and missing immutable outbox snapshot bytes before evidence can be minted', async () => {
    const f = await fixture();
    const backup = await createBackup({
      ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      now: () => new Date('2026-08-25T00:00:00.000Z'),
    });
    for (const kind of ['tampered', 'missing'] as const) {
      const corruptingAge = new FakeAge('test-key', bundle => {
        const index = bundle.files.findIndex(entry => entry.path === 'state/calendar-outbox.sqlite3');
        if (kind === 'missing') bundle.files.splice(index, 1);
        else {
          const entry = bundle.files[index]!;
          const bytes = Buffer.from(entry.data, 'base64');
          bytes[Math.max(0, bytes.length - 100)] ^= 1;
          entry.data = bytes.toString('base64');
          entry.sha256 = createHash('sha256').update(bytes).digest('hex');
        }
      });
      await expect(verifyBackup({ archivePath: backup.archivePath, identityFile: 'test-key', ageRunner: corruptingAge, health: f.health }))
        .rejects.toMatchObject({ code: kind === 'tampered' ? 'manifest_hash_mismatch' : 'manifest_file_set_mismatch' });
    }
    f.outbox.close(); f.alerts.close(); f.health.close();
  }, 30_000);

  it('never deletes link, outside-root, malformed-name, or unverified retention candidates', async () => {
    const f = await fixture();
    await mkdir(f.backupDir);
    const outside = join(f.root, '2026-01-01.age');
    await writeFile(outside, 'outside');
    const linked = join(f.backupDir, '2026-01-02.age');
    const outsideDirectory = join(f.root, 'outside-directory');
    await mkdir(outsideDirectory);
    await symlink(outsideDirectory, linked, 'junction');
    const malformed = join(f.backupDir, 'old.age');
    await writeFile(malformed, 'not an archive');
    const result = await applyRetention({
      backupDir: f.backupDir, identityFile: 'test-key', ageRunner: f.age,
      candidatePaths: [linked, outside, malformed], health: f.health,
    });
    expect(result.deleted).toEqual([]);
    expect(await readFile(outside, 'utf8')).toBe('outside');
    f.outbox.close(); f.alerts.close(); f.health.close();
  });

  it('deletes only verified oldest archives while retaining at least two recovery points', async () => {
    const f = await fixture();
    const newest = await createBackup({
      ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      now: () => new Date('2026-08-25T00:00:00.000Z'),
    });
    await copyFile(newest.archivePath, join(f.backupDir, '2026-08-24.age'));
    await copyFile(newest.archivePath, join(f.backupDir, '2026-08-23.age'));
    const result = await applyRetention({
      backupDir: f.backupDir, identityFile: 'test-key', ageRunner: f.age, keep: 2, health: f.health,
    });
    expect(result.deleted.map(path => path.split(/[\\/]/).at(-1))).toEqual(['2026-08-23.age']);
    await expect(stat(join(f.backupDir, '2026-08-24.age'))).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(stat(join(f.backupDir, '2026-08-25.age'))).resolves.toMatchObject({ size: expect.any(Number) });
    expect((await readdir(f.backupDir)).filter(name => name.endsWith('.age')).sort())
      .toEqual(['2026-08-24.age', '2026-08-25.age']);
    f.outbox.close(); f.alerts.close(); f.health.close();
  }, 30_000);
});
