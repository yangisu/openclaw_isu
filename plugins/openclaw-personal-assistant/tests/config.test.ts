import { describe, expect, it } from 'vitest';
import { loadCalendarMappings, loadConfig } from '../src/config.js';
import { loadConfigFromApi } from '../src/tools/trust.js';

const validConfig = {
  workspaceDir: '/home/user/.openclaw/workspace',
  stateDir: '/home/user/.openclaw/state',
  backupDir: '/mnt/d/openclaw_setting/backups',
  telegramUserId: '123456789',
  timezone: 'Asia/Seoul',
} as const;

describe('loadConfig', () => {
  it('loads the exact Google calendar configuration through the hardened plugin config boundary', () => {
    const loaded = loadConfigFromApi({ pluginConfig: {
      ...validConfig,
      calendar: {
        provider: 'google',
        googleOAuthClientFile: '/home/user/.openclaw/secrets/google-oauth-client',
        googleTokenFile: '/home/user/.openclaw/secrets/google-oauth-token',
        googleCalendarBindingFile: '/home/user/.openclaw/secrets/google-calendar-binding',
        expectedAccount: 'yangisu12@gmail.com',
      },
    } } as never);
    expect(loaded.calendar).toEqual({
      provider: 'google',
      googleOAuthClientFile: '/home/user/.openclaw/secrets/google-oauth-client',
      googleTokenFile: '/home/user/.openclaw/secrets/google-oauth-token',
      googleCalendarBindingFile: '/home/user/.openclaw/secrets/google-calendar-binding',
      expectedAccount: 'yangisu12@gmail.com',
    });
  });

  it('loads explicit API IDs mapped to exact canonical same-origin collection URLs', () => {
    expect(loadCalendarMappings('https://caldav.example.test/root/', [
      { apiCalendarId: 'api-personal', caldavHref: 'https://caldav.example.test/collections/personal/' },
      { apiCalendarId: 'api-work', caldavHref: '/collections/work/' },
    ])).toEqual([
      { apiCalendarId: 'api-personal', caldavHref: 'https://caldav.example.test/collections/personal/' },
      { apiCalendarId: 'api-work', caldavHref: 'https://caldav.example.test/collections/work/' },
    ]);
  });

  it.each([
    ['API ID', [
      { apiCalendarId: 'same', caldavHref: '/collections/a/' },
      { apiCalendarId: 'same', caldavHref: '/collections/b/' },
    ]],
    ['canonical href', [
      { apiCalendarId: 'a', caldavHref: '/collections/same/' },
      { apiCalendarId: 'b', caldavHref: 'https://caldav.example.test/collections/same/' },
    ]],
  ])('rejects a duplicate calendar mapping %s', (_kind, mappings) => {
    expect(() => loadCalendarMappings('https://caldav.example.test/', mappings)).toThrow(/calendarMappings/);
  });

  it.each([
    ['cross-origin', 'https://other.example.test/collections/a/'],
    ['credentials', 'https://owner:secret@caldav.example.test/collections/a/'],
    ['query', 'https://caldav.example.test/collections/a/?view=all'],
    ['fragment', 'https://caldav.example.test/collections/a/#events'],
    ['traversal', '/collections/a/../admin/'],
    ['double-encoded traversal', '/collections/a/%252e%252e/admin/'],
    ['base root', 'https://caldav.example.test/'],
  ])('rejects a calendar mapping href with %s', (_kind, caldavHref) => {
    expect(() => loadCalendarMappings('https://caldav.example.test/', [
      { apiCalendarId: 'a', caldavHref },
    ])).toThrow(/calendarMappings/);
  });

  it('rejects mappings whose canonical collection paths are ambiguous prefixes', () => {
    expect(() => loadCalendarMappings('https://caldav.example.test/', [
      { apiCalendarId: 'a', caldavHref: '/collections/team/' },
      { apiCalendarId: 'b', caldavHref: '/collections/team/private/' },
    ])).toThrow(/calendarMappings/);
  });

  it('rejects more than ten calendar mappings before runtime request multiplication', () => {
    expect(() => loadCalendarMappings('https://caldav.example.test/', Array.from({ length: 11 }, (_, index) => ({
      apiCalendarId: `api-${index}`,
      caldavHref: `/collections/${index}/`,
    })))).toThrow(/calendarMappings/);
  });

  it('accepts absolute WSL paths and one Telegram sender', () => {
    expect(loadConfig(validConfig).telegramUserId).toBe('123456789');
  });

  it('preserves the signed SQLite int64 maximum Telegram ID exactly', () => {
    expect(loadConfig({
      ...validConfig,
      telegramUserId: '9223372036854775807',
    }).telegramUserId).toBe('9223372036854775807');
  });

  it.each(['0', '00123', '9223372036854775808'])(
    'rejects non-canonical or overflowing Telegram ID %s',
    telegramUserId => expect(() => loadConfig({ ...validConfig, telegramUserId })).toThrow(/telegramUserId/),
  );

  it.each(['../workspace', '', '/tmp/../etc'])(
    'rejects unsafe workspace path %s',
    workspaceDir => expect(() => loadConfig({ ...validConfig, workspaceDir })).toThrow(/workspaceDir/),
  );
});
