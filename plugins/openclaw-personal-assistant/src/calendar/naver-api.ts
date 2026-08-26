import { BoundedBodyError, readBoundedJson } from './bounded-json.js';

const CREATE_SCHEDULE_ENDPOINT = 'https://openapi.naver.com/calendar/createSchedule.json';
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RESPONSE_FIELD_LENGTH = 1_024;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface CreateScheduleRequest {
  calendarId: string;
  scheduleIcalString: string;
}

export interface CreateScheduleResult {
  processType: 'create';
  calendarId: string;
  icalUid: string;
}

export type NaverCalendarErrorCode =
  | 'request_pre_send'
  | 'request_maybe_sent'
  | 'naver_auth'
  | 'naver_rate_limited'
  | 'naver_server'
  | 'naver_http'
  | 'naver_invalid_request'
  | 'naver_invalid_response';

export class NaverCalendarError extends Error {
  constructor(public readonly code: NaverCalendarErrorCode, message: string) {
    super(message);
    this.name = 'NaverCalendarError';
  }
}

export interface NaverCalendarApiOptions {
  accessToken: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export class NaverCalendarApi {
  readonly #accessToken: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: NaverCalendarApiOptions) {
    if (!options.accessToken) throw new NaverCalendarError('naver_invalid_request', 'Naver access token is required');
    this.#accessToken = options.accessToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async createSchedule(request: CreateScheduleRequest): Promise<CreateScheduleResult> {
    if (!request.calendarId || !request.scheduleIcalString) {
      throw new NaverCalendarError('naver_invalid_request', 'Calendar ID and iCalendar payload are required');
    }
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(CREATE_SCHEDULE_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#accessToken}`,
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: new URLSearchParams({
          calendarId: request.calendarId,
          scheduleIcalString: request.scheduleIcalString,
        }),
        signal,
      });
    } catch (error) {
      if (isProvenPreSend(error)) {
        throw new NaverCalendarError('request_pre_send', 'Naver Calendar request was not sent');
      }
      throw new NaverCalendarError('request_maybe_sent', 'Naver Calendar request outcome is unknown');
    }

    const httpError = classifyHttp(response.status);
    if (httpError) throw httpError;

    let decoded: unknown;
    try {
      decoded = await readBoundedJson(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof BoundedBodyError && ['invalid_json', 'invalid_shape'].includes(error.code)) {
        throw new NaverCalendarError('naver_invalid_response', 'Naver Calendar returned an invalid response');
      }
      throw new NaverCalendarError('request_maybe_sent', 'Naver Calendar response was not received completely');
    }
    const envelope = objectValue(decoded);
    const returnValue = objectValue(envelope.returnValue);
    const processType = nonEmptyString(returnValue.processType);
    if (envelope.result === 'success' && processType === 'modify') {
      throw new NaverCalendarError('request_maybe_sent', 'Naver Calendar modified an existing schedule');
    }
    const calendarId = nonEmptyString(returnValue.calendarId);
    const icalUid = nonEmptyString(returnValue.icalUid);
    if (envelope.result !== 'success' || processType !== 'create' || !calendarId || !icalUid) {
      throw new NaverCalendarError('naver_invalid_response', 'Naver Calendar returned an incomplete create response');
    }
    return { processType: 'create', calendarId, icalUid };
  }
}

const PROVEN_PRE_SEND_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_DNS',
]);

function isProvenPreSend(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === 'string' && PROVEN_PRE_SEND_CODES.has(record.code)) return true;
    current = record.cause;
  }
  return false;
}

function classifyHttp(status: number): NaverCalendarError | undefined {
  if (status >= 200 && status < 300) return undefined;
  if (status === 401 || status === 403) return new NaverCalendarError('naver_auth', 'Naver Calendar authentication failed');
  if (status === 429) return new NaverCalendarError('naver_rate_limited', 'Naver Calendar rate limit exceeded');
  if (status >= 500) return new NaverCalendarError('naver_server', 'Naver Calendar server failed');
  return new NaverCalendarError('naver_http', `Naver Calendar request failed with HTTP ${status}`);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_RESPONSE_FIELD_LENGTH ? value : undefined;
}
