export type CalDavErrorCode =
  | 'CALDAV_AUTH'
  | 'CALDAV_TIMEOUT'
  | 'CALDAV_XML'
  | 'CALDAV_DUPLICATE_UID'
  | 'CALDAV_SECRET_PERMISSIONS'
  | 'CALDAV_SECRET'
  | 'CALDAV_TLS_REQUIRED'
  | 'CALDAV_HTTP'
  | 'CALDAV_RESPONSE_TOO_LARGE'
  | 'CALDAV_XML_LIMIT'
  | 'CALDAV_MAPPING';

export class CalDavError extends Error {
  constructor(public readonly code: CalDavErrorCode, message: string) {
    super(message);
    this.name = 'CalDavError';
  }
}
