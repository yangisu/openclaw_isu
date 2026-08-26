import { readSecretFile, productionSecretFs } from '../secrets/file-store-internal.js';
import { SecretFileError } from '../secrets/file-store.js';
import { CalDavError } from './errors.js';

export interface CalDavCredentials {
  username: string;
  password: string;
}

const CALDAV_SECRET_MAX_BYTES = 16_384;

export function isOwnerOnlySecretMode(mode: number, platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32' && (mode & 0o777) === 0o600;
}

export function parseCalDavCredentials(serialized: string): CalDavCredentials {
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'password,username' ||
        typeof record.username !== 'string' || record.username.trim().length === 0 ||
        typeof record.password !== 'string' || record.password.trim().length === 0) throw new Error('invalid');
    return { username: record.username, password: record.password };
  } catch {
    throw new CalDavError('CALDAV_SECRET', 'Invalid CalDAV secret file');
  }
}

export async function readCalDavCredentials(path: string): Promise<CalDavCredentials> {
  try {
    return parseCalDavCredentials(await readSecretFile(path, productionSecretFs, CALDAV_SECRET_MAX_BYTES));
  } catch (error) {
    if (error instanceof CalDavError) throw error;
    if (error instanceof SecretFileError && (
      error.code === 'secret_permissions_unverifiable' ||
      error.code === 'secret_permissions_invalid' ||
      error.code === 'secret_parent_permissions_invalid' ||
      error.code === 'secret_file_replaced'
    )) throw new CalDavError('CALDAV_SECRET_PERMISSIONS', 'CalDAV secret file permissions are invalid');
    throw new CalDavError('CALDAV_SECRET', 'Invalid CalDAV secret file');
  }
}
