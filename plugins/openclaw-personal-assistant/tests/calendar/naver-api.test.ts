import { describe, expect, it, vi } from 'vitest';
import { NaverCalendarApi } from '../../src/calendar/naver-api.js';

const request = {
  calendarId: 'defaultCalendarId',
  scheduleIcalString: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:uid-1\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
};

function apiResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

describe('NaverCalendarApi.createSchedule', () => {
  it('posts only the official create form and accepts a complete create response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(apiResponse(200, {
      result: 'success', returnValue: { processType: 'create', calendarId: '1', icalUid: 'uid-1' },
    }));
    const api = new NaverCalendarApi({ accessToken: 'access-secret', fetch });

    await expect(api.createSchedule(request)).resolves.toEqual({ processType: 'create', calendarId: '1', icalUid: 'uid-1' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://openapi.naver.com/calendar/createSchedule.json');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access-secret');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded;charset=UTF-8');
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual(request);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    {},
    { result: 'failure', returnValue: { processType: 'create', calendarId: '1', icalUid: 'uid-1' } },
    { result: 'success' },
    { result: 'success', returnValue: { processType: 'create', calendarId: '', icalUid: 'uid-1' } },
    { result: 'success', returnValue: { processType: 'create', calendarId: '1', icalUid: '' } },
  ])('rejects incomplete or unsuccessful HTTP success response %#', async body => {
    const api = new NaverCalendarApi({
      accessToken: 'access-secret', fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(apiResponse(200, body)),
    });
    await expect(api.createSchedule(request)).rejects.toMatchObject({ code: 'naver_invalid_response' });
  });

  it('treats a modify result as maybe sent rather than a successful create', async () => {
    const api = new NaverCalendarApi({
      accessToken: 'access-secret',
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(apiResponse(200, {
        result: 'success', returnValue: { processType: 'modify', calendarId: '1', icalUid: 'uid-1' },
      })),
    });
    await expect(api.createSchedule(request)).rejects.toMatchObject({ code: 'request_maybe_sent' });
  });

  it.each([
    [401, 'naver_auth'], [403, 'naver_auth'], [429, 'naver_rate_limited'], [500, 'naver_server'], [503, 'naver_server'],
  ])('classifies HTTP %i as %s', async (status, code) => {
    const api = new NaverCalendarApi({
      accessToken: 'access-secret', fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(apiResponse(status, 'secret server body')),
    });
    await expect(api.createSchedule(request)).rejects.toMatchObject({ code });
  });

  it.each(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])(
    'classifies proven pre-send %s failure separately', async networkCode => {
      const cause = Object.assign(new Error('network failed'), { code: networkCode });
      const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('fetch failed', { cause }));
      const api = new NaverCalendarApi({ accessToken: 'access-secret', fetch });
      await expect(api.createSchedule(request)).rejects.toMatchObject({ code: 'request_pre_send' });
    },
  );

  it.each(['ECONNRESET', 'EPIPE'])('classifies ambiguous %s failure as maybe sent', async networkCode => {
    const cause = Object.assign(new Error('connection lost'), { code: networkCode });
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('fetch failed', { cause }));
    const api = new NaverCalendarApi({ accessToken: 'access-secret', fetch });
    await expect(api.createSchedule(request)).rejects.toMatchObject({ code: 'request_maybe_sent' });
  });

  it('classifies response-body loss as maybe sent', async () => {
    const response = { ok: true, status: 200, text: async () => { throw new Error('socket reset'); } } as Response;
    const api = new NaverCalendarApi({ accessToken: 'access-secret', fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response) });
    await expect(api.createSchedule(request)).rejects.toMatchObject({ code: 'request_maybe_sent' });
  });

  it('uses one bounded signal for fetch and body consumption', async () => {
    let requestSignal: AbortSignal | null = null;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      requestSignal = init?.signal ?? null;
      return new Response(new ReadableStream({
        start(controller) {
          requestSignal!.addEventListener('abort', () => controller.error(requestSignal!.reason));
        },
      }), { status: 200 });
    });
    const api = new NaverCalendarApi({ accessToken: 'access-secret', fetch, timeoutMs: 10 });
    const pending = api.createSchedule(request);
    await expect(pending).rejects.toMatchObject({ code: 'request_maybe_sent' });
    expect(requestSignal?.aborted).toBe(true);
  });

  it('redacts bearer tokens and server bodies from all exposed errors', async () => {
    const api = new NaverCalendarApi({
      accessToken: 'access-secret',
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(apiResponse(403, 'Authorization: Bearer access-secret private-body')),
    });
    const error = await api.createSchedule(request).catch(value => value as Error & { code: string });
    const exposed = `${error.name} ${error.message} ${error.stack ?? ''}`;
    expect(error.code).toBe('naver_auth');
    expect(exposed).not.toMatch(/access-secret|private-body|authorization|bearer/i);
  });

  it('rejects oversized chunked JSON and overlong response fields with stable redacted outcomes', async () => {
    const oversized = new Response(JSON.stringify({ value: 'x'.repeat(70_000) }), { status: 200 });
    const hugeField = apiResponse(200, {
      result: 'success', returnValue: { processType: 'create', calendarId: 'x'.repeat(5000), icalUid: 'uid-1' },
    });
    for (const [response, code] of [[oversized, 'request_maybe_sent'], [hugeField, 'naver_invalid_response']] as const) {
      const api = new NaverCalendarApi({ accessToken: 'access-secret', fetch: vi.fn().mockResolvedValue(response) });
      await expect(api.createSchedule(request)).rejects.toMatchObject({ code });
    }
  });
});
