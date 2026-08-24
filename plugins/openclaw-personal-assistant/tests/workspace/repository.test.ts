import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
      if (crashPhase === 'afterRename') {
        expect(repo.ledger.get(`crash-${crashPhase}`)?.phase).toBe('begun');
      }
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

  it('recovers a dead child process lock and quarantines only its known temp file', async () => {
    const { config, repo, workspace } = await fixture();
    const tsc = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json']);
    const repositoryUrl = pathToFileURL(
      join(process.cwd(), 'dist', 'workspace', 'repository.js'),
    ).href;
    const childProgram = `
      import { openRepository } from ${JSON.stringify(repositoryUrl)};
      const config = JSON.parse(process.env.ASSISTANT_CRASH_CONFIG);
      const repo = await openRepository(config, {
        now: () => new Date('2026-08-25T00:03:00.000Z'),
        checkpoint: phase => { if (phase === 'beforeRename') process.exit(91); },
      });
      await repo.addTask('abrupt-child', {
        title: 'Task 1', body: 'Body 1\\n', priority: 'normal', source: 'telegram',
      });
    `;
    expect(() => execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', childProgram],
      {
        cwd: process.cwd(),
        env: { ...process.env, ASSISTANT_CRASH_CONFIG: JSON.stringify(config) },
      },
    ))
      .toThrow();
    expect(await readFile(join(workspace, '.assistant.lock'), 'utf8')).toContain('abrupt-child');
    await writeFile(join(workspace, 'TASKS.md.tmp-abrupt-child'), 'PROMOTE-ME\n');

    const result = await repo.addTask('abrupt-child', taskInput(1));

    expect(result.id).toBe('T-20260825-001');
    expect(result.replayed).toBe(true);
    expect((await readdir(workspace)).filter(name => name.includes('.tmp-'))).toEqual([]);
    expect(await readFile(join(workspace, 'TASKS.md'), 'utf8')).not.toContain('PROMOTE-ME');
  }, 30_000);

  it('does not quarantine arbitrary user temp files', async () => {
    const { repo, workspace } = await fixture();
    await writeFile(join(workspace, 'notes.tmp-draft'), 'user draft\n');
    await writeFile(join(workspace, 'TASKS.md.tmp-user-draft'), 'user task draft\n');

    await repo.addTask('leave-user-temps', taskInput(1));

    expect(await readFile(join(workspace, 'notes.tmp-draft'), 'utf8')).toBe('user draft\n');
    expect(await readFile(join(workspace, 'TASKS.md.tmp-user-draft'), 'utf8'))
      .toBe('user task draft\n');
  });

  it('leaves ambiguous lock ownership untouched until the 10-second timeout', async () => {
    const { repo, workspace } = await fixture();
    await writeFile(join(workspace, '.assistant.lock'), 'not-valid-lock-metadata\n');
    const startedAt = Date.now();

    await expect(repo.addTask('ambiguous-lock', taskInput(1))).rejects.toMatchObject({
      code: 'workspace_lock_timeout',
    });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(9_900);
    expect(await readFile(join(workspace, '.assistant.lock'), 'utf8'))
      .toBe('not-valid-lock-metadata\n');
  }, 15_000);

  it('preflights every archive target before the first rename on begun recovery', async () => {
    let crashArchive = false;
    const { config, repo, workspace } = await fixture(phase => {
      if (crashArchive && phase === 'beforeRename') throw new Error('crash:beforeRename');
    });
    const added = await repo.addTask('preflight-add', taskInput(1));
    crashArchive = true;
    await expect(repo.archiveRecord('preflight-archive', added.id, 'done'))
      .rejects.toThrow('crash:beforeRename');
    const userText = (await readFile(join(workspace, 'TASKS.md'), 'utf8'))
      .replace('Body 1', 'User changed body');
    await writeFile(join(workspace, 'TASKS.md'), userText);
    const restarted = await restart(config, repo);

    await expect(restarted.archiveRecord('preflight-archive', added.id, 'done'))
      .rejects.toMatchObject({ code: 'operation_reconcile_conflict' });
    await expect(readFile(join(workspace, 'archive', 'TASKS.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(workspace, 'TASKS.md'), 'utf8')).toBe(userText);
  });

  it('recovers an archive crash between replacements before exposing records to query', async () => {
    let archiveMode = false;
    let renameCount = 0;
    const { repo } = await fixture(phase => {
      if (archiveMode && phase === 'afterRename' && ++renameCount === 1) {
        throw new Error('crash:archive-after-first-rename');
      }
    });
    const added = await repo.addTask('partial-add', taskInput(1));
    archiveMode = true;
    await expect(repo.archiveRecord('partial-archive', added.id, 'done'))
      .rejects.toThrow('crash:archive-after-first-rename');
    expect(repo.ledger.get('partial-archive')?.phase).toBe('begun');

    const records = await repo.query({ kind: 'task', includeArchived: true });
    expect(records).toHaveLength(1);
    expect(records[0].fields.status).toBe('archived');
  });

  it('blocks a concurrent query until both archive replacements are complete', async () => {
    let releaseRename!: () => void;
    let reachedRename!: () => void;
    const renameReached = new Promise<void>(resolve => { reachedRename = resolve; });
    const release = new Promise<void>(resolve => { releaseRename = resolve; });
    let archiveMode = false;
    let renameCount = 0;
    const { repo } = await fixture(async phase => {
      if (archiveMode && phase === 'afterRename' && ++renameCount === 1) {
        reachedRename();
        await release;
      }
    });
    const added = await repo.addTask('concurrent-query-add', taskInput(1));
    archiveMode = true;
    const archive = repo.archiveRecord('concurrent-query-archive', added.id, 'done');
    await renameReached;
    let querySettled = false;
    const query = repo.query({ kind: 'task', includeArchived: true }).finally(() => {
      querySettled = true;
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    const settledBeforeRelease = querySettled;
    releaseRename();

    await archive;
    const records = await query;
    expect(settledBeforeRelease).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0].fields.status).toBe('archived');
  });

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
    git(workspace, 'add', '--', 'INBOX.md');
    git(workspace, 'commit', '--quiet', '-m', 'record conflict');
    await expect(restarted.addTask('applied-mismatch', taskInput(1))).rejects.toMatchObject({
      code: 'operation_reconcile_conflict',
    });
    const explanations = parseDocument(
      'inbox',
      await readFile(join(workspace, 'INBOX.md'), 'utf8'),
    ).records;
    expect(explanations).toHaveLength(1);
    expect(explanations[0].fields.operation_id).toBe('applied-mismatch');
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
