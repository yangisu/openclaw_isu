import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { SubsystemHealthStore } from '../../src/state/health.js';
import { AlertLedger } from '../../src/state/alerts.js';
import { CalendarOutbox } from '../../src/calendar/outbox.js';
import { createBackup, RESTORE_EVIDENCE_MAX_BYTES, restoreBackup, verifyScheduledRestore, type AgeRunner } from '../../src/ops/backup.js';
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

it('restores a credential-free reachable Git snapshot without dangling secret objects', async () => {
  const f = await fixture();
  execFileSync('git', ['remote', 'add', 'origin', 'https://backup-user:backup-password@example.test/repo.git'], {
    cwd: f.workspaceDir,
  });
  const dangling = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: f.workspaceDir, input: 'DANGLING-SECRET-CANARY', encoding: 'utf8',
  }).trim();
  const backup = await createBackup({
    ...f, recipient: 'git-key', identityFile: 'git-key', ageRunner: f.age,
    secretCanaries: ['DANGLING-SECRET-CANARY'],
    now: () => new Date('2026-08-25T00:00:00.000Z'),
  });
  const restoreRoot = join(f.root, 'git-restores');
  await mkdir(restoreRoot);
  const restored = await restoreBackup({
    archivePath: backup.archivePath, restoreRoot, identityFile: 'git-key', ageRunner: f.age,
  });
  const restoredWorkspace = join(restored.restorePath, 'workspace');
  expect(execFileSync('git', ['remote'], { cwd: restoredWorkspace, encoding: 'utf8' }).trim()).toBe('');
  expect(() => execFileSync('git', ['cat-file', '-e', dangling], {
    cwd: restoredWorkspace, stdio: 'ignore',
  })).toThrow();
  expect(await readFile(join(restored.restorePath, 'git', 'repository.bundle'))).not.toContain('backup-password');
  f.outbox.close(); f.health.close();
}, 30_000);

it('rejects a canary in reachable Git history even after the working file is removed', async () => {
  const f = await fixture();
  await writeFile(join(f.workspaceDir, 'history-secret.txt'), 'REACHABLE-HISTORY-CANARY\n');
  execFileSync('git', ['add', 'history-secret.txt'], { cwd: f.workspaceDir });
  execFileSync('git', ['commit', '--quiet', '-m', 'secret history'], { cwd: f.workspaceDir });
  await rm(join(f.workspaceDir, 'history-secret.txt'));
  execFileSync('git', ['add', '-u'], { cwd: f.workspaceDir });
  execFileSync('git', ['commit', '--quiet', '-m', 'remove secret'], { cwd: f.workspaceDir });
  await expect(createBackup({
    ...f, recipient: 'git-key', identityFile: 'git-key', ageRunner: f.age,
    secretCanaries: ['REACHABLE-HISTORY-CANARY'],
    now: () => new Date('2026-08-25T00:00:00.000Z'),
  })).rejects.toMatchObject({ code: 'secret_material_detected' });
  f.outbox.close(); f.health.close();
}, 30_000);

it('records deterministic daily sample and monthly full restore evidence', async () => {
  const f = await fixture();
  await mkdir(join(f.workspaceDir, 'memory'));
  await writeFile(join(f.workspaceDir, 'memory', '2026-08-25.md'), [
    '# Daily Memory', '', '### D-090300-001 Morning note', '- type: "daily"',
    '- entry_at: 2026-08-25T09:03:00+09:00', '- created_at: 2026-08-25T09:03:00+09:00',
    '- updated_at: 2026-08-25T09:03:00+09:00', '- source: "telegram"', '', 'Daily body', '',
  ].join('\n'));
  const backup = await createBackup({ ...f, recipient: 'schedule-key', identityFile: 'schedule-key', ageRunner: f.age,
    now: () => new Date('2026-08-25T00:00:00.000Z') });
  const restoreRoot = join(f.root, 'scheduled-restores'); await mkdir(restoreRoot);
  for (const kind of ['daily-sample', 'monthly-full'] as const) {
    const result = await verifyScheduledRestore({ archivePath: backup.archivePath, restoreRoot, stateDir: f.stateDir,
      identityFile: 'schedule-key', ageRunner: f.age, kind,
      now: () => new Date('2026-08-25T12:00:00.000Z') });
    expect(result).toMatchObject({ restoreRetained: false }); expect(result).not.toHaveProperty('restorePath');
  }
  const records = (await readFile(join(f.stateDir, 'backup-restore-verifications.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  expect(records.map(record => [record.kind, record.status, record.gitHead])).toEqual([
    ['daily-sample', 'passed', backup.manifest.gitHead], ['monthly-full', 'passed', backup.manifest.gitHead],
  ]);
  expect(records[0].sample).toMatchObject({ path: 'workspace/memory/2026-08-25.md', recordId: 'D-090300-001' });
  expect(records[1].full).toMatchObject({ fileCount: expect.any(Number), treeSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  expect((await readdir(restoreRoot)).filter(name => name.startsWith('restore-'))).toEqual([]);
  f.outbox.close(); f.health.close();
}, 30_000);

it('validates and restores nonempty archived daily Markdown', async () => {
  const f = await fixture();
  await mkdir(join(f.workspaceDir, 'archive'));
  await writeFile(join(f.workspaceDir, 'archive', '2026-08-24.md'), [
    '# Daily Archive', '', '### D-080000-001 Archived note', '- type: "daily"',
    '- entry_at: 2026-08-24T08:00:00+09:00', '- created_at: 2026-08-24T08:00:00+09:00',
    '- updated_at: 2026-08-24T08:00:00+09:00', '- source: "telegram"', '', 'Archived body', '',
  ].join('\n'));
  for (const name of ['TASKS.md', 'STUDY.md', 'NOTES.md', 'USER.md', 'MEMORY.md', 'INBOX.md']) {
    await writeFile(join(f.workspaceDir, 'archive', name), await readFile(join(f.workspaceDir, name)));
  }
  const backup = await createBackup({ ...f, recipient: 'archive-key', identityFile: 'archive-key', ageRunner: f.age,
    now: () => new Date('2026-08-25T00:00:00.000Z') });
  const restoreRoot = join(f.root, 'archive-restore'); await mkdir(restoreRoot);
  const restored = await restoreBackup({ archivePath: backup.archivePath, restoreRoot, identityFile: 'archive-key', ageRunner: f.age });
  expect(await readFile(join(restored.restorePath, 'workspace', 'archive', '2026-08-24.md'), 'utf8')).toContain('D-080000-001');
  expect(await readFile(join(restored.restorePath, 'workspace', 'archive', 'TASKS.md'), 'utf8')).toContain('# TASKS');
  f.outbox.close(); f.health.close();
}, 30_000);

it('records failed daily sampling and cleans its temporary restore', async () => {
  const f = await fixture();
  const backup = await createBackup({ ...f, recipient: 'failure-key', identityFile: 'failure-key', ageRunner: f.age,
    now: () => new Date('2026-08-25T00:00:00.000Z') });
  const restoreRoot = join(f.root, 'failed-sample'); await mkdir(restoreRoot);
  await expect(verifyScheduledRestore({ archivePath: backup.archivePath, restoreRoot, stateDir: f.stateDir,
    identityFile: 'failure-key', ageRunner: f.age, kind: 'daily-sample',
    now: () => new Date('2026-08-25T12:00:00.000Z') })).rejects.toMatchObject({ code: 'restore_sample_missing' });
  const records = (await readFile(join(f.stateDir, 'backup-restore-verifications.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  expect(records).toEqual([expect.objectContaining({ kind: 'daily-sample', status: 'failed', errorCode: 'restore_sample_missing' })]);
  expect((await readdir(restoreRoot)).filter(name => name.startsWith('restore-'))).toEqual([]);
  f.outbox.close(); f.health.close();
}, 30_000);

it('atomically compacts bounded restore evidence and cleans evidence temps on failure', async () => {
  const f = await fixture();
  const backup = await createBackup({ ...f, recipient: 'rotation-key', identityFile: 'rotation-key', ageRunner: f.age,
    now: () => new Date('2026-08-25T00:00:00.000Z') });
  const evidence = join(f.stateDir, 'backup-restore-verifications.jsonl');
  const line = `${JSON.stringify({ version: 1, status: 'passed', padding: 'x'.repeat(1024) })}\n`;
  await writeFile(evidence, line.repeat(Math.floor((RESTORE_EVIDENCE_MAX_BYTES - 4096) / Buffer.byteLength(line))), { mode: 0o600 });
  const restoreRoot = join(f.root, 'rotated-evidence'); await mkdir(restoreRoot);
  await verifyScheduledRestore({ archivePath: backup.archivePath, restoreRoot, stateDir: f.stateDir,
    identityFile: 'rotation-key', ageRunner: f.age, kind: 'monthly-full' });
  expect((await stat(evidence)).size).toBeLessThanOrEqual(RESTORE_EVIDENCE_MAX_BYTES / 2 + 4096);

  await expect(verifyScheduledRestore({ archivePath: backup.archivePath, restoreRoot, stateDir: f.stateDir,
    identityFile: 'rotation-key', ageRunner: f.age, kind: 'monthly-full',
    durability: { async syncFile() { throw Object.assign(new Error('disk'), { code: 'EIO' }); }, async syncDirectory() {} } }))
    .rejects.toBeDefined();
  expect((await readdir(f.stateDir)).filter(name => name.startsWith('.backup-restore-evidence-'))).toEqual([]);
  f.outbox.close(); f.health.close();
}, 30_000);
