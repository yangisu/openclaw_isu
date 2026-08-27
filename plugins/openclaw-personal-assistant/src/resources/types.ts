export type ResourceContentType = 'web' | 'pdf';

export interface ResourceSaveInput {
  operationId: string;
  url: string;
  title: string;
  summary: string;
  claims: string[];
  tags: string[];
  contentType: ResourceContentType;
  extractedText: string;
  extractedAt: string;
}

export interface ResourceIdentity {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredResource extends ResourceIdentity {
  url: string;
  title: string;
  summary: string;
  claims: string[];
  tags: string[];
  contentType: ResourceContentType;
  extractedText: string;
  extractedAt: string;
  contentSha256: string;
}

export interface ResourceSearchHit {
  id: string;
  url: string;
  title: string;
  summary: string;
  tags: string[];
  contentType: ResourceContentType;
  extractedAt: string;
  score: number;
  excerpt: string;
}

export class ResourceArchiveError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ResourceArchiveError';
  }
}

function resourceError(code: string, message: string): never {
  throw new ResourceArchiveError(code, message);
}

export function canonicalizeResourceUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2_048) {
    resourceError('invalid_url', 'resource URL must be a bounded HTTP(S) URL');
  }

  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    resourceError('invalid_url', 'resource URL must be a valid HTTP(S) URL');
  }
  if (value.protocol !== 'http:' && value.protocol !== 'https:') {
    resourceError('invalid_url', 'resource URL must use HTTP or HTTPS');
  }
  if (value.username || value.password) {
    resourceError('url_credentials', 'resource URL cannot contain credentials');
  }
  if (!value.hostname) resourceError('invalid_url', 'resource URL must include a hostname');

  value.hash = '';
  if ((value.protocol === 'https:' && value.port === '443')
    || (value.protocol === 'http:' && value.port === '80')) {
    value.port = '';
  }
  return value.href;
}

export function validateResourceId(id: string): string {
  const match = /^R-(\d{4})(\d{2})(\d{2})-(\d{3})$/.exec(id);
  if (!match) resourceError('invalid_resource_id', 'resource ID has an invalid format');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    resourceError('invalid_resource_id', 'resource ID contains an invalid date');
  }
  return id;
}
