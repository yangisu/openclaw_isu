import { createHash } from 'node:crypto';
import {
  canonicalizeResourceUrl,
  ResourceArchiveError,
  type ResourceContentType,
  type ResourceIdentity,
  type ResourceSaveInput,
  type StoredResource,
  validateResourceId,
} from './types.js';

const METADATA_VERSION = 1;
const MAX_CONTENT_CHARS = 100_000;
const METADATA_KEYS = [
  'version', 'id', 'url', 'title', 'summary', 'claims', 'tags', 'contentType',
  'extractedAt', 'createdAt', 'updatedAt', 'contentFile', 'contentSha256',
] as const;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const DISALLOWED_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

interface ResourceMetadata {
  version: 1;
  id: string;
  url: string;
  title: string;
  summary: string;
  claims: string[];
  tags: string[];
  contentType: ResourceContentType;
  extractedAt: string;
  createdAt: string;
  updatedAt: string;
  contentFile: 'content.md';
  contentSha256: string;
}

function invalid(code: string, message: string): never {
  throw new ResourceArchiveError(code, message);
}

function assertTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !RFC3339.test(value) || !Number.isFinite(Date.parse(value))) {
    invalid('invalid_resource_timestamp', `${field} must be an RFC 3339 timestamp`);
  }
}

function assertText(value: unknown, field: string, maximum: number, oneLine = false): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    invalid('invalid_resource_text', `${field} must contain 1-${maximum} characters`);
  }
  if (DISALLOWED_CONTROL.test(value) || (oneLine && /[\r\n]/u.test(value))) {
    invalid('invalid_resource_text', `${field} contains disallowed controls or line breaks`);
  }
  if (/^###\s/u.test(value)) {
    invalid('invalid_resource_text', `${field} cannot inject a record heading`);
  }
}

function assertStringList(
  value: unknown,
  field: string,
  maximumItems: number,
  maximumLength: number,
  unique = false,
): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    invalid('invalid_resource_list', `${field} exceeds its item limit`);
  }
  value.forEach(item => assertText(item, field, maximumLength, true));
  if (unique && new Set(value.map(item => item.normalize('NFKC').toLocaleLowerCase('und'))).size !== value.length) {
    invalid('duplicate_resource_tag', 'resource tags must be unique');
  }
}

function normalizedContent(raw: unknown): string {
  if (typeof raw !== 'string') invalid('invalid_resource_content', 'resource content must be text');
  const value = raw.replace(/\r\n?/gu, '\n');
  if (value.length > MAX_CONTENT_CHARS) {
    invalid('resource_content_too_large', 'resource content exceeds 100000 characters');
  }
  if (DISALLOWED_CONTROL.test(value)) {
    invalid('invalid_resource_content', 'resource content contains disallowed controls');
  }
  return value;
}

function validateInput(input: ResourceSaveInput, identity: ResourceIdentity): ResourceMetadata {
  if (!/^[\x21-\x7E]{1,128}$/u.test(input.operationId)) {
    invalid('invalid_operation_id', 'operation ID must contain 1-128 printable ASCII characters');
  }
  validateResourceId(identity.id);
  assertTimestamp(identity.createdAt, 'createdAt');
  assertTimestamp(identity.updatedAt, 'updatedAt');
  assertTimestamp(input.extractedAt, 'extractedAt');
  assertText(input.title, 'title', 200, true);
  assertText(input.summary, 'summary', 4_000);
  assertStringList(input.claims, 'claims', 32, 1_000);
  assertStringList(input.tags, 'tags', 64, 64, true);
  if (input.contentType !== 'web' && input.contentType !== 'pdf') {
    invalid('invalid_resource_content_type', 'resource content type must be web or pdf');
  }
  const content = normalizedContent(input.extractedText);
  return {
    version: METADATA_VERSION,
    id: identity.id,
    url: canonicalizeResourceUrl(input.url),
    title: input.title,
    summary: input.summary,
    claims: [...input.claims],
    tags: [...input.tags],
    contentType: input.contentType,
    extractedAt: input.extractedAt,
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
    contentFile: 'content.md',
    contentSha256: createHash('sha256').update(content, 'utf8').digest('hex'),
  };
}

export function encodeResourceFiles(
  input: ResourceSaveInput,
  identity: ResourceIdentity,
): { metadata: string; content: string } {
  const normalized = normalizedContent(input.extractedText);
  const metadata = validateInput(input, identity);
  return {
    metadata: `${JSON.stringify(metadata, null, 2)}\n`,
    content: `${normalized}\n`,
  };
}

function parseMetadata(raw: string): ResourceMetadata {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    invalid('invalid_resource_metadata', 'resource metadata must be valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid('invalid_resource_metadata', 'resource metadata must be an object');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== METADATA_KEYS.length || METADATA_KEYS.some((key, index) => keys[index] !== key)) {
    invalid('invalid_resource_metadata', 'resource metadata keys or order are invalid');
  }
  if (record.version !== METADATA_VERSION || record.contentFile !== 'content.md') {
    invalid('invalid_resource_metadata', 'resource metadata version or content reference is invalid');
  }
  if (typeof record.id !== 'string') invalid('invalid_resource_id', 'resource ID is missing');
  validateResourceId(record.id);
  if (typeof record.url !== 'string' || canonicalizeResourceUrl(record.url) !== record.url) {
    invalid('invalid_resource_metadata', 'stored resource URL is not canonical');
  }
  assertText(record.title, 'title', 200, true);
  assertText(record.summary, 'summary', 4_000);
  assertStringList(record.claims, 'claims', 32, 1_000);
  assertStringList(record.tags, 'tags', 64, 64, true);
  if (record.contentType !== 'web' && record.contentType !== 'pdf') {
    invalid('invalid_resource_content_type', 'resource content type must be web or pdf');
  }
  assertTimestamp(record.extractedAt, 'extractedAt');
  assertTimestamp(record.createdAt, 'createdAt');
  assertTimestamp(record.updatedAt, 'updatedAt');
  if (typeof record.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(record.contentSha256)) {
    invalid('invalid_resource_metadata', 'resource content hash is invalid');
  }
  return record as unknown as ResourceMetadata;
}

export function decodeResourceFiles(metadataRaw: string, contentRaw: string): StoredResource {
  const metadata = parseMetadata(metadataRaw);
  if (!contentRaw.endsWith('\n')) invalid('invalid_resource_content', 'resource content must end in one newline');
  const content = normalizedContent(contentRaw.slice(0, -1));
  if (`${content}\n` !== contentRaw) invalid('invalid_resource_content', 'resource content is not canonical');
  const hash = createHash('sha256').update(content, 'utf8').digest('hex');
  if (hash !== metadata.contentSha256) {
    invalid('resource_content_hash_mismatch', 'resource content does not match metadata');
  }
  return {
    id: metadata.id,
    url: metadata.url,
    title: metadata.title,
    summary: metadata.summary,
    claims: [...metadata.claims],
    tags: [...metadata.tags],
    contentType: metadata.contentType,
    extractedText: content,
    extractedAt: metadata.extractedAt,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    contentSha256: metadata.contentSha256,
  };
}
