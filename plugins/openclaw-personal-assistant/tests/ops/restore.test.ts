import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { SubsystemHealthStore } from '../../src/state/health.js';
import { AlertLedger } from '../../src/state/alerts.js';
import { CalendarOutbox } from '../../src/calendar/outbox.js';
import { createBackup, restoreBackup, type AgeRunner } from '../../src/ops/backup.js';
import { runExecFile } from '../../src/ops/process.js';
import { openRepository, type WorkspaceRepository } from '../../src/workspace/repository.js';

const roots: string[] = [];
const repositories: WorkspaceRepository[] = [];
const closeables: Array<{ close(): void }> = [];

class FakeAge implements AgeRunner {
  async encrypt(inputPath: string, outputPath: string, recipient: string): Promise<void> {
    const bytes = await readFile(inputPath);
    await writeFile(outputPath, Buffer.concat([Buffer.from(`${recipient}\0`), bytes.reverse()]));
  }
  async decrypt(inputPath: string, outputPath: string, identityFile: string): Promise<void> {
    const bytes = await readFile(inputPath);
    const separator = bytes.indexOf(0);
    if (bytes.subarray(0, separator).toString() !== identityFile) throw Object.assign(new Error('wrong key'), { code: 'age_decrypt_failed' });
    await writeFile(outputPath, Buffer.from(bytes.subarray(separator + 1)).reverse());
  }
}

afterEach(async () => {
  for (const closeable of closeables.splice(0)) {
    try { closeable.close(); } catch { /* already closed */ }
  }
  for (const repository of repositories.splice(0)) repository.close();
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
}, 30_000);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-restore-'));
  roots.push(root);
  const workspaceDir = join(root, 'workspace');
  const stateDir = join(root, 'state');
  const backupDir = join(root, 'backups');
  await mkdir(workspaceDir); await mkdir(stateDir);
  for (const name of ['TASKS', 'STUDY', 'NOTES', 'USER', 'MEMORY', 'INBOX']) {
    await writeFile(join(workspaceDir, `${name}.md`), `# ${name}\n\n`);
  }
  execFileSync('git', ['init', '--quiet'], { cwd: workspaceDir });
  execFileSync('git', ['config', 'user.name', 'Restore Tests'], { cwd: workspaceDir });
  execFileSync('git', ['config', 'user.email', 'restore@example.test'], { cwd: workspaceDir });
  execFileSync('git', ['add', '.'], { cwd: workspaceDir });
  execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: workspaceDir });
  const repository = await openRepository({ workspaceDir, stateDir, backupDir, telegramUserId: '42', timezone: 'Asia/Seoul' });
  repositories.push(repository);
  const outbox = new CalendarOutbox({
    stateDir, api: { async createSchedule() { throw new Error('unused'); } },
    caldav: { async listEvents() { return []; } },
  });
  const alerts = new AlertLedger(stateDir);
  const health = new SubsystemHealthStore(stateDir);
  closeables.push(outbox, alerts, health);
  return { root, workspaceDir, stateDir, backupDir, repository, outbox, health, age: new FakeAge() };
}

it('restores only into a newly created isolated directory and validates Git, Markdown, and SQLite', async () => {
  const f = await fixture();
  const backup = await createBackup({
    ...f, recipient: 'restore-key', identityFile: 'restore-key', ageRunner: f.age,
    now: () => new Date('2026-08-25T00:00:00.000Z'),
  });
  const restoreRoot = join(f.root, 'restores');
  await mkdir(restoreRoot);
  const restored = await restoreBackup({
    archivePath: backup.archivePath, restoreRoot, identityFile: 'restore-key', ageRunner: f.age,
  });
  expect(restored.restorePath).not.toBe(f.workspaceDir);
  expect(await readFile(join(restored.restorePath, 'workspace', 'TASKS.md'), 'utf8')).toBe('# TASKS\n\n');
  expect(execFileSync('git', ['fsck', '--full'], { cwd: join(restored.restorePath, 'workspace'), encoding: 'utf8' })).toBe('');
  f.outbox.close(); f.health.close();
}, 30_000);

it('rejects a wrong key without creating a restore destination', async () => {
  const f = await fixture();
  const backup = await createBackup({
    ...f, recipient: 'right-key', identityFile: 'right-key', ageRunner: f.age,
    now: () => new Date('2026-08-25T00:00:00.000Z'),
  });
  const restoreRoot = join(f.root, 'restores');
  await mkdir(restoreRoot);
  await expect(restoreBackup({
    archivePath: backup.archivePath, restoreRoot, identityFile: 'wrong-key', ageRunner: f.age,
  })).rejects.toMatchObject({ code: 'age_decrypt_failed' });
  expect(await import('node:fs/promises').then(fs => fs.readdir(restoreRoot))).toEqual([]);
  f.outbox.close(); f.health.close();
}, 30_000);

it('terminates a timed-out child with a stable bounded-process error', async () => {
  await expect(runExecFile({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    timeoutMs: 50,
  })).rejects.toMatchObject({ code: 'process_timeout' });
});
