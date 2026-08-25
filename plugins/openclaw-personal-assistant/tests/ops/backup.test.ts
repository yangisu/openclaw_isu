import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, readFile, mkdir, mkdtemp, readdir, rename, rm, stat, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
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
  classifyDirectorySyncFailure,
  createBackup,
  parseNtfsFileIdentity,
  parseWindowsReparseClassification,
  restoreBackup,
  validateWindowsBackupAcl,
  verifyBackup,
  writeAll,
  type AgeRunner,
  type FileIdentityEvidence,
  type IdentityBoundDeleter,
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

async function cloneCommittedArchive(source: string, destination: string): Promise<void> {
  await copyFile(source, destination);
  const record = JSON.parse(await readFile(`${source}.committed`, 'utf8')) as Record<string, unknown>;
  record.archive = destination.split(/[\\/]/).at(-1)!;
  await writeFile(`${destination}.committed`, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function calendarDraft(uid = 'backup-event') {
  const event = {
    calendarId: 'personal', uid,
    dtstart: '2026-08-25T09:00:00+09:00', dtend: '2026-08-25T10:00:00+09:00',
    summary: 'Backup coverage',
  };
  return { calendarId: event.calendarId, uid, payloadIcal: buildIcal(event), payloadHash: semanticEventHash(event) };
}

class PortableTestIdentityDeleter implements IdentityBoundDeleter {
  readonly deletes: Array<{ path: string; expected: FileIdentityEvidence }> = [];
  async capture(path: string): Promise<FileIdentityEvidence> {
    const evidence = await stat(path, { bigint: true });
    return { volumeId: evidence.dev.toString(), fileId: evidence.ino.toString() };
  }
  async deleteOpened(path: string, expected: FileIdentityEvidence): Promise<void> {
    this.deletes.push({ path, expected });
    const actual = await this.capture(path);
    if (actual.volumeId !== expected.volumeId || actual.fileId !== expected.fileId) {
      throw Object.assign(new Error('identity changed'), { code: 'retention_identity_changed' });
    }
    await unlink(path);
  }
}

afterEach(async () => {
  for (const closeable of closeables.splice(0)) {
    try { closeable.close(); } catch { /* already closed */ }
  }
  for (const repository of repositories.splice(0)) repository.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('encrypted verified backup', () => {
  it('completes short writes and rejects a zero-progress writer', async () => {
    const written: number[] = [];
    const handle = { async write(_bytes: Uint8Array, offset: number, length: number) {
      const bytesWritten = Math.min(3, length); written.push(offset); return { bytesWritten, buffer: Buffer.alloc(0) };
    } };
    await expect(writeAll(handle as never, Buffer.from('abcdefgh'), 7)).resolves.toBe(15);
    expect(written).toEqual([0, 3, 6]);
    await expect(writeAll({ async write() { return { bytesWritten: 0, buffer: Buffer.alloc(0) }; } } as never, Buffer.from('x'), 0))
      .rejects.toMatchObject({ code: 'archive_write_failed' });
  });

  it('classifies the production D-drive directory-sync fallback as unsupported and observable', () => {
    expect(classifyDirectorySyncFailure('D:\\openclaw_setting\\backups', 'EPERM', 'win32')).toBe('unsupported');
    expect(classifyDirectorySyncFailure('C:\\temp', 'EPERM', 'win32')).toBe('non-target-fallback');
    expect(classifyDirectorySyncFailure('/mnt/d/openclaw_setting/backups', 'EPERM', 'linux')).toBe('unsupported');
  });

  it('independently rejects a corrupted streamed destination', async () => {
    const f = await fixture(); let corrupted = false;
    await expect(createBackup({ ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      destinationWriteCheckpoint: async path => {
        if (!corrupted && path.endsWith('TASKS.md')) { corrupted = true; await writeFile(path, '# Corrupt\n'); }
      }, now: () => new Date('2026-08-25T00:00:00.000Z') })).rejects.toMatchObject({ code: 'destination_mismatch' });
  }, 30_000);

  it('rejects unknown archived Markdown names instead of treating them as daily records', async () => {
    const f = await fixture(); await writeFile(join(f.workspaceDir, 'archive', 'unknown.md'), '# Unknown\n\n');
    await expect(createBackup({ ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      now: () => new Date('2026-08-25T00:00:00.000Z') })).rejects.toMatchObject({ code: 'markdown_path_invalid' });
  }, 30_000);
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
  }, 30_000);

  it('syncs the encrypted file and containing directory before reporting recovery', async () => {
    const f = await fixture(); const events: string[] = [];
    await createBackup({ repository: f.repository, workspaceDir: f.workspaceDir, stateDir: f.stateDir,
      backupDir: f.backupDir, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      durability: { async syncFile() { events.push('file'); }, async syncDirectory() { events.push('directory'); } },
      durabilityDiagnostic(event) { events.push(event); },
      health: { report() { events.push('report'); }, recover() { events.push('recover'); } } as never,
      now: () => new Date('2026-08-25T00:00:00.000Z') });
    expect(events.at(-1)).toBe('recover');
    expect(events.filter(event => event === 'file')).toHaveLength(3);
    expect(events.filter(event => event === 'directory')).toHaveLength(3);
    expect(events.indexOf('recover')).toBeGreaterThan(events.lastIndexOf('directory'));
  });

  it('requires a durable hash-bound commit record for every recovery operation', async () => {
    const f = await fixture();
    const backup = await createBackup({ ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      now: () => new Date('2026-08-25T00:00:00.000Z') });
    const committedPath = `${backup.archivePath}.committed`;
    const original = await readFile(committedPath, 'utf8');
    await rm(committedPath);
    await expect(verifyBackup({ archivePath: backup.archivePath, identityFile: 'test-key', ageRunner: f.age }))
      .rejects.toMatchObject({ code: 'archive_uncommitted' });
    await writeFile(committedPath, original);
    await writeFile(backup.archivePath, Buffer.concat([await readFile(backup.archivePath), Buffer.from([0])]));
    await expect(verifyBackup({ archivePath: backup.archivePath, identityFile: 'test-key', ageRunner: f.age }))
      .rejects.toMatchObject({ code: 'archive_commit_mismatch' });
  }, 30_000);

  it('rejects invalid, unknown-key, and stale-manifest commit evidence', async () => {
    const f = await fixture();
    const backup = await createBackup({ ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      now: () => new Date('2026-08-25T00:00:00.000Z') });
    const path = `${backup.archivePath}.committed`;
    const original = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    for (const [mutation, code] of [
      [(record: Record<string, unknown>) => { record.version = 2; }, 'archive_commit_invalid'],
      [(record: Record<string, unknown>) => { record.extra = true; }, 'archive_commit_invalid'],
      [(record: Record<string, unknown>) => { record.manifestHash = '0'.repeat(64); }, 'archive_commit_mismatch'],
    ] as const) {
      const changed = { ...original }; mutation(changed);
      await writeFile(path, `${JSON.stringify(changed)}\n`);
      await expect(verifyBackup({ archivePath: backup.archivePath, identityFile: 'test-key', ageRunner: f.age }))
        .rejects.toMatchObject({ code });
    }
  }, 30_000);

  it('does not recover health until the positive commit record is directory durable', async () => {
    const f = await fixture(); const events: string[] = []; let directorySyncs = 0;
    await expect(createBackup({ ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      durability: {
        async syncFile(path) { events.push(`file:${path.split(/[\\/]/).at(-1)}`); },
        async syncDirectory() { events.push(`directory:${++directorySyncs}`); if (directorySyncs === 2) throw Object.assign(new Error('disk'), { code: 'EIO' }); },
      }, health: { report() { events.push('report'); }, recover() { events.push('recover'); } } as never,
      now: () => new Date('2026-08-25T00:00:00.000Z') })).rejects.toBeDefined();
    expect(events).not.toContain('recover');
    await expect(verifyBackup({ archivePath: join(f.backupDir, '2026-08-25.age'), identityFile: 'test-key', ageRunner: f.age }))
      .rejects.toMatchObject({ code: expect.stringMatching(/^archive_(?:uncommitted|commit_missing)$/) });
  }, 30_000);

  it('returns publication_unknown without rollback when the positive commit sync is indeterminate', async () => {
    const f = await fixture(); const health: string[] = []; let directorySyncs = 0; let renames = 0; let unlinks = 0;
    const failure = await createBackup({ ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      durability: {
        async syncFile() {},
        async syncDirectory() { directorySyncs += 1; if (directorySyncs >= 3) throw Object.assign(new Error('indeterminate'), { code: 'EIO' }); },
      }, publicationOps: {
        async rename(source, destination) { renames += 1; await rename(source, destination); },
        async unlink() { unlinks += 1; throw new Error('rollback must not run after commit attempt'); },
      }, health: {
        report(error) { health.push(`report:${error.errorCode}`); }, recover() { health.push('recover'); },
      } as never, now: () => new Date('2026-08-25T00:00:00.000Z'),
    }).then(() => undefined, error => error as { code?: string; outcome?: string });
    expect(failure).toMatchObject({ code: 'publication_unknown', outcome: 'unknown' });
    expect({ renames, unlinks }).toEqual({ renames: 2, unlinks: 0 });
    expect(health).toEqual(['report:BACKUP_PUBLICATION_UNKNOWN']);
    expect(await readdir(f.backupDir)).toEqual(expect.arrayContaining([
      '2026-08-25.age', '2026-08-25.age.committed', '2026-08-25.age.uncommitted',
    ]));
  }, 30_000);

  it('blocks concurrent verification through the irreversible commit attempt', async () => {
    const f = await fixture(); let directorySyncs = 0; let entered!: () => void; let release!: () => void;
    const committing = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const durability = { async syncFile() {}, async syncDirectory() {
      directorySyncs += 1; if (directorySyncs === 3) { entered(); await held; }
    } };
    const creating = createBackup({ ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age, durability,
      now: () => new Date('2026-08-25T00:00:00.000Z') });
    await committing; let verified = false;
    const verification = verifyBackup({ archivePath: join(f.backupDir, '2026-08-25.age'), identityFile: 'test-key', ageRunner: f.age,
      durability }).then(result => { verified = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 50)); expect(verified).toBe(false);
    release(); await creating;
    await expect(verification).resolves.toMatchObject({ archivePath: join(f.backupDir, '2026-08-25.age') });
  }, 30_000);

  it('prevents retention until an unknown commit attempt is explicitly reconciled', async () => {
    const f = await fixture(); let directorySyncs = 0;
    const durability = { async syncFile() {}, async syncDirectory() {
      directorySyncs += 1; if (directorySyncs === 3) throw Object.assign(new Error('unknown'), { code: 'EIO' });
    } };
    await expect(createBackup({ ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      durability, health: f.health, now: () => new Date('2026-08-25T00:00:00.000Z') }))
      .rejects.toMatchObject({ code: 'publication_unknown', outcome: 'unknown' });
    await expect(applyRetention({ backupDir: f.backupDir, identityFile: 'test-key', ageRunner: f.age,
      health: f.health, keep: 2 })).rejects.toMatchObject({ code: 'publication_unknown', outcome: 'unknown' });
    await expect(verifyBackup({ archivePath: join(f.backupDir, '2026-08-25.age'), identityFile: 'test-key', ageRunner: f.age,
      health: f.health, durability })).resolves.toBeDefined();
    expect(f.health.listActive()).toEqual([]);
  }, 30_000);

  it('keeps torn commit evidence in unknown health instead of downgrading it to definite failure', async () => {
    const f = await fixture(); let directorySyncs = 0;
    const durability = { async syncFile() {}, async syncDirectory() {
      directorySyncs += 1; if (directorySyncs === 3) throw Object.assign(new Error('unknown'), { code: 'EIO' });
    } };
    await expect(createBackup({ ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      durability, health: f.health, now: () => new Date('2026-08-25T00:00:00.000Z') }))
      .rejects.toMatchObject({ code: 'publication_unknown' });
    await writeFile(join(f.backupDir, '2026-08-25.age.committed'), '{"version":1');
    await expect(verifyBackup({ archivePath: join(f.backupDir, '2026-08-25.age'), identityFile: 'test-key', ageRunner: f.age,
      health: f.health, durability })).rejects.toMatchObject({ code: 'archive_commit_invalid' });
    expect(f.health.listActive()).toEqual([expect.objectContaining({ errorCode: 'BACKUP_PUBLICATION_UNKNOWN', target: 'backup' })]);
  }, 30_000);

  it('leaves no eligible archive at every commit-record publication crash point', async () => {
    for (const point of ['archive-directory-sync', 'commit-file-sync'] as const) {
      const f = await fixture(); const health: string[] = []; let fileSyncs = 0; let directorySyncs = 0; let renames = 0;
      const failure = await createBackup({ ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
        durability: {
          async syncFile() {
            if (++fileSyncs === 3 && point === 'commit-file-sync') throw Object.assign(new Error('crash'), { code: 'EIO' });
          },
          async syncDirectory() {
            directorySyncs += 1;
            if (point === 'archive-directory-sync' && directorySyncs === 2) throw Object.assign(new Error('crash'), { code: 'EIO' });
          },
        },
        publicationOps: {
          async rename(source, destination) {
            renames += 1;
            await rename(source, destination);
          },
          async unlink(path) { await unlink(path); },
        },
        health: { report() { health.push('report'); }, recover() { health.push('recover'); } } as never,
        now: () => new Date('2026-08-25T00:00:00.000Z') }).then(() => undefined, error => error as { code?: string });
      expect(failure).toBeDefined();
      expect(health).toEqual(['report']);
      expect(await readdir(f.backupDir)).toContain('2026-08-25.age.uncommitted');
      expect(await readdir(f.backupDir)).not.toContain('2026-08-25.age');
      await expect(verifyBackup({ archivePath: join(f.backupDir, '2026-08-25.age'), identityFile: 'test-key', ageRunner: f.age }))
        .rejects.toMatchObject({ code: 'archive_uncommitted' });
    }
  }, 30_000);

  it('retains the durable marker and reports rollback failure when rollback directory sync fails', async () => {
    const f = await fixture(); let directorySyncs = 0; const health: string[] = [];
    await expect(createBackup({ ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      durability: {
        async syncFile() {},
        async syncDirectory() { directorySyncs += 1; if (directorySyncs >= 2) throw Object.assign(new Error('sync unavailable'), { code: 'EIO' }); },
      }, health: { report() { health.push('report'); }, recover() { health.push('recover'); } } as never,
      now: () => new Date('2026-08-25T00:00:00.000Z') }))
      .rejects.toMatchObject({ code: 'archive_rollback_failed' });
    expect(directorySyncs).toBeGreaterThanOrEqual(2);
    expect(await readdir(f.backupDir)).toContain('2026-08-25.age.uncommitted');
    expect(health).toEqual(['report']);
  }, 30_000);

  it('reconciles a valid recovered archive and commit pair despite stale audit marker residue', async () => {
    const f = await fixture(); const health: string[] = [];
    const backup = await createBackup({ ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      now: () => new Date('2026-08-25T00:00:00.000Z') });
    await writeFile(`${backup.archivePath}.uncommitted`, 'publication pending\n', { mode: 0o600 });
    await expect(verifyBackup({ archivePath: backup.archivePath, identityFile: 'test-key', ageRunner: f.age,
      health: { report() { health.push('report'); }, recover() { health.push('recover'); } } as never }))
      .resolves.toMatchObject({ archivePath: backup.archivePath });
    const restoreRoot = join(f.root, 'marker-restore'); await mkdir(restoreRoot);
    await expect(restoreBackup({ archivePath: backup.archivePath, restoreRoot, identityFile: 'test-key', ageRunner: f.age }))
      .resolves.toMatchObject({ restorePath: expect.any(String) });
    expect((await applyRetention({ backupDir: f.backupDir, identityFile: 'test-key', ageRunner: f.age, keep: 2 })).retained)
      .toContain(backup.archivePath);
    expect(health).toEqual(['recover']);
  }, 30_000);

  it('reconciles success from durable commit evidence if post-publication health recovery throws', async () => {
    const f = await fixture(); let recoveries = 0; const diagnostics: string[] = [];
    const backup = await createBackup({ ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      health: { report() { throw new Error('must not report committed backup as failed'); }, recover() { recoveries += 1; throw new Error('journal unavailable'); } } as never,
      healthDiagnostic(event) { diagnostics.push(event); },
      now: () => new Date('2026-08-25T00:00:00.000Z') });
    expect(recoveries).toBe(1);
    expect(diagnostics).toEqual(['health-recovery-failed']);
    await expect(verifyBackup({ archivePath: backup.archivePath, identityFile: 'test-key', ageRunner: f.age }))
      .resolves.toMatchObject({ archivePath: backup.archivePath });
  }, 30_000);

  it('does not recover health when directory durability is unsupported', async () => {
    const f = await fixture(); const events: string[] = [];
    await expect(createBackup({ ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      durability: { async syncFile() {}, async syncDirectory() { return 'unsupported' as const; } },
      health: { report() { events.push('report'); }, recover() { events.push('recover'); } } as never,
      now: () => new Date('2026-08-25T00:00:00.000Z') })).rejects.toMatchObject({ code: 'archive_directory_sync_unsupported' });
    expect(events).toEqual(['report']);
    expect(await readdir(f.backupDir)).toContain('2026-08-25.age.uncommitted');
    expect(await readdir(f.backupDir)).not.toContain('2026-08-25.age');
  }, 30_000);

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

  it('rolls back a post-rename directory-sync failure and surfaces rollback failure safely', async () => {
    const rolledBack = await fixture(); const events: string[] = []; let directorySyncs = 0;
    await expect(createBackup({ ...rolledBack, recipient: 'age1test', identityFile: 'test-key', ageRunner: rolledBack.age,
      durability: { async syncFile() {}, async syncDirectory() { if (++directorySyncs >= 2) throw Object.assign(new Error('disk'), { code: 'EIO' }); } },
      health: { report() { events.push('report'); }, recover() { events.push('recover'); } } as never,
      now: () => new Date('2026-08-25T00:00:00.000Z') })).rejects.toMatchObject({ code: 'archive_rollback_failed' });
    expect(events).toEqual(['report']);
    expect(await readdir(rolledBack.backupDir)).toContain('2026-08-25.age.uncommitted');
    expect(await readdir(rolledBack.backupDir)).not.toContain('2026-08-25.age');

    const stuck = await fixture(); let renames = 0; let stuckDirectorySyncs = 0;
    await expect(createBackup({ ...stuck, recipient: 'age1test', identityFile: 'test-key', ageRunner: stuck.age,
      durability: { async syncFile() {}, async syncDirectory() { if (++stuckDirectorySyncs >= 2) throw Object.assign(new Error('disk'), { code: 'EIO' }); } },
      publicationOps: {
        async rename(source, destination) { if (++renames === 1) await rename(source, destination); else throw new Error('rollback rename denied'); },
        async unlink() { throw new Error('rollback unlink denied'); },
      }, now: () => new Date('2026-08-25T00:00:00.000Z') }))
      .rejects.toMatchObject({ code: 'archive_rollback_failed' });
    expect(await readdir(stuck.backupDir)).toEqual(expect.arrayContaining(['2026-08-25.age', '2026-08-25.age.uncommitted']));
    const eligibilityHealth: string[] = [];
    await expect(verifyBackup({ archivePath: join(stuck.backupDir, '2026-08-25.age'), identityFile: 'test-key', ageRunner: stuck.age,
      health: { report() { eligibilityHealth.push('report'); }, recover() { eligibilityHealth.push('recover'); } } as never }))
      .rejects.toMatchObject({ code: 'archive_uncommitted' });
    expect(eligibilityHealth).toEqual(['report']);
    const restoreRoot = join(stuck.root, 'stuck-restore'); await mkdir(restoreRoot);
    await expect(restoreBackup({ archivePath: join(stuck.backupDir, '2026-08-25.age'), restoreRoot, identityFile: 'test-key', ageRunner: stuck.age }))
      .rejects.toMatchObject({ code: 'archive_uncommitted' });
    const retained = await applyRetention({ backupDir: stuck.backupDir, identityFile: 'test-key', ageRunner: stuck.age, keep: 2 });
    expect(retained.retained).toEqual([]);
  }, 30_000);

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

  it('rejects oversized sources before allocation and detects canaries across stream chunks', async () => {
    const oversized = await fixture();
    await truncate(join(oversized.workspaceDir, 'NOTES.md'), BACKUP_ARCHIVE_LIMITS.maxFileBytes + 1);
    await expect(createBackup({ ...oversized, recipient: 'age1test', identityFile: 'test-key', ageRunner: oversized.age,
      now: () => new Date('2026-08-25T00:00:00.000Z') })).rejects.toMatchObject({ code: 'source_size_limit' });
    const boundary = await fixture(); const canary = 'BOUNDARY-CANARY-123456789';
    await writeFile(join(boundary.workspaceDir, 'NOTES.md'), `${'x'.repeat(65_530)}${canary}\n`);
    await expect(createBackup({ ...boundary, recipient: 'age1test', identityFile: 'test-key', ageRunner: boundary.age,
      secretCanaries: [canary], now: () => new Date('2026-08-25T00:00:00.000Z') }))
      .rejects.toMatchObject({ code: 'secret_material_detected' });
  }, 30_000);

  it('validates authoritative Windows reparse and ACL evidence', () => {
    expect(parseWindowsReparseClassification(' True\r\n')).toBe(true);
    expect(parseWindowsReparseClassification('false')).toBe(false);
    expect(() => parseWindowsReparseClassification('unknown')).toThrowError(expect.objectContaining({ code: 'reparse_classification_failed' }));
    const valid = { currentSid: 'S-1-5-21-100', ownerSid: 'S-1-5-21-100', protected: true,
      rules: [{ sid: 'S-1-5-21-100', inherited: false, type: 'Allow' }, { sid: 'S-1-5-32-544', inherited: false, type: 'Allow' }] };
    expect(() => validateWindowsBackupAcl(JSON.stringify(valid))).not.toThrow();
    for (const mutation of [
      { ownerSid: 'S-1-5-21-999' }, { rules: valid.rules.slice(0, 1) },
      { rules: [...valid.rules, { sid: 'S-1-5-18', inherited: false, type: 'Allow' }] },
      { rules: valid.rules.map((rule, index) => index ? { ...rule, type: 'Deny' } : rule) },
      { protected: false }, { rules: valid.rules.map((rule, index) => index ? { ...rule, inherited: true } : rule) },
    ]) expect(() => validateWindowsBackupAcl(JSON.stringify({ ...valid, ...mutation }))).toThrowError(expect.objectContaining({ code: 'acl_unsafe' }));
  });

  it('strictly parses production NTFS volume and file identity evidence', () => {
    expect(parseNtfsFileIdentity('00ABCDEF|0123456789ABCDEF\r\n')).toEqual({ volumeId: '00ABCDEF', fileId: '0123456789ABCDEF' });
    expect(() => parseNtfsFileIdentity('00abcdef|1')).toThrowError(expect.objectContaining({ code: 'retention_identity_delete_unavailable' }));
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

  it('takes a consistent online SQLite backup while an outbox writer commits under quiesce', async () => {
    const f = await fixture(); let entered!: () => void; const locked = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    const backupPromise = createBackup({ ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      snapshotCheckpoint: async phase => { if (phase === 'locked') { entered(); await hold; } },
      now: () => new Date('2026-08-25T00:00:00.000Z') });
    await locked;
    const prepared = f.outbox.prepare(calendarDraft('backup-event'));
    f.outbox.confirm(prepared.requestId, '42', prepared.payloadHash); await f.outbox.submit(prepared.requestId, '42');
    release(); const backup = await backupPromise;
    f.clock.now = new Date('2026-09-25T00:00:01.000Z');
    expect(f.outbox.pruneSucceeded(backup.outboxEvidence)).toContain(prepared.requestId);
  }, 30_000);

  it('quarantines staged plaintext after abort or post-encryption verification failure and never publishes', async () => {
    const controller = new AbortController(); controller.abort();
    for (const scenario of [
      { signal: controller.signal, ageRunner: {
        async encrypt(_input: string, _output: string, _recipient: string, signal?: AbortSignal) {
          expect(signal?.aborted).toBe(true); throw Object.assign(new Error('aborted'), { code: 'process_aborted' });
        }, async decrypt() { throw new Error('unreachable'); },
      } as AgeRunner },
      { ageRunner: new FakeAge('test-key', bundle => { const entry = bundle.files.find(file => file.path === 'workspace/TASKS.md')!; entry.data[0] ^= 1; }) },
    ]) {
      const f = await fixture();
      await expect(createBackup({ ...f, recipient: 'age1test', identityFile: 'test-key', ...scenario,
        now: () => new Date('2026-08-25T00:00:00.000Z') })).rejects.toBeDefined();
      expect(await readdir(f.backupDir)).not.toContain('2026-08-25.age');
      expect((await readdir(join(f.stateDir, '.backup-quarantine'))).some(name => name.startsWith('quarantine-'))).toBe(true);
    }
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
    const f = await fixture(); const identityDeleter = new PortableTestIdentityDeleter();
    const newest = await createBackup({
      ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      now: () => new Date('2026-08-25T00:00:00.000Z'),
    });
    await cloneCommittedArchive(newest.archivePath, join(f.backupDir, '2026-08-24.age'));
    await cloneCommittedArchive(newest.archivePath, join(f.backupDir, '2026-08-23.age'));
    const result = await applyRetention({
      backupDir: f.backupDir, identityFile: 'test-key', ageRunner: f.age, keep: 2, health: f.health, identityDeleter,
    });
    expect(result.deleted.map(path => path.split(/[\\/]/).at(-1))).toEqual(['2026-08-23.age']);
    await expect(stat(join(f.backupDir, '2026-08-24.age'))).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(stat(join(f.backupDir, '2026-08-25.age'))).resolves.toMatchObject({ size: expect.any(Number) });
    expect((await readdir(f.backupDir)).filter(name => name.endsWith('.age')).sort())
      .toEqual(['2026-08-24.age', '2026-08-25.age']);
    expect(identityDeleter.deletes).toHaveLength(2);
    expect(identityDeleter.deletes.every(call => call.path.includes('.retention-delete'))).toBe(true);
    f.outbox.close(); f.alerts.close(); f.health.close();
  }, 30_000);

  it('fails closed when identity-bound retention deletion is unavailable', async () => {
    const f = await fixture();
    const newest = await createBackup({ ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      now: () => new Date('2026-08-25T00:00:00.000Z') });
    await cloneCommittedArchive(newest.archivePath, join(f.backupDir, '2026-08-24.age'));
    await cloneCommittedArchive(newest.archivePath, join(f.backupDir, '2026-08-23.age'));
    const unavailable: IdentityBoundDeleter = {
      async capture() { throw Object.assign(new Error('unsupported'), { code: 'retention_identity_delete_unavailable' }); },
      async deleteOpened() { throw new Error('unreachable'); },
    };
    await expect(applyRetention({ backupDir: f.backupDir, identityFile: 'test-key', ageRunner: f.age,
      keep: 2, identityDeleter: unavailable })).rejects.toMatchObject({ code: 'retention_identity_delete_unavailable' });
    await expect(stat(join(f.backupDir, '2026-08-23.age'))).resolves.toBeDefined();
    await expect(stat(join(f.backupDir, '2026-08-23.age.committed'))).resolves.toBeDefined();
  }, 30_000);

  it('checks reparse classification again immediately before retention deletion', async () => {
    const f = await fixture();
    const newest = await createBackup({ ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      now: () => new Date('2026-08-25T00:00:00.000Z') });
    await cloneCommittedArchive(newest.archivePath, join(f.backupDir, '2026-08-24.age'));
    await cloneCommittedArchive(newest.archivePath, join(f.backupDir, '2026-08-23.age'));
    let oldestChecks = 0;
    const result = await applyRetention({ backupDir: f.backupDir, identityFile: 'test-key', ageRunner: f.age, keep: 2,
      pathSafety: { async isReparsePoint(path) { if (path.endsWith('2026-08-23.age')) { oldestChecks += 1; return oldestChecks >= 3; } return false; } } });
    expect(oldestChecks).toBe(3); expect(result.deleted).toEqual([]);
    await expect(stat(join(f.backupDir, '2026-08-23.age'))).resolves.toBeDefined();
  }, 30_000);

  it('never unlinks the original pathname when a retention tombstone is swapped', async () => {
    const f = await fixture();
    const newest = await createBackup({ ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      now: () => new Date('2026-08-25T00:00:00.000Z') });
    await cloneCommittedArchive(newest.archivePath, join(f.backupDir, '2026-08-24.age'));
    await cloneCommittedArchive(newest.archivePath, join(f.backupDir, '2026-08-23.age'));
    const swapping = new PortableTestIdentityDeleter(); let swapped = false;
    swapping.deleteOpened = async (path, expected) => {
      if (!swapped && path.includes('.age.delete-')) {
        swapped = true;
        await rename(path, `${path}.verified-inode`);
        await copyFile(newest.archivePath, path);
      }
      await PortableTestIdentityDeleter.prototype.deleteOpened.call(swapping, path, expected);
    };
    await expect(applyRetention({ backupDir: f.backupDir, identityFile: 'test-key', ageRunner: f.age, keep: 2,
      identityDeleter: swapping, durability: { async syncFile() {}, async syncDirectory() {} } }))
      .rejects.toMatchObject({ code: 'retention_identity_changed' });
    const names = await readdir(join(f.backupDir, '.retention-delete'), { recursive: true });
    expect(names.some(name => name.includes('.delete-') && !name.endsWith('.verified-inode'))).toBe(true);
    expect(names.some(name => name.endsWith('.verified-inode'))).toBe(true);
  }, 30_000);

  it('keeps interrupted deletion-namespace orphans quarantined for explicit recovery', async () => {
    const f = await fixture();
    const newest = await createBackup({ ...f, recipient: 'age1test', identityFile: 'test-key', ageRunner: f.age,
      now: () => new Date('2026-08-25T00:00:00.000Z') });
    await cloneCommittedArchive(newest.archivePath, join(f.backupDir, '2026-08-24.age'));
    await cloneCommittedArchive(newest.archivePath, join(f.backupDir, '2026-08-23.age'));
    const deletionRoot = join(f.backupDir, '.retention-delete'); await mkdir(deletionRoot, { mode: 0o700 });
    const tombstone = join(deletionRoot, '2026-08-23.age.delete-00000000-0000-4000-8000-000000000000');
    const commitTombstone = join(deletionRoot, '2026-08-23.age.committed.delete-00000000-0000-4000-8000-000000000000');
    await rename(join(f.backupDir, '2026-08-23.age'), tombstone);
    await rename(join(f.backupDir, '2026-08-23.age.committed'), commitTombstone);
    const result = await applyRetention({ backupDir: f.backupDir, identityFile: 'test-key', ageRunner: f.age, keep: 2,
      identityDeleter: new PortableTestIdentityDeleter() });
    expect(result.deleted).toEqual([]);
    expect(await readdir(deletionRoot)).toEqual(expect.arrayContaining([
      tombstone.split(/[\\/]/).at(-1), commitTombstone.split(/[\\/]/).at(-1),
    ]));
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
