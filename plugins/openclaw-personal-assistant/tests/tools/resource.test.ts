import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from 'typebox/value';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ResourceCatalog } from '../../src/resources/catalog.js';
import type { StoredResource } from '../../src/resources/types.js';
import { createQueryTool } from '../../src/tools/query.js';
import { createResourceTool, resourceParameters } from '../../src/tools/resource.js';
import type { ResourceMutationResult } from '../../src/workspace/repository.js';

const config = {
  workspaceDir: '/home/user/.openclaw/workspace',
  stateDir: '/home/user/.openclaw/state',
  backupDir: '/mnt/d/openclaw_setting/backups',
  telegramUserId: '123456789',
  timezone: 'Asia/Seoul',
} as const;

const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function api() {
  return { config: {}, pluginConfig: config } as never;
}

function storedResource(): StoredResource {
  return {
    id: 'R-20260827-001',
    url: 'https://example.test/article',
    title: '에이전트 메모리',
    summary: '로컬 자료 보관',
    claims: ['검색 가능'],
    tags: ['AI'],
    contentType: 'web',
    extractedText: '에이전트 메모리 원문',
    extractedAt: '2026-08-27T09:00:00+09:00',
    createdAt: '2026-08-27T09:00:00+09:00',
    updatedAt: '2026-08-27T09:00:00+09:00',
    contentSha256: 'a'.repeat(64),
  };
}

function saveParams() {
  return {
    action: 'save' as const,
    operationId: 'resource-save-1',
    url: 'https://example.test/article',
    title: '에이전트 메모리',
    summary: '로컬 자료 보관',
    claims: ['검색 가능'],
    tags: ['AI'],
    contentType: 'web' as const,
    extractedText: '에이전트 메모리 원문',
    extractedAt: '2026-08-27T09:00:00+09:00',
  };
}

describe('assistant_resource_store', () => {
  it('stores owner-supplied analysis, reconciles the catalog, and marks reads untrusted', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'assistant-resource-tool-'));
    temporaryDirs.push(stateDir);
    const resource = storedResource();
    const mutation: ResourceMutationResult = {
      operationId: 'resource-save-1', id: resource.id, replayed: false, resource,
    };
    const repository = {
      async saveResource() { return mutation; },
      async readResource() { return resource; },
      async listResources() { return [resource]; },
      close() {},
    };
    const tool = createResourceTool(api(), { requesterSenderId: config.telegramUserId }, {
      openRepository: () => repository,
      openCatalog: () => new ResourceCatalog(stateDir),
    });

    const saved = await tool.execute('call-1', saveParams(), undefined);
    const read = await tool.execute('call-2', {
      action: 'read', resourceId: resource.id,
    }, undefined);

    expect(saved.details).toMatchObject({ id: resource.id, replayed: false });
    const verificationCatalog = new ResourceCatalog(stateDir);
    expect(verificationCatalog.search('에이전트', 5).map(hit => hit.id)).toEqual([resource.id]);
    verificationCatalog.close();
    expect(read.details).toMatchObject({
      action: 'read', trust: 'quoted_untrusted_data', resource: { id: resource.id },
    });
  });

  it('rejects a non-owner before opening repository or catalog state', async () => {
    const openRepository = vi.fn();
    const openCatalog = vi.fn();
    const tool = createResourceTool(api(), { requesterSenderId: '999' }, {
      openRepository,
      openCatalog,
    });

    await expect(tool.execute('call-1', saveParams(), undefined))
      .rejects.toMatchObject({ code: 'sender_not_allowed' });
    expect(openRepository).not.toHaveBeenCalled();
    expect(openCatalog).not.toHaveBeenCalled();
  });

  it('uses strict bounded save and read schemas', () => {
    expect(Value.Check(resourceParameters, saveParams())).toBe(true);
    expect(Value.Check(resourceParameters, { ...saveParams(), extra: true })).toBe(false);
    expect(Value.Check(resourceParameters, {
      ...saveParams(), extractedText: 'x'.repeat(100_001),
    })).toBe(false);
    expect(Value.Check(resourceParameters, {
      action: 'read', resourceId: 'R-20260827-001',
    })).toBe(true);
  });

  it('searches synced committed resources through assistant_query', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'assistant-resource-query-'));
    temporaryDirs.push(stateDir);
    const resource = storedResource();
    const query = createQueryTool(api(), { requesterSenderId: config.telegramUserId }, {
      openRepository: () => ({
        async query() { return []; },
        async listResources() { return [resource]; },
        async readResource() { return resource; },
        close() {},
      }),
      openCatalog: () => new ResourceCatalog(stateDir),
    });

    const result = await query.execute('query-1', {
      kind: 'resource_search', query: '에이전트', limit: 5,
    }, undefined);

    expect(result.details).toMatchObject({
      kind: 'resource_search', trust: 'quoted_untrusted_data',
      items: [{ id: resource.id }],
    });
  });
});
