import { lstat, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runCli, type CliIo } from '../src/cli.js';

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
      observedChecks: ['authentication rejected for https://user:token@example.invalid/path'],
      redactedErrorCode: 'CALDAV_AUTH',
      timestamp: '2026-08-25T00:00:00Z',
    }));
    const poc = capture();
    expect(await runCli(['poc', 'caldav', '--state', state, '--evidence', evidence], poc.io)).toBe(1);
    expect(poc.stdout.join('')).not.toContain('token@');
    const doctor = capture();
    expect(await runCli(['doctor', '--state', state], doctor.io)).toBe(1);
    expect(doctor.stdout.join('')).toContain('caldav: closed');
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

  it.each([
    ['backup', '--workspace', '/tmp/workspace', '--state', '/tmp/state', '--backup-dir', 'relative', '--identity', '/tmp/key', '--recipient', 'age1test'],
    ['restore', '--archive', 'relative', '--restore-root', '/tmp/restore', '--identity', '/tmp/key'],
  ])('requires absolute paths for %s', async (...args) => {
    const output = capture();
    expect(await runCli(args as string[], output.io)).toBe(64);
  });

  it('rejects secrets and credential URLs in command-line arguments', async () => {
    const output = capture();
    expect(await runCli(['poc', 'openai', '--token', 'secret-value'], output.io)).toBe(64);
    expect(output.stderr.join('')).not.toContain('secret-value');
  });
});
