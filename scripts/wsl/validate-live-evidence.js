#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const { lstatSync, realpathSync } = require('node:fs');
const { isAbsolute, join, resolve } = require('node:path');
const {
  MAX_EVIDENCE_BYTES, MAX_RAW_BYTES, PRODUCER, PROBES, PROTOCOL_VERSION, TEST_PRODUCER,
  canonical, deriveObservations, fresh, secureReadFile, sha256, validateRaw, validateSafeValue, within,
} = require('./live-probe-contract.js');

try {
  const [evidenceDirectory, criterionId, option] = process.argv.slice(2);
  const allowTest = option === '--allow-test-evidence' && process.argv.length === 5
    && process.env.OCPA_LIVE_PROBE_TEST_MODE === '1';
  if (!evidenceDirectory || !criterionId || !PROBES[criterionId] || !PROBES[criterionId].supported
    || (option !== undefined && !allowTest) || !isAbsolute(evidenceDirectory)
    || resolve(evidenceDirectory) !== evidenceDirectory) fail();
  const rootInfo = lstatSync(evidenceDirectory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || realpathSync(evidenceDirectory) !== evidenceDirectory) fail();
  assertPrivate(evidenceDirectory, true);

  const canaries = loadCanaries();
  const evidencePath = join(evidenceDirectory, `${criterionId}.json`);
  assertPrivate(evidencePath, false);
  const evidenceBytes = secureReadFile(evidencePath, { root: evidenceDirectory, maxBytes: MAX_EVIDENCE_BYTES });
  const evidence = parseJson(evidenceBytes);
  validateSafeValue(evidence, canaries);
  const keys = ['criterionId', 'endedAt', 'exitCode', 'ledgerPath', 'ledgerSha256', 'observations', 'probeDigest', 'probeId', 'producer', 'protocolVersion', 'rawArtifacts', 'startedAt', 'status', 'targetIdentity'];
  const probe = PROBES[criterionId];
  if (!plainExact(evidence, keys)
    || !(evidence.producer === PRODUCER || (allowTest && evidence.producer === TEST_PRODUCER))
    || evidence.protocolVersion !== PROTOCOL_VERSION || evidence.criterionId !== criterionId
    || evidence.probeId !== probe.probeId || evidence.probeDigest !== probe.digest
    || evidence.status !== 'PASS' || evidence.exitCode !== 0
    || !fresh(evidence.startedAt) || !fresh(evidence.endedAt)
    || new Date(evidence.endedAt) < new Date(evidence.startedAt)
    || !/^[a-f0-9]{64}$/.test(String(evidence.targetIdentity))
    || !Array.isArray(evidence.rawArtifacts) || evidence.rawArtifacts.length !== probe.phases.length
    || evidence.rawArtifacts.length > 16 || !/^[a-f0-9]{64}$/.test(String(evidence.ledgerSha256))) fail();

  const rawByPhase = {};
  const seen = new Set();
  let totalBytes = evidenceBytes.length;
  for (const record of evidence.rawArtifacts) {
    if (!plainExact(record, ['capturedAt', 'path', 'phase', 'sha256', 'size'])
      || !probe.phases.includes(record.phase) || seen.has(record.phase) || !fresh(record.capturedAt)
      || !Number.isInteger(record.size) || record.size < 1 || record.size > MAX_RAW_BYTES
      || !/^[a-f0-9]{64}$/.test(String(record.sha256)) || !safeAbsoluteChild(evidenceDirectory, record.path)) fail();
    seen.add(record.phase);
    assertPrivate(record.path, false);
    const bytes = secureReadFile(record.path, { root: evidenceDirectory, maxBytes: MAX_RAW_BYTES });
    totalBytes += bytes.length;
    if (totalBytes > 8 * 1024 * 1024 || bytes.length !== record.size || sha256(bytes) !== record.sha256) fail();
    const raw = parseJson(bytes);
    validateRaw(criterionId, record.phase, raw, canaries);
    if (raw.capturedAt !== record.capturedAt) fail();
    rawByPhase[record.phase] = raw;
  }
  if (seen.size !== probe.phases.length) fail();

  if (!safeAbsoluteChild(evidenceDirectory, evidence.ledgerPath)) fail();
  assertPrivate(evidence.ledgerPath, false);
  const ledgerBytes = secureReadFile(evidence.ledgerPath, { root: evidenceDirectory, maxBytes: MAX_EVIDENCE_BYTES });
  if (sha256(ledgerBytes) !== evidence.ledgerSha256) fail();
  const ledger = parseJson(ledgerBytes);
  validateSafeValue(ledger, canaries);
  if (!plainExact(ledger, ['criterionId', 'phases', 'probeDigest', 'probeId', 'producer', 'protocolVersion', 'startedAt', 'status', 'targetIdentity', 'updatedAt'])
    || ledger.producer !== evidence.producer || ledger.protocolVersion !== PROTOCOL_VERSION
    || ledger.criterionId !== criterionId || ledger.probeId !== probe.probeId || ledger.probeDigest !== probe.digest
    || ledger.targetIdentity !== evidence.targetIdentity || ledger.status !== 'COMPLETE'
    || !fresh(ledger.startedAt) || !fresh(ledger.updatedAt)
    || canonical(ledger.phases) !== canonical(evidence.rawArtifacts)) fail();

  const derived = deriveObservations(criterionId, rawByPhase);
  if (canonical(derived) !== canonical(evidence.observations)) fail();
  process.stdout.write(`${JSON.stringify({ status: 'PASS', observedArtifactPath: evidencePath })}\n`);
} catch { fail(); }

function parseJson(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail();
  try { return JSON.parse(text); } catch { fail(); }
}
function plainExact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}
function safeAbsoluteChild(root, path) {
  return typeof path === 'string' && isAbsolute(path) && resolve(path) === path && within(root, path);
}
function loadCanaries() {
  const path = process.env.OCPA_LIVE_CANARY_FILE;
  if (!path) return [];
  if (!isAbsolute(path)) fail();
  assertPrivate(path, false);
  const bytes = secureReadFile(path, { root: resolve(path, '..'), maxBytes: 64 * 1024 });
  const values = bytes.toString('utf8').split(/\r?\n/).filter(Boolean);
  if (values.length > 128 || values.some(value => value.length < 4 || value.length > 256)) fail();
  return values;
}
function assertPrivate(path, directory) {
  const info = lstatSync(path);
  if ((directory ? !info.isDirectory() : !info.isFile()) || info.isSymbolicLink()) fail();
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) fail();
    if ((info.mode & 0o777) !== (directory ? 0o700 : 0o600)) fail();
    return;
  }
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
    '$p=$env:OCPA_EVIDENCE_PATH;', '$d=$env:OCPA_EVIDENCE_DIRECTORY -eq "1";',
    '$i=[Security.Principal.WindowsIdentity]::GetCurrent().User;', '$a=[Security.Principal.SecurityIdentifier]::new("S-1-5-32-544");',
    '$acl=Get-Acl -LiteralPath $p;', '$owner=([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]);',
    '$rules=@($acl.Access);', '$sids=@($rules|ForEach-Object{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value});',
    '$ok=$owner.Value -eq $i.Value -and @($rules|Where-Object AccessControlType -ne Allow).Count -eq 0 -and @($sids|Where-Object{$_ -ne $i.Value -and $_ -ne $a.Value}).Count -eq 0 -and $sids -contains $i.Value;',
    'if($d){$ok=$ok -and $acl.AreAccessRulesProtected -and @($rules|Where-Object IsInherited).Count -eq 0};', 'if(!$ok){exit 1}',
  ].join(' ')], { encoding: 'utf8', windowsHide: true, env: windowsEnvironment(path, directory) });
}
function windowsEnvironment(path, directory) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  environment.OCPA_EVIDENCE_PATH = path; environment.OCPA_EVIDENCE_DIRECTORY = directory ? '1' : '0';
  return environment;
}
function fail() { process.stderr.write('live_evidence_invalid\n'); process.exit(1); }
