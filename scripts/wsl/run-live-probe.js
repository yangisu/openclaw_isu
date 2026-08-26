#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { chmodSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, renameSync, realpathSync, statSync, unlinkSync, writeFileSync } = require('node:fs');
const { hostname, userInfo } = require('node:os');
const { isAbsolute, join, resolve } = require('node:path');
const {
  MAX_EVIDENCE_BYTES, MAX_RAW_BYTES, PRODUCER, PROBES, PROTOCOL_VERSION, TEST_PRODUCER,
  canonical, deriveObservations, secureReadFile, sha256, validateRaw, validateSafeValue,
} = require('./live-probe-contract.js');

try { main(); } catch (error) {
  process.stderr.write(`${safeCode(error)}\n`);
  process.exit(1);
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  const criterionId = required(options, 'criterion');
  const outputDir = required(options, 'output-dir');
  const probe = PROBES[criterionId];
  if (!probe || !isAbsolute(outputDir) || resolve(outputDir) !== outputDir) throw coded('probe_usage');
  ensurePrivateRoot(outputDir);
  const phase = options.get('phase') ?? (probe.phases.length === 1 ? probe.phases[0] : undefined);
  if (!phase || !probe.phases.includes(phase)) throw coded('probe_phase_required');
  const adapter = options.get('test-adapter');
  const testMode = adapter !== undefined;
  if (testMode && (process.env.OCPA_LIVE_PROBE_TEST_MODE !== '1' || !isAbsolute(adapter))) throw coded('test_adapter_forbidden');
  const canaries = loadCanaries(outputDir);
  const startedAt = new Date().toISOString();
  const result = testMode ? runTestAdapter(adapter) : runFixedAdapter(criterionId, phase);
  if (result.status !== 0 || result.signal || result.error || Buffer.byteLength(result.stdout ?? '', 'utf8') > MAX_RAW_BYTES) throw coded('probe_command_failed');
  let raw;
  try { raw = JSON.parse(result.stdout); } catch { throw coded('probe_output_invalid'); }
  validateSafeValue(raw, canaries);
  validateRaw(criterionId, phase, raw, canaries);

  const rawPath = join(outputDir, `${criterionId}.${phase}.raw.json`);
  writePrivateAtomic(rawPath, `${canonical(raw)}\n`);
  const rawBytes = secureReadFile(rawPath, { root: outputDir, maxBytes: MAX_RAW_BYTES });
  const records = collectPhaseRecords(outputDir, criterionId, probe, canaries);
  const ledger = {
    producer: testMode ? TEST_PRODUCER : PRODUCER,
    protocolVersion: PROTOCOL_VERSION,
    criterionId,
    probeId: probe.probeId,
    probeDigest: probe.digest,
    targetIdentity: targetIdentity(),
    startedAt,
    updatedAt: new Date().toISOString(),
    phases: records,
    status: records.length === probe.phases.length ? 'COMPLETE' : 'NOT_VERIFIED',
  };
  validateSafeValue(ledger, canaries);
  const ledgerPath = join(outputDir, `${criterionId}.ledger.json`);
  writePrivateAtomic(ledgerPath, `${canonical(ledger)}\n`);
  const ledgerBytes = secureReadFile(ledgerPath, { root: outputDir, maxBytes: MAX_EVIDENCE_BYTES });

  if (records.length !== probe.phases.length) {
    process.stdout.write(`${JSON.stringify({ status: 'NOT_VERIFIED', criterionId, completedPhases: records.map(item => item.phase) })}\n`);
    process.exit(125);
  }
  const rawByPhase = Object.fromEntries(records.map(record => {
    const bytes = secureReadFile(record.path, { root: outputDir, maxBytes: MAX_RAW_BYTES });
    return [record.phase, JSON.parse(bytes.toString('utf8'))];
  }));
  const observations = deriveObservations(criterionId, rawByPhase);
  const evidence = {
    producer: testMode ? TEST_PRODUCER : PRODUCER,
    protocolVersion: PROTOCOL_VERSION,
    criterionId,
    probeId: probe.probeId,
    probeDigest: probe.digest,
    startedAt: records.map(item => item.capturedAt).sort()[0],
    endedAt: records.map(item => item.capturedAt).sort().at(-1),
    targetIdentity: ledger.targetIdentity,
    exitCode: 0,
    status: 'PASS',
    observations,
    rawArtifacts: records,
    ledgerPath,
    ledgerSha256: sha256(ledgerBytes),
  };
  validateSafeValue(evidence, canaries);
  const evidencePath = join(outputDir, `${criterionId}.json`);
  writePrivateAtomic(evidencePath, `${canonical(evidence)}\n`);
  void rawBytes;
  process.stdout.write(`${JSON.stringify({ status: 'PASS', criterionId, evidencePath })}\n`);
}

function collectPhaseRecords(root, criterionId, probe, canaries) {
  const records = [];
  for (const phase of probe.phases) {
    const path = join(root, `${criterionId}.${phase}.raw.json`);
    if (!existsSync(path)) continue;
    const bytes = secureReadFile(path, { root, maxBytes: MAX_RAW_BYTES });
    const raw = JSON.parse(bytes.toString('utf8'));
    validateRaw(criterionId, phase, raw, canaries);
    records.push({ phase, path, size: bytes.length, sha256: sha256(bytes), capturedAt: raw.capturedAt });
  }
  return records;
}

function runTestAdapter(path) {
  secureReadFile(path, { root: resolve(path, '..'), maxBytes: 64 * 1024 });
  return spawnSync(process.execPath, [path], { encoding: 'utf8', maxBuffer: MAX_RAW_BYTES + 1, windowsHide: true, env: testEnvironment() });
}

function runFixedAdapter(criterionId, phase) {
  const target = join(__dirname, 'live-probe-target.js');
  return spawnSync(process.execPath, [target, '--criterion', criterionId, '--phase', phase], {
    encoding: 'utf8', maxBuffer: MAX_RAW_BYTES + 1, windowsHide: true,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^OCPA_LIVE_PROBE_TEST_MODE$/i.test(key))),
  });
}

function loadCanaries(root) {
  const path = process.env.OCPA_LIVE_CANARY_FILE;
  if (!path) return [];
  if (!isAbsolute(path)) throw coded('canary_file_invalid');
  const bytes = secureReadFile(path, { root: resolve(path, '..'), maxBytes: 64 * 1024 });
  const values = bytes.toString('utf8').split(/\r?\n/).filter(Boolean);
  if (values.length > 128 || values.some(value => value.length < 4 || value.length > 256)) throw coded('canary_file_invalid');
  void root;
  return values;
}

function targetIdentity() {
  const boot = process.platform === 'linux' && existsSync('/proc/sys/kernel/random/boot_id')
    ? secureSystemText('/proc/sys/kernel/random/boot_id') : 'boot-unavailable';
  return createHash('sha256').update(`${hostname()}\0${userInfo().username}\0${boot}`).digest('hex');
}

function secureSystemText(path) {
  const info = statSync(path);
  if (!info.isFile() || info.size > 4096) throw coded('target_identity_invalid');
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(info.size);
    require('node:fs').readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString('utf8').trim();
  } finally { closeSync(fd); }
}

function ensurePrivateRoot(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: false, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) throw coded('evidence_root_invalid');
  if (process.platform !== 'win32') {
    chmodSync(path, 0o700);
    const checked = statSync(path);
    if ((checked.mode & 0o777) !== 0o700 || (typeof process.getuid === 'function' && checked.uid !== process.getuid())) throw coded('evidence_root_private');
  }
}

function writePrivateAtomic(path, content) {
  if (Buffer.byteLength(content, 'utf8') > MAX_EVIDENCE_BYTES) throw coded('evidence_too_large');
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    if (existsSync(path)) {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || realpathSync(path) !== path) throw coded('evidence_path_unsafe');
    }
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

function parseOptions(args) {
  const allowed = new Set(['criterion', 'output-dir', 'phase', 'test-adapter']);
  const result = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) throw coded('probe_usage');
    const name = key.slice(2);
    if (!allowed.has(name) || result.has(name)) throw coded('probe_usage');
    result.set(name, value);
  }
  return result;
}
function required(options, key) { const value = options.get(key); if (!value) throw coded('probe_usage'); return value; }
function testEnvironment() { return { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }; }
function coded(code) { return Object.assign(new Error(code), { code }); }
function safeCode(error) { return error && typeof error.code === 'string' && /^[a-z0-9_]+$/.test(error.code) ? error.code : 'live_probe_failed'; }
