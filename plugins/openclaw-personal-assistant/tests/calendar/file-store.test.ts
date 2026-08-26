import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretFileStore } from '../../src/secrets/file-store.js';
import {
  readSecretFile,
  SECRET_NOFOLLOW_FLAG,
  writeSecretFile,
  type SecretFsAdapter,
  type SecretHandle,
  type SecretStats,
} from '../../src/secrets/file-store-internal.js';

type Kind = 'file' | 'directory' | 'symlink';
interface NodeEntry { kind: Kind; mode: number; uid: number; dev: number; ino: number; nlink: number; content: string }

class FakeFs implements SecretFsAdapter {
  readonly platform = 'linux' as const;
  readonly uid = 1000;
  readonly nodes = new Map<string, NodeEntry>();
  readonly syncs: Kind[] = [];
  readonly unlinks: string[] = [];
  readonly openFlags: number[] = [];
  mkdirCalls = 0;
  nextIno = 10;
  tempPath: string | undefined;
  renameFails = false;
  failFileSync = false;
  failDirectorySync = false;
  swapTargetAfterRead = false;
  replacementKind: Kind = 'file';
  swapTempBeforeRename = false;
  canonicalParent: string | undefined;

  constructor(readonly target: string) {
    this.nodes.set(dirname(target), this.node('directory', 0o700));
  }

  node(kind: Kind, mode: number, content = ''): NodeEntry {
    return { kind, mode, uid: this.uid, dev: 1, ino: this.nextIno++, nlink: 1, content };
  }

  stats(entry: NodeEntry): SecretStats {
    return {
      dev: entry.dev, ino: entry.ino, nlink: entry.nlink, mode: entry.mode, uid: entry.uid,
      size: Buffer.byteLength(entry.content),
      isFile: () => entry.kind === 'file',
      isDirectory: () => entry.kind === 'directory',
      isSymbolicLink: () => entry.kind === 'symlink',
    };
  }

  async lstat(path: string): Promise<SecretStats> {
    if (this.swapTempBeforeRename && path === this.tempPath) {
      this.swapTempBeforeRename = false;
      this.nodes.set(path, this.node('file', 0o600, 'attacker'));
    }
    const entry = this.nodes.get(path);
    if (!entry) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return this.stats(entry);
  }

  async realpath(path: string): Promise<string> {
    if (path === dirname(this.target) && this.canonicalParent) return this.canonicalParent;
    return path;
  }

  async mkdir(path: string): Promise<void> {
    this.mkdirCalls += 1;
    if (!this.nodes.has(path)) this.nodes.set(path, this.node('directory', 0o700));
  }

  async open(path: string, flags: number, mode?: number): Promise<SecretHandle> {
    this.openFlags.push(flags);
    let entry = this.nodes.get(path);
    if ((flags & constants.O_CREAT) !== 0) {
      if (entry && (flags & constants.O_EXCL) !== 0) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      entry = this.node('file', mode ?? 0o600);
      this.nodes.set(path, entry);
      this.tempPath = path;
    }
    if (!entry) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    const captured = entry;
    return {
      stat: async () => this.stats(captured),
      chmod: async modeValue => { captured.mode = modeValue; },
      readBounded: async maxBytes => {
        if (this.swapTargetAfterRead) {
          this.swapTargetAfterRead = false;
          this.nodes.set(path, this.node(this.replacementKind, 0o600, 'replacement'));
        }
        if (Buffer.byteLength(captured.content) > maxBytes) throw new Error('oversized');
        return captured.content;
      },
      writeFile: async content => { captured.content = content; },
      sync: async () => {
        this.syncs.push(captured.kind);
        if ((captured.kind === 'file' && this.failFileSync) ||
            (captured.kind === 'directory' && this.failDirectorySync)) throw new Error('sync failed');
      },
      close: async () => undefined,
    };
  }

  async rename(source: string, destination: string): Promise<void> {
    if (this.renameFails) throw Object.assign(new Error('rename failed'), { code: 'EIO' });
    const entry = this.nodes.get(source);
    if (!entry) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    this.nodes.delete(source);
    this.nodes.set(destination, entry);
  }

  async unlink(path: string): Promise<void> {
    this.unlinks.push(path);
    this.nodes.delete(path);
  }
}

function fakeFixture() {
  const target = resolve(join('D:\secure-vault', 'tokens.json'));
  return { target, fs: new FakeFs(target) };
}

describe('SecretFileStore production policy', () => {
  it('fails closed on native Windows without exposing a constructor bypass', async () => {
    if (process.platform !== 'win32') return;
    const store = new SecretFileStore(join(process.cwd(), 'never-written-secret.json'));
    await expect(store.write({ token: 'secret' })).rejects.toMatchObject({ code: 'secret_permissions_unverifiable' });
  });

  it.each([
    ['inode replacement', 'file' as const, 'secret_file_replaced'],
    ['symlink swap', 'symlink' as const, 'secret_permissions_invalid'],
  ])('reads through O_NOFOLLOW and rejects a pathname %s after read', async (_name, replacementKind, code) => {
    const { target, fs } = fakeFixture();
    fs.nodes.set(target, fs.node('file', 0o600, '{"token":"secret"}'));
    fs.swapTargetAfterRead = true;
    fs.replacementKind = replacementKind;

    await expect(readSecretFile(target, fs)).rejects.toMatchObject({ code });
    expect(fs.openFlags.some(flags => (flags & SECRET_NOFOLLOW_FLAG) !== 0)).toBe(true);
  });

  it.each(['symlink', 'directory'] as const)('rejects a non-regular %s final component', async kind => {
    const { target, fs } = fakeFixture();
    fs.nodes.set(target, fs.node(kind, kind === 'directory' ? 0o700 : 0o600));
    await expect(readSecretFile(target, fs)).rejects.toMatchObject({ code: 'secret_permissions_invalid' });
  });

  it('rejects an insecure existing parent before creating a temporary file', async () => {
    const { target, fs } = fakeFixture();
    fs.nodes.get(dirname(target))!.mode = 0o755;
    await expect(writeSecretFile(target, '{"token":"secret"}\n', fs)).rejects.toMatchObject({
      code: 'secret_parent_permissions_invalid',
    });
    expect(fs.tempPath).toBeUndefined();
  });

  it('rejects a symlinked or canonically redirected parent', async () => {
    const { target, fs } = fakeFixture();
    fs.canonicalParent = resolve('D:\other-vault');
    await expect(writeSecretFile(target, '{"token":"secret"}\n', fs)).rejects.toMatchObject({
      code: 'secret_parent_permissions_invalid',
    });
    expect(fs.mkdirCalls).toBe(0);
  });

  it('keeps the temp handle through rename and fsyncs both file and parent', async () => {
    const { target, fs } = fakeFixture();
    await writeSecretFile(target, '{"token":"secret"}\n', fs);

    expect(fs.nodes.get(target)?.content).toBe('{"token":"secret"}\n');
    expect(fs.syncs).toEqual(['file', 'directory']);
    expect(fs.openFlags.some(flags => (flags & SECRET_NOFOLLOW_FLAG) !== 0 && (flags & constants.O_EXCL) !== 0)).toBe(true);
    expect(fs.tempPath && fs.nodes.has(fs.tempPath)).toBe(false);
  });

  it('creates a missing immediate parent only after verifying and syncing its ancestor', async () => {
    const { target, fs } = fakeFixture();
    fs.nodes.delete(dirname(target));
    fs.nodes.set(dirname(dirname(target)), fs.node('directory', 0o700));
    await writeSecretFile(target, '{"token":"secret"}\n', fs);
    expect(fs.mkdirCalls).toBe(1);
    expect(fs.syncs).toEqual(['directory', 'file', 'directory']);
  });

  it('cleans its temp identity when file fsync fails', async () => {
    const { target, fs } = fakeFixture();
    fs.failFileSync = true;
    await expect(writeSecretFile(target, '{"token":"secret"}\n', fs)).rejects.toMatchObject({ code: 'secret_file_io' });
    expect(fs.unlinks).toEqual([fs.tempPath]);
    expect(fs.syncs).toEqual(['file', 'directory']);
  });

  it('reports parent fsync failure without deleting the atomically renamed target', async () => {
    const { target, fs } = fakeFixture();
    fs.failDirectorySync = true;
    await expect(writeSecretFile(target, '{"token":"secret"}\n', fs)).rejects.toMatchObject({ code: 'secret_file_io' });
    expect(fs.nodes.get(target)?.content).toBe('{"token":"secret"}\n');
    expect(fs.unlinks).toEqual([]);
  });

  it('cleans up only its own unchanged temp inode after rename failure', async () => {
    const { target, fs } = fakeFixture();
    fs.renameFails = true;
    await expect(writeSecretFile(target, '{"token":"secret"}\n', fs)).rejects.toMatchObject({ code: 'secret_file_io' });
    expect(fs.unlinks).toEqual([fs.tempPath]);
    expect(fs.tempPath && fs.nodes.has(fs.tempPath)).toBe(false);
  });

  it('never unlinks a temp pathname replaced by another inode', async () => {
    const { target, fs } = fakeFixture();
    fs.swapTempBeforeRename = true;
    await expect(writeSecretFile(target, '{"token":"secret"}\n', fs)).rejects.toMatchObject({ code: 'secret_file_replaced' });
    expect(fs.unlinks).toEqual([]);
    expect(fs.tempPath && fs.nodes.get(fs.tempPath)?.content).toBe('attacker');
  });

  it('rejects an insecure existing target before replacement', async () => {
    const { target, fs } = fakeFixture();
    fs.nodes.set(target, fs.node('symlink', 0o600));
    await expect(writeSecretFile(target, '{"token":"secret"}\n', fs)).rejects.toMatchObject({
      code: 'secret_permissions_invalid',
    });
    expect(fs.tempPath).toBeUndefined();
  });

  it.each([
    ['wrong owner', { uid: 2000 }],
    ['extra hard link', { nlink: 2 }],
    ['group-readable mode', { mode: 0o640 }],
  ])('rejects a secure-looking file with %s', async (_name, mutation) => {
    const { target, fs } = fakeFixture();
    const entry = fs.node('file', 0o600, '{"token":"secret"}');
    Object.assign(entry, mutation);
    fs.nodes.set(target, entry);
    await expect(readSecretFile(target, fs)).rejects.toMatchObject({ code: 'secret_permissions_invalid' });
  });

  it('rejects a secret larger than the caller bound before reading it', async () => {
    const { target, fs } = fakeFixture();
    fs.nodes.set(target, fs.node('file', 0o600, 'x'.repeat(17)));

    await expect(readSecretFile(target, fs, 16)).rejects.toMatchObject({ code: 'secret_file_invalid' });
  });
});
