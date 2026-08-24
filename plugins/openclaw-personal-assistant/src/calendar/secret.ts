import { open } from 'node:fs/promises';
import { CalDavError } from './errors.js';

export interface CalDavCredentials {
  username: string;
  password: string;
}

export function isOwnerOnlySecretMode(mode: number, platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32' && (mode & 0o777) === 0o600;
}

export async function readCalDavCredentials(path: string): Promise<CalDavCredentials> {
  let handle;
  try {
    handle = await open(path, 'r');
    const metadata = await handle.stat();
    if (!metadata.isFile() || !isOwnerOnlySecretMode(metadata.mode)) {
      throw new CalDavError('CALDAV_SECRET_PERMISSIONS', 'CalDAV secret file must have mode 600');
    }
    const parsed = JSON.parse(await handle.readFile('utf8')) as Partial<CalDavCredentials>;
    if (typeof parsed.username !== 'string' || !parsed.username ||
        typeof parsed.password !== 'string' || !parsed.password) throw new Error('invalid');
    return { username: parsed.username, password: parsed.password };
  } catch (error) {
    if (error instanceof CalDavError) throw error;
    throw new CalDavError('CALDAV_SECRET', 'Invalid CalDAV secret file');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
