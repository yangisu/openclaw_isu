import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../../..');
const windowsScript = resolve(repo, 'scripts/windows/install-wsl-task.ps1');
const installer = resolve(repo, 'scripts/wsl/install-openclaw.sh');
const acceptance = resolve(repo, 'scripts/wsl/run-acceptance.sh');
const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';

describe('deployment scripts', () => {
  it('PowerShell task installer parses and WhatIf rejects an unavailable explicit distro without mutation', () => {
    const parsed = spawnSync('pwsh', ['-NoProfile', '-Command',
      `[System.Management.Automation.Language.Parser]::ParseFile('${windowsScript.replaceAll("'", "''")}',[ref]$null,[ref]$null).EndBlock.Extent.Text.Length`],
      { encoding: 'utf8' });
    expect(parsed.status).toBe(0);
    const result = spawnSync('pwsh', ['-NoProfile', '-File', windowsScript, '-Distro', 'Definitely-Missing', '-WhatIf'], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('wsl_distro_not_found');
  });

  it('PowerShell task plan is owner-scoped, startup-triggered, persistent, and contains the exact keepalive argv', () => {
    const source = readFileSync(windowsScript, 'utf8');
    expect(source).toContain('SupportsShouldProcess');
    expect(source).toContain('/bin/sleep infinity');
    expect(source).toContain('New-ScheduledTaskTrigger -AtStartup');
    expect(source).toContain('PT1M');
    expect(source).toContain('Get-Credential -UserName $owner');
    expect(source).toContain('Register-ScheduledTask -TaskName $TaskName -InputObject $task -User $owner');
    expect(source).not.toMatch(/-User\s+['"]SYSTEM['"]/i);
    expect(source).not.toMatch(/portproxy|New-NetFirewallRule/i);
  });

  it('WSL installer has valid bash syntax and dry-run does not mutate the host', () => {
    expect(spawnSync(gitBash, ['-n', installer], { encoding: 'utf8' }).status).toBe(0);
    const result = spawnSync(gitBash, [installer, '--dry-run'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('DRY_RUN');
    expect(result.stdout).toContain('OpenClaw 2026.7.1');
    expect(result.stdout).toContain('0 8-22 * * *');
  });

  it('suppresses OpenClaw startup catch-up outside an exact Seoul hour', () => {
    const source = readFileSync(installer, 'utf8');
    const trigger = resolve(repo, 'scripts/wsl/briefing-cron-trigger.js');
    expect(source).toContain('--trigger-script "$CRON_TRIGGER"');
    expect(readFileSync(trigger, 'utf8')).toContain("timeZone: 'Asia/Seoul'");
    expect(readFileSync(trigger, 'utf8')).toContain('minute === 0');
    const config = readFileSync(resolve(repo, 'config/openclaw.personal-assistant.example.json5'), 'utf8');
    expect(config).toContain('triggers: { enabled: true }');
  });

  it('non-live acceptance emits exactly 32 criterion records with live work not verified', () => {
    expect(spawnSync(gitBash, ['-n', acceptance], { encoding: 'utf8' }).status).toBe(0);
    const result = spawnSync(gitBash, [acceptance, '--non-live'], { cwd: repo, encoding: 'utf8', timeout: 120_000 });
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);
    expect(summary.total).toBe(32);
    expect(summary.fail).toBe(0);
    expect(summary.pass).toBeGreaterThan(0);
    expect(summary.notVerified).toBeGreaterThan(0);
    const index = JSON.parse(readFileSync(resolve(repo, summary.index), 'utf8'));
    expect(index.criteria).toHaveLength(32);
    expect(index.criteria.every((item: Record<string, unknown>) =>
      typeof item.command === 'string' && typeof item.exitCode === 'number'
      && ['PASS', 'FAIL', 'NOT_VERIFIED'].includes(String(item.status))
      && /^[0-9a-f]{64}$/.test(String(item.stdoutSha256))
      && /^[0-9a-f]{64}$/.test(String(item.stderrSha256)))).toBe(true);
    if (process.platform === 'win32') {
      const artifactDir = dirname(resolve(repo, summary.index)).replaceAll("'", "''");
      const acl = spawnSync('pwsh', ['-NoProfile', '-Command',
        `$a=Get-Acl -LiteralPath '${artifactDir}'; [pscustomobject]@{protected=$a.AreAccessRulesProtected; inherited=@($a.Access|? IsInherited).Count}|ConvertTo-Json -Compress`], { encoding: 'utf8' });
      expect(acl.status).toBe(0);
      expect(JSON.parse(acl.stdout)).toEqual({ protected: true, inherited: 0 });
    }
  }, 130_000);

  it('--all with LIVE_TEST refuses missing explicit live evidence without truncating the index', () => {
    const evidence = mkdtempSync(resolve(tmpdir(), 'ocpa-live-evidence-'));
    try {
      const result = spawnSync(gitBash, [acceptance, '--all'], {
        cwd: repo, encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, LIVE_TEST: '1', ACCEPTANCE_EVIDENCE_DIR: evidence },
      });
      expect(result.status).toBe(2);
      const summary = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);
      expect(summary).toMatchObject({ total: 32, fail: 0, notVerified: 15 });
    } finally {
      rmSync(evidence, { recursive: true, force: true });
    }
  }, 130_000);
});
