#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } = require('node:fs');
const { isAbsolute, join, relative, resolve } = require('node:path');

const PROTOCOL_VERSION = 3;
const PRODUCER = 'openclaw-personal-assistant-live-probe/v3';
const TEST_PRODUCER = 'openclaw-personal-assistant-live-probe-test-adapter/v3';
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MAX_RAW_BYTES = 1024 * 1024;

const unsupportedIds = ['AC-02', 'AC-03', 'AC-07', 'AC-08', 'AC-13', 'AC-14', 'AC-15', 'AC-23', 'AC-25', 'AC-26', 'AC-27', 'AC-32'];
const requirements = {
  'AC-01': { supported: true, phases: ['single'], probeId: 'ocpa-live-ac01-v3', adapter: 'system-health-v1', commands: ['os-release', 'pid1', 'gateway-active'] },
  'AC-12': { supported: true, phases: ['before-restart', 'after-restart'], probeId: 'ocpa-live-ac12-v3', adapter: 'restart-health-v1', commands: ['windows-boot-id', 'wsl-boot-id', 'gateway-active'] },
  ...Object.fromEntries(unsupportedIds.map(id => [id, { supported: false, phases: [], probeId: `ocpa-live-${id.toLowerCase().replace('-', '')}-v3`, adapter: 'unsupported' }])),
};

const targetImplementationSha256 = sha256(readFileSync(join(__dirname, 'live-probe-target.js')));

const PROBES = Object.fromEntries(Object.entries(requirements).map(([criterionId, value]) => {
  const command = { executable: 'node', argv: ['scripts/wsl/live-probe-target.js', '--criterion', criterionId, '--phase', '<phase>'] };
  const base = { criterionId, probeId: value.probeId, supported: value.supported, adapter: value.adapter,
    phases: value.phases, commands: value.commands ?? [], command, targetImplementationSha256 };
  return [criterionId, { ...value, command, digest: sha256(canonical(base)) }];
}));

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function within(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function secureReadFile(path, { root, maxBytes, afterOpen } = {}) {
  if (!isAbsolute(path) || resolve(path) !== path || !isAbsolute(root) || !within(root, path)) throw new Error('unsafe_path');
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maxBytes) throw new Error('unsafe_file');
  if (realpathSync(path) !== path) throw new Error('unsafe_path');
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
  const fd = openSync(path, flags);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error('file_changed');
    assertPosixPrivate(opened, false);
    if (afterOpen) afterOpen();
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error('short_read');
      offset += count;
    }
    const extra = Buffer.alloc(1);
    if (readSync(fd, extra, 0, 1, offset) !== 0) throw new Error('oversized_file');
    const after = fstatSync(fd);
    const current = lstatSync(path);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || current.dev !== opened.dev || current.ino !== opened.ino || current.size !== opened.size) throw new Error('file_changed');
    return bytes;
  } finally { closeSync(fd); }
}

function assertPosixPrivate(info, directory) {
  if (process.platform === 'win32') return;
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('owner_invalid');
  if ((info.mode & 0o777) !== (directory ? 0o700 : 0o600)) throw new Error('mode_invalid');
}

const forbiddenKey = /^(?:token|secret|secret[_-]?value|access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|apikey|authorization|password|password[_-]?hash|telegram[_-]?token|bearer|basic|oauth[_-]?(?:code|state|verifier)|code|state|verifier|cookie|credential|private[_-]?key)$/i;
const forbiddenValue = /(?:\b(?:Basic|Bearer)\s+\S+|\b\d{6,12}:[A-Za-z0-9_-]{20,}\b|\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-|ghp_|AIza)[A-Za-z0-9_-]{8,}\b|https?:\/\/[^\s/@]+:[^\s/@]+@|https?:\/\/[^\s]+[?&](?:token|code|state|secret|key|api[_-]?key|password|verifier)=[^&#\s]*)/iu;

function validateSafeValue(value, canaries = [], state = { nodes: 0, strings: 0 }, depth = 0) {
  if (depth > 8 || ++state.nodes > 1000) throw new Error('structure_limit');
  if (typeof value === 'string') {
    state.strings += value.length;
    if (value.length > 4096 || state.strings > 128 * 1024 || /[\p{Cc}\p{Cf}]/u.test(value)
      || forbiddenValue.test(value) || canaries.some(canary => canary && value.includes(canary))) throw new Error('unsafe_value');
    return;
  }
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('unsafe_number'); return; }
  if (typeof value === 'boolean' || value === null) return;
  if (Array.isArray(value)) {
    if (value.length > 128) throw new Error('array_limit');
    for (const item of value) validateSafeValue(item, canaries, state, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') throw new Error('unsafe_type');
  const keys = Object.keys(value);
  if (keys.length > 128) throw new Error('object_limit');
  for (const key of keys) {
    const normalizedKey = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    if (key.length > 128 || forbiddenKey.test(key)
      || /^(?:token|secret|secretvalue|accesstoken|refreshtoken|clientsecret|apikey|authorization|password|passwordhash|telegramtoken|bearer|basic|oauthcode|oauthstate|oauthverifier|code|state|verifier|cookie|credentials?|privatekey)$/.test(normalizedKey)) throw new Error('secret_key');
    validateSafeValue(value[key], canaries, state, depth + 1);
  }
}

function validateRaw(criterionId, phase, raw, canaries = []) {
  const probe = PROBES[criterionId];
  if (!probe || !probe.supported) throw new Error('probe_unsupported');
  if (!probe.phases.includes(phase)) throw new Error('probe_invalid');
  validateSafeValue(raw, canaries);
  const keys = ['adapter', 'capturedAt', 'commandResults', 'phase', 'probeId'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join('\0') !== keys.join('\0')
    || raw.probeId !== probe.probeId || raw.phase !== phase || !fresh(raw.capturedAt)
    || raw.adapter !== probe.adapter || !Array.isArray(raw.commandResults)
    || raw.commandResults.length !== probe.commands.length) throw new Error('raw_invalid');
  for (let index = 0; index < probe.commands.length; index += 1) {
    const result = raw.commandResults[index];
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || Object.keys(result).sort().join('\0') !== 'commandId\0exitCode\0stdoutLines'
      || result.commandId !== probe.commands[index] || result.exitCode !== 0
      || !Array.isArray(result.stdoutLines) || result.stdoutLines.length < 1 || result.stdoutLines.length > 128
      || result.stdoutLines.some(line => typeof line !== 'string' || line.length > 4096)) throw new Error('command_result_invalid');
  }
  return raw;
}

function deriveObservations(criterionId, rawByPhase) {
  const probe = PROBES[criterionId];
  if (!probe || !probe.supported) throw new Error('probe_unsupported');
  if (Object.keys(rawByPhase).sort().join('\0') !== [...probe.phases].sort().join('\0')) throw new Error('phases_incomplete');
  for (const phase of probe.phases) validateRaw(criterionId, phase, rawByPhase[phase]);
  if (criterionId === 'AC-01') {
    const commands = commandMap(rawByPhase.single);
    const release = parseOsRelease(commands.get('os-release'));
    const observations = {
      ubuntuVersion: release.VERSION_ID,
      systemdPid1: commands.get('pid1').trim() === 'systemd',
      gatewayActive: commands.get('gateway-active').trim() === 'active',
    };
    if (release.ID !== 'ubuntu' || observations.ubuntuVersion !== '24.04'
      || !observations.systemdPid1 || !observations.gatewayActive) throw new Error('criterion_not_observed');
    return observations;
  }
  if (criterionId === 'AC-12') {
    const before = commandMap(rawByPhase['before-restart']); const after = commandMap(rawByPhase['after-restart']);
    const observations = {
      windowsRestartRecovered: before.get('windows-boot-id').trim() !== after.get('windows-boot-id').trim(),
      wslRestartRecovered: before.get('wsl-boot-id').trim() !== after.get('wsl-boot-id').trim(),
      gatewayActive: after.get('gateway-active').trim() === 'active',
    };
    if (![before.get('windows-boot-id'), after.get('windows-boot-id'), before.get('wsl-boot-id'), after.get('wsl-boot-id')]
      .every(value => /^[A-Za-z0-9._:-]{6,128}\s*$/.test(value)) || !Object.values(observations).every(Boolean)) throw new Error('restart_not_observed');
    return observations;
  }
  throw new Error('probe_unsupported');
}

function commandMap(raw) { return new Map(raw.commandResults.map(result => [result.commandId, result.stdoutLines.join('\n')])); }
function parseOsRelease(text) {
  return Object.fromEntries(text.split(/\r?\n/).filter(line => line.includes('=')).map(line => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).replace(/^"|"$/g, '')];
  }));
}

function parseOpenClawAuditPage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('audit_invalid');
  const keys = Object.keys(value).sort().join('\0');
  if (keys !== 'events' && keys !== 'events\0nextCursor') throw new Error('audit_invalid');
  if (!Array.isArray(value.events) || value.events.length > 500
    || (value.nextCursor !== undefined && !/^[1-9][0-9]*$/.test(value.nextCursor))) throw new Error('audit_invalid');
  for (const event of value.events) {
    if (!event || typeof event !== 'object' || Array.isArray(event)
      || !Number.isSafeInteger(event.occurredAt) || typeof event.action !== 'string'
      || !['agent_run', 'tool_action'].includes(event.kind)
      || !['started', 'succeeded', 'failed', 'cancelled', 'timed_out', 'blocked', 'unknown'].includes(event.status)
      || event.redaction !== 'metadata_only') throw new Error('audit_invalid');
  }
  return value.events;
}

function fresh(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const time = new Date(value).valueOf();
  return Number.isFinite(time) && Date.now() - time <= 24 * 3_600_000 && time - Date.now() <= 5 * 60_000;
}

module.exports = {
  MAX_EVIDENCE_BYTES, MAX_RAW_BYTES, PRODUCER, PROBES, PROTOCOL_VERSION, TEST_PRODUCER,
  canonical, deriveObservations, fresh, parseOpenClawAuditPage, secureReadFile, sha256, validateRaw, validateSafeValue, within,
};
