import type {
  AssistantRecord,
  ParsedDocument,
  ParsedRecord,
  RecordKind,
} from '../domain.js';

export type { AssistantRecord, ParsedDocument, ParsedRecord, RecordKind } from '../domain.js';

export class RecordValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RecordValidationError';
  }
}

const RECORD_KINDS: ReadonlySet<RecordKind> = new Set([
  'task', 'study', 'note', 'preference', 'memory', 'inbox', 'daily',
]);

const TYPE_TO_KIND: Readonly<Record<string, RecordKind>> = {
  task: 'task',
  study: 'study',
  note: 'note',
  preference: 'preference',
  memory: 'memory',
  inbox: 'inbox',
  daily: 'daily',
};

const STRING_FIELDS = new Set([
  'type', 'source', 'subject', 'unit', 'url', 'reason', 'original_text',
  'archive_reason',
]);
const STRING_LIST_FIELDS = new Set(['tags']);
const DATE_LIST_FIELDS = new Set(['review_dates']);
const ID_LIST_FIELDS = new Set(['related_ids']);
const BOOLEAN_FIELDS = new Set(['active']);
const INTEGER_FIELDS = new Set(['target_amount', 'progress']);
const TIMESTAMP_FIELDS = new Set([
  'created_at', 'updated_at', 'due_at', 'completed_at', 'resolved_at',
  'archived_at', 'entry_at',
]);
const DATE_FIELDS = new Set(['target_date']);
const ENUM_FIELDS = new Set([
  'status', 'priority', 'recurrence', 'sensitivity',
]);
const ID_FIELDS = new Set(['supersedes', 'target_id']);

const KIND_ID_PREFIX: Readonly<Record<RecordKind, string>> = {
  task: 'T',
  study: 'S',
  note: 'N',
  preference: 'U',
  memory: 'M',
  inbox: 'I',
  daily: 'D',
};

const HEADING = /^### (\S+) (.*)$/;
const FIELD = /^- ([a-z][a-z0-9_]*): (.+)$/;
const INTEGER = /^(?:0|[1-9]\d*|-[1-9]\d*)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?\+09:00$/;

function invalid(code: string, message: string): never {
  throw new RecordValidationError(code, message);
}

function parseRawValue(rawValue: string): unknown {
  if (rawValue === 'true') return true;
  if (rawValue === 'false') return false;
  if (INTEGER.test(rawValue)) return Number(rawValue);
  if (rawValue.startsWith('"') || rawValue.startsWith('[')) {
    try {
      return JSON.parse(rawValue) as unknown;
    } catch {
      return rawValue;
    }
  }
  return rawValue;
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function assertDate(value: unknown, code = 'invalid_date'): asserts value is string {
  if (typeof value !== 'string') invalid(code, 'date must be a YYYY-MM-DD string');
  const match = DATE.exec(value);
  if (!match || !isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    invalid(code, 'date must be a valid YYYY-MM-DD value');
  }
}

function assertTimestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string') invalid('invalid_timestamp', 'timestamp must be a string');
  const match = TIMESTAMP.exec(value);
  if (!match || !isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    invalid('invalid_timestamp', 'timestamp must be RFC 3339 with +09:00');
  }
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    invalid('invalid_string', `${field} must be a non-empty JSON string`);
  }
}

function assertBoolean(value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') invalid('invalid_boolean', 'active must be true or false');
}

function assertInteger(value: unknown, code = 'invalid_integer'): asserts value is number {
  if (!Number.isSafeInteger(value)) invalid(code, 'value must be a safe decimal integer');
}

function assertEnum(value: unknown, allowed: readonly string[], code: string): asserts value is string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    invalid(code, `value must be one of: ${allowed.join(', ')}`);
  }
}

function isAnyRecordId(value: string): boolean {
  const dated = /^([TSNUMI])-(\d{4})(\d{2})(\d{2})-(\d{3})$/.exec(value);
  if (dated) return isCalendarDate(Number(dated[2]), Number(dated[3]), Number(dated[4]));
  const daily = /^D-([01]\d|2[0-3])([0-5]\d)([0-5]\d)-(\d{3})$/.exec(value);
  return daily !== null;
}

function assertIdForKind(kind: RecordKind, id: string): void {
  const prefix = KIND_ID_PREFIX[kind];
  if (kind === 'daily') {
    if (!/^D-([01]\d|2[0-3])([0-5]\d)([0-5]\d)-(\d{3})$/.test(id)) {
      invalid('invalid_id', 'daily ID must use D-HHMMSS-NNN');
    }
    return;
  }
  const match = new RegExp(`^${prefix}-(\\d{4})(\\d{2})(\\d{2})-(\\d{3})$`).exec(id);
  if (!match || !isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    invalid('invalid_id', `${kind} ID has an invalid format`);
  }
}

function requireField(record: ParsedRecord, key: string): unknown {
  if (!(key in record.fields)) invalid('missing_required_field', `missing required field: ${key}`);
  return record.fields[key];
}

function assertJsonStringField(record: ParsedRecord, key: string, required = true): string | undefined {
  const value = required ? requireField(record, key) : record.fields[key];
  if (value === undefined && !required) return undefined;
  assertString(value, key);
  return value;
}

function assertJsonArray(record: ParsedRecord, key: string, item: (value: unknown) => void): void {
  const values = record.fields[key];
  if (!Array.isArray(values)) invalid('invalid_list', `${key} must be a JSON array`);
  values.forEach(item);
}

function assertRawJsonString(key: string, rawValue: string): void {
  try {
    assertString(JSON.parse(rawValue) as unknown, key);
  } catch (error) {
    if (error instanceof RecordValidationError) throw error;
    invalid('invalid_string', `${key} must be a JSON string`);
  }
}

function assertRawJsonArray(key: string, rawValue: string): void {
  try {
    if (!Array.isArray(JSON.parse(rawValue))) invalid('invalid_list', `${key} must be a JSON array`);
  } catch (error) {
    if (error instanceof RecordValidationError) throw error;
    invalid('invalid_list', `${key} must be a JSON array`);
  }
}

function assertKnownRawSyntax(record: ParsedRecord): void {
  for (const { key, rawValue } of record.orderedFields) {
    if (STRING_FIELDS.has(key)) {
      assertRawJsonString(key, rawValue);
    } else if (STRING_LIST_FIELDS.has(key) || DATE_LIST_FIELDS.has(key) || ID_LIST_FIELDS.has(key)) {
      assertRawJsonArray(key, rawValue);
    } else if (BOOLEAN_FIELDS.has(key) && rawValue !== 'true' && rawValue !== 'false') {
      invalid('invalid_boolean', `${key} must be true or false`);
    } else if (INTEGER_FIELDS.has(key) && !INTEGER.test(rawValue)) {
      invalid('invalid_integer', `${key} must be a decimal integer`);
    } else if (TIMESTAMP_FIELDS.has(key) && !TIMESTAMP.test(rawValue)) {
      invalid('invalid_timestamp', `${key} must be RFC 3339 with +09:00`);
    } else if (DATE_FIELDS.has(key) && !DATE.test(rawValue)) {
      invalid('invalid_date', `${key} must be a YYYY-MM-DD value`);
    } else if (ENUM_FIELDS.has(key) && (rawValue.startsWith('"') || /\s/.test(rawValue))) {
      invalid(key === 'status' ? 'invalid_status' : `invalid_${key}`, `${key} must be a bare enum value`);
    } else if (ID_FIELDS.has(key) && rawValue.startsWith('"')) {
      invalid(key === 'target_id' ? 'invalid_target_id' : 'invalid_supersedes', `${key} must be a bare record ID`);
    }
  }
}

function assertCommon(record: ParsedRecord): void {
  assertTimestamp(requireField(record, 'created_at'));
  assertTimestamp(requireField(record, 'updated_at'));
  assertJsonStringField(record, 'source');
  if ('archived_at' in record.fields) assertTimestamp(record.fields.archived_at);
  if ('archive_reason' in record.fields) assertJsonStringField(record, 'archive_reason', false);
}

/** Validates one parsed record against the section 5.1 Markdown contract. */
export function validateRecord(record: ParsedRecord): void {
  if (record.title.trim().length === 0) invalid('empty_title', 'record title cannot be empty');
  if (record.orderedFields.length !== new Set(record.orderedFields.map(field => field.key)).size) {
    invalid('duplicate_field', 'record fields cannot repeat a key');
  }
  assertKnownRawSyntax(record);

  const type = assertJsonStringField(record, 'type');
  const kind = TYPE_TO_KIND[type ?? ''];
  if (!kind || !RECORD_KINDS.has(kind)) invalid('invalid_type', 'record type is not supported');
  assertIdForKind(kind, record.id);
  assertCommon(record);

  switch (kind) {
    case 'task':
      assertEnum(requireField(record, 'status'), ['open', 'in_progress', 'done', 'archived'], 'invalid_status');
      assertEnum(requireField(record, 'priority'), ['high', 'normal', 'low'], 'invalid_priority');
      for (const key of ['due_at', 'completed_at'] as const) {
        if (key in record.fields) assertTimestamp(record.fields[key]);
      }
      break;
    case 'study': {
      assertEnum(requireField(record, 'status'), ['open', 'in_progress', 'done', 'archived'], 'invalid_status');
      assertJsonStringField(record, 'subject');
      const targetAmount = requireField(record, 'target_amount');
      assertInteger(targetAmount, 'invalid_target_amount');
      if (targetAmount < 1) invalid('invalid_target_amount', 'target_amount must be at least 1');
      assertJsonStringField(record, 'unit');
      const progress = requireField(record, 'progress');
      assertInteger(progress, 'invalid_progress');
      if (progress < 0 || progress > targetAmount) invalid('invalid_progress', 'progress must be between zero and target_amount');
      if ('target_date' in record.fields) assertDate(record.fields.target_date);
      if ('recurrence' in record.fields) assertEnum(record.fields.recurrence, ['none', 'daily', 'weekly'], 'invalid_recurrence');
      if ('review_dates' in record.fields) {
        assertJsonArray(record, 'review_dates', value => assertDate(value));
      }
      break;
    }
    case 'note':
      assertEnum(requireField(record, 'status'), ['active', 'archived'], 'invalid_status');
      if ('url' in record.fields) assertJsonStringField(record, 'url', false);
      if ('tags' in record.fields) assertJsonArray(record, 'tags', value => assertString(value, 'tags item'));
      break;
    case 'preference':
      assertBoolean(requireField(record, 'active'));
      if ('supersedes' in record.fields) assertPrefixedId(record.fields.supersedes, 'U', 'invalid_supersedes');
      break;
    case 'memory':
      assertBoolean(requireField(record, 'active'));
      if ('supersedes' in record.fields) assertPrefixedId(record.fields.supersedes, 'M', 'invalid_supersedes');
      if ('sensitivity' in record.fields) assertEnum(record.fields.sensitivity, ['normal', 'sensitive'], 'invalid_sensitivity');
      break;
    case 'inbox':
      assertEnum(requireField(record, 'status'), ['pending', 'resolved', 'archived'], 'invalid_status');
      assertJsonStringField(record, 'reason');
      assertJsonStringField(record, 'original_text');
      if ('resolved_at' in record.fields) assertTimestamp(record.fields.resolved_at);
      if ('target_id' in record.fields) {
        const target = record.fields.target_id;
        if (typeof target !== 'string' || !isAnyRecordId(target)) {
          invalid('invalid_target_id', 'target_id must be a record ID');
        }
      }
      break;
    case 'daily':
      assertTimestamp(requireField(record, 'entry_at'));
      if ('related_ids' in record.fields) {
        try {
          assertJsonArray(record, 'related_ids', value => {
            if (typeof value !== 'string' || !isAnyRecordId(value)) {
              invalid('invalid_related_ids', 'related_ids must contain record IDs');
            }
          });
        } catch (error) {
          if (error instanceof RecordValidationError && error.code === 'invalid_list') {
            invalid('invalid_related_ids', 'related_ids must contain record IDs');
          }
          throw error;
        }
      }
      break;
  }
}

function assertPrefixedId(value: unknown, prefix: 'U' | 'M', code: string): void {
  if (typeof value !== 'string' || !isAnyRecordId(value) || !value.startsWith(`${prefix}-`)) {
    invalid(code, `supersedes must be a ${prefix} ID`);
  }
}

/** Parses a UTF-8/LF Markdown document without losing unrecognised fields or bodies. */
export function parseDocument(
  kind: RecordKind,
  text: string,
  existingIds: Iterable<string> = [],
): ParsedDocument {
  if (!RECORD_KINDS.has(kind)) invalid('invalid_document', 'unknown document kind');
  if (text.includes('\r')) invalid('invalid_line_endings', 'Markdown must use LF line endings');

  const headings = [...text.matchAll(/^### [^\n]*(?:\n|$)/gm)];
  const firstHeading = headings[0]?.index ?? text.length;
  const document: ParsedDocument = {
    kind,
    preamble: text.slice(0, firstHeading),
    records: [],
  };
  const seenIds = new Set(existingIds);

  for (let headingIndex = 0; headingIndex < headings.length; headingIndex += 1) {
    const matchedHeading = headings[headingIndex];
    const start = matchedHeading.index;
    const end = headings[headingIndex + 1]?.index ?? text.length;
    const headingLine = matchedHeading[0].endsWith('\n')
      ? matchedHeading[0].slice(0, -1)
      : matchedHeading[0];
    const heading = HEADING.exec(headingLine);
    if (!heading) invalid('invalid_heading', 'record heading must use ### <ID> <title>');
    const [, id, title] = heading;
    if (title.trim().length === 0) invalid('empty_title', 'record title cannot be empty');

    const content = text.slice(start + matchedHeading[0].length, end);
    const separator = content.indexOf('\n\n');
    if (separator < 0) invalid('invalid_document', 'fields must be followed by one blank line');
    const fieldBlock = content.slice(0, separator);
    const orderedFields: ParsedRecord['orderedFields'] = [];
    for (const line of fieldBlock.split('\n')) {
      const field = FIELD.exec(line);
      if (!field) invalid('invalid_field', 'fields must be consecutive - key: value lines');
      orderedFields.push({ key: field[1], rawValue: field[2] });
    }
    const fields: Record<string, unknown> = {};
    for (const field of orderedFields) fields[field.key] = parseRawValue(field.rawValue);
    const record: ParsedRecord = {
      id,
      title,
      orderedFields,
      fields,
      body: content.slice(separator + 2),
    };
    validateRecord(record);
    const expectedKind = TYPE_TO_KIND[String(record.fields.type)];
    if (expectedKind !== kind) invalid('invalid_type', `record type does not match ${kind} document`);
    if (seenIds.has(id)) invalid('duplicate_id', `duplicate record ID: ${id}`);
    seenIds.add(id);
    document.records.push(record);
  }
  return document;
}

function serializeValue(key: string, value: unknown, rawValue: string): string {
  if (STRING_FIELDS.has(key) || STRING_LIST_FIELDS.has(key) || DATE_LIST_FIELDS.has(key) || ID_LIST_FIELDS.has(key)) {
    return JSON.stringify(value);
  }
  if (BOOLEAN_FIELDS.has(key)) return value === true ? 'true' : 'false';
  if (INTEGER_FIELDS.has(key)) return String(value);
  if (TIMESTAMP_FIELDS.has(key) || DATE_FIELDS.has(key) || ENUM_FIELDS.has(key)) return String(value);
  if (ID_FIELDS.has(key)) return String(value);
  return rawValue;
}

/** Serializes validated records as UTF-8-compatible LF Markdown. */
export function serializeDocument(document: ParsedDocument): string {
  if (document.preamble.includes('\r')) invalid('invalid_line_endings', 'Markdown must use LF line endings');
  const ids = new Set<string>();
  const records = document.records.map(record => {
    validateRecord(record);
    const kind = TYPE_TO_KIND[String(record.fields.type)];
    if (kind !== document.kind) invalid('invalid_type', 'record type does not match document kind');
    if (ids.has(record.id)) invalid('duplicate_id', `duplicate record ID: ${record.id}`);
    ids.add(record.id);

    const present = new Set<string>();
    const fields: string[] = [];
    for (const field of record.orderedFields) {
      present.add(field.key);
      if (record.fields[field.key] === undefined) continue;
      fields.push(`- ${field.key}: ${serializeValue(field.key, record.fields[field.key], field.rawValue)}`);
    }
    for (const key of Object.keys(record.fields)) {
      if (present.has(key) || record.fields[key] === undefined) continue;
      fields.push(`- ${key}: ${serializeValue(key, record.fields[key], '')}`);
    }
    return `### ${record.id} ${record.title}\n${fields.join('\n')}\n\n${record.body}`;
  });
  const serialized = document.preamble + records.join('');
  if (serialized.includes('\r')) invalid('invalid_line_endings', 'Markdown must use LF line endings');
  return serialized;
}
