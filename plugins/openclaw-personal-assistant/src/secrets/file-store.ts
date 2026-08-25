import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export type SecretFileErrorCode =
  | 'secret_permissions_unverifiable'
  | 'secret_permissions_invalid'
  | 'secret_file_invalid'
  | 'secret_file_io';

export class SecretFileError extends Error {
  constructor(public readonly code: SecretFileErrorCode, message: string) {
    super(message);
    this.name = 'SecretFileError';
  }
}

type OwnerOnlyVerifier = (mode: number) => boolean | Promise<boolean>;
type ParentSync = (directory: string) => Promise<void>;

export interface SecretFileStoreOptions {
  platform?: NodeJS.Platform;
  /** Injectable only for filesystems whose permission policy is verified externally. */
  verifyOwnerOnly?: OwnerOnlyVerifier;
  /** Injectable for tests; production always fsyncs the containing directory. */
  syncParent?: ParentSync;
}

export function isOwnerOnlySecretMode(mode: number, platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32' && (mode & 0o777) === 0o600;
}

export class SecretFileStore<T> {
  readonly #path: string;
  readonly #platform: NodeJS.Platform;
  readonly #verifyOwnerOnly?: OwnerOnlyVerifier;
  readonly #syncParent: ParentSync;

  constructor(path: string, options: SecretFileStoreOptions = {}) {
    this.#path = path;
    this.#platform = options.platform ?? process.platform;
    this.#verifyOwnerOnly = options.verifyOwnerOnly;
    this.#syncParent = options.syncParent ?? syncDirectory;
  }

  async read(): Promise<T> {
    this.#assertPermissionVerificationAvailable();
    let handle: FileHandle | undefined;
    try {
      const metadata = await lstat(this.#path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw invalidPermissions();
      handle = await open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      await this.#assertOwnerOnly(opened.mode);
      return JSON.parse(await handle.readFile('utf8')) as T;
    } catch (error) {
      if (error instanceof SecretFileError) throw error;
      throw new SecretFileError('secret_file_invalid', 'Secret file is missing or invalid');
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async write(value: T): Promise<void> {
    this.#assertPermissionVerificationAvailable();
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(directory, `.${basename(this.#path)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`);
    let handle: FileHandle | undefined;
    let renamed = false;
    try {
      handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await chmod(temporaryPath, 0o600);
      await this.#assertOwnerOnly((await handle.stat()).mode);
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.#path);
      renamed = true;
      await this.#verifyFinalFile();
      await this.#syncParent(directory);
    } catch (error) {
      if (!renamed) await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof SecretFileError) throw error;
      throw new SecretFileError('secret_file_io', 'Secret file update failed');
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async delete(): Promise<void> {
    this.#assertPermissionVerificationAvailable();
    try {
      await this.#verifyFinalFile();
      await unlink(this.#path);
      await this.#syncParent(dirname(this.#path));
    } catch (error) {
      if (error instanceof SecretFileError) throw error;
      throw new SecretFileError('secret_file_io', 'Secret file deletion failed');
    }
  }

  #assertPermissionVerificationAvailable(): void {
    if (this.#platform === 'win32' && !this.#verifyOwnerOnly) {
      throw new SecretFileError(
        'secret_permissions_unverifiable',
        'Owner-only secret permissions cannot be verified on this platform',
      );
    }
  }

  async #assertOwnerOnly(mode: number): Promise<void> {
    const accepted = this.#verifyOwnerOnly
      ? await this.#verifyOwnerOnly(mode)
      : isOwnerOnlySecretMode(mode, this.#platform);
    if (!accepted) throw invalidPermissions();
  }

  async #verifyFinalFile(): Promise<void> {
    const metadata = await lstat(this.#path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw invalidPermissions();
    await this.#assertOwnerOnly(metadata.mode);
  }
}

function invalidPermissions(): SecretFileError {
  return new SecretFileError('secret_permissions_invalid', 'Secret file must be a regular owner-only mode-600 file');
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
