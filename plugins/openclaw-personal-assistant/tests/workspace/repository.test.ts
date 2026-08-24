import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { AssistantConfig } from '../../src/config.js';
import { parseDocument } from '../../src/markdown/codec.js';
import {
  openRepository,
  type AddTaskInput,
  type RepositoryCheckpoint,
  type WorkspaceRepository,
} from '../../src/workspace/repository.js';

const repositories: WorkspaceRepository[] = [];
const fixedNow = () => new Date('2026-08-25T00:03:00.000Z');

afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
});

function git(workspace: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
}

async function fixture(
  checkpoint?: (phase: RepositoryCheckpoint) => void | Promise<void>,
): Promise<{ config: AssistantConfig; repo: WorkspaceRepository; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-repository-'));
  const workspace = join(root, 'workspace');
  const stateDir = join(root, 'state');
  await mkdir(workspace);
  await mkdir(stateDir);
  await writeFile(join(workspace, 'TASKS.md'), '# Tasks\n\n');
  await writeFile(join(workspace, 'INBOX.md'), '# Inbox\n\n');
  git(workspace, 'init', '--quiet');
  git(workspace, 'config', 'user.name', 'Assistant Tests');
  git(workspace, 'config', 'user.email', 'assistant@example.test');
  git(workspace, 'config', 'core.autocrlf', 'false');
  git(workspace, 'add', '--', 'TASKS.md', 'INBOX.md');
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

function taskInput(index: number): AddTaskInput {
  return {
    title: `Task ${index}`,
    body: `Body ${index}\n`,
    priority: index % 2 === 0 ? 'high' : 'normal',
    source: 'telegram',
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

describe('WorkspaceRepository', () => {
  it('allocates ten unique IDs under concurrent adds', async () => {
    const { repo, workspace } = await fixture();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => repo.addTask(`op-${i}`, taskInput(i))),
    );

    expect(new Set(results.map(result => result.id)).size).toBe(10);
    expect(parseDocument('task', await readFile(join(workspace, 'TASKS.md'), 'utf8')).records)
      .toHaveLength(10);
  }, 20_000);

  it('does not duplicate an applied operation after restart', async () => {
    const { config, repo } = await fixture();
    const first = await repo.addTask('stable-operation-id', taskInput(1));
    const restarted = await restart(config, repo);

    const replay = await restarted.addTask('stable-operation-id', taskInput(1));
    expect(replay).toMatchObject({ id: first.id, replayed: true });
    expect(await restarted.query({ kind: 'task' })).toHaveLength(1);
  });

  it('preserves unrelated staged and unstaged Git changes', async () => {
    const { repo, workspace } = await fixture();
    await writeFile(join(workspace, 'staged.txt'), 'staged user change\n');
    await writeFile(join(workspace, 'unstaged.txt'), 'unstaged user change\n');
    git(workspace, 'add', '--', 'staged.txt');

    const result = await repo.addTask('git-scope', taskInput(1));

    expect(result.gitCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(git(workspace, 'show', '--format=', '--name-only', result.gitCommit!)).toBe('TASKS.md');
    const status = git(workspace, 'status', '--short');
    expect(status).toContain('A  staged.txt');
    expect(status).toContain('?? unstaged.txt');
  });

  it('matches operation trailers as whole lines rather than prefixes', async () => {
    const { repo, workspace } = await fixture();
    const longer = await repo.addTask('op-10', taskInput(10));
    const shorter = await repo.addTask('op-1', taskInput(1));

    expect(shorter.gitCommit).not.toBe(longer.gitCommit);
    expect(git(workspace, 'status', '--short', '--', 'TASKS.md')).toBe('');
    expect(git(workspace, 'show', '-s', '--format=%B', shorter.gitCommit!))
      .toContain('\nAssistant-Operation-Id: op-1');
  });

  it.each(['beforeRename', 'afterRename', 'afterGitCommit'] as const)(
    'recovers idempotently after interruption at %s',
    async crashPhase => {
      let interrupt = true;
      const { config, repo, workspace } = await fixture(phase => {
        if (phase === crashPhase && interrupt) throw new Error(`crash:${phase}`);
      });

      await expect(repo.addTask(`crash-${crashPhase}`, taskInput(1)))
        .rejects.toThrow(`crash:${crashPhase}`);
      const countAfterCrash = parseDocument(
        'task',
        await readFile(join(workspace, 'TASKS.md'), 'utf8'),
      ).records.length;
      expect(countAfterCrash).toBe(crashPhase === 'beforeRename' ? 0 : 1);
      expect((await readdir(workspace)).filter(name => name.includes('.tmp-'))).toEqual([]);

      interrupt = false;
      const restarted = await restart(config, repo);
      const result = await restarted.addTask(`crash-${crashPhase}`, taskInput(1));
      expect(result).toMatchObject({ id: 'T-20260825-001', replayed: true });
      expect(await restarted.query({ kind: 'task' })).toHaveLength(1);
      expect(git(workspace, 'log', '--format=%B', '--all').split(`Assistant-Operation-Id: crash-${crashPhase}`))
        .toHaveLength(2);
    },
  );

  it('updates, queries, and archives a record without losing its body', async () => {
    const { repo, workspace } = await fixture();
    const added = await repo.addTask('add', taskInput(1));
    const updated = await repo.updateRecord('update', added.id, {
      title: 'Changed title',
      fields: { status: 'done', completed_at: '2026-08-25T09:03:00+09:00' },
    });
    expect(updated.record).toMatchObject({
      title: 'Changed title',
      body: 'Body 1\n',
      fields: { status: 'done' },
    });

    const archived = await repo.archiveRecord('archive', added.id, 'completed');
    expect(archived.record.fields).toMatchObject({
      status: 'archived',
      archived_at: '2026-08-25T09:03:00+09:00',
      archive_reason: 'completed',
    });
    expect(await repo.query({ kind: 'task' })).toEqual([]);
    expect(await repo.query({ kind: 'task', includeArchived: true })).toHaveLength(1);
    expect(parseDocument(
      'task',
      await readFile(join(workspace, 'archive', 'TASKS.md'), 'utf8'),
    ).records[0].body).toBe('Body 1\n');
  });

  it('fails closed if the managed target was already modified by the user', async () => {
    const { repo, workspace } = await fixture();
    await writeFile(join(workspace, 'TASKS.md'), '# Tasks\n\nUser edit\n');

    await expect(repo.addTask('conflict', taskInput(1))).rejects.toMatchObject({
      code: 'workspace_conflict',
    });
    expect(await readFile(join(workspace, 'TASKS.md'), 'utf8')).toBe('# Tasks\n\nUser edit\n');
  });

  it('re-reads the target immediately before rename and preserves a racing user edit', async () => {
    let changed = false;
    let workspace = '';
    const created = await fixture(async phase => {
      if (phase === 'beforeRename' && !changed) {
        changed = true;
        await writeFile(join(workspace, 'TASKS.md'), '# Tasks\n\nRacing user edit\n');
      }
    });
    workspace = created.workspace;

    await expect(created.repo.addTask('racing-edit', taskInput(1))).rejects.toMatchObject({
      code: 'workspace_conflict',
    });
    expect(await readFile(join(workspace, 'TASKS.md'), 'utf8'))
      .toBe('# Tasks\n\nRacing user edit\n');
  });

  it('fails closed when an applied operation no longer matches Markdown on restart', async () => {
    let interrupt = true;
    const { config, repo, workspace } = await fixture(phase => {
      if (phase === 'afterRename' && interrupt) throw new Error('crash:afterRename');
    });
    await expect(repo.addTask('applied-mismatch', taskInput(1))).rejects.toThrow('crash:afterRename');
    await writeFile(join(workspace, 'TASKS.md'), '# Tasks\n\nReplacement user text\n');
    interrupt = false;
    const restarted = await restart(config, repo);

    await expect(restarted.addTask('applied-mismatch', taskInput(1))).rejects.toMatchObject({
      code: 'operation_reconcile_conflict',
    });
    expect(await readFile(join(workspace, 'TASKS.md'), 'utf8'))
      .toBe('# Tasks\n\nReplacement user text\n');
    expect(parseDocument('inbox', await readFile(join(workspace, 'INBOX.md'), 'utf8')).records)
      .toHaveLength(1);
  });

  it('queries, updates, and archives daily records in their dated files', async () => {
    const { repo, workspace } = await fixture();
    await mkdir(join(workspace, 'memory'));
    await writeFile(join(workspace, 'memory', '2026-08-25.md'), [
      '# Daily Memory',
      '',
      '### D-090300-001 Morning note',
      '- type: "daily"',
      '- entry_at: 2026-08-25T09:03:00+09:00',
      '- created_at: 2026-08-25T09:03:00+09:00',
      '- updated_at: 2026-08-25T09:03:00+09:00',
      '- source: "telegram"',
      '',
      'Daily body',
      '',
    ].join('\n'));
    git(workspace, 'add', '--', 'memory/2026-08-25.md');
    git(workspace, 'commit', '--quiet', '-m', 'add daily fixture');

    expect(await repo.query({ kind: 'daily' })).toHaveLength(1);
    await repo.updateRecord('update-daily', 'D-090300-001', {
      fields: { source: 'manual' },
    });
    await repo.archiveRecord('archive-daily', 'D-090300-001', 'rolled up');

    expect(await repo.query({ kind: 'daily' })).toEqual([]);
    expect(await repo.query({ kind: 'daily', includeArchived: true })).toHaveLength(1);
    expect(parseDocument(
      'daily',
      await readFile(join(workspace, 'archive', '2026-08-25.md'), 'utf8'),
    ).records[0].fields).toMatchObject({ source: 'manual', archive_reason: 'rolled up' });
  });
});
