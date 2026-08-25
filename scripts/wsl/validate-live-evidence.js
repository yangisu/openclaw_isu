#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { lstatSync, readFileSync, realpathSync, statSync } = require('node:fs');
const { isAbsolute, join, relative, resolve } = require('node:path');

const [evidenceDirectory, criterionId] = process.argv.slice(2);
const REQUIRED = {
  'AC-01': { ubuntuVersion: '24.04', systemdPid1: true, gatewayActive: true },
  'AC-02': { provider: 'openai', modelResponseObserved: true },
  'AC-03': { ownerMessageReceived: true, ownerResponseObserved: true },
  'AC-07': { caldavAuthenticated: true, existingEventRead: true },
  'AC-08': { confirmationObserved: true, createdCount: 1, duplicateCount: 0, deletedByUser: true },
  'AC-12': { windowsRestartRecovered: true, wslRestartRecovered: true, gatewayActive: true },
  'AC-13': { ageEncrypted: true, isolatedRestore: true, manifestVerified: true },
  'AC-14': { trackedFilesClean: true, logsClean: true, encryptedArchiveClean: true },
  'AC-15': { authenticated: true, listedCalendars: true, singleEventRead: true, allDayRead: true, recurringRead: true, crossTimezoneRead: true, limitedModeOnFailure: true },
  'AC-23': { observed0800: true, observed2200: true, observed2300: false, catchUpReplayObserved: false },
  'AC-25': { windowsRebooted: true, idleMinutes: 30, noInteractiveLogin: true, wslActive: true, gatewayActive: true, telegramResponseObserved: true },
  'AC-26': { gatewayModelCall: true, telegramModelCall: true, refreshFailureClosed: true, revocationClosed: true },
  'AC-27': { invalidStateRejected: true, expiredStateRejected: true, reusedStateRejected: true, eventCreated: true, tokenRefreshed: true, tokenRevoked: true, postRevocationFailed: true },
  'AC-32': { sha256Verified: true, gitVerified: true, markdownVerified: true, sqliteVerified: true, fullRestoreVerified: true, monthlyEvidenceRecorded: true },
};

try {
  if (!evidenceDirectory || !criterionId || !Object.hasOwn(REQUIRED, criterionId)
    || !isAbsolute(evidenceDirectory) || resolve(evidenceDirectory) !== evidenceDirectory) fail();
  const rootInfo = lstatSync(evidenceDirectory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail();
  const root = realpathSync(evidenceDirectory);
  if (resolve(root) !== resolve(evidenceDirectory)) fail();
  assertPrivate(root, true);

  const evidencePath = join(root, `${criterionId}.json`);
  const evidenceInfo = lstatSync(evidencePath);
  if (!evidenceInfo.isFile() || evidenceInfo.isSymbolicLink()) fail();
  if (realpathSync(evidencePath) !== evidencePath || !within(root, evidencePath)) fail();
  assertPrivate(evidencePath, false);

  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  const keys = ['criterionId', 'exitCode', 'generator', 'observations', 'observedArtifactPath', 'observedArtifactSha256', 'observedAt', 'status', 'version'];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
    || Object.keys(evidence).sort().join('\0') !== keys.sort().join('\0')
    || evidence.version !== 1 || evidence.generator !== 'openclaw-personal-assistant-live-acceptance/v1'
    || evidence.criterionId !== criterionId || evidence.status !== 'PASS' || evidence.exitCode !== 0
    || typeof evidence.observedAt !== 'string' || !freshTimestamp(evidence.observedAt)
    || typeof evidence.observedArtifactPath !== 'string' || !isAbsolute(evidence.observedArtifactPath)
    || resolve(evidence.observedArtifactPath) !== evidence.observedArtifactPath
    || !/^[a-f0-9]{64}$/.test(String(evidence.observedArtifactSha256))) fail();
  validateObservations(criterionId, evidence.observations);

  const artifactPath = evidence.observedArtifactPath;
  if (!within(root, artifactPath)) fail();
  const artifactInfo = lstatSync(artifactPath);
  if (!artifactInfo.isFile() || artifactInfo.isSymbolicLink() || realpathSync(artifactPath) !== artifactPath) fail();
  assertPrivate(artifactPath, false);
  const bytes = readFileSync(artifactPath);
  if (createHash('sha256').update(bytes).digest('hex') !== evidence.observedArtifactSha256) fail();
  const artifactText = bytes.toString('utf8');
  if (Buffer.from(artifactText, 'utf8').compare(bytes) !== 0 || !safeArtifactText(artifactText)) fail();

  process.stdout.write(`${JSON.stringify({ status: 'PASS', observedArtifactPath: artifactPath })}\n`);
} catch {
  fail();
}

function validateObservations(id, observations) {
  const required = REQUIRED[id];
  if (!observations || typeof observations !== 'object' || Array.isArray(observations)
    || Object.keys(observations).sort().join('\0') !== Object.keys(required).sort().join('\0')) fail();
  for (const [key, expected] of Object.entries(required)) {
    const actual = observations[key];
    if (id === 'AC-25' && key === 'idleMinutes') {
      if (!Number.isFinite(actual) || actual < expected) fail();
    } else if (actual !== expected) fail();
  }
}

function freshTimestamp(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const timestamp = new Date(value).valueOf();
  return Number.isFinite(timestamp) && Date.now() - timestamp <= 24 * 3_600_000 && timestamp - Date.now() <= 5 * 60_000;
}

function safeArtifactText(value) {
  return value.length > 0 && value.length <= 8 * 1024 * 1024
    && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\p{Cf}]/u.test(value)
    && !/https?:\/\/[^\s/@]+:[^\s/@]+@/iu.test(value)
    && !/[?&](?:token|code|secret|key|api[_-]?key|refresh[_-]?token)=[^&\s]+/iu.test(value)
    && !/\b(?:Bearer\s+|sk-)[A-Za-z0-9_.-]{16,}\b/iu.test(value);
}

function within(root, path) {
  const rel = relative(root, path);
  return rel !== '' ? !rel.startsWith('..') && !isAbsolute(rel) : true;
}

function assertPrivate(path, directory) {
  if (process.platform !== 'win32') {
    const info = statSync(path);
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) fail();
    if ((info.mode & 0o777) !== (directory ? 0o700 : 0o600)) fail();
    return;
  }
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
    '$p=$env:OCPA_EVIDENCE_PATH;',
    '$d=$env:OCPA_EVIDENCE_DIRECTORY -eq "1";',
    '$i=[Security.Principal.WindowsIdentity]::GetCurrent().User;',
    '$a=[Security.Principal.SecurityIdentifier]::new("S-1-5-32-544");',
    '$acl=Get-Acl -LiteralPath $p;',
    '$owner=([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]);',
    '$rules=@($acl.Access);',
    '$sids=@($rules|ForEach-Object{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value});',
    '$ok=$owner.Value -eq $i.Value -and @($rules|Where-Object AccessControlType -ne Allow).Count -eq 0 -and @($sids|Where-Object{$_ -ne $i.Value -and $_ -ne $a.Value}).Count -eq 0 -and $sids -contains $i.Value;',
    'if($d){$ok=$ok -and $acl.AreAccessRulesProtected -and @($rules|Where-Object IsInherited).Count -eq 0};',
    'if(!$ok){exit 1}',
  ].join(' ')], {
    encoding: 'utf8', windowsHide: true,
    env: windowsPowerShellEnvironment(path, directory),
  });
  void output;
}

function windowsPowerShellEnvironment(path, directory) {
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  environment.OCPA_EVIDENCE_PATH = path;
  environment.OCPA_EVIDENCE_DIRECTORY = directory ? '1' : '0';
  return environment;
}

function fail() {
  process.stderr.write('live_evidence_invalid\n');
  process.exit(1);
}
