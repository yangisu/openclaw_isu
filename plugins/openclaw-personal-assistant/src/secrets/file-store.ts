import { deleteSecretFile, productionSecretFs, readSecretFile, writeSecretFile } from './file-store-internal.js';

export type SecretFileErrorCode =
  | 'secret_permissions_unverifiable'
  | 'secret_permissions_invalid'
  | 'secret_parent_permissions_invalid'
  | 'secret_file_replaced'
  | 'secret_file_invalid'
  | 'secret_file_io';

export class SecretFileError extends Error {
  constructor(public readonly code: SecretFileErrorCode, message: string) {
    super(message);
    this.name = 'SecretFileError';
  }
}

export function isOwnerOnlySecretMode(mode: number, platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32' && (mode & 0o777) === 0o600;
}

export class SecretFileStore<T> {
  readonly #path: string;
  readonly #maxBytes: number;

  constructor(path: string, maxBytes = 1_048_576) {
    this.#path = path;
    this.#maxBytes = maxBytes;
  }

  async read(): Promise<T> {
    const serialized = await readSecretFile(this.#path, productionSecretFs, this.#maxBytes);
    try {
      return JSON.parse(serialized) as T;
    } catch {
      throw new SecretFileError('secret_file_invalid', 'Secret file is missing or invalid');
    }
  }

  async write(value: T): Promise<void> {
    let serialized: string;
    try {
      serialized = `${JSON.stringify(value)}\n`;
    } catch {
      throw new SecretFileError('secret_file_invalid', 'Secret value cannot be serialized');
    }
    await writeSecretFile(this.#path, serialized, productionSecretFs);
  }

  async delete(): Promise<void> {
    await deleteSecretFile(this.#path, productionSecretFs);
  }
}
