import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ResourceCatalog } from '../../src/resources/catalog.js';
import type { StoredResource } from '../../src/resources/types.js';

const catalogs: ResourceCatalog[] = [];

afterEach(() => {
  while (catalogs.length > 0) catalogs.pop()?.close();
});

function resource(overrides: Partial<StoredResource> & Pick<StoredResource, 'id'>): StoredResource {
  return {
    id: overrides.id,
    url: `https://example.test/${overrides.id}`,
    title: '기타',
    summary: '요약',
    claims: [],
    tags: [],
    contentType: 'web',
    extractedText: '본문',
    extractedAt: '2026-08-27T09:00:00+09:00',
    createdAt: '2026-08-27T09:00:00+09:00',
    updatedAt: '2026-08-27T09:00:00+09:00',
    contentSha256: 'a'.repeat(64),
    ...overrides,
  };
}

async function catalogFixture(): Promise<{ catalog: ResourceCatalog; stateDir: string }> {
  const stateDir = await mkdtemp(join(tmpdir(), 'assistant-resource-catalog-'));
  const catalog = new ResourceCatalog(stateDir);
  catalogs.push(catalog);
  return { catalog, stateDir };
}

describe('ResourceCatalog', () => {
  it('ranks title then tags then summary then body with stable ties', async () => {
    const { catalog } = await catalogFixture();
    catalog.sync([
      resource({
        id: 'R-20260827-001',
        title: '에이전트 메모리',
        tags: ['AI'],
        summary: '기억 구조',
        extractedText: '검색',
      }),
      resource({
        id: 'R-20260827-002',
        title: '기타',
        tags: ['에이전트'],
        summary: 'AI 기억 구조',
        extractedText: '메모리',
      }),
      resource({
        id: 'R-20260827-003',
        summary: '에이전트 설계',
        extractedAt: '2026-08-27T10:00:00+09:00',
      }),
      resource({ id: 'R-20260827-004', extractedText: '에이전트 본문' }),
    ]);

    expect(catalog.search('에이전트', 5).map(hit => hit.id)).toEqual([
      'R-20260827-001',
      'R-20260827-002',
      'R-20260827-003',
      'R-20260827-004',
    ]);
  });

  it('normalizes Korean and English terms and returns a bounded control-free excerpt', async () => {
    const { catalog } = await catalogFixture();
    catalog.sync([resource({
      id: 'R-20260827-001',
      title: 'ＡＩ Memory',
      extractedText: `${'앞'.repeat(220)}\nMEMORY\u0009${'뒤'.repeat(220)}`,
    })]);

    const [hit] = catalog.search('ai memory', 5);
    expect(hit).toMatchObject({ id: 'R-20260827-001', title: 'ＡＩ Memory' });
    expect(hit.excerpt.length).toBeLessThanOrEqual(240);
    expect(hit.excerpt).not.toMatch(/[\u0000-\u001f\u007f]/u);
  });

  it('rebuilds a corrupt catalog only from supplied committed resources', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'assistant-resource-catalog-corrupt-'));
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'resource-catalog.sqlite3'), 'not a database');

    const catalog = new ResourceCatalog(stateDir);
    catalogs.push(catalog);
    catalog.sync([resource({ id: 'R-20260827-001', title: 'Memory archive' })]);

    expect(catalog.search('memory', 5).map(hit => hit.id)).toEqual(['R-20260827-001']);
  });

  it('replaces removed rows during sync and validates query limits', async () => {
    const { catalog } = await catalogFixture();
    catalog.sync([resource({ id: 'R-20260827-001', title: 'Old memory' })]);
    catalog.sync([resource({ id: 'R-20260827-002', title: 'New memory' })]);

    expect(catalog.search('memory', 5).map(hit => hit.id)).toEqual(['R-20260827-002']);
    expect(() => catalog.search('', 5)).toThrow(expect.objectContaining({ code: 'invalid_resource_query' }));
    expect(() => catalog.search('memory', 21)).toThrow(expect.objectContaining({ code: 'invalid_resource_limit' }));
  });
});
