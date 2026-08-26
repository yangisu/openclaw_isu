import { chmod, lstat, mkdtemp, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runCli, type CliIo } from '../src/cli.js';
import { buildBriefing } from '../src/briefing/build.js';
import { applyRetention } from '../src/ops/backup.js';
import { SubsystemHealthStore } from '../src/state/health.js';

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: { stdout: value => stdout.push(value), stderr: value => stderr.push(value) },
  };
}

describe('operational CLI', () => {
  it('initializes only private directories and non-secret templates without overwriting data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-cli-'));
    const out = capture();
    expect(await runCli(['init', '--root', root], out.io)).toBe(0);
    const tasks = join(root, 'workspace', 'TASKS.md');
    expect(await readFile(tasks, 'utf8')).toContain('# Tasks\n');
    await writeFile(tasks, 'owner data\n', 'utf8');
    expect(await runCli(['init', '--root', root], out.io)).toBe(0);
    expect(await readFile(tasks, 'utf8')).toBe('owner data\n');
    expect(out.stdout.at(-1)).toContain('"status":"open"');
  }, 15_000);

  it('refuses relative roots and indirect roots', async () => {
    const out = capture();
    expect(await runCli(['init', '--root', 'relative'], out.io)).toBe(64);
    const parent = await mkdtemp(join(tmpdir(), 'ocpa-link-'));
    const target = join(parent, 'target');
    await mkdir(target);
    const link = join(parent, 'link');
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await runCli(['init', '--root', link], out.io)).toBe(64);
    const indirectChild = join(link, 'new-root');
    expect(await runCli(['init', '--root', indirectChild], out.io)).toBe(64);
    await expect(lstat(join(target, 'new-root'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('records a redacted PoC result and doctor fails closed for closed gates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-gate-'));
    const state = join(root, 'state');
    const evidence = join(root, 'evidence.json');
    await writeFile(evidence, JSON.stringify({
      status: 'closed',
      observedChecks: ['authentication rejected without credential disclosure'],
      redactedErrorCode: 'CALDAV_AUTH',
      timestamp: new Date().toISOString(),
    }));
    const poc = capture();
    expect(await runCli(['poc', 'caldav', '--state', state, '--evidence', evidence], poc.io)).toBe(1);
    expect(poc.stdout.join('')).toContain('authentication rejected without credential disclosure');
    const doctor = capture();
    expect(await runCli(['doctor', '--state', state], doctor.io)).toBe(1);
    expect(doctor.stdout.join('')).toContain('caldav: closed');
  });

  it('rejects extra PoC evidence fields before secrets can reach stdout or durable state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-gate-extra-'));
    const state = join(root, 'state');
    const evidence = join(root, 'evidence.json');
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    await writeFile(evidence, JSON.stringify({
      status: 'open', observedChecks: ['model response observed'], redactedErrorCode: null,
      timestamp: new Date().toISOString(), refreshToken: secret, nested: { apiKey: secret },
    }));
    const output = capture();

    expect(await runCli(['poc', 'openai', '--state', state, '--evidence', evidence], output.io)).toBe(64);
    expect(output.stdout.join('')).toBe('');
    expect(output.stderr.join('')).not.toContain(secret);
    await expect(lstat(join(state, 'gates', 'openai.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['unsafe URL', ['callback https://example.invalid/?code=secret-value'], new Date().toISOString()],
    ['control character', ['line\u0000break'], new Date().toISOString()],
    ['format character', ['hidden\u202Evalue'], new Date().toISOString()],
    ['expired timestamp', ['model response observed'], '2020-01-01T00:00:00Z'],
    ['future timestamp', ['model response observed'], new Date(Date.now() + 60 * 60_000).toISOString()],
  ])('rejects %s in PoC evidence', async (_label, observedChecks, timestamp) => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-gate-invalid-'));
    const evidence = join(root, 'evidence.json');
    await writeFile(evidence, JSON.stringify({ status: 'open', observedChecks, redactedErrorCode: null, timestamp }));
    const output = capture();
    expect(await runCli(['poc', 'openai', '--state', join(root, 'state'), '--evidence', evidence], output.io)).toBe(64);
    expect(output.stdout).toEqual([]);
  });

  it('emits and persists only the exact four PoC evidence fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-gate-fields-'));
    const state = join(root, 'state');
    const evidence = join(root, 'evidence.json');
    await writeFile(evidence, JSON.stringify({
      status: 'open', observedChecks: ['model response observed'], redactedErrorCode: null,
      timestamp: new Date().toISOString(),
    }));
    const output = capture();
    expect(await runCli(['poc', 'openai', '--state', state, '--evidence', evidence], output.io)).toBe(0);
    const printed = JSON.parse(output.stdout[0]!);
    const stored = JSON.parse(await readFile(join(state, 'gates', 'openai.json'), 'utf8'));
    expect(Object.keys(printed).sort()).toEqual(['observedChecks', 'redactedErrorCode', 'status', 'timestamp']);
    expect(stored).toEqual(printed);
  });

  it('doctor reports missing and expired durable evidence as non-success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-doctor-'));
    const state = join(root, 'state');
    await mkdir(join(state, 'gates'), { recursive: true });
    await writeFile(join(state, 'gates', 'openai.json'), JSON.stringify({
      status: 'open', observedChecks: ['model response observed'], redactedErrorCode: null,
      timestamp: '2020-01-01T00:00:00Z',
    }));
    const output = capture();
    expect(await runCli(['doctor', '--state', state, '--max-age-hours', '24'], output.io)).toBe(1);
    expect(output.stdout.join('')).toContain('openai: expired');
    expect(output.stdout.join('')).toContain('caldav: unknown');
  });

  it('doctor fails a durable gate closed when its timestamp is in the future', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-doctor-future-'));
    const state = join(root, 'state');
    await mkdir(join(state, 'gates'), { recursive: true });
    await writeFile(join(state, 'gates', 'openai.json'), JSON.stringify({
      status: 'open', observedChecks: ['model response observed'], redactedErrorCode: null,
      timestamp: new Date(Date.now() + 60 * 60_000).toISOString(),
    }));
    const output = capture();
    expect(await runCli(['doctor', '--state', state], output.io)).toBe(1);
    expect(output.stdout.join('')).toContain('openai: unknown');
  });

  it('repairs and verifies private permissions for every existing init directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-private-tree-'));
    await mkdir(join(root, 'workspace', 'memory'), { recursive: true });
    await mkdir(join(root, 'state', 'gates'), { recursive: true });
    if (process.platform !== 'win32') {
      await chmod(root, 0o755);
      await chmod(join(root, 'workspace'), 0o755);
      await chmod(join(root, 'state', 'gates'), 0o755);
    }
    expect(await runCli(['init', '--root', root], capture().io)).toBe(0);
    const directories = [root, 'workspace', 'workspace/memory', 'workspace/archive', 'state', 'state/gates', 'secrets', 'config']
      .map(path => path === root ? root : join(root, path));
    if (process.platform === 'win32') {
      for (const directory of directories) {
        const script = `$a=Get-Acl -LiteralPath '${directory.replaceAll("'", "''")}'; if(!$a.AreAccessRulesProtected -or @($a.Access|? IsInherited).Count -ne 0){exit 1}`;
        expect((await import('node:child_process')).spawnSync('pwsh', ['-NoProfile', '-Command', script]).status).toBe(0);
      }
    } else {
      for (const directory of directories) {
        const info = await stat(directory);
        expect(info.mode & 0o777).toBe(0o700);
        expect(info.uid).toBe(process.getuid!());
      }
    }
  }, 30_000);

  it('preserves existing managed files while repairing their privacy idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-private-files-'));
    await mkdir(join(root, 'workspace'), { recursive: true });
    const tasks = join(root, 'workspace', 'TASKS.md');
    await writeFile(tasks, 'owner content must survive\n', { mode: 0o644 });
    if (process.platform === 'win32') {
      const { spawnSync } = await import('node:child_process');
      expect(spawnSync('icacls.exe', [tasks, '/inheritance:e']).status).toBe(0);
    } else await chmod(tasks, 0o644);

    expect(await runCli(['init', '--root', root], capture().io)).toBe(0);
    expect(await runCli(['init', '--root', root], capture().io)).toBe(0);
    expect(await readFile(tasks, 'utf8')).toBe('owner content must survive\n');
    if (process.platform === 'win32') {
      const { spawnSync } = await import('node:child_process');
      const script = `$a=Get-Acl -LiteralPath '${tasks.replaceAll("'", "''")}'; if(!$a.AreAccessRulesProtected -or @($a.Access|? IsInherited).Count -ne 0){exit 1}`;
      expect(spawnSync('pwsh', ['-NoProfile', '-Command', script]).status).toBe(0);
    } else {
      const info = await stat(tasks);
      expect(info.mode & 0o777).toBe(0o600);
      expect(info.uid).toBe(process.getuid!());
    }
  }, 30_000);

  it.each([
    ['backup', '--workspace', '/tmp/workspace', '--state', '/tmp/state', '--backup-dir', 'relative', '--identity', '/tmp/key', '--recipient', 'age1test'],
    ['restore', '--archive', 'relative', '--restore-root', '/tmp/restore', '--identity', '/tmp/key'],
  ])('requires absolute paths for %s', async (...args) => {
    const output = capture();
    expect(await runCli(args as string[], output.io)).toBe(64);
  });

  it('requires reconcile state and records verification failure in the real health store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-reconcile-health-'));
    const archive = join(root, '2026-08-25.age');
    const identity = join(root, 'identity.txt');
    const state = join(root, 'state');
    await writeFile(archive, 'not an archive');
    await writeFile(identity, 'not an identity');
    expect(await runCli(['backup', 'reconcile', '--archive', archive, '--identity', identity], capture().io)).toBe(64);
    expect(await runCli(['backup', 'reconcile', '--archive', archive, '--identity', identity, '--state', state], capture().io)).toBe(70);
    const health = new SubsystemHealthStore(state);
    try {
      expect(health.listActive()).toEqual([expect.objectContaining({ target: 'backup' })]);
      health.recover('backup');
      health.report({
        target: `backup-publication:${'a'.repeat(64)}`, errorCode: 'BACKUP_PUBLICATION_UNKNOWN',
        message: 'Backup commit durability is unknown; run verified reconciliation before retention',
      });
    } finally { health.close(); }
    expect(await runCli(['backup', 'reconcile', '--archive', archive, '--identity', identity, '--state', state], capture().io)).toBe(70);
    const reopened = new SubsystemHealthStore(state);
    try {
      const active = reopened.listActive();
      expect(active).toEqual([expect.objectContaining({
        target: `backup-publication:${'a'.repeat(64)}`, errorCode: 'BACKUP_PUBLICATION_UNKNOWN',
      })]);
      expect(buildBriefing({
        now: '2026-08-25T09:00:00+09:00', events: [], tasks: [], studies: [], activeErrors: active,
      }).messages.join('\n')).toContain('Backup commit durability is unknown');
      const backupDir = join(root, 'backups');
      await mkdir(backupDir);
      await expect(applyRetention({ backupDir, identityFile: identity, health: reopened }))
        .rejects.toMatchObject({ code: 'publication_unknown' });
    } finally { reopened.close(); }
  });

  it('validates every reconcile option before creating or opening health state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-reconcile-parse-'));
    const state = join(root, 'state-that-must-not-exist');
    expect(await runCli([
      'backup', 'reconcile', '--archive', 'relative', '--identity', join(root, 'identity'), '--state', state,
    ], capture().io)).toBe(64);
    await expect(lstat(state)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symlinked health state before SQLite can be created', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocpa-backup-state-link-'));
    const target = join(root, 'target');
    const state = join(root, 'state');
    const workspace = join(root, 'workspace');
    const backupDir = join(root, 'backup');
    const identity = join(root, 'identity');
    await Promise.all([mkdir(target), mkdir(workspace), mkdir(backupDir), writeFile(identity, 'identity')]);
    await symlink(target, state, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await runCli([
      'backup', '--workspace', workspace, '--state', state, '--backup-dir', backupDir,
      '--identity', identity, '--recipient', 'age1abcdefghijklmnop',
    ], capture().io)).toBe(64);
    await expect(lstat(join(target, 'health.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects secrets and credential URLs in command-line arguments', async () => {
    const output = capture();
    expect(await runCli(['poc', 'openai', '--token', 'secret-value'], output.io)).toBe(64);
    expect(output.stderr.join('')).not.toContain('secret-value');
  });
});
