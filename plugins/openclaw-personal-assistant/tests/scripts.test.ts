import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../../..');
const windowsScript = resolve(repo, 'scripts/windows/install-wsl-task.ps1');
const installer = resolve(repo, 'scripts/wsl/install-openclaw.sh');
const acceptance = resolve(repo, 'scripts/wsl/run-acceptance.sh');
const liveEvidenceValidator = resolve(repo, 'scripts/wsl/validate-live-evidence.js');
const liveProbe = resolve(repo, 'scripts/wsl/run-live-probe.js');
const liveContract = resolve(repo, 'scripts/wsl/live-probe-contract.js');
const cronValidator = resolve(repo, 'scripts/wsl/validate-cron-contract.js');
const hardenedConfigValidator = resolve(repo, 'scripts/wsl/validate-hardened-config.js');
const privateAcl = resolve(repo, 'scripts/windows/set-private-directory-acl.ps1');
const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';

describe('deployment scripts', () => {
  function privateDirectory(path: string): void {
    chmodSync(path, 0o700);
    if (process.platform === 'win32') {
      expect(spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', privateAcl, '-DirectoryPath', path]).status).toBe(0);
    }
  }

  function generateAc01Evidence(root: string, payload?: Record<string, unknown>): string {
    privateDirectory(root);
    const adapter = resolve(root, 'fake-adapter.cjs');
    const result = payload ?? {
      probeId: 'ocpa-live-ac01-v2', phase: 'single', capturedAt: new Date().toISOString(),
      target: { ubuntuVersion: '24.04', pid1: 'systemd', gatewayState: 'active' },
    };
    writeFileSync(adapter, `process.stdout.write(${JSON.stringify(`${JSON.stringify(result)}\n`)});\n`, { mode: 0o600 });
    const generated = spawnSync(process.execPath, [liveProbe, '--criterion', 'AC-01', '--output-dir', root, '--test-adapter', adapter], {
      encoding: 'utf8', env: { ...process.env, OCPA_LIVE_PROBE_TEST_MODE: '1' },
    });
    expect(generated.status, `${generated.stdout}\n${generated.stderr}`).toBe(0);
    return resolve(root, 'AC-01.json');
  }

  it('promotes only evidence emitted by the fixed live probe and cross-checked against its raw records', () => {
    const evidenceRoot = mkdtempSync(resolve(tmpdir(), 'ocpa-live-valid-'));
    try {
      generateAc01Evidence(evidenceRoot);
      const result = spawnSync(process.execPath, [liveEvidenceValidator, evidenceRoot, 'AC-01', '--allow-test-evidence'], {
        encoding: 'utf8', env: { ...process.env, OCPA_LIVE_PROBE_TEST_MODE: '1' },
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ status: 'PASS', observedArtifactPath: resolve(evidenceRoot, 'AC-01.json') });
    } finally { rmSync(evidenceRoot, { recursive: true, force: true }); }
  });

  it('rejects a handcrafted matching envelope that was not produced from fixed raw probe records', () => {
    const evidenceRoot = mkdtempSync(resolve(tmpdir(), 'ocpa-live-invalid-'));
    try {
      privateDirectory(evidenceRoot);
      writeFileSync(resolve(evidenceRoot, 'AC-01.json'), `${JSON.stringify({
        producer: 'openclaw-personal-assistant-live-probe/v2', protocolVersion: 2,
        criterionId: 'AC-01', probeId: 'ocpa-live-ac01-v2', observations: {
          ubuntuVersion: '24.04', systemdPid1: true, gatewayActive: true,
        },
      })}\n`, { mode: 0o600 });
      expect(spawnSync(process.execPath, [liveEvidenceValidator, evidenceRoot, 'AC-01'], { encoding: 'utf8' }).status).not.toBe(0);
    } finally { rmSync(evidenceRoot, { recursive: true, force: true }); }
  });

  it.each([
    ['stale time', (value: Record<string, unknown>) => { value.endedAt = '2020-01-01T00:00:00Z'; }],
    ['wrong criterion', (value: Record<string, unknown>) => { value.criterionId = 'AC-02'; }],
    ['wrong probe digest', (value: Record<string, unknown>) => { value.probeDigest = '0'.repeat(64); }],
    ['fabricated observation', (value: Record<string, unknown>) => { value.observations = { ubuntuVersion: '24.04', systemdPid1: true, gatewayActive: false }; }],
  ])('rejects generated evidence after %s tampering', (_label, mutate) => {
    const root = mkdtempSync(resolve(tmpdir(), 'ocpa-live-tamper-'));
    try {
      const evidencePath = generateAc01Evidence(root);
      const value = JSON.parse(readFileSync(evidencePath, 'utf8'));
      mutate(value);
      writeFileSync(evidencePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      expect(spawnSync(process.execPath, [liveEvidenceValidator, root, 'AC-01', '--allow-test-evidence'], {
        encoding: 'utf8', env: { ...process.env, OCPA_LIVE_PROBE_TEST_MODE: '1' },
      }).status).not.toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects live evidence beneath a non-private evidence directory', () => {
    const evidenceRoot = mkdtempSync(resolve(tmpdir(), 'ocpa-live-public-'));
    try {
      generateAc01Evidence(evidenceRoot);
      if (process.platform === 'win32') {
        expect(spawnSync('icacls.exe', [evidenceRoot, '/grant', '*S-1-1-0:(RX)']).status).toBe(0);
      } else chmodSync(evidenceRoot, 0o755);
      expect(spawnSync(process.execPath, [liveEvidenceValidator, evidenceRoot, 'AC-01', '--allow-test-evidence'], {
        encoding: 'utf8', env: { ...process.env, OCPA_LIVE_PROBE_TEST_MODE: '1' },
      }).status).not.toBe(0);
    } finally { rmSync(evidenceRoot, { recursive: true, force: true }); }
  });

  it.each([
    ['short secret key', { token: 'x' }],
    ['nested secret key', { nested: { apiKey: 'x' } }],
    ['credential-shaped value', { note: 'Basic YTpi' }],
    ['URL query credential', { note: 'https://example.invalid/cb?state=x' }],
  ])('rejects %s before a live probe artifact can be persisted', (_label, injected) => {
    const evidenceRoot = mkdtempSync(resolve(tmpdir(), 'ocpa-live-secret-'));
    try {
      privateDirectory(evidenceRoot);
      const adapter = resolve(evidenceRoot, 'fake-adapter.cjs');
      const payload = {
        probeId: 'ocpa-live-ac01-v2', phase: 'single', capturedAt: new Date().toISOString(),
        target: { ubuntuVersion: '24.04', pid1: 'systemd', gatewayState: 'active' }, ...injected,
      };
      writeFileSync(adapter, `process.stdout.write(${JSON.stringify(`${JSON.stringify(payload)}\n`)});\n`, { mode: 0o600 });
      const result = spawnSync(process.execPath, [liveProbe, '--criterion', 'AC-01', '--output-dir', evidenceRoot, '--test-adapter', adapter], {
        encoding: 'utf8', env: { ...process.env, OCPA_LIVE_PROBE_TEST_MODE: '1' },
      });
      expect(result.status).not.toBe(0);
      expect(() => readFileSync(resolve(evidenceRoot, 'AC-01.json'))).toThrow();
    } finally { rmSync(evidenceRoot, { recursive: true, force: true }); }
  });

  it('bounds evidence reads before allocation and detects a pathname swap after opening', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'ocpa-live-resource-'));
    try {
      privateDirectory(root);
      const oversized = resolve(root, 'oversized.json');
      writeFileSync(oversized, Buffer.alloc(1_048_577, 0x20), { mode: 0o600 });
      const { secureReadFile } = createRequire(import.meta.url)(liveContract) as {
        secureReadFile(path: string, options: Record<string, unknown>): Buffer;
      };
      expect(() => secureReadFile(oversized, { root, maxBytes: 1_048_576, directory: false })).toThrow();

      const victim = resolve(root, 'victim.json');
      const replacement = resolve(root, 'replacement.json');
      writeFileSync(victim, '{"safe":true}\n', { mode: 0o600 });
      writeFileSync(replacement, '{"token":"x"}\n', { mode: 0o600 });
      expect(() => secureReadFile(victim, {
        root, maxBytes: 1024, directory: false,
        afterOpen: () => { renameSync(victim, resolve(root, 'moved.json')); renameSync(replacement, victim); },
      })).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('applies the recursive secret taxonomy and operator canaries without rejecting safe observation names', () => {
    const { validateSafeValue } = createRequire(import.meta.url)(liveContract) as {
      validateSafeValue(value: unknown, canaries?: string[]): void;
    };
    for (const value of [
      { token: 'x' }, { nested: { access_token: 'x' } }, { client_secret: 'x' }, { apiKey: 'x' },
      { authorization: 'x' }, { password: 'x' }, { oauth_state: 'x' }, { cookie: 'x' }, { privateKey: 'x' }, { 'telegram token': 'x' },
      { value: 'Bearer x' }, { value: '123456789:abcdefghijklmnopqrstuvwxyzABCDE' },
      { value: 'eyJabcdefghi.abcdefghijk.abcdefghijk' }, { value: '-----BEGIN PRIVATE KEY-----' },
      { value: 'https://example.invalid/cb?code=x' }, { value: 'operator-canary-42' },
    ]) expect(() => validateSafeValue(value, ['operator-canary-42'])).toThrow();
    expect(() => validateSafeValue({ tokenRefreshed: true, gatewayState: 'active', codeStatus: 'rejected' })).not.toThrow();
  });

  it('keeps a multi-stage restart probe NOT_VERIFIED until fixed before and after phases prove changed boot identities', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'ocpa-live-multistage-'));
    try {
      privateDirectory(root);
      const runPhase = (phase: string, target: Record<string, unknown>) => {
        const adapter = resolve(root, `${phase}.cjs`);
        const payload = { probeId: 'ocpa-live-ac12-v2', phase, capturedAt: new Date().toISOString(), target };
        writeFileSync(adapter, `process.stdout.write(${JSON.stringify(`${JSON.stringify(payload)}\n`)});\n`, { mode: 0o600 });
        return spawnSync(process.execPath, [liveProbe, '--criterion', 'AC-12', '--phase', phase,
          '--output-dir', root, '--test-adapter', adapter], {
          encoding: 'utf8', env: { ...process.env, OCPA_LIVE_PROBE_TEST_MODE: '1' },
        });
      };
      const before = runPhase('before-restart', { windowsBootId: 'windows-before', wslBootId: 'wsl-before' });
      expect(before.status, `${before.stdout}\n${before.stderr}`).toBe(125);
      expect(() => readFileSync(resolve(root, 'AC-12.json'))).toThrow();
      expect(runPhase('after-restart', {
        windowsBootId: 'windows-after', wslBootId: 'wsl-after', windowsRecovery: 'observed',
        wslRecovery: 'observed', gatewayState: 'active',
      }).status).toBe(0);
      expect(spawnSync(process.execPath, [liveEvidenceValidator, root, 'AC-12', '--allow-test-evidence'], {
        encoding: 'utf8', env: { ...process.env, OCPA_LIVE_PROBE_TEST_MODE: '1' },
      }).status).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
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

  it('accepts only one enabled Cron row with the exact installed trigger bytes', () => {
    const trigger = resolve(repo, 'scripts/wsl/briefing-cron-trigger.js');
    const script = readFileSync(trigger, 'utf8');
    const valid = { jobs: [{
      declarationKey: 'openclaw-personal-assistant-hourly-briefing', name: 'Personal assistant hourly briefing', enabled: true,
      schedule: { expr: '0 8-22 * * *', tz: 'Asia/Seoul', staggerMs: 0 }, sessionTarget: 'isolated',
      payload: { message: 'Call assistant_briefing once. Deliver only when send=true.' },
      delivery: { mode: 'announce', channel: 'telegram', to: '123456789' }, trigger: { script },
    }] };
    const args = [cronValidator, trigger, 'openclaw-personal-assistant-hourly-briefing', '0 8-22 * * *',
      'Call assistant_briefing once. Deliver only when send=true.', '123456789'];
    expect(spawnSync(process.execPath, args, { input: JSON.stringify(valid), encoding: 'utf8' }).status).toBe(0);
    valid.jobs[0]!.enabled = false;
    expect(spawnSync(process.execPath, args, { input: JSON.stringify(valid), encoding: 'utf8' }).status).not.toBe(0);
    valid.jobs[0]!.enabled = true;
    valid.jobs[0]!.trigger.script = `malicious(); /* ${script} */`;
    expect(spawnSync(process.execPath, args, { input: JSON.stringify(valid), encoding: 'utf8' }).status).not.toBe(0);
  });

  it('validates the private hardened config before patching or starting the service', () => {
    const source = readFileSync(installer, 'utf8');
    const privateCheck = source.indexOf('validate_config_file');
    const prePatchHardening = source.indexOf('OPENCLAW_CONFIG_PATH="$CONFIG_FILE" validate_active_config');
    const patch = source.indexOf('config patch --file "$CONFIG_FILE"');
    const service = source.indexOf('gateway install --force');
    expect(privateCheck).toBeGreaterThan(0);
    expect(prePatchHardening).toBeGreaterThan(privateCheck);
    expect(patch).toBeGreaterThan(prePatchHardening);
    expect(service).toBeGreaterThan(patch);
  });

  it('fails closed on an unsafe config before installer mutation', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'ocpa-unsafe-config-'));
    try {
      privateDirectory(root);
      const config = resolve(root, 'openclaw.json5');
      const unsafe = readFileSync(resolve(repo, 'config/openclaw.personal-assistant.example.json5'), 'utf8')
        .replace("bind: 'loopback'", "bind: 'lan'");
      writeFileSync(config, unsafe, { mode: 0o600 });
      const openclaw = resolve(repo, 'plugins/openclaw-personal-assistant/node_modules/.bin/openclaw.cmd');
      const result = spawnSync(process.execPath, [hardenedConfigValidator, openclaw, config, '/home/user/.openclaw/secrets'], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('active_config_not_hardened');
    } finally { rmSync(root, { recursive: true, force: true }); }
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
      generateAc01Evidence(evidence);
      const result = spawnSync(gitBash, [acceptance, '--all'], {
        cwd: repo, encoding: 'utf8', timeout: 200_000,
        env: { ...process.env, LIVE_TEST: '1', LIVE_EVIDENCE_DIR: evidence },
      });
      expect(result.status).toBe(2);
      const summary = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);
      expect(summary).toMatchObject({ total: 32, fail: 0, notVerified: 16 });
      const index = JSON.parse(readFileSync(resolve(repo, summary.index), 'utf8'));
      expect(index.criteria[0]).toMatchObject({
        criterionId: 'AC-01', status: 'NOT_VERIFIED', exitCode: 125,
      });
    } finally {
      rmSync(evidence, { recursive: true, force: true });
    }
  }, 210_000);
});
