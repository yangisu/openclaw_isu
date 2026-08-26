import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { SecretFileError } from './file-store.js';

export const SECRET_NOFOLLOW_FLAG = constants.O_NOFOLLOW ?? 0x20_000;
const SECRET_DIRECTORY_FLAG = constants.O_DIRECTORY ?? 0x10_000;

export interface SecretStats {
  dev: number | bigint;
  ino: number | bigint;
  nlink: number;
  mode: number;
  uid: number;
  size: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface SecretHandle {
  stat(): Promise<SecretStats>;
  chmod(mode: number): Promise<void>;
  readBounded(maxBytes: number): Promise<string>;
  writeFile(content: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface SecretFsAdapter {
  readonly platform: NodeJS.Platform;
  readonly uid: number | undefined;
  lstat(path: string): Promise<SecretStats>;
  realpath(path: string): Promise<string>;
  mkdir(path: string): Promise<void>;
  open(path: string, flags: number, mode?: number): Promise<SecretHandle>;
  rename(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export const productionSecretFs: SecretFsAdapter = {
  platform: process.platform,
  uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
  lstat,
  realpath,
  mkdir: async path => { await mkdir(path, { mode: 0o700 }); },
  open: async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    return {
      stat: () => handle.stat(),
      chmod: value => handle.chmod(value),
      readBounded: async maxBytes => {
        const chunks: Buffer[] = [];
        let total = 0;
        while (true) {
          const buffer = Buffer.allocUnsafe(Math.min(8_192, maxBytes + 1 - total));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) return Buffer.concat(chunks, total).toString('utf8');
          total += bytesRead;
          if (total > maxBytes) throw new SecretFileError('secret_file_invalid', 'Secret file is missing or invalid');
          chunks.push(buffer.subarray(0, bytesRead));
        }
      },
      writeFile: content => handle.writeFile(content, 'utf8'),
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  rename,
  unlink,
};

interface SecuredParent {
  path: string;
  handle: SecretHandle;
  identity: SecretStats;
}

export async function readSecretFile(path: string, fs: SecretFsAdapter, maxBytes = 1_048_576): Promise<string> {
  requireVerifiablePlatform(fs);
  const target = resolve(path);
  let parent: SecuredParent | undefined;
  let handle: SecretHandle | undefined;
  try {
    parent = await secureParent(target, fs, false);
    const before = await fs.lstat(target);
    assertSecureFile(before, fs.uid!);
    handle = await fs.open(target, constants.O_RDONLY | SECRET_NOFOLLOW_FLAG);
    const opened = await handle.stat();
    assertSecureFile(opened, fs.uid!);
    if (opened.size > maxBytes) throw new SecretFileError('secret_file_invalid', 'Secret file is missing or invalid');
    assertSameIdentity(before, opened);
    const content = await handle.readBounded(maxBytes);
    const afterPath = await fs.lstat(target);
    const afterHandle = await handle.stat();
    assertSecureFile(afterPath, fs.uid!);
    assertSecureFile(afterHandle, fs.uid!);
    assertSameIdentity(opened, afterPath);
    assertSameIdentity(opened, afterHandle);
    await assertParentUnchanged(parent, fs);
    return content;
  } catch (error) {
    if (error instanceof SecretFileError) throw error;
    throw new SecretFileError('secret_file_invalid', 'Secret file is missing or invalid');
  } finally {
    await handle?.close().catch(() => undefined);
    await parent?.handle.close().catch(() => undefined);
  }
}

export async function writeSecretFile(path: string, content: string, fs: SecretFsAdapter): Promise<void> {
  requireVerifiablePlatform(fs);
  const target = resolve(path);
  let parent: SecuredParent | undefined;
  let handle: SecretHandle | undefined;
  let createdIdentity: SecretStats | undefined;
  let temporaryPath: string | undefined;
  let renamed = false;
  try {
    parent = await secureParent(target, fs, true);
    const previousTarget = await optionalLstat(target, fs);
    if (previousTarget) assertSecureFile(previousTarget, fs.uid!);
    temporaryPath = join(parent.path, `.${basename(target)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`);
    handle = await fs.open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | SECRET_NOFOLLOW_FLAG,
      0o600,
    );
    await handle.chmod(0o600);
    createdIdentity = await handle.stat();
    assertSecureFile(createdIdentity, fs.uid!);
    await handle.writeFile(content);
    await handle.sync();
    const afterSync = await handle.stat();
    assertSecureFile(afterSync, fs.uid!);
    assertSameIdentity(createdIdentity, afterSync);
    assertSameIdentity(createdIdentity, await fs.lstat(temporaryPath));
    const targetBeforeRename = await optionalLstat(target, fs);
    if (previousTarget) {
      if (!targetBeforeRename) throw replaced();
      assertSecureFile(targetBeforeRename, fs.uid!);
      assertSameIdentity(previousTarget, targetBeforeRename);
    } else if (targetBeforeRename) {
      throw replaced();
    }
    await assertParentUnchanged(parent, fs);
    await fs.rename(temporaryPath, target);
    renamed = true;
    const finalPath = await fs.lstat(target);
    const finalHandle = await handle.stat();
    assertSecureFile(finalPath, fs.uid!);
    assertSecureFile(finalHandle, fs.uid!);
    assertSameIdentity(createdIdentity, finalPath);
    assertSameIdentity(createdIdentity, finalHandle);
    await assertParentUnchanged(parent, fs);
    await parent.handle.sync();
    await assertParentUnchanged(parent, fs);
  } catch (error) {
    if (!renamed && temporaryPath && createdIdentity) {
      const current = await optionalLstat(temporaryPath, fs);
      if (current && sameIdentity(current, createdIdentity)) {
        await fs.unlink(temporaryPath).catch(() => undefined);
        await parent?.handle.sync().catch(() => undefined);
      }
    }
    if (error instanceof SecretFileError) throw error;
    throw new SecretFileError('secret_file_io', 'Secret file update failed');
  } finally {
    await handle?.close().catch(() => undefined);
    await parent?.handle.close().catch(() => undefined);
  }
}

export async function deleteSecretFile(path: string, fs: SecretFsAdapter): Promise<void> {
  requireVerifiablePlatform(fs);
  const target = resolve(path);
  let parent: SecuredParent | undefined;
  let handle: SecretHandle | undefined;
  try {
    parent = await secureParent(target, fs, false);
    const before = await fs.lstat(target);
    assertSecureFile(before, fs.uid!);
    handle = await fs.open(target, constants.O_RDONLY | SECRET_NOFOLLOW_FLAG);
    const opened = await handle.stat();
    assertSecureFile(opened, fs.uid!);
    assertSameIdentity(before, opened);
    assertSameIdentity(opened, await fs.lstat(target));
    await assertParentUnchanged(parent, fs);
    await fs.unlink(target);
    await parent.handle.sync();
    await assertParentUnchanged(parent, fs);
  } catch (error) {
    if (error instanceof SecretFileError) throw error;
    throw new SecretFileError('secret_file_io', 'Secret file deletion failed');
  } finally {
    await handle?.close().catch(() => undefined);
    await parent?.handle.close().catch(() => undefined);
  }
}

async function secureParent(target: string, fs: SecretFsAdapter, create: boolean): Promise<SecuredParent> {
  const parentPath = dirname(target);
  const existingParent = await optionalLstat(parentPath, fs);
  if (!existingParent && create) await createSecureParent(parentPath, fs);
  if (resolve(await fs.realpath(parentPath)) !== parentPath) throw parentInvalid();
  const before = await fs.lstat(parentPath);
  assertSecureParent(before, fs.uid!);
  const handle = await fs.open(parentPath, constants.O_RDONLY | SECRET_DIRECTORY_FLAG | SECRET_NOFOLLOW_FLAG);
  try {
    const opened = await handle.stat();
    assertSecureParent(opened, fs.uid!);
    assertSameIdentity(before, opened);
    assertSameIdentity(opened, await fs.lstat(parentPath));
    return { path: parentPath, handle, identity: opened };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function createSecureParent(parentPath: string, fs: SecretFsAdapter): Promise<void> {
  const ancestorPath = dirname(parentPath);
  if (resolve(await fs.realpath(ancestorPath)) !== ancestorPath) throw parentInvalid();
  const ancestorBefore = await fs.lstat(ancestorPath);
  assertSecureParent(ancestorBefore, fs.uid!);
  const ancestorHandle = await fs.open(
    ancestorPath,
    constants.O_RDONLY | SECRET_DIRECTORY_FLAG | SECRET_NOFOLLOW_FLAG,
  );
  try {
    const ancestorOpened = await ancestorHandle.stat();
    assertSecureParent(ancestorOpened, fs.uid!);
    assertSameIdentity(ancestorBefore, ancestorOpened);
    await fs.mkdir(parentPath);
    assertSameIdentity(ancestorOpened, await fs.lstat(ancestorPath));
    await ancestorHandle.sync();
    assertSameIdentity(ancestorOpened, await ancestorHandle.stat());
  } finally {
    await ancestorHandle.close().catch(() => undefined);
  }
}

async function assertParentUnchanged(parent: SecuredParent, fs: SecretFsAdapter): Promise<void> {
  const pathStats = await fs.lstat(parent.path);
  const handleStats = await parent.handle.stat();
  assertSecureParent(pathStats, fs.uid!);
  assertSecureParent(handleStats, fs.uid!);
  assertSameIdentity(parent.identity, pathStats);
  assertSameIdentity(parent.identity, handleStats);
}

function assertSecureFile(stats: SecretStats, uid: number): void {
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o600 || stats.uid !== uid || stats.nlink !== 1) {
    throw new SecretFileError('secret_permissions_invalid', 'Secret file must be a regular owner-owned mode-600 file with one link');
  }
}

function assertSecureParent(stats: SecretStats, uid: number): void {
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0 || stats.uid !== uid) {
    throw parentInvalid();
  }
}

function requireVerifiablePlatform(fs: SecretFsAdapter): void {
  if (fs.platform === 'win32' || !Number.isInteger(fs.uid)) {
    throw new SecretFileError('secret_permissions_unverifiable', 'Owner-only secret permissions cannot be verified on this platform');
  }
}

function assertSameIdentity(expected: SecretStats, actual: SecretStats): void {
  if (!sameIdentity(expected, actual)) throw replaced();
}

function sameIdentity(left: SecretStats, right: SecretStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink;
}

async function optionalLstat(path: string, fs: SecretFsAdapter): Promise<SecretStats | undefined> {
  try {
    return await fs.lstat(path);
  } catch (error) {
    if (error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') return undefined;
    throw error;
  }
}

function replaced(): SecretFileError {
  return new SecretFileError('secret_file_replaced', 'Secret file path changed during the operation');
}

function parentInvalid(): SecretFileError {
  return new SecretFileError('secret_parent_permissions_invalid', 'Secret parent directory is not secure');
}
