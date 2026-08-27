import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  ResourceArchiveError,
  type ResourceContentType,
  type ResourceSearchHit,
  type StoredResource,
} from './types.js';

const DATABASE_NAME = 'resource-catalog.sqlite3';
const SCHEMA_VERSION = 1;
const SCHEMA = `
CREATE TABLE schema_meta (
  version INTEGER PRIMARY KEY CHECK (version = 1)
) STRICT;
INSERT INTO schema_meta (version) VALUES (1);
CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  claims_json TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('web','pdf')),
  extracted_text TEXT NOT NULL,
  extracted_at TEXT NOT NULL,
  content_hash TEXT NOT NULL
) STRICT;
PRAGMA user_version = 1;
`;

interface CatalogRow {
  id: string;
  url: string;
  title: string;
  summary: string;
  claims_json: string;
  tags_json: string;
  content_type: ResourceContentType;
  extracted_text: string;
  extracted_at: string;
  content_hash: string;
}

function invalid(code: string, message: string): never {
  throw new ResourceArchiveError(code, message);
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('und');
}

function queryTerms(query: string): string[] {
  if (typeof query !== 'string' || query.length > 1_000) {
    invalid('invalid_resource_query', 'resource query must be bounded text');
  }
  const terms = normalize(query)
    .split(/[\p{P}\p{S}\s]+/u)
    .map(term => term.trim())
    .filter(Boolean);
  const unique = [...new Set(terms)];
  if (unique.length === 0 || unique.length > 32) {
    invalid('invalid_resource_query', 'resource query must contain 1-32 terms');
  }
  return unique;
}

function parsedStringArray(raw: string, field: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    invalid('resource_catalog_corrupt', `${field} is not valid JSON`);
  }
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    invalid('resource_catalog_corrupt', `${field} is not a string array`);
  }
  return value as string[];
}

function termScore(row: CatalogRow, claims: string[], tags: string[], term: string): number {
  const title = normalize(row.title);
  if (title === term) return 100;
  if (title.startsWith(term) || title.includes(term)) return 70;
  if (tags.some(tag => normalize(tag) === term)) return 60;
  if (normalize(row.summary).includes(term) || claims.some(claim => normalize(claim).includes(term))) {
    return 30;
  }
  if (normalize(row.extracted_text).includes(term)) return 10;
  return 0;
}

function excerpt(row: CatalogRow, claims: string[], tags: string[], terms: string[]): string {
  const candidates = [row.title, ...tags, row.summary, ...claims, row.extracted_text];
  for (const candidate of candidates) {
    const cleaned = candidate.replace(/[\u0000-\u001F\u007F]+/gu, ' ').replace(/\s+/gu, ' ').trim();
    const normalized = normalize(cleaned);
    const term = terms.find(item => normalized.includes(item));
    if (!term) continue;
    const found = normalized.indexOf(term);
    const start = Math.max(0, found - 80);
    const slice = cleaned.slice(start, start + 240);
    return `${start > 0 ? '…' : ''}${slice}`.slice(0, 240);
  }
  return '';
}

function assertCompatible(database: DatabaseSync): void {
  const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown };
  const userVersion = Number(
    (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
  );
  const tables = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as unknown as Array<{ name: string }>;
  const meta = userVersion === SCHEMA_VERSION
    ? database.prepare('SELECT version FROM schema_meta').get() as { version?: unknown } | undefined
    : undefined;
  if (integrity.integrity_check !== 'ok'
    || userVersion !== SCHEMA_VERSION
    || tables.map(row => row.name).join(',') !== 'resources,schema_meta'
    || meta?.version !== SCHEMA_VERSION) {
    throw new ResourceArchiveError('resource_catalog_schema_mismatch', 'resource catalog schema is incompatible');
  }
}

function createDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec('PRAGMA busy_timeout = 10000;');
  database.exec(SCHEMA);
  chmodSync(path, 0o600);
  return database;
}

function openDatabase(path: string): DatabaseSync {
  if (!existsSync(path)) return createDatabase(path);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path);
    database.exec('PRAGMA busy_timeout = 10000;');
    assertCompatible(database);
    return database;
  } catch {
    database?.close();
    const quarantine = `${path}.corrupt-${process.pid}-${Date.now()}`;
    renameSync(path, quarantine);
    for (const suffix of ['-wal', '-shm'] as const) {
      const sidecar = `${path}${suffix}`;
      if (existsSync(sidecar)) renameSync(sidecar, `${quarantine}${suffix}`);
    }
    return createDatabase(path);
  }
}

export class ResourceCatalog {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.database = openDatabase(join(stateDir, DATABASE_NAME));
  }

  sync(resources: StoredResource[]): void {
    if (this.closed) invalid('resource_catalog_closed', 'resource catalog is closed');
    const ids = new Set<string>();
    const urls = new Set<string>();
    for (const resource of resources) {
      if (ids.has(resource.id) || urls.has(resource.url)) {
        invalid('resource_catalog_conflict', 'resource catalog input contains duplicate IDs or URLs');
      }
      ids.add(resource.id);
      urls.add(resource.url);
    }

    const insert = this.database.prepare(`
      INSERT INTO resources (
        id, url, title, summary, claims_json, tags_json, content_type,
        extracted_text, extracted_at, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec('DELETE FROM resources');
      for (const resource of [...resources].sort((left, right) => left.id.localeCompare(right.id))) {
        insert.run(
          resource.id,
          resource.url,
          resource.title,
          resource.summary,
          JSON.stringify(resource.claims),
          JSON.stringify(resource.tags),
          resource.contentType,
          resource.extractedText,
          resource.extractedAt,
          resource.contentSha256,
        );
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  search(query: string, limit: number): ResourceSearchHit[] {
    if (this.closed) invalid('resource_catalog_closed', 'resource catalog is closed');
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      invalid('invalid_resource_limit', 'resource search limit must be 1-20');
    }
    const terms = queryTerms(query);
    const rows = this.database.prepare(`
      SELECT id, url, title, summary, claims_json, tags_json, content_type,
             extracted_text, extracted_at, content_hash
      FROM resources ORDER BY id
    `).all() as unknown as CatalogRow[];

    return rows.map(row => {
      const claims = parsedStringArray(row.claims_json, 'claims');
      const tags = parsedStringArray(row.tags_json, 'tags');
      const score = terms.reduce((total, term) => total + termScore(row, claims, tags, term), 0);
      return {
        id: row.id,
        url: row.url,
        title: row.title,
        summary: row.summary,
        tags,
        contentType: row.content_type,
        extractedAt: row.extracted_at,
        score,
        excerpt: excerpt(row, claims, tags, terms),
      } satisfies ResourceSearchHit;
    })
      .filter(hit => hit.score > 0)
      .sort((left, right) => right.score - left.score
        || right.extractedAt.localeCompare(left.extractedAt)
        || left.id.localeCompare(right.id))
      .slice(0, limit);
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}
