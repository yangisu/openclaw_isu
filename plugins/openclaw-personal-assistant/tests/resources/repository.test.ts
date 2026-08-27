import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { AssistantConfig } from '../../src/config.js';
import type { ResourceSaveInput } from '../../src/resources/types.js';
import {
  openRepository,
  type RepositoryCheckpoint,
  type WorkspaceRepository,
} from '../../src/workspace/repository.js';

const repositories: WorkspaceRepository[] = [];
const fixedNow = () => new Date('2026-08-27T00:00:00.000Z');

afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
});

function git(workspace: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
}

async function fixture(
  checkpoint?: (phase: RepositoryCheckpoint) => void | Promise<void>,
): Promise<{ config: AssistantConfig; repo: WorkspaceRepository; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-resource-repository-'));
  const workspace = join(root, 'workspace');
  const stateDir = join(root, 'state');
  await mkdir(workspace);
  await mkdir(stateDir);
  await writeFile(join(workspace, 'INBOX.md'), '# Inbox\n\n');
  git(workspace, 'init', '--quiet');
  git(workspace, 'config', 'user.name', 'Assistant Tests');
  git(workspace, 'config', 'user.email', 'assistant@example.test');
  git(workspace, 'config', 'core.autocrlf', 'false');
  git(workspace, 'add', '--', 'INBOX.md');
  git(workspace, 'commit', '--quiet', '-m', 'initial');
  const config: AssistantConfig = {
    workspaceDir: workspace,
    stateDir,
    backupDir: join(root, 'backup'),
    telegramUserId: '42',
    timezone: 'Asia/Seoul',
  };
  const repo = await openRepository(config, { now: fixedNow, checkpoint });
  repositories.push(repo);
  return { config, repo, workspace };
}

function resourceInput(
  operationId: string,
  url = 'https://example.test/article#first',
  summary = 'first summary',
): ResourceSaveInput {
  return {
    operationId,
    url,
    title: '에이전트 자료',
    summary,
    claims: ['로컬에 저장한다.'],
    tags: ['AI'],
    contentType: 'web',
    extractedText: `${summary}\nsource text`,
    extractedAt: '2026-08-27T09:00:00+09:00',
  };
}

async function restart(
  config: AssistantConfig,
  previous: WorkspaceRepository,
): Promise<WorkspaceRepository> {
  previous.close();
  repositories.splice(repositories.indexOf(previous), 1);
  const restarted = await openRepository(config, { now: fixedNow });
  repositories.push(restarted);
  return restarted;
}

describe('WorkspaceRepository resource snapshots', () => {
  it('keeps one stable ID when the same canonical URL is saved again', async () => {
    const { repo, workspace } = await fixture();
    const first = await repo.saveResource(
      'resource-save-1',
      resourceInput('resource-save-1'),
    );
    const second = await repo.saveResource(
      'resource-save-2',
      resourceInput('resource-save-2', 'https://EXAMPLE.test:443/article#second', 'updated'),
    );

    expect(second.id).toBe(first.id);
    expect(second.resource.summary).toBe('updated');
    expect(git(workspace, 'log', '--format=%H', '--', `resources/${first.id}`).split(/\r?\n/u))
      .toHaveLength(2);
  });

  it('replays one operation and reads only committed resource pairs', async () => {
    const { repo } = await fixture();
    const input = resourceInput('resource-replay');
    const first = await repo.saveResource('resource-replay', input);
    const replay = await repo.saveResource('resource-replay', input);

    expect(replay).toMatchObject({ id: first.id, replayed: true });
    await expect(repo.readResource(first.id)).resolves.toMatchObject({
      id: first.id,
      url: 'https://example.test/article',
    });
    await expect(repo.listResources()).resolves.toHaveLength(1);
  });

  it.each(['beforeRename', 'afterRename', 'afterGitCommit'] as const)(
    'recovers an interrupted resource mutation at %s',
    async checkpoint => {
      let interrupted = false;
      const setup = await fixture(phase => {
        if (!interrupted && phase === checkpoint) {
          interrupted = true;
          throw new Error(`interrupt-${checkpoint}`);
        }
      });
      const input = resourceInput(`recover-${checkpoint}`);

      await expect(setup.repo.saveResource(input.operationId, input))
        .rejects.toThrow(`interrupt-${checkpoint}`);
      const recoveredRepo = await restart(setup.config, setup.repo);
      const recovered = await recoveredRepo.saveResource(input.operationId, input);

      expect(recovered.id).toMatch(/^R-20260827-/u);
      expect(await recoveredRepo.readResource(recovered.id)).toMatchObject({
        summary: input.summary,
      });
      expect(await readFile(
        join(setup.workspace, 'resources', recovered.id, 'content.md'),
        'utf8',
      )).toContain('source text');
    },
  );
});
