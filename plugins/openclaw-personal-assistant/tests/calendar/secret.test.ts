import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isOwnerOnlySecretMode, readCalDavCredentials } from '../../src/calendar/secret.js';

const temporaryDirectories: string[] = [];

async function secretFile(mode = 0o600): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'caldav-secret-test-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'credentials.json');
  await writeFile(path, JSON.stringify({ username: 'naver-user', password: 'top-secret' }), { mode });
  await chmod(path, mode);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('CalDAV secret reader', () => {
  it('accepts exact POSIX 0600 only and fails closed on Windows', () => {
    expect(isOwnerOnlySecretMode(0o100600, 'linux')).toBe(true);
    expect(isOwnerOnlySecretMode(0o100400, 'linux')).toBe(false);
    expect(isOwnerOnlySecretMode(0o100644, 'linux')).toBe(false);
    expect(isOwnerOnlySecretMode(0o100600, 'win32')).toBe(false);
  });

  it('uses the real platform permission policy when reading credentials', async () => {
    const path = await secretFile();
    if (process.platform === 'win32') {
      await expect(readCalDavCredentials(path)).rejects.toMatchObject({ code: 'CALDAV_SECRET_PERMISSIONS' });
    } else {
      await expect(readCalDavCredentials(path)).resolves.toEqual({ username: 'naver-user', password: 'top-secret' });
      await chmod(path, 0o644);
      await expect(readCalDavCredentials(path)).rejects.toMatchObject({ code: 'CALDAV_SECRET_PERMISSIONS' });
    }
  });
});
