import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
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
let childRepositoryUrl: string | undefined;

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

function legacyAddTaskHash(input: AddTaskInput): string {
  const payload = JSON.stringify({
    action: 'add-task',
    input: {
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      source: input.source,
      title: input.title,
    },
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function taskDocument(id: string, status: 'open' | 'archived' = 'open'): string {
  return [
    '# Tasks', '', `### ${id} Existing task`, '- type: "task"', `- status: ${status}`,
    '- priority: normal', '- created_at: 2026-08-25T09:03:00+09:00',
    '- updated_at: 2026-08-25T09:03:00+09:00', '- source: "manual"', '', 'Existing body', '',
  ].join('\n');
}

function dailyDocument(id: string, title: string, entryAt: string): string {
  return [
    '# Daily Memory', '', `### ${id} ${title}`, '- type: "daily"', `- entry_at: ${entryAt}`,
    `- created_at: ${entryAt}`, `- updated_at: ${entryAt}`, '- source: "manual"', '',
    `${title} body`, '',
  ].join('\n');
}

function memoryDocument(id: string, sensitivity: 'normal' | 'sensitive'): string {
  return [
    '# Memory', '', `### ${id} Existing memory`, '- type: "memory"', '- active: true',
    `- sensitivity: ${sensitivity}`, '- created_at: 2026-08-25T09:03:00+09:00',
    '- updated_at: 2026-08-25T09:03:00+09:00', '- source: "manual"', '',
    'Existing memory body', '',
  ].join('\n');
}

function repositoryUrlForChild(): string {
  if (childRepositoryUrl !== undefined) return childRepositoryUrl;
  const tsc = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json']);
  childRepositoryUrl = pathToFileURL(
    join(process.cwd(), 'dist', 'workspace', 'repository.js'),
  ).href;
  return childRepositoryUrl;
}

async function waitForFile(path: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}

function waitForChild(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
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
  it('AC-16 preserves uncommitted changes during ten concurrent adds and reads with parseable unique IDs', async () => {
    const { repo, workspace } = await fixture();
    await writeFile(join(workspace, 'staged-owner.txt'), 'staged owner change\n');
    await writeFile(join(workspace, 'unstaged-owner.txt'), 'unstaged owner change\n');
    git(workspace, 'add', '--', 'staged-owner.txt');
    const additions = Array.from({ length: 10 }, (_, index) => repo.addTask(`ac16-${index}`, taskInput(index)));
    const reads = Array.from({ length: 10 }, () => repo.query({ kind: 'task' }));

    const [added, queried] = await Promise.all([Promise.all(additions), Promise.all(reads)]);

    expect(new Set(added.map(item => item.id)).size).toBe(10);
    expect(queried.every(records => Array.isArray(records))).toBe(true);
    expect(parseDocument('task', await readFile(join(workspace, 'TASKS.md'), 'utf8')).records).toHaveLength(10);
    expect(git(workspace, 'status', '--short')).toContain('A  staged-owner.txt');
    expect(git(workspace, 'status', '--short')).toContain('?? unstaged-owner.txt');
  }, 30_000);

  it('AC-17 interruption immediately before replacement preserves original bytes and removes the temporary file', async () => {
    const { repo, workspace } = await fixture(phase => {
      if (phase === 'beforeRename') throw new Error('interrupt-before-replace');
    });
    const original = await readFile(join(workspace, 'TASKS.md'), 'utf8');

    await expect(repo.addTask('ac17-before-replace', taskInput(1))).rejects.toThrow('interrupt-before-replace');

    expect(await readFile(join(workspace, 'TASKS.md'), 'utf8')).toBe(original);
    expect((await readdir(workspace)).filter(name => name.startsWith('TASKS.md.tmp-'))).toEqual([]);
  });

  it('AC-06 updates task completion and study progress then archives both records', async () => {
    const { repo, workspace } = await fixture();
    await writeFile(join(workspace, 'STUDY.md'), [
      '# Study', '', '### S-20260825-001 Korean', '- type: "study"', '- status: in_progress',
      '- subject: "Korean"', '- target_amount: 10', '- unit: "pages"', '- progress: 1',
      '- recurrence: none', '- created_at: 2026-08-25T09:03:00+09:00',
      '- updated_at: 2026-08-25T09:03:00+09:00', '- source: "telegram"', '', 'Study body', '',
    ].join('\n'));
    git(workspace, 'add', '--', 'STUDY.md');
    git(workspace, 'commit', '--quiet', '-m', 'add study acceptance record');
    const task = await repo.addTask('ac06-add-task', taskInput(1));
    await repo.updateRecord('ac06-complete-task', task.id, { fields: { status: 'done', completed_at: '2026-08-25T09:03:00+09:00' } });
    await repo.updateRecord('ac06-progress-study', 'S-20260825-001', { fields: { progress: 10, status: 'done' } });
    await repo.archiveRecord('ac06-archive-task', task.id, 'completed');
    await repo.archiveRecord('ac06-archive-study', 'S-20260825-001', 'completed');

    expect(await repo.query({ kind: 'task' })).toEqual([]);
    expect(await repo.query({ kind: 'study' })).toEqual([]);
    expect((await repo.query({ includeArchived: true })).map(record => record.id).sort())
      .toEqual(['S-20260825-001', task.id].sort());
  });

  it('allocates ten unique IDs under concurrent adds', async () => {
    const { repo, workspace } = await fixture();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => repo.addTask(`op-${i}`, taskInput(i))),
    );

    expect(new Set(results.map(result => result.id)).size).toBe(10);
    expect(parseDocument('task', await readFile(join(workspace, 'TASKS.md'), 'utf8')).records)
      .toHaveLength(10);
  }, 20_000);

  it('fails every query closed when two daily files contain the same workspace ID', async () => {
    const { repo, workspace } = await fixture();
    await mkdir(join(workspace, 'memory'));
    const firstPath = join(workspace, 'memory', '2026-08-24.md');
    const secondPath = join(workspace, 'memory', '2026-08-25.md');
    await writeFile(firstPath, dailyDocument(
      'D-090300-001', 'First daily', '2026-08-24T09:03:00+09:00',
    ));
    await writeFile(secondPath, dailyDocument(
      'D-090300-001', 'Second daily', '2026-08-25T09:03:00+09:00',
    ));
    git(workspace, 'add', '--', 'memory/2026-08-24.md', 'memory/2026-08-25.md');
    git(workspace, 'commit', '--quiet', '-m', 'add duplicate daily IDs');
    const head = git(workspace, 'rev-parse', 'HEAD');

    await expect(repo.query({ kind: 'task' })).rejects.toMatchObject({
      code: 'workspace_duplicate_id',
    });

    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(workspace, 'status', '--short')).toBe('');
    expect(await readFile(firstPath, 'utf8')).toContain('First daily body');
    expect(await readFile(secondPath, 'utf8')).toContain('Second daily body');
  });

  it('fails update closed without a ledger row when active and archive contain the same ID', async () => {
    const { repo, workspace } = await fixture();
    await mkdir(join(workspace, 'archive'));
    const active = taskDocument('T-20260825-001');
    const archived = taskDocument('T-20260825-001', 'archived');
    await writeFile(join(workspace, 'TASKS.md'), active);
    await writeFile(join(workspace, 'archive', 'TASKS.md'), archived);
    git(workspace, 'add', '--', 'TASKS.md', 'archive/TASKS.md');
    git(workspace, 'commit', '--quiet', '-m', 'add active archive duplicate');
    const head = git(workspace, 'rev-parse', 'HEAD');

    await expect(repo.updateRecord('duplicate-update', 'T-20260825-001', {
      title: 'Must not update either copy',
    })).rejects.toMatchObject({ code: 'workspace_duplicate_id' });

    expect(repo.ledger.get('duplicate-update')).toBeUndefined();
    expect(await readFile(join(workspace, 'TASKS.md'), 'utf8')).toBe(active);
    expect(await readFile(join(workspace, 'archive', 'TASKS.md'), 'utf8')).toBe(archived);
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(workspace, 'status', '--short')).toBe('');
  });

  it('allocates a task ID not used in either the active or archive workspace index', async () => {
    const { repo, workspace } = await fixture();
    await mkdir(join(workspace, 'archive'));
    await writeFile(join(workspace, 'TASKS.md'), taskDocument('T-20260825-003'));
    await writeFile(
      join(workspace, 'archive', 'TASKS.md'),
      taskDocument('T-20260825-001', 'archived'),
    );
    git(workspace, 'add', '--', 'TASKS.md', 'archive/TASKS.md');
    git(workspace, 'commit', '--quiet', '-m', 'seed non-contiguous global task IDs');

    await expect(repo.addTask('global-id-allocation', taskInput(1)))
      .resolves.toMatchObject({ id: 'T-20260825-002' });
  });

  it.each([
    ['task', 'TASKS.md', 'T-20260825-001', {
      kind: 'task', title: 'Typed task', body: 'Task body\n', source: 'telegram',
      dueAt: '2026-08-26T10:00:00+09:00',
    }, {
      type: 'task', status: 'open', priority: 'normal',
      due_at: '2026-08-26T10:00:00+09:00', source: 'telegram',
    }],
    ['study', 'STUDY.md', 'S-20260825-001', {
      kind: 'study', title: 'Korean plan', body: 'Read carefully\n', source: 'telegram',
      subject: 'Korean', targetAmount: 20, unit: 'pages', targetDate: '2026-08-31',
      reviewDates: ['2026-08-26', '2026-08-28'],
    }, {
      type: 'study', status: 'open', subject: 'Korean', target_amount: 20,
      unit: 'pages', progress: 0, target_date: '2026-08-31',
      review_dates: ['2026-08-26', '2026-08-28'], source: 'telegram',
    }],
    ['note', 'NOTES.md', 'N-20260825-001', {
      kind: 'note', title: 'Reference', body: 'Quoted untrusted text\n', source: 'telegram',
      url: 'https://example.test/reference', tags: ['research', 'later'],
    }, {
      type: 'note', status: 'active', url: 'https://example.test/reference',
      tags: ['research', 'later'], source: 'telegram',
    }],
    ['preference', 'USER.md', 'U-20260825-001', {
      kind: 'preference', title: 'Concise replies', body: 'Prefer concise replies.\n',
      source: 'telegram',
    }, { type: 'preference', active: true, source: 'telegram' }],
    ['memory', 'MEMORY.md', 'M-20260825-001', {
      kind: 'memory', title: 'Project convention', body: 'Use LF endings.\n',
      source: 'telegram', sensitivity: 'normal',
    }, { type: 'memory', active: true, sensitivity: 'normal', source: 'telegram' }],
  ] as const)(
    'adds and queries a typed %s record in %s',
    async (kind, relativePath, id, input, expectedFields) => {
      const { repo, workspace } = await fixture();

      const added = await repo.addRecord(`typed-add-${kind}`, input);
      const queried = await repo.query({ kind, id });

      expect(added).toMatchObject({ id, replayed: false, record: { body: input.body } });
      expect(queried).toHaveLength(1);
      expect(queried[0]).toMatchObject({ id, title: input.title, fields: expectedFields });
      expect(parseDocument(kind, await readFile(join(workspace, relativePath), 'utf8')).records)
        .toEqual(queried);
      expect(git(workspace, 'show', '--format=', '--name-only', added.gitCommit!))
        .toBe(relativePath);
    },
  );

  it('preserves existing unknown note fields and replays a typed add idempotently', async () => {
    const { repo, workspace } = await fixture();
    await writeFile(join(workspace, 'NOTES.md'), [
      '# Notes', '', '### N-20260825-001 Existing note', '- type: "note"',
      '- status: active', '- created_at: 2026-08-25T09:03:00+09:00',
      '- updated_at: 2026-08-25T09:03:00+09:00', '- source: "manual"',
      '- custom_field: "keep-me"', '', 'Existing body', '',
    ].join('\n'));
    git(workspace, 'add', '--', 'NOTES.md');
    git(workspace, 'commit', '--quiet', '-m', 'seed note with unknown field');
    const input = {
      kind: 'note' as const, title: 'Second note', body: 'Second body\n', source: 'telegram',
    };

    const first = await repo.addRecord('typed-note-replay', input);
    const replay = await repo.addRecord('typed-note-replay', input);

    expect(first.id).toBe('N-20260825-002');
    expect(replay).toMatchObject({ id: first.id, replayed: true });
    const text = await readFile(join(workspace, 'NOTES.md'), 'utf8');
    expect(text).toContain('- custom_field: "keep-me"');
    expect(parseDocument('note', text).records).toHaveLength(2);
  });

  it('uses the global archive index when allocating a typed study ID', async () => {
    const { repo, workspace } = await fixture();
    await mkdir(join(workspace, 'archive'));
    await writeFile(join(workspace, 'archive', 'STUDY.md'), [
      '# Study', '', '### S-20260825-001 Archived study', '- type: "study"',
      '- status: archived', '- subject: "Old"', '- target_amount: 1', '- unit: "page"',
      '- progress: 1', '- created_at: 2026-08-25T09:03:00+09:00',
      '- updated_at: 2026-08-25T09:03:00+09:00', '- source: "manual"', '', '',
    ].join('\n'));
    git(workspace, 'add', '--', 'archive/STUDY.md');
    git(workspace, 'commit', '--quiet', '-m', 'seed archived study ID');

    await expect(repo.addRecord('typed-study-allocation', {
      kind: 'study', title: 'New study', source: 'telegram',
      subject: 'New', targetAmount: 5, unit: 'pages',
    })).resolves.toMatchObject({ id: 'S-20260825-002' });
  });

  it.each([
    ['invalid task status', 'invalid_status', {
      kind: 'task', title: 'Bad task', source: 'telegram', status: 'pending',
    }],
    ['study progress above target', 'invalid_progress', {
      kind: 'study', title: 'Bad progress', source: 'telegram', subject: 'Math',
      targetAmount: 2, unit: 'pages', progress: 3,
    }],
    ['invalid study civil date', 'invalid_date', {
      kind: 'study', title: 'Bad date', source: 'telegram', subject: 'Math',
      targetAmount: 2, unit: 'pages', targetDate: '2026-02-29',
    }],
    ['invalid internal source', 'invalid_source', {
      kind: 'note', title: 'Bad source', source: 'owner supplied prose',
    }],
    ['title line injection', 'invalid_title', {
      kind: 'note', title: 'First line\n### N-20260825-999 Injected', source: 'telegram',
    }],
    ['body heading injection', 'invalid_body', {
      kind: 'note', title: 'Unsafe body', source: 'telegram',
      body: 'Normal text\n### N-20260825-999 Injected\n- type: "note"\n',
    }],
    ['unsafe study integer', 'invalid_target_amount', {
      kind: 'study', title: 'Unsafe number', source: 'telegram', subject: 'Math',
      targetAmount: 1e21, unit: 'pages',
    }],
    ['oversized study subject', 'input_too_long', {
      kind: 'study', title: 'Oversized subject', source: 'telegram', subject: 'x'.repeat(501),
      targetAmount: 1, unit: 'page',
    }],
    ['duplicate note tags', 'invalid_tags', {
      kind: 'note', title: 'Duplicate tags', source: 'telegram', tags: ['same', 'same'],
    }],
  ] as const)('rejects %s before ledger, file, or Git mutation', async (_label, code, input) => {
    const { repo, workspace } = await fixture();
    const operationId = `typed-invalid-${code}`;
    const head = git(workspace, 'rev-parse', 'HEAD');

    await expect(repo.addRecord(operationId, input as never)).rejects.toMatchObject({ code });

    expect(repo.ledger.get(operationId)).toBeUndefined();
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(workspace, 'status', '--short')).toBe('');
  });

  it('rejects sensitive memory before ledger, file, or Git mutation', async () => {
    const { repo, workspace } = await fixture();
    const head = git(workspace, 'rev-parse', 'HEAD');

    await expect(repo.addRecord('typed-sensitive-memory', {
      kind: 'memory', title: 'Sensitive fact', body: 'Do not store this.\n',
      source: 'telegram', sensitivity: 'sensitive',
    })).rejects.toMatchObject({ code: 'confirmation_unavailable' });

    expect(repo.ledger.get('typed-sensitive-memory')).toBeUndefined();
    await expect(readFile(join(workspace, 'MEMORY.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(workspace, 'status', '--short')).toBe('');
  });

  it('keeps the legacy addTask payload identity replayable after upgrade', async () => {
    const { repo } = await fixture();
    const input = taskInput(1);
    repo.ledger.begin('legacy-add-task', '42', legacyAddTaskHash(input));

    const result = await repo.addTask('legacy-add-task', input);

    expect(result).toMatchObject({ id: 'T-20260825-001', replayed: true });
    expect(repo.ledger.get('legacy-add-task')).toMatchObject({ phase: 'committed' });
  });

  it.each(['applied', 'committed'] as const)(
    'replays a legacy %s add-task ledger entry after upgrade',
    async phase => {
      const operationId = `legacy-add-task-${phase}`;
      const { repo, workspace } = await fixture();
      const input = taskInput(1);
      const template = await repo.addTask(`legacy-template-${phase}`, input);
      const templateOperation = repo.ledger.get<{
        version: 1;
        action: string;
        result: typeof template;
        files: Array<{
          relativePath: string;
          beforeHash: string | null;
          afterHash: string;
          contents: string;
        }>;
      }>(`legacy-template-${phase}`)!;
      const prepared = {
        ...templateOperation.result!,
        action: 'add-task',
        result: { ...templateOperation.result!.result, operationId },
      };
      repo.ledger.begin(operationId, '42', legacyAddTaskHash(input));
      repo.ledger.markApplied(operationId, prepared);
      if (phase === 'committed') {
        repo.ledger.markCommitted(operationId, {
          ...prepared,
          result: { ...prepared.result, gitCommit: template.gitCommit },
        });
      } else {
        git(workspace, 'reset', '--hard', `${template.gitCommit}^`);
        await writeFile(join(workspace, 'TASKS.md'), prepared.files[0].contents);
        git(workspace, 'add', '--', 'TASKS.md');
        git(workspace, 'commit', '--quiet', '-m', 'legacy applied task', '-m',
          `Assistant-Operation-Id: ${operationId}`);
      }

      const replay = await repo.addTask(operationId, input);

      expect(replay).toMatchObject({ operationId, id: template.id, replayed: true });
      expect(repo.ledger.get(operationId)).toMatchObject({ phase: 'committed' });
      expect(git(workspace, 'status', '--short')).toBe('');
    },
  );

  it('keeps addTask task-only when unchecked input carries a conflicting discriminant', async () => {
    const { repo, workspace } = await fixture();
    const unchecked = {
      ...taskInput(1),
      kind: 'memory',
      sensitivity: 'sensitive',
    };

    const result = await repo.addTask('task-discriminant-override', unchecked as never);

    expect(result).toMatchObject({
      id: 'T-20260825-001',
      record: { fields: { type: 'task', status: 'open', priority: 'normal' } },
    });
    await expect(readFile(join(workspace, 'MEMORY.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(parseDocument('task', await readFile(join(workspace, 'TASKS.md'), 'utf8')).records)
      .toHaveLength(1);
  });

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

  it('does not reuse an exact trailer commit that is only reachable on another branch', async () => {
    let interrupt = true;
    const operationId = 'unrelated-trailer-candidate';
    const { config, repo, workspace } = await fixture(phase => {
      if (phase === 'afterGitCommit' && interrupt) throw new Error('crash:afterGitCommit');
    });
    await expect(repo.addTask(operationId, taskInput(1))).rejects.toThrow('crash:afterGitCommit');
    const unrelatedCandidate = git(workspace, 'rev-parse', 'HEAD');
    const exactPreparedText = await readFile(join(workspace, 'TASKS.md'), 'utf8');
    git(workspace, 'branch', 'unrelated-candidate', unrelatedCandidate);
    git(workspace, 'reset', '--hard', 'HEAD^');
    await writeFile(join(workspace, 'ordinary-parent.txt'), 'different recovery parent\n');
    git(workspace, 'add', '--', 'ordinary-parent.txt');
    git(workspace, 'commit', '--quiet', '-m', 'different recovery parent');
    await writeFile(join(workspace, 'TASKS.md'), exactPreparedText);
    interrupt = false;

    const restarted = await restart(config, repo);
    const recovered = await restarted.addTask(operationId, taskInput(1));

    expect(recovered.gitCommit).not.toBe(unrelatedCandidate);
    expect(git(workspace, 'merge-base', '--is-ancestor', recovered.gitCommit!, 'HEAD')).toBe('');
    expect(git(workspace, 'status', '--short')).toBe('');
  });

  it('does not reuse an ancestor trailer commit whose prepared blob is wrong', async () => {
    let interrupt = true;
    const operationId = 'wrong-blob-candidate';
    const { config, repo, workspace } = await fixture(phase => {
      if (phase === 'afterGitCommit' && interrupt) throw new Error('crash:afterGitCommit');
    });
    await expect(repo.addTask(operationId, taskInput(1))).rejects.toThrow('crash:afterGitCommit');
    const exactPreparedText = await readFile(join(workspace, 'TASKS.md'), 'utf8');
    git(workspace, 'reset', '--hard', 'HEAD^');
    await writeFile(join(workspace, 'TASKS.md'), taskDocument('T-20260825-001'));
    git(workspace, 'add', '--', 'TASKS.md');
    git(workspace, 'commit', '--quiet', '-m', 'wrong prepared blob', '-m',
      `Assistant-Operation-Id: ${operationId}`);
    const wrongCandidate = git(workspace, 'rev-parse', 'HEAD');
    await writeFile(join(workspace, 'TASKS.md'), exactPreparedText);
    interrupt = false;

    const restarted = await restart(config, repo);
    const recovered = await restarted.addTask(operationId, taskInput(1));

    expect(recovered.gitCommit).not.toBe(wrongCandidate);
    expect(git(workspace, 'status', '--short')).toBe('');
    expect(git(workspace, 'show', `${recovered.gitCommit}:TASKS.md`)).toContain('Task 1');
  });

  it('does not reuse a trailer commit that touched an extra managed workspace path', async () => {
    let interrupt = true;
    const operationId = 'extra-managed-path-candidate';
    const { config, repo, workspace } = await fixture(phase => {
      if (phase === 'afterGitCommit' && interrupt) throw new Error('crash:afterGitCommit');
    });
    await expect(repo.addTask(operationId, taskInput(1))).rejects.toThrow('crash:afterGitCommit');
    const exactPreparedText = await readFile(join(workspace, 'TASKS.md'), 'utf8');
    git(workspace, 'reset', '--hard', 'HEAD^');
    await writeFile(join(workspace, 'TASKS.md'), exactPreparedText);
    await writeFile(join(workspace, 'NOTES.md'), '# Notes\n\n');
    git(workspace, 'add', '--', 'TASKS.md', 'NOTES.md');
    git(workspace, 'commit', '--quiet', '-m', 'candidate with extra managed path', '-m',
      `Assistant-Operation-Id: ${operationId}`);
    const extraPathCandidate = git(workspace, 'rev-parse', 'HEAD');
    await writeFile(join(workspace, 'TASKS.md'), '# Tasks\n\n');
    git(workspace, 'add', '--', 'TASKS.md');
    git(workspace, 'commit', '--quiet', '-m', 'later unrelated workspace state');
    await writeFile(join(workspace, 'TASKS.md'), exactPreparedText);
    interrupt = false;

    const restarted = await restart(config, repo);
    const recovered = await restarted.addTask(operationId, taskInput(1));

    expect(recovered.gitCommit).not.toBe(extraPathCandidate);
    expect(git(workspace, 'show', '--format=', '--name-only', recovered.gitCommit!)).toBe('TASKS.md');
    expect(git(workspace, 'status', '--short')).toBe('');
  });

  it('does not reuse a trailer commit that touched an extra ordinary path', async () => {
    let interrupt = true;
    const operationId = 'extra-ordinary-path-candidate';
    const { config, repo, workspace } = await fixture(phase => {
      if (phase === 'afterGitCommit' && interrupt) throw new Error('crash:afterGitCommit');
    });
    await expect(repo.addTask(operationId, taskInput(1))).rejects.toThrow('crash:afterGitCommit');
    await writeFile(join(workspace, 'ordinary-candidate.txt'), 'candidate-only change\n');
    git(workspace, 'add', '--', 'ordinary-candidate.txt');
    git(workspace, 'commit', '--quiet', '--amend', '--no-edit');
    const extraPathCandidate = git(workspace, 'rev-parse', 'HEAD');
    await writeFile(join(workspace, 'user-staged.txt'), 'preserve staged user change\n');
    git(workspace, 'add', '--', 'user-staged.txt');
    await writeFile(join(workspace, 'user-untracked.txt'), 'preserve untracked user change\n');
    interrupt = false;

    const restarted = await restart(config, repo);
    const recovered = await restarted.addTask(operationId, taskInput(1));

    expect(recovered.gitCommit).not.toBe(extraPathCandidate);
    expect(git(workspace, 'show', '--format=', '--name-only', recovered.gitCommit!)).toBe('');
    expect(git(workspace, 'status', '--short')).toBe([
      'A  user-staged.txt',
      '?? user-untracked.txt',
    ].join('\n'));
  });

  it('reuses one semantic recovery proof after crashing during extra-path fallback', async () => {
    let initialInterrupt = true;
    const operationId = 'extra-path-second-crash';
    const { config, repo, workspace } = await fixture(phase => {
      if (phase === 'afterGitCommit' && initialInterrupt) throw new Error('crash:initial-commit');
    });
    await expect(repo.addTask(operationId, taskInput(1))).rejects.toThrow('crash:initial-commit');
    await writeFile(join(workspace, 'ordinary-candidate.txt'), 'candidate-only change\n');
    git(workspace, 'add', '--', 'ordinary-candidate.txt');
    git(workspace, 'commit', '--quiet', '--amend', '--no-edit');
    const rejectedCandidate = git(workspace, 'rev-parse', 'HEAD');
    await writeFile(join(workspace, 'user-staged.txt'), 'preserve staged user change\n');
    git(workspace, 'add', '--', 'user-staged.txt');
    await writeFile(join(workspace, 'user-untracked.txt'), 'preserve untracked user change\n');
    initialInterrupt = false;

    repo.close();
    repositories.splice(repositories.indexOf(repo), 1);
    let fallbackInterrupt = true;
    const recovering = await openRepository(config, {
      now: fixedNow,
      checkpoint(phase) {
        if (phase === 'afterGitCommit' && fallbackInterrupt) throw new Error('crash:fallback-commit');
      },
    });
    repositories.push(recovering);
    await expect(recovering.addTask(operationId, taskInput(1))).rejects
      .toThrow('crash:fallback-commit');
    const recoveryProof = git(workspace, 'rev-parse', 'HEAD');
    expect(recoveryProof).not.toBe(rejectedCandidate);
    expect(recovering.ledger.get(operationId)?.phase).toBe('applied');
    fallbackInterrupt = false;

    const restarted = await restart(config, recovering);
    const recovered = await restarted.addTask(operationId, taskInput(1));
    expect(recovered).toMatchObject({ gitCommit: recoveryProof, replayed: true });
    expect(git(workspace, 'merge-base', '--is-ancestor', recovered.gitCommit!, 'HEAD')).toBe('');
    expect(git(workspace, 'log', '--format=%B', '--all').split(
      `Assistant-Operation-Id: ${operationId}`,
    )).toHaveLength(3);
    expect(git(workspace, 'status', '--short')).toBe([
      'A  user-staged.txt',
      '?? user-untracked.txt',
    ].join('\n'));

    const restartedAgain = await restart(config, restarted);
    expect(await restartedAgain.addTask(operationId, taskInput(1)))
      .toMatchObject({ gitCommit: recoveryProof, replayed: true });
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(recoveryProof);
  });

  it('does not reuse either commit when an exact operation trailer is ambiguous', async () => {
    let interrupt = true;
    const operationId = 'ambiguous-trailer-candidate';
    const { config, repo, workspace } = await fixture(phase => {
      if (phase === 'afterGitCommit' && interrupt) throw new Error('crash:afterGitCommit');
    });
    await expect(repo.addTask(operationId, taskInput(1))).rejects.toThrow('crash:afterGitCommit');
    const exactPreparedText = await readFile(join(workspace, 'TASKS.md'), 'utf8');
    git(workspace, 'reset', '--hard', 'HEAD^');
    for (const title of ['First wrong candidate', 'Second wrong candidate']) {
      await writeFile(join(workspace, 'TASKS.md'), `${taskDocument('T-20260825-001')}\n${title}\n`);
      git(workspace, 'add', '--', 'TASKS.md');
      git(workspace, 'commit', '--quiet', '-m', title, '-m',
        `Assistant-Operation-Id: ${operationId}`);
    }
    const newestAmbiguousCandidate = git(workspace, 'rev-parse', 'HEAD');
    await writeFile(join(workspace, 'TASKS.md'), exactPreparedText);
    interrupt = false;

    const restarted = await restart(config, repo);
    const recovered = await restarted.addTask(operationId, taskInput(1));

    expect(recovered.gitCommit).not.toBe(newestAmbiguousCandidate);
    expect(git(workspace, 'status', '--short')).toBe('');
  });

  it('reuses a unique exact ancestor commit despite unrelated files in a later parent tree', async () => {
    let interrupt = true;
    const operationId = 'valid-ancestor-candidate';
    const { config, repo, workspace } = await fixture(phase => {
      if (phase === 'afterGitCommit' && interrupt) throw new Error('crash:afterGitCommit');
    });
    await expect(repo.addTask(operationId, taskInput(1))).rejects.toThrow('crash:afterGitCommit');
    const validCandidate = git(workspace, 'rev-parse', 'HEAD');
    await writeFile(join(workspace, 'ordinary.txt'), 'ordinary later file\n');
    git(workspace, 'add', '--', 'ordinary.txt');
    git(workspace, 'commit', '--quiet', '-m', 'later unrelated file');
    interrupt = false;

    const restarted = await restart(config, repo);
    const recovered = await restarted.addTask(operationId, taskInput(1));

    expect(recovered.gitCommit).toBe(validCandidate);
    expect(git(workspace, 'status', '--short')).toBe('');
  });

  it('recovers a dead child process lock and quarantines only its known temp file', async () => {
    const { config, repo, workspace } = await fixture();
    const repositoryUrl = repositoryUrlForChild();
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

  it('serializes two stale-lock reclaimers before either can replace a live owner', async () => {
    const { config, repo, workspace } = await fixture();
    repo.close();
    repositories.splice(repositories.indexOf(repo), 1);
    const deadOwner = spawn(process.execPath, ['--eval', 'process.exit(0)'], { stdio: 'ignore' });
    const deadPid = deadOwner.pid!;
    await waitForChild(deadOwner);
    await writeFile(join(workspace, '.assistant.lock'), `${JSON.stringify({
      version: 1,
      pid: deadPid,
      createdAt: '2026-08-25T00:00:00.000Z',
      ownerId: 'dead-owner-identity',
      operationId: 'dead-operation',
    })}\n`);
    const control = join(config.stateDir, 'race-control');
    await mkdir(control);
    const repositoryUrl = repositoryUrlForChild();
    const childProgram = `
      import { readFile, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { openRepository } from ${JSON.stringify(repositoryUrl)};
      const config = JSON.parse(process.env.ASSISTANT_RACE_CONFIG);
      const label = process.env.ASSISTANT_RACE_LABEL;
      const control = process.env.ASSISTANT_RACE_CONTROL;
      const exists = async path => readFile(path).then(() => true, () => false);
      await writeFile(join(control, 'ready-' + label), 'ready');
      while (!(await exists(join(control, 'start')))) await new Promise(r => setTimeout(r, 10));
      const repo = await openRepository(config, {
        now: () => new Date('2026-08-25T00:03:00.000Z'),
        checkpoint: async phase => {
          if (phase !== 'beforeRename') return;
          await writeFile(join(control, 'entered-' + label), 'entered');
          while (!(await exists(join(control, 'release-' + label)))) {
            await new Promise(r => setTimeout(r, 10));
          }
        },
      });
      const mutation = repo.addTask('race-' + label, {
        title: 'Race ' + label, body: 'Body\\n', priority: 'normal', source: 'telegram',
      });
      await writeFile(join(control, 'acquiring-' + label), 'acquiring');
      await mutation;
      repo.close();
    `;
    const children = ['a', 'b'].map(label => spawn(
      process.execPath,
      ['--input-type=module', '--eval', childProgram],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ASSISTANT_RACE_CONFIG: JSON.stringify(config),
          ASSISTANT_RACE_CONTROL: control,
          ASSISTANT_RACE_LABEL: label,
        },
        stdio: 'ignore',
      },
    ));
    const exits = children.map(waitForChild);
    await Promise.all(['a', 'b'].map(label => waitForFile(join(control, `ready-${label}`))));
    await writeFile(join(control, 'start'), 'start');
    await Promise.all(['a', 'b'].map(label => waitForFile(join(control, `acquiring-${label}`))));
    let first: 'a' | 'b';
    while (true) {
      const names = await readdir(control);
      if (names.includes('entered-a')) { first = 'a'; break; }
      if (names.includes('entered-b')) { first = 'b'; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const second = first === 'a' ? 'b' : 'a';
    const beforeRelease = await readdir(control);
    await writeFile(join(control, `release-${first}`), 'release');
    await waitForFile(join(control, `entered-${second}`));
    await writeFile(join(control, `release-${second}`), 'release');
    expect(await Promise.all(exits)).toEqual([0, 0]);

    expect(beforeRelease.filter(name => name.startsWith('entered-'))).toHaveLength(1);
    const coordinator = join(config.stateDir, 'workspace-lock-coordinator.sqlite3');
    expect((await stat(coordinator)).isFile()).toBe(true);
    if (process.platform !== 'win32') expect((await stat(coordinator)).mode & 0o777).toBe(0o600);
    const reopened = await openRepository(config, { now: fixedNow });
    expect(reopened.ledger).toBeDefined();
    reopened.close();
  }, 30_000);

  it('continues after a process dies while holding the SQLite lock coordinator', async () => {
    const { config, repo } = await fixture();
    const coordinator = join(config.stateDir, 'workspace-lock-coordinator.sqlite3');
    const ready = join(config.stateDir, 'coordinator-holder-ready');
    const holderProgram = `
      import { chmodSync } from 'node:fs';
      import { writeFile } from 'node:fs/promises';
      import { DatabaseSync } from 'node:sqlite';
      const database = new DatabaseSync(process.env.ASSISTANT_COORDINATOR_PATH);
      chmodSync(process.env.ASSISTANT_COORDINATOR_PATH, 0o600);
      database.exec('BEGIN IMMEDIATE');
      await writeFile(process.env.ASSISTANT_COORDINATOR_READY, 'ready');
      setTimeout(() => process.exit(91), 1500);
    `;
    const holder = spawn(process.execPath, ['--input-type=module', '--eval', holderProgram], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ASSISTANT_COORDINATOR_PATH: coordinator,
        ASSISTANT_COORDINATOR_READY: ready,
      },
      stdio: 'ignore',
    });
    const holderExit = waitForChild(holder);
    await waitForFile(ready);
    const startedAt = Date.now();

    const result = await repo.addTask('after-coordinator-death', taskInput(1));

    const elapsed = Date.now() - startedAt;
    expect(await holderExit).toBe(91);
    expect(elapsed).toBeGreaterThanOrEqual(1_200);
    expect(result.id).toBe('T-20260825-001');
  }, 20_000);

  it('canonicalizes equivalent state-directory aliases for the same-process async gate', async () => {
    const { config, repo } = await fixture();
    repo.close();
    repositories.splice(repositories.indexOf(repo), 1);
    const aliases = [`${config.stateDir}${sep}.`];
    const link = join(dirname(config.stateDir), 'state-link');
    try {
      await symlink(config.stateDir, link, process.platform === 'win32' ? 'junction' : 'dir');
      aliases.push(link);
    } catch (error) {
      if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    if (process.platform === 'win32') {
      const caseAlias = config.stateDir.replace(/^([a-z]):/i, drive => (
        drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()
      ));
      if (caseAlias !== config.stateDir) aliases.push(caseAlias);
    }

    for (const [index, alias] of aliases.entries()) {
      let entered!: () => void;
      const enteredRename = new Promise<void>(resolve => { entered = resolve; });
      let release!: () => void;
      const releaseRename = new Promise<void>(resolve => { release = resolve; });
      const primary = await openRepository(config, {
        now: fixedNow,
        checkpoint: async phase => {
          if (phase === 'beforeRename') {
            entered();
            await releaseRename;
          }
        },
      });
      const equivalent = await openRepository({ ...config, stateDir: alias }, { now: fixedNow });
      repositories.push(primary, equivalent);
      const firstMutation = primary.addTask(`canonical-primary-${index}`, taskInput(index * 2));
      await enteredRename;
      const secondMutation = equivalent.addTask(
        `canonical-alias-${index}`,
        taskInput(index * 2 + 1),
      );
      let timerAdvanced = false;
      await new Promise<void>(resolve => setTimeout(() => {
        timerAdvanced = true;
        release();
        resolve();
      }, 25));
      const [first, second] = await Promise.all([
        firstMutation,
        secondMutation,
      ]);
      expect(timerAdvanced).toBe(true);
      expect(first.id).not.toBe(second.id);
      primary.close();
      equivalent.close();
      repositories.splice(repositories.indexOf(primary), 1);
      repositories.splice(repositories.indexOf(equivalent), 1);
    }
  }, 40_000);

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

  it.each([
    ['title structural injection', 'invalid_title', 'task', {
      title: 'Changed\n### T-20260825-999 Injected',
    }],
    ['body structural injection', 'invalid_body', 'task', {
      body: 'Normal\n### T-20260825-999 Injected\n- type: "task"\n',
    }],
    ['oversized body', 'input_too_long', 'task', { body: 'x'.repeat(16_001) }],
    ['strict timestamp', 'invalid_timestamp', 'task', {
      fields: { due_at: '2026-04-31T09:00:00+09:00' },
    }],
    ['invalid status', 'invalid_status', 'task', { fields: { status: 'pending' } }],
    ['progress above target', 'invalid_progress', 'study', { fields: { progress: 11 } }],
    ['unsafe progress integer', 'invalid_progress', 'study', { fields: { progress: 1e21 } }],
    ['invalid target date', 'invalid_date', 'study', { fields: { target_date: '2026-02-29' } }],
    ['wrong-kind field combination', 'invalid_patch_fields', 'study', {
      fields: { priority: 'high' },
    }],
  ] as const)(
    'rejects an invalid update with %s before ledger, file, or Git mutation',
    async (_label, code, kind, patch) => {
      const { repo, workspace } = await fixture();
      const added = kind === 'task'
        ? await repo.addTask(`invalid-update-seed-${code}`, taskInput(1))
        : await repo.addRecord(`invalid-update-seed-${code}`, {
          kind: 'study', title: 'Study', source: 'telegram', subject: 'Math',
          targetAmount: 10, unit: 'pages', progress: 2,
        });
      const operationId = `invalid-update-${code}`;
      const relativePath = kind === 'task' ? 'TASKS.md' : 'STUDY.md';
      const before = await readFile(join(workspace, relativePath), 'utf8');
      const head = git(workspace, 'rev-parse', 'HEAD');

      await expect(repo.updateRecord(operationId, added.id, patch as never))
        .rejects.toMatchObject({ code });

      expect(repo.ledger.get(operationId)).toBeUndefined();
      expect(await readFile(join(workspace, relativePath), 'utf8')).toBe(before);
      expect(git(workspace, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(workspace, 'status', '--short')).toBe('');
    },
  );

  it('round-trips a valid update as one typed record while preserving unknown fields and order', async () => {
    const { repo, workspace } = await fixture();
    const original = [
      '# Notes', '', '### N-20260825-001 Existing note', '- type: "note"',
      '- custom_field: "keep-me"', '- status: active',
      '- created_at: 2026-08-25T09:03:00+09:00',
      '- updated_at: 2026-08-25T09:03:00+09:00', '- source: "manual"', '',
      'Existing body', '',
    ].join('\n');
    await writeFile(join(workspace, 'NOTES.md'), original);
    git(workspace, 'add', '--', 'NOTES.md');
    git(workspace, 'commit', '--quiet', '-m', 'seed note update invariant');

    await repo.updateRecord('valid-note-roundtrip', 'N-20260825-001', {
      title: 'Updated note', body: 'Updated body\n',
      fields: { url: 'https://example.test/updated', tags: ['one', 'two'] },
    });

    const text = await readFile(join(workspace, 'NOTES.md'), 'utf8');
    const parsed = parseDocument('note', text);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]).toMatchObject({
      id: 'N-20260825-001', title: 'Updated note', body: 'Updated body\n',
      fields: {
        type: 'note', custom_field: 'keep-me', status: 'active',
        url: 'https://example.test/updated', tags: ['one', 'two'],
      },
    });
    expect(text.indexOf('- custom_field: "keep-me"')).toBeLessThan(text.indexOf('- status: active'));
    expect(await repo.query({ kind: 'note', id: 'N-20260825-001' })).toEqual(parsed.records);
  });

  it.each([
    ['body-only patch', { body: 'Changed body\n' }],
    ['fields-only downgrade patch', { fields: { sensitivity: 'normal' } }],
  ] as const)(
    'rejects a mutation of an existing sensitive memory for a %s',
    async (_label, patch) => {
      const { repo, workspace } = await fixture();
      const text = memoryDocument('M-20260825-001', 'sensitive');
      await writeFile(join(workspace, 'MEMORY.md'), text);
      git(workspace, 'add', '--', 'MEMORY.md');
      git(workspace, 'commit', '--quiet', '-m', 'seed sensitive memory');
      const operationId = `existing-sensitive-${_label.replaceAll(' ', '-')}`;
      const head = git(workspace, 'rev-parse', 'HEAD');

      await expect(repo.updateRecord(operationId, 'M-20260825-001', patch as never))
        .rejects.toMatchObject({ code: 'confirmation_unavailable' });

      expect(repo.ledger.get(operationId)).toBeUndefined();
      expect(await readFile(join(workspace, 'MEMORY.md'), 'utf8')).toBe(text);
      expect(git(workspace, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(workspace, 'status', '--short')).toBe('');
    },
  );

  it('rejects an update that would make a normal memory sensitive before state mutation', async () => {
    const { repo, workspace } = await fixture();
    const added = await repo.addRecord('normal-memory-seed', {
      kind: 'memory', title: 'Normal memory', source: 'telegram', sensitivity: 'normal',
    });
    const before = await readFile(join(workspace, 'MEMORY.md'), 'utf8');
    const head = git(workspace, 'rev-parse', 'HEAD');

    await expect(repo.updateRecord('become-sensitive', added.id, {
      fields: { sensitivity: 'sensitive' },
    })).rejects.toMatchObject({ code: 'confirmation_unavailable' });

    expect(repo.ledger.get('become-sensitive')).toBeUndefined();
    expect(await readFile(join(workspace, 'MEMORY.md'), 'utf8')).toBe(before);
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(workspace, 'status', '--short')).toBe('');
  });

  it('rejects archiving an existing sensitive memory before state mutation', async () => {
    const { repo, workspace } = await fixture();
    const text = memoryDocument('M-20260825-001', 'sensitive');
    await writeFile(join(workspace, 'MEMORY.md'), text);
    git(workspace, 'add', '--', 'MEMORY.md');
    git(workspace, 'commit', '--quiet', '-m', 'seed sensitive memory for archive');
    const head = git(workspace, 'rev-parse', 'HEAD');

    await expect(repo.archiveRecord('archive-sensitive', 'M-20260825-001', 'cleanup'))
      .rejects.toMatchObject({ code: 'confirmation_unavailable' });

    expect(repo.ledger.get('archive-sensitive')).toBeUndefined();
    expect(await readFile(join(workspace, 'MEMORY.md'), 'utf8')).toBe(text);
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(workspace, 'status', '--short')).toBe('');
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

  it('fails closed when a begun operation no longer matches Markdown on restart', async () => {
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

  it('records one explanation across repeated mismatches in the applied phase', async () => {
    let interrupt = true;
    const { config, repo, workspace } = await fixture(phase => {
      if (phase === 'afterGitCommit' && interrupt) throw new Error('crash:afterGitCommit');
    });
    await expect(repo.addTask('applied-phase-mismatch', taskInput(1)))
      .rejects.toThrow('crash:afterGitCommit');
    expect(repo.ledger.get('applied-phase-mismatch')?.phase).toBe('applied');
    await writeFile(join(workspace, 'TASKS.md'), '# Tasks\n\nApplied replacement text\n');
    interrupt = false;
    const restarted = await restart(config, repo);

    await expect(restarted.addTask('applied-phase-mismatch', taskInput(1))).rejects.toMatchObject({
      code: 'operation_reconcile_conflict',
    });
    git(workspace, 'add', '--', 'INBOX.md');
    git(workspace, 'commit', '--quiet', '-m', 'record applied conflict');
    await expect(restarted.addTask('applied-phase-mismatch', taskInput(1))).rejects.toMatchObject({
      code: 'operation_reconcile_conflict',
    });

    const explanations = parseDocument(
      'inbox',
      await readFile(join(workspace, 'INBOX.md'), 'utf8'),
    ).records;
    expect(explanations).toHaveLength(1);
    expect(explanations[0].fields.operation_id).toBe('applied-phase-mismatch');
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
