import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GoogleCalendarLedger } from '../../src/calendar/google-ledger.js';
import {
  calendarManageParameters,
  createCalendarManageTool,
  type CalendarManageApi,
} from '../../src/tools/calendar.js';
import { Value } from 'typebox/value';

const config = {
  workspaceDir: '/home/user/.openclaw/workspace', stateDir: '/home/user/.openclaw/state',
  backupDir: '/mnt/d/openclaw_setting/backups', telegramUserId: '6520016662', timezone: 'Asia/Seoul',
} as const;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function pluginApi() {
  return { config: {}, pluginConfig: config } as never;
}

function event(eventId: string, overrides: Record<string, unknown> = {}) {
  return {
    calendarId: 'dedicated@group.calendar.google.com', uid: eventId, eventId,
    etag: '"etag-1"', dtstart: '2026-08-27T01:00:00.000Z',
    dtend: '2026-08-27T02:00:00.000Z', summary: '병원', kind: 'timed' as const,
    status: 'CONFIRMED', ...overrides,
  };
}

describe('assistant_calendar_manage', () => {
  it('defines create, update and delete without any arbitrary calendar or invitation fields', () => {
    expect(Value.Check(calendarManageParameters, {
      action: 'create', requestId: '12345678-1234-4234-8234-1234567890ab',
      summary: '병원', dtstart: '2026-08-27T10:00:00+09:00', dtend: '2026-08-27T11:00:00+09:00',
    })).toBe(true);
    for (const forbidden of ['calendarId', 'attendees', 'conferenceData', 'sendUpdates', 'acl']) {
      expect(Value.Check(calendarManageParameters, {
        action: 'create', requestId: '12345678-1234-4234-8234-1234567890ab',
        summary: '병원', dtstart: '2026-08-27T10:00:00+09:00', dtend: '2026-08-27T11:00:00+09:00',
        [forbidden]: forbidden,
      })).toBe(false);
    }
  });

  it('rejects a non-owner before opening the ledger or calendar client', async () => {
    const openLedger = vi.fn();
    const openApi = vi.fn();
    const tool = createCalendarManageTool(pluginApi(), { requesterSenderId: '999' }, { openLedger, openApi });
    await expect(tool.execute('call', {
      action: 'delete', requestId: '12345678-1234-4234-8234-1234567890ab',
      eventId: 'event1', etag: '"etag-1"',
    })).rejects.toMatchObject({ code: 'sender_not_allowed' });
    expect(openLedger).not.toHaveBeenCalled();
    expect(openApi).not.toHaveBeenCalled();
  });

  it('creates one deterministic event and replays a completed request without another API call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'google-tool-'));
    roots.push(root);
    const ledger = new GoogleCalendarLedger(join(root, 'ledger.sqlite3'));
    const createEvent = vi.fn(async input => event(input.eventId));
    const api: CalendarManageApi = {
      createEvent,
      async getEvent(eventId) { return event(eventId); },
      async updateEvent() { throw new Error('not used'); },
      async deleteEvent() { throw new Error('not used'); },
    };
    const tool = createCalendarManageTool(pluginApi(), { requesterSenderId: config.telegramUserId }, {
      openLedger: () => ledger,
      openApi: async () => api,
      closeLedger: false,
    });
    const params = {
      action: 'create' as const, requestId: '12345678-1234-4234-8234-1234567890ab',
      summary: '병원', dtstart: '2026-08-27T10:00:00+09:00', dtend: '2026-08-27T11:00:00+09:00',
    };

    const first = await tool.execute('call-1', params);
    const replay = await tool.execute('call-2', params);
    expect(first.details).toMatchObject({
      action: 'create', status: 'succeeded', replayed: false,
      event: { eventId: 'oc123456781234423482341234567890ab' },
    });
    expect(replay.details).toMatchObject({
      action: 'create', status: 'succeeded', replayed: true,
      eventId: 'oc123456781234423482341234567890ab',
    });
    expect(createEvent).toHaveBeenCalledTimes(1);
    ledger.close();
  });

  it('updates and deletes with the observed ETag and rejects an individual recurring instance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'google-tool-etag-'));
    roots.push(root);
    const ledger = new GoogleCalendarLedger(join(root, 'ledger.sqlite3'));
    let currentEtag = '"etag-1"';
    const updateEvent = vi.fn(async (eventId, etag, patch) => {
      currentEtag = '"etag-2"';
      return event(eventId, { ...patch, etag: currentEtag, summary: patch.summary ?? '병원' });
    });
    const deleteEvent = vi.fn(async () => ({ deleted: true as const }));
    const getEvent = vi.fn(async eventId => event(eventId, { etag: currentEtag }));
    const api: CalendarManageApi = { createEvent: vi.fn(), getEvent, updateEvent, deleteEvent };
    const tool = createCalendarManageTool(pluginApi(), { requesterSenderId: config.telegramUserId }, {
      openLedger: () => ledger, openApi: async () => api, closeLedger: false,
    });

    await expect(tool.execute('update', {
      action: 'update', requestId: '22345678-1234-4234-8234-1234567890ab',
      eventId: 'event1', etag: '"etag-1"', summary: '병원 변경',
    })).resolves.toMatchObject({ details: { status: 'succeeded', event: { etag: '"etag-2"' } } });
    expect(updateEvent).toHaveBeenCalledWith('event1', '"etag-1"', { summary: '병원 변경' }, undefined);

    await expect(tool.execute('delete', {
      action: 'delete', requestId: '32345678-1234-4234-8234-1234567890ab',
      eventId: 'event1', etag: '"etag-2"',
    })).resolves.toMatchObject({ details: { status: 'succeeded', deleted: true } });
    expect(deleteEvent).toHaveBeenCalledWith('event1', '"etag-2"', undefined);

    getEvent.mockResolvedValueOnce(event('instance1', { recurringEventId: 'series1' }));
    await expect(tool.execute('instance', {
      action: 'delete', requestId: '42345678-1234-4234-8234-1234567890ab',
      eventId: 'instance1', etag: '"etag-1"',
    })).rejects.toMatchObject({ code: 'calendar_recurring_instance_unsupported' });
    ledger.close();
  });
});
