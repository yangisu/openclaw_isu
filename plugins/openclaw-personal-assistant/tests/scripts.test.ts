import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
const activeConfigPathValidator = resolve(repo, 'scripts/wsl/validate-active-config-path.js');
const runtimeToolsValidator = resolve(repo, 'scripts/wsl/validate-runtime-tools.js');
const privateAcl = resolve(repo, 'scripts/windows/set-private-directory-acl.ps1');
const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';

describe('deployment scripts', () => {
  function privateDirectory(path: string): void {
    chmodSync(path, 0o700);
    if (process.platform === 'win32') {
      expect(spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', privateAcl, '-DirectoryPath', path]).status).toBe(0);
    }
  }

  function forgeAc01Evidence(root: string): string {
    privateDirectory(root);
    const rawPath = resolve(root, 'AC-01.single.raw.json');
    const ledgerPath = resolve(root, 'AC-01.ledger.json');
    const evidencePath = resolve(root, 'AC-01.json');
    const raw = `${JSON.stringify({
      probeId: 'ocpa-live-ac01-v3', phase: 'single', capturedAt: new Date().toISOString(), adapter: 'system-health-v1',
      commandResults: [{ commandId: 'gateway-active', exitCode: 0, stdoutLines: ['active'] }],
    })}\n`;
    writeFileSync(rawPath, raw, { mode: 0o600 });
    const sha = (value: string) => createHash('sha256').update(value).digest('hex');
    const ledger = `${JSON.stringify({
      producer: 'openclaw-personal-assistant-live-probe/v3', protocolVersion: 3,
      criterionId: 'AC-01', probeId: 'ocpa-live-ac01-v3', probeDigest: 'a'.repeat(64),
      targetIdentity: 'b'.repeat(64), startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      phases: [{ phase: 'single', path: rawPath, size: Buffer.byteLength(raw), sha256: sha(raw), capturedAt: new Date().toISOString() }], status: 'COMPLETE',
    })}\n`;
    writeFileSync(ledgerPath, ledger, { mode: 0o600 });
    writeFileSync(evidencePath, `${JSON.stringify({
      producer: 'openclaw-personal-assistant-live-probe/v3', protocolVersion: 3,
      criterionId: 'AC-01', probeId: 'ocpa-live-ac01-v3', probeDigest: 'a'.repeat(64),
      startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), targetIdentity: 'b'.repeat(64),
      exitCode: 0, status: 'PASS', observations: { ubuntuVersion: '24.04', systemdPid1: true, gatewayActive: true },
      rawArtifacts: [{ phase: 'single', path: rawPath, size: Buffer.byteLength(raw), sha256: sha(raw), capturedAt: new Date().toISOString() }],
      ledgerPath, ledgerSha256: sha(ledger),
    })}\n`, { mode: 0o600 });
    return evidencePath;
  }

  const liveCriteria = [
    'AC-01', 'AC-02', 'AC-03', 'AC-07', 'AC-08', 'AC-12', 'AC-13',
    'AC-14', 'AC-15', 'AC-23', 'AC-25', 'AC-26', 'AC-27', 'AC-32',
  ];

  it.each(liveCriteria)('keeps %s unsupported in both production producer and validator', criterionId => {
    const root = mkdtempSync(resolve(tmpdir(), 'ocpa-live-unsupported-'));
    try {
      privateDirectory(root);
      const produced = spawnSync(process.execPath, [liveProbe, '--criterion', criterionId, '--output-dir', root], { encoding: 'utf8' });
      expect(produced.status).toBe(125);
      expect(produced.stdout).toContain('NOT_VERIFIED');
      expect(() => readFileSync(resolve(root, `${criterionId}.json`))).toThrow();
      const validated = spawnSync(process.execPath, [liveEvidenceValidator, root, criterionId], { encoding: 'utf8' });
      expect(validated.status).toBe(125);
      expect(validated.stdout).toContain('NOT_VERIFIED');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('never promotes a forged AC-01 production identity/hash fixture or invokes a hostile PATH command', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'ocpa-live-forged-'));
    try {
      forgeAc01Evidence(root);
      const hostile = resolve(root, process.platform === 'win32' ? 'systemctl.cmd' : 'systemctl');
      const marker = resolve(root, 'hostile-invoked');
      writeFileSync(hostile, process.platform === 'win32'
        ? `@echo hostile>${marker}\r\n@exit /b 0\r\n`
        : `#!/bin/sh\nprintf hostile > '${marker}'\n`, { mode: 0o700 });
      const env = { ...process.env, PATH: `${root}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`, OCPA_LIVE_PROBE_TEST_MODE: '1' };
      const generated = spawnSync(process.execPath, [liveProbe, '--criterion', 'AC-01', '--output-dir', root,
        '--test-adapter', resolve(root, 'forged-adapter.cjs')], { encoding: 'utf8', env });
      expect(generated.status).toBe(125);
      const validated = spawnSync(process.execPath, [liveEvidenceValidator, root, 'AC-01', '--allow-test-evidence'], { encoding: 'utf8', env });
      expect(validated.status).toBe(125);
      expect(validated.stdout).toContain('NOT_VERIFIED');
      expect(() => readFileSync(marker)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ['short secret key', { token: 'x' }],
    ['nested secret key', { nested: { apiKey: 'x' } }],
    ['bare secret key', { Se_CrEt: 'x' }],
    ['secret value key', { nested: { 'secret-value': 'x' } }],
    ['password hash key', { Password_Hash: 'x' }],
    ['credential-shaped value', { note: 'Basic YTpi' }],
    ['URL query credential', { note: 'https://example.invalid/cb?state=x' }],
  ])('rejects %s before a live probe artifact can be persisted', (_label, injected) => {
    const evidenceRoot = mkdtempSync(resolve(tmpdir(), 'ocpa-live-secret-'));
    try {
      privateDirectory(evidenceRoot);
      const adapter = resolve(evidenceRoot, 'fake-adapter.cjs');
      const payload = {
        probeId: 'ocpa-live-ac01-v3', phase: 'single', capturedAt: new Date().toISOString(), adapter: 'system-health-v1',
        commandResults: [
          { commandId: 'os-release', exitCode: 0, stdoutLines: ['ID=ubuntu', 'VERSION_ID="24.04"'] },
          { commandId: 'pid1', exitCode: 0, stdoutLines: ['systemd'] },
          { commandId: 'gateway-active', exitCode: 0, stdoutLines: ['active'] },
        ], ...injected,
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
      { secret: 'x' }, { nested: { SECRET_VALUE: 'x' } }, { 'password-hash': 'x' },
      { value: 'Bearer x' }, { value: '123456789:abcdefghijklmnopqrstuvwxyzABCDE' },
      { value: 'eyJabcdefghi.abcdefghijk.abcdefghijk' }, { value: '-----BEGIN PRIVATE KEY-----' },
      { value: 'https://example.invalid/cb?code=x' }, { value: 'operator-canary-42' },
    ]) expect(() => validateSafeValue(value, ['operator-canary-42'])).toThrow();
    expect(() => validateSafeValue({ tokenRefreshed: true, gatewayState: 'active', codeStatus: 'rejected' })).not.toThrow();
  });

  it('contains no production live command adapter or audit-to-PASS derivation surface', () => {
    const probeSource = readFileSync(liveProbe, 'utf8');
    const validatorSource = readFileSync(liveEvidenceValidator, 'utf8');
    expect(probeSource).not.toMatch(/spawn|exec|test-adapter|audit|gateway-active|systemctl/i);
    expect(validatorSource).not.toMatch(/readFile|lstat|sha256|targetIdentity|allow-test-evidence/i);
    expect(() => readFileSync(resolve(repo, 'scripts/wsl/live-probe-target.js'))).toThrow();
  });

  it('returns 125 without PASS evidence for an unsupported live criterion even when an audit event matches by name', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'ocpa-live-unsupported-'));
    try {
      privateDirectory(root);
      const adapter = resolve(root, 'audit-adapter.cjs');
      writeFileSync(adapter, `process.stdout.write(JSON.stringify({events:[{occurredAt:Date.now(),action:'tool.action.finished',toolName:'assistant_calendar_confirm',status:'succeeded'}]}));\n`, { mode: 0o600 });
      const result = spawnSync(process.execPath, [liveProbe, '--criterion', 'AC-08', '--output-dir', root, '--test-adapter', adapter], {
        encoding: 'utf8', env: { ...process.env, OCPA_LIVE_PROBE_TEST_MODE: '1' },
      });
      expect(result.status).toBe(125);
      expect(result.stdout).toContain('NOT_VERIFIED');
      expect(() => readFileSync(resolve(root, 'AC-08.json'))).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not let test-adapter restart phases create production PASS evidence', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'ocpa-live-multistage-'));
    try {
      privateDirectory(root);
      const runPhase = (phase: string, target: Record<string, unknown>) => {
        const adapter = resolve(root, `${phase}.cjs`);
        const payload = { probeId: 'ocpa-live-ac12-v3', phase, capturedAt: new Date().toISOString(), adapter: 'restart-health-v1',
          commandResults: [
            { commandId: 'windows-boot-id', exitCode: 0, stdoutLines: [String(target.windowsBootId)] },
            { commandId: 'wsl-boot-id', exitCode: 0, stdoutLines: [String(target.wslBootId)] },
            { commandId: 'gateway-active', exitCode: 0, stdoutLines: [String(target.gatewayState ?? 'active')] },
          ] };
        writeFileSync(adapter, `process.stdout.write(${JSON.stringify(`${JSON.stringify(payload)}\n`)});\n`, { mode: 0o600 });
        return spawnSync(process.execPath, [liveProbe, '--criterion', 'AC-12', '--phase', phase,
          '--output-dir', root, '--test-adapter', adapter], {
          encoding: 'utf8', env: { ...process.env, OCPA_LIVE_PROBE_TEST_MODE: '1' },
        });
      };
      const before = runPhase('before-restart', { windowsBootId: 'windows-before', wslBootId: 'wsl-before' });
      expect(before.status, `${before.stdout}\n${before.stderr}`).toBe(125);
      expect(runPhase('after-restart', { windowsBootId: 'windows-after', wslBootId: 'wsl-after', gatewayState: 'active' }).status).toBe(125);
      expect(() => readFileSync(resolve(root, 'AC-12.json'))).toThrow();
      expect(spawnSync(process.execPath, [liveEvidenceValidator, root, 'AC-12', '--allow-test-evidence'], {
        encoding: 'utf8', env: { ...process.env, OCPA_LIVE_PROBE_TEST_MODE: '1' },
      }).status).toBe(125);
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

  it('validates the actual OpenClaw runtime inspect names-array shape as exactly five optional tools', () => {
    const valid = { tools: [
      { names: ['assistant_query'], optional: true }, { names: ['assistant_mutate'], optional: true },
      { names: ['assistant_calendar_prepare'], optional: true }, { names: ['assistant_calendar_confirm'], optional: true },
      { names: ['assistant_briefing'], optional: true },
    ] };
    expect(spawnSync(process.execPath, [runtimeToolsValidator], { input: JSON.stringify(valid), encoding: 'utf8' }).status).toBe(0);
    valid.tools[0]!.optional = false;
    expect(spawnSync(process.execPath, [runtimeToolsValidator], { input: JSON.stringify(valid), encoding: 'utf8' }).status).not.toBe(0);
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
    valid.jobs[0]!.declarationKey = 'attacker-key';
    expect(spawnSync(process.execPath, args, { input: JSON.stringify(valid), encoding: 'utf8' }).status).not.toBe(0);
    valid.jobs[0]!.declarationKey = 'openclaw-personal-assistant-hourly-briefing';
    valid.jobs[0]!.trigger.script = `malicious(); /* ${script} */`;
    expect(spawnSync(process.execPath, args, { input: JSON.stringify(valid), encoding: 'utf8' }).status).not.toBe(0);
  });

  it('validates the private hardened config before patching or starting the service', () => {
    const source = readFileSync(installer, 'utf8');
    const privateCheck = source.indexOf('validate_config_file "$ACTIVE_CONFIG_FILE"');
    const patch = source.indexOf('config patch --file "$CONFIG_FILE"');
    const postPatchPrivate = source.indexOf('validate_config_file "$ACTIVE_CONFIG_FILE"', patch);
    const postPatchHardening = source.indexOf('node "$HARDENED_CONFIG_VALIDATOR" "$OPENCLAW" "$ACTIVE_CONFIG_FILE" "$SECRET_DIR"', patch);
    const service = source.indexOf('gateway install --force');
    expect(privateCheck).toBeGreaterThan(0);
    expect(postPatchPrivate).toBeGreaterThan(patch);
    expect(postPatchHardening).toBeGreaterThan(postPatchPrivate);
    expect(service).toBeGreaterThan(postPatchHardening);
    expect(source).toContain('export OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH');
    expect(source).toContain('OPENCLAW_CONFIG_PATH="$ACTIVE_CONFIG_FILE"');
  });

  it('accepts only the exact active path reported by openclaw config file across POSIX and Windows forms', () => {
    const cases = [
      ['/home/owner/.openclaw/openclaw.json', '/home/owner', '~/.openclaw/openclaw.json\n'],
      ['C:\\Users\\Owner\\.openclaw\\openclaw.json', 'C:\\Users\\Owner', 'C:\\Users\\Owner\\.openclaw\\openclaw.json\r\n'],
    ];
    for (const [expected, home, output] of cases) {
      expect(spawnSync(process.execPath, [activeConfigPathValidator, expected, home], { input: output, encoding: 'utf8' }).status).toBe(0);
      expect(spawnSync(process.execPath, [activeConfigPathValidator, expected, home], { input: `${output.trim()}.other\n`, encoding: 'utf8' }).status).not.toBe(0);
    }
    const source = readFileSync(installer, 'utf8');
    expect(source).toContain('"$OPENCLAW" config file');
    expect(source).toContain('node "$ACTIVE_CONFIG_PATH_VALIDATOR" "$ACTIVE_CONFIG_FILE" "$HOME"');
  });

  it('fails closed on missing, linked, wrong-owner, wrong-mode, or identity-drifting active config files', () => {
    const source = readFileSync(installer, 'utf8');
    const validation = source.split('validate_config_file() {')[1]!.split('\n}')[0]!;
    expect(validation).toContain('local path="$1"');
    expect(validation).toContain('[[ -e "$path" && ! -L "$path" ]]');
    expect(validation.match(/stat -Lc/g)).toHaveLength(2);
    expect(validation).toContain('readlink -f -- "$path"');
    expect(validation).toContain('"$before" == "$after"');
    expect(validation).toContain("':regular file:'\"$owner\"':600'");
    const checkBlock = source.split('if [[ "$MODE" == check ]]; then')[1]!.split('\nfi')[0]!;
    expect(checkBlock.indexOf('validate_config_file "$ACTIVE_CONFIG_FILE"')).toBeLessThan(checkBlock.indexOf('validate_active_config_path'));
    expect(checkBlock.indexOf('validate_active_config_path')).toBeLessThan(
      checkBlock.indexOf('node "$HARDENED_CONFIG_VALIDATOR" "$OPENCLAW" "$ACTIVE_CONFIG_FILE" "$SECRET_DIR"'));
  });

  it('pins the same explicit active config into the OpenClaw Gateway service environment', () => {
    const source = readFileSync(installer, 'utf8');
    expect(source).toContain('OPENCLAW_STATE_DIR="$OPENCLAW_HOME"');
    expect(source).toContain('ACTIVE_CONFIG_FILE="$OPENCLAW_STATE_DIR/openclaw.json"');
    expect(source).toContain('OPENCLAW_CONFIG_PATH="$ACTIVE_CONFIG_FILE"');
    const runtimePaths = readFileSync(resolve(repo,
      'plugins/openclaw-personal-assistant/node_modules/openclaw/dist/runtime-paths-C6MOwQ_j.js'), 'utf8');
    expect(runtimePaths).toContain('OPENCLAW_CONFIG_PATH: sharedEnv.configPath');
    expect(runtimePaths).toContain('const configPath = env.OPENCLAW_CONFIG_PATH');
  });

  it('fails closed on an unsafe config before installer mutation', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'ocpa-unsafe-config-'));
    try {
      privateDirectory(root);
      const config = resolve(root, 'openclaw.json5');
      const secretRoot = resolve(root, 'secrets');
      const configSecretRoot = secretRoot.replaceAll('\\', '/');
      const unsafe = readFileSync(resolve(repo, 'config/openclaw.personal-assistant.example.json5'), 'utf8')
        .replaceAll('/home/user/.openclaw/secrets', configSecretRoot)
        .replace("bind: 'loopback'", "bind: 'lan'");
      writeFileSync(config, unsafe, { mode: 0o600 });
      const openclaw = resolve(repo, 'plugins/openclaw-personal-assistant/node_modules/.bin/openclaw.cmd');
      const result = spawnSync(process.execPath, [hardenedConfigValidator, openclaw, config, secretRoot], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('active_config_not_hardened');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ['disabled Telegram', (text: string) => text.replace('enabled: true,\n      tokenFile:', 'enabled: false,\n      tokenFile:')],
    ['wrong CalDAV secret path', (text: string) => text.replace('/naver-caldav', '/wrong-caldav')],
    ['wrong Naver token path', (text: string) => text.replace('/naver-oauth', '/wrong-oauth')],
    ['placeholder', (text: string) => text.replace("timezone: 'Asia/Seoul'", "timezone: '<replace-timezone>'")],
  ])('rejects %s through the full hardened config contract used by --check', (_label, mutate) => {
    const root = mkdtempSync(resolve(tmpdir(), 'ocpa-check-config-'));
    try {
      privateDirectory(root);
      const config = resolve(root, 'openclaw.json5');
      const secretRoot = resolve(root, 'secrets');
      const configSecretRoot = secretRoot.replaceAll('\\', '/');
      const baseline = readFileSync(resolve(repo, 'config/openclaw.personal-assistant.example.json5'), 'utf8')
        .replaceAll('/home/user/.openclaw/secrets', configSecretRoot);
      writeFileSync(config, baseline, { mode: 0o600 });
      const openclaw = resolve(repo, 'plugins/openclaw-personal-assistant/node_modules/.bin/openclaw.cmd');
      const valid = spawnSync(process.execPath, [hardenedConfigValidator, openclaw, config, secretRoot], { encoding: 'utf8' });
      expect(valid.status, valid.stderr).toBe(0);
      writeFileSync(config, mutate(baseline), { mode: 0o600 });
      expect(spawnSync(process.execPath, [hardenedConfigValidator, openclaw, config, secretRoot], { encoding: 'utf8' }).status).not.toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
    const checkBlock = readFileSync(installer, 'utf8').split('if [[ "$MODE" == check ]]; then')[1]!.split('\nfi')[0]!;
    expect(checkBlock).toContain('validate_config_file "$ACTIVE_CONFIG_FILE"');
    expect(checkBlock).toContain('node "$HARDENED_CONFIG_VALIDATOR" "$OPENCLAW" "$ACTIVE_CONFIG_FILE" "$SECRET_DIR"');
    expect(checkBlock).not.toMatch(/config patch|gateway install|cron add|mkdir/);
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

  it('--all records every live criterion as NV125 without invoking a hostile validator node wrapper', () => {
    const evidence = mkdtempSync(resolve(tmpdir(), 'ocpa-live-evidence-'));
    try {
      forgeAc01Evidence(evidence);
      const hostileBin = resolve(evidence, 'hostile-bin');
      mkdirSync(hostileBin);
      const marker = resolve(evidence, 'validator-was-invoked');
      const wrapper = resolve(hostileBin, 'node');
      const bashPath = (value: string) => value.replace(/^([A-Za-z]):[\\/]/, (_match, drive: string) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/');
      writeFileSync(wrapper, `#!/usr/bin/env bash\nif [[ \"\${1:-}\" == *validate-live-evidence.js ]]; then\n  printf invoked > '${bashPath(marker)}'\n  printf '%s\\n' '{"status":"PASS","observedArtifactPath":"forged"}'\n  exit 0\nfi\nexec '${bashPath(process.execPath).replaceAll("'", "'\\''")}' \"$@\"\n`, { mode: 0o700 });
      const result = spawnSync(gitBash, [acceptance, '--all'], {
        cwd: repo, encoding: 'utf8', timeout: 200_000,
        env: { ...process.env, LIVE_TEST: '1', LIVE_EVIDENCE_DIR: evidence,
          PATH: `${hostileBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` },
      });
      expect(result.status).toBe(2);
      const summary = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);
      expect(summary).toMatchObject({ total: 32, fail: 0, notVerified: 16 });
      const index = JSON.parse(readFileSync(resolve(repo, summary.index), 'utf8'));
      expect(index.criteria.filter((item: Record<string, unknown>) => liveCriteria.includes(String(item.criterionId))))
        .toHaveLength(14);
      expect(index.criteria.filter((item: Record<string, unknown>) => liveCriteria.includes(String(item.criterionId)))
        .every((item: Record<string, unknown>) => item.status === 'NOT_VERIFIED' && item.exitCode === 125)).toBe(true);
      expect(() => readFileSync(marker)).toThrow();
    } finally {
      rmSync(evidence, { recursive: true, force: true });
    }
  }, 210_000);
});
