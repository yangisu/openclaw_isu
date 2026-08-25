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
  BACKUP_ARCHIVE_LIMITS,
  cleanupBackupQuarantine,
  createBackup,
  verifyBackup,
  type AgeRunner,
} from '../../src/ops/backup.js';
import { openRepository, type WorkspaceRepository } from '../../src/workspace/repository.js';

const roots: string[] = [];
const repositories: WorkspaceRepository[] = [];
const closeables: Array<{ close(): void }> = [];

class FakeAge implements AgeRunner {
  constructor(
    readonly key = 'test-key',
    readonly mutate?: (bundle: ArchiveBundle) => void,
    readonly mutateRaw?: (bytes: Buffer) => Buffer,
  ) {}

  async encrypt(inputPath: string, outputPath: string, _recipient: string): Promise<void> {
    const bytes = await readFile(inputPath);
    await writeFile(outputPath, Buffer.concat([Buffer.from(`FAKEAGE:${this.key}:`), bytes.reverse()]));
  }

  async decrypt(inputPath: string, outputPath: string, identityFile: string): Promise<void> {
    const bytes = await readFile(inputPath);
    const prefix = Buffer.from(`FAKEAGE:${identityFile}:`);
    if (!bytes.subarray(0, prefix.length).equals(prefix)) throw Object.assign(new Error('wrong key'), { code: 'age_decrypt_failed' });
    let plaintext = Buffer.from(bytes.subarray(prefix.length)).reverse();
    if (this.mutateRaw) plaintext = this.mutateRaw(plaintext);
    if (this.mutate) {
      const bundle = decodeBundle(plaintext);
      this.mutate(bundle);
      plaintext = encodeBundle(bundle);
    }
    await writeFile(outputPath, plaintext);
  }
}

interface ArchiveBundle {
  files: Array<{ path: string; size: number; sha256: string; data: Buffer }>;
}

function decodeBundle(bytes: Buffer): ArchiveBundle {
  let position = 8;
  const files: ArchiveBundle['files'] = [];
  while (true) {
    const length = bytes.readUInt32BE(position); position += 4;
    if (length === 0) break;
    const header = JSON.parse(bytes.subarray(position, position + length).toString('utf8')) as {
      path: string; size: number; sha256: string;
    };
    position += length;
    files.push({ ...header, data: Buffer.from(bytes.subarray(position, position + header.size)) });
    position += header.size;
  }
  return { files };
}

function encodeBundle(bundle: ArchiveBundle): Buffer {
  const parts = [Buffer.from('OCPABK01')];
  for (const entry of bundle.files) {
    const header = Buffer.from(JSON.stringify({ path: entry.path, size: entry.size, sha256: entry.sha256 }));
    const length = Buffer.alloc(4); length.writeUInt32BE(header.byteLength);
    parts.push(length, header, entry.data);
  }
  parts.push(Buffer.alloc(4));
  return Buffer.concat(parts);
}

function mutateManifest(bundle: ArchiveBundle, mutation: (manifest: Record<string, unknown>) => void): void {
  const entry = bundle.files.find(file => file.path === 'manifest.json')!;
  const manifest = JSON.parse(entry.data.toString('utf8')) as Record<string, unknown>;
  mutation(manifest);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  entry.data = bytes;
  entry.size = bytes.byteLength;
  entry.sha256 = createHash('sha256').update(bytes).digest('hex');
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
  it('rejects hostile oversized, truncated, and trailing archive frames', async () => {
    const f = await fixture();
    const backup = await createBackup({ repository: f.repository, workspaceDir: f.workspaceDir, stateDir: f.stateDir,
      backupDir: f.backupDir, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      now: () => new Date('2026-08-25T00:00:00.000Z') });
    for (const [mutate, code] of [
      [(bytes: Buffer) => { const copy = Buffer.from(bytes); copy.writeUInt32BE(BACKUP_ARCHIVE_LIMITS.maxHeaderBytes + 1, 8); return copy; }, 'archive_header_limit'],
      [(bytes: Buffer) => bytes.subarray(0, bytes.length - 1), 'archive_truncated'],
      [(bytes: Buffer) => Buffer.concat([bytes, Buffer.from([1])]), 'archive_trailing_bytes'],
      [() => {
        const parts = [Buffer.from('OCPABK01')]; const emptyHash = createHash('sha256').update('').digest('hex');
        for (let index = 0; index <= BACKUP_ARCHIVE_LIMITS.maxEntries; index += 1) {
          const header = Buffer.from(JSON.stringify({ path: `workspace/memory/${String(index).padStart(5, '0')}.md`, size: 0, sha256: emptyHash }));
          const length = Buffer.alloc(4); length.writeUInt32BE(header.length); parts.push(length, header);
        }
        parts.push(Buffer.alloc(4)); return Buffer.concat(parts);
      }, 'archive_entry_limit'],
    ] as const) {
      await expect(verifyBackup({ archivePath: backup.archivePath, identityFile: 'test-key', ageRunner: new FakeAge('test-key', undefined, mutate) }))
        .rejects.toMatchObject({ code });
    }
  }, 30_000);

  it('quarantines plaintext on ACL failure and removes only safe quarantine entries after success', async () => {
    const f = await fixture();
    const failingAcl = {
      async verifyPrivateDirectory() {},
      async verifyBackupRoot() { throw Object.assign(new Error('unsafe ACL'), { code: 'acl_unsafe' }); },
    };
    await expect(createBackup({ repository: f.repository, workspaceDir: f.workspaceDir, stateDir: f.stateDir,
      backupDir: f.backupDir, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age, aclVerifier: failingAcl,
      now: () => new Date('2026-08-25T00:00:00.000Z') })).rejects.toMatchObject({ code: 'acl_unsafe' });
    const quarantine = join(f.stateDir, '.backup-quarantine');
    expect((await readdir(quarantine)).filter(name => name.startsWith('quarantine-'))).toHaveLength(1);
    const outside = join(f.root, 'outside-quarantine'); await mkdir(outside);
    const unsafe = join(quarantine, 'quarantine-00000000-0000-4000-8000-000000000000');
    await symlink(outside, unsafe, 'junction');
    await createBackup({ repository: f.repository, workspaceDir: f.workspaceDir, stateDir: f.stateDir,
      backupDir: f.backupDir, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      now: () => new Date('2026-08-25T00:00:00.000Z') });
    expect(await readdir(quarantine)).toEqual(['quarantine-00000000-0000-4000-8000-000000000000']);
    expect(await cleanupBackupQuarantine({ stateDir: f.stateDir })).toEqual([]);
  });

  it('syncs the encrypted file and containing directory before reporting recovery', async () => {
    const f = await fixture(); const events: string[] = [];
    await createBackup({ repository: f.repository, workspaceDir: f.workspaceDir, stateDir: f.stateDir,
      backupDir: f.backupDir, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      durability: { async syncFile() { events.push('file'); }, async syncDirectory() { events.push('directory'); } },
      health: { report() { events.push('report'); }, recover() { events.push('recover'); } } as never,
      now: () => new Date('2026-08-25T00:00:00.000Z') });
    expect(events).toEqual(['file', 'directory', 'recover']);
  });

  it('does not publish or recover when durability fails', async () => {
    const f = await fixture(); const events: string[] = [];
    await expect(createBackup({ repository: f.repository, workspaceDir: f.workspaceDir, stateDir: f.stateDir,
      backupDir: f.backupDir, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      durability: { async syncFile() { throw Object.assign(new Error('disk'), { code: 'EIO' }); }, async syncDirectory() {} },
      health: { report() { events.push('report'); }, recover() { events.push('recover'); } } as never,
      now: () => new Date('2026-08-25T00:00:00.000Z') })).rejects.toMatchObject({ code: 'EIO' });
    expect(events).toEqual(['report']);
    expect(await readdir(f.backupDir)).not.toContain('2026-08-25.age');
  });

  it('rejects a Markdown source that changes between read and identity verification', async () => {
    const f = await fixture(); let changed = false;
    await expect(createBackup({ repository: f.repository, workspaceDir: f.workspaceDir, stateDir: f.stateDir,
      backupDir: f.backupDir, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      sourceReadCheckpoint: async path => {
        if (!changed && path.endsWith('TASKS.md')) { changed = true; await writeFile(path, '# Tasks\n\nchanged\n'); }
      },
      now: () => new Date('2026-08-25T00:00:00.000Z') })).rejects.toMatchObject({ code: 'source_changed' });
    expect(await readdir(f.backupDir)).not.toContain('2026-08-25.age');
  });
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
          const bytes = Buffer.from(entry.data);
          bytes[Math.max(0, bytes.length - 100)] ^= 1;
          entry.data = bytes;
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

  it('rejects a configured workspace junction and an injected database reparse classification', async () => {
    const f = await fixture();
    const workspaceLink = join(f.root, 'workspace-link');
    await symlink(f.workspaceDir, workspaceLink, 'junction');
    await expect(createBackup({
      ...f, workspaceDir: workspaceLink,
      recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      now: () => new Date('2026-08-25T00:00:00.000Z'),
    })).rejects.toMatchObject({ code: 'source_root_unsafe' });

    await expect(createBackup({
      ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      now: () => new Date('2026-08-26T00:00:00.000Z'),
      pathSafety: {
        async isReparsePoint(path: string) { return path.endsWith('alerts.sqlite3'); },
      },
    })).rejects.toMatchObject({ code: 'source_reparse_rejected' });
    f.outbox.close(); f.alerts.close(); f.health.close();
  }, 30_000);

  it('rejects unknown, reordered, and required-entry-deficient manifests', async () => {
    const f = await fixture();
    const backup = await createBackup({
      ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      now: () => new Date('2026-08-25T00:00:00.000Z'),
    });
    const mutations: Array<(bundle: ArchiveBundle) => void> = [
      bundle => mutateManifest(bundle, manifest => { manifest.unexpected = true; }),
      bundle => mutateManifest(bundle, manifest => { manifest.version = 2; }),
      bundle => mutateManifest(bundle, manifest => { manifest.schemaVersion = 'changed'; }),
      bundle => mutateManifest(bundle, manifest => {
        (manifest.files as unknown[]).reverse();
      }),
      bundle => {
        mutateManifest(bundle, manifest => {
          manifest.files = (manifest.files as Array<{ path: string }>).filter(
            entry => entry.path !== 'state/operations.sqlite3',
          );
          manifest.sqlite = (manifest.sqlite as Array<{ path: string }>).filter(
            entry => entry.path !== 'state/operations.sqlite3',
          );
        });
        bundle.files = bundle.files.filter(entry => entry.path !== 'state/operations.sqlite3');
      },
    ];
    for (const mutate of mutations) {
      await expect(verifyBackup({
        archivePath: backup.archivePath, identityFile: 'test-key',
        ageRunner: new FakeAge('test-key', mutate), health: f.health,
      })).rejects.toMatchObject({ code: 'manifest_contract_invalid' });
    }
    f.outbox.close(); f.alerts.close(); f.health.close();
  }, 30_000);
});
