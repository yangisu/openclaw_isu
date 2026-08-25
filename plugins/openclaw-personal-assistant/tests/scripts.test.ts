import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../../..');
const windowsScript = resolve(repo, 'scripts/windows/install-wsl-task.ps1');
const installer = resolve(repo, 'scripts/wsl/install-openclaw.sh');
const acceptance = resolve(repo, 'scripts/wsl/run-acceptance.sh');
const liveEvidenceValidator = resolve(repo, 'scripts/wsl/validate-live-evidence.js');
const privateAcl = resolve(repo, 'scripts/windows/set-private-directory-acl.ps1');
const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';

describe('deployment scripts', () => {
  function privateDirectory(path: string): void {
    chmodSync(path, 0o700);
    if (process.platform === 'win32') {
      expect(spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', privateAcl, '-DirectoryPath', path]).status).toBe(0);
    }
  }

  function writeAc01Evidence(
    root: string,
    mutation: (value: Record<string, unknown>) => void = () => undefined,
    artifactText = 'authorized target observation\n',
  ): string {
    privateDirectory(root);
    const artifact = resolve(root, 'AC-01-observation.txt');
    writeFileSync(artifact, artifactText, { mode: 0o600 });
    const value: Record<string, unknown> = {
      version: 1,
      generator: 'openclaw-personal-assistant-live-acceptance/v1',
      criterionId: 'AC-01',
      status: 'PASS',
      observedAt: new Date().toISOString(),
      exitCode: 0,
      observedArtifactPath: artifact,
      observedArtifactSha256: createHash('sha256').update(readFileSync(artifact)).digest('hex'),
      observations: { ubuntuVersion: '24.04', systemdPid1: true, gatewayActive: true },
    };
    mutation(value);
    const evidence = resolve(root, 'AC-01.json');
    writeFileSync(evidence, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    return evidence;
  }

  it('promotes only fresh criterion-specific private live evidence and returns its observed artifact', () => {
    const evidenceRoot = mkdtempSync(resolve(tmpdir(), 'ocpa-live-valid-'));
    try {
      writeAc01Evidence(evidenceRoot);
      const result = spawnSync(process.execPath, [liveEvidenceValidator, evidenceRoot, 'AC-01'], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        status: 'PASS', observedArtifactPath: resolve(evidenceRoot, 'AC-01-observation.txt'),
      });
    } finally { rmSync(evidenceRoot, { recursive: true, force: true }); }
  });

  it.each([
    ['trivial', (value: Record<string, unknown>) => { delete value.observations; }],
    ['fabricated observation', (value: Record<string, unknown>) => { value.observations = { ubuntuVersion: '24.04' }; }],
    ['stale', (value: Record<string, unknown>) => { value.observedAt = '2020-01-01T00:00:00Z'; }],
    ['wrong ID', (value: Record<string, unknown>) => { value.criterionId = 'AC-02'; }],
    ['missing artifact', (value: Record<string, unknown>) => { value.observedArtifactPath = resolve(tmpdir(), 'missing-live-artifact'); }],
    ['wrong artifact hash', (value: Record<string, unknown>) => { value.observedArtifactSha256 = '0'.repeat(64); }],
  ])('does not promote %s live evidence', (_label, mutate) => {
    const evidenceRoot = mkdtempSync(resolve(tmpdir(), 'ocpa-live-invalid-'));
    try {
      writeAc01Evidence(evidenceRoot, mutate);
      expect(spawnSync(process.execPath, [liveEvidenceValidator, evidenceRoot, 'AC-01'], { encoding: 'utf8' }).status).not.toBe(0);
    } finally { rmSync(evidenceRoot, { recursive: true, force: true }); }
  });

  it('rejects live evidence beneath a non-private evidence directory', () => {
    const evidenceRoot = mkdtempSync(resolve(tmpdir(), 'ocpa-live-public-'));
    try {
      writeAc01Evidence(evidenceRoot);
      if (process.platform === 'win32') {
        expect(spawnSync('icacls.exe', [evidenceRoot, '/grant', '*S-1-1-0:(RX)']).status).toBe(0);
      } else chmodSync(evidenceRoot, 0o755);
      expect(spawnSync(process.execPath, [liveEvidenceValidator, evidenceRoot, 'AC-01'], { encoding: 'utf8' }).status).not.toBe(0);
    } finally { rmSync(evidenceRoot, { recursive: true, force: true }); }
  });

  it('rejects a correctly hashed live artifact that still contains a credential-like value', () => {
    const evidenceRoot = mkdtempSync(resolve(tmpdir(), 'ocpa-live-secret-'));
    try {
      writeAc01Evidence(evidenceRoot, () => undefined, 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456\n');
      expect(spawnSync(process.execPath, [liveEvidenceValidator, evidenceRoot, 'AC-01'], { encoding: 'utf8' }).status).not.toBe(0);
    } finally { rmSync(evidenceRoot, { recursive: true, force: true }); }
  });

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
    expect(result.stdout).toContain('Node >=24.15.0 <25.0.0');
    expect(result.stdout).toContain('assistant_briefing,assistant_calendar_confirm,assistant_calendar_prepare,assistant_mutate,assistant_query');
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
    const result = spawnSync(gitBash, [acceptance, '--non-live'], { cwd: repo, encoding: 'utf8', timeout: 200_000 });
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
    expect(index.criteria.filter((item: Record<string, unknown>) => item.status === 'NOT_VERIFIED')
      .every((item: Record<string, unknown>) => item.exitCode === 125)).toBe(true);
    if (process.platform === 'win32') {
      const artifactDir = dirname(resolve(repo, summary.index)).replaceAll("'", "''");
      const acl = spawnSync('pwsh', ['-NoProfile', '-Command',
        `$a=Get-Acl -LiteralPath '${artifactDir}'; [pscustomobject]@{protected=$a.AreAccessRulesProtected; inherited=@($a.Access|? IsInherited).Count}|ConvertTo-Json -Compress`], { encoding: 'utf8' });
      expect(acl.status).toBe(0);
      expect(JSON.parse(acl.stdout)).toEqual({ protected: true, inherited: 0 });
    }
  }, 210_000);

  it('--all preserves one faithful live artifact path while refusing all missing evidence without truncation', () => {
    const evidence = mkdtempSync(resolve(tmpdir(), 'ocpa-live-evidence-'));
    try {
      writeAc01Evidence(evidence);
      const result = spawnSync(gitBash, [acceptance, '--all'], {
        cwd: repo, encoding: 'utf8', timeout: 200_000,
        env: { ...process.env, LIVE_TEST: '1', LIVE_EVIDENCE_DIR: evidence },
      });
      expect(result.status).toBe(2);
      const summary = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);
      expect(summary).toMatchObject({ total: 32, fail: 0, notVerified: 15 });
      const index = JSON.parse(readFileSync(resolve(repo, summary.index), 'utf8'));
      expect(index.criteria[0]).toMatchObject({
        criterionId: 'AC-01', status: 'PASS', exitCode: 0,
        observedArtifactPath: resolve(evidence, 'AC-01-observation.txt'),
      });
    } finally {
      rmSync(evidence, { recursive: true, force: true });
    }
  }, 210_000);
});
