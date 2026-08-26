#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } = require('node:fs');
const { isAbsolute, join, relative, resolve } = require('node:path');

const PROTOCOL_VERSION = 2;
const PRODUCER = 'openclaw-personal-assistant-live-probe/v2';
const TEST_PRODUCER = 'openclaw-personal-assistant-live-probe-test-adapter/v2';
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MAX_RAW_BYTES = 1024 * 1024;

const requirements = {
  'AC-01': { phases: ['single'], probeId: 'ocpa-live-ac01-v2', source: { ubuntuVersion: '24.04', pid1: 'systemd', gatewayState: 'active' }, observations: { ubuntuVersion: '24.04', systemdPid1: true, gatewayActive: true } },
  'AC-02': { phases: ['model-call'], probeId: 'ocpa-live-ac02-v2', source: { provider: 'openai', modelResult: 'response_observed' }, observations: { provider: 'openai', modelResponseObserved: true } },
  'AC-03': { phases: ['owner-request', 'owner-response'], phaseKeys: { 'owner-request': ['ownerRequest', 'messageId'], 'owner-response': ['ownerResponse', 'messageId'] }, probeId: 'ocpa-live-ac03-v2', source: { ownerRequest: 'received', ownerResponse: 'observed', messageId: 'id' }, observations: { ownerMessageReceived: true, ownerResponseObserved: true } },
  'AC-07': { phases: ['caldav-read'], probeId: 'ocpa-live-ac07-v2', source: { authentication: 'accepted', existingEvent: 'read', eventId: 'id' }, observations: { caldavAuthenticated: true, existingEventRead: true } },
  'AC-08': { phases: ['before-create', 'after-create', 'after-user-delete'], phaseKeys: { 'before-create': ['confirmation', 'eventId'], 'after-create': ['createdCount', 'duplicateCount', 'eventId'], 'after-user-delete': ['userDeletion', 'eventId'] }, probeId: 'ocpa-live-ac08-v2', source: { confirmation: 'observed', createdCount: 1, duplicateCount: 0, userDeletion: 'observed', eventId: 'id' }, observations: { confirmationObserved: true, createdCount: 1, duplicateCount: 0, deletedByUser: true } },
  'AC-12': { phases: ['before-restart', 'after-restart'], phaseKeys: { 'before-restart': ['windowsBootId', 'wslBootId'], 'after-restart': ['windowsBootId', 'wslBootId', 'windowsRecovery', 'wslRecovery', 'gatewayState'] }, probeId: 'ocpa-live-ac12-v2', source: { windowsBootId: 'id', wslBootId: 'id', windowsRecovery: 'observed', wslRecovery: 'observed', gatewayState: 'active' }, observations: { windowsRestartRecovered: true, wslRestartRecovered: true, gatewayActive: true } },
  'AC-13': { phases: ['backup', 'isolated-restore'], phaseKeys: { backup: ['archiveFormat', 'archiveId'], 'isolated-restore': ['restoreMode', 'manifestResult', 'archiveId'] }, probeId: 'ocpa-live-ac13-v2', source: { archiveFormat: 'age', restoreMode: 'isolated', manifestResult: 'verified', archiveId: 'id' }, observations: { ageEncrypted: true, isolatedRestore: true, manifestVerified: true } },
  'AC-14': { phases: ['canary-scan'], probeId: 'ocpa-live-ac14-v2', source: { trackedScan: 'clean', logScan: 'clean', archiveScan: 'clean' }, observations: { trackedFilesClean: true, logsClean: true, encryptedArchiveClean: true } },
  'AC-15': { phases: ['caldav-shapes', 'failure-injection'], phaseKeys: { 'caldav-shapes': ['authentication', 'calendars', 'singleEvent', 'allDayEvent', 'recurringEvent', 'crossTimezoneEvent'], 'failure-injection': ['failureMode'] }, probeId: 'ocpa-live-ac15-v2', source: { authentication: 'accepted', calendars: 'listed', singleEvent: 'read', allDayEvent: 'read', recurringEvent: 'read', crossTimezoneEvent: 'read', failureMode: 'calendar_limited' }, observations: { authenticated: true, listedCalendars: true, singleEventRead: true, allDayRead: true, recurringRead: true, crossTimezoneRead: true, limitedModeOnFailure: true } },
  'AC-23': { phases: ['observe-0800', 'observe-2200', 'observe-2300', 'after-wake'], phaseKeys: { 'observe-0800': ['run0800', 'messageId'], 'observe-2200': ['run2200', 'messageId'], 'observe-2300': ['run2300'], 'after-wake': ['catchUpReplay'] }, probeId: 'ocpa-live-ac23-v2', source: { run0800: 'observed', run2200: 'observed', run2300: 'not_observed', catchUpReplay: 'not_observed', messageId: 'id' }, observations: { observed0800: true, observed2200: true, observed2300: false, catchUpReplayObserved: false } },
  'AC-25': { phases: ['before-reboot', 'after-reboot-idle'], phaseKeys: { 'before-reboot': ['windowsBootId'], 'after-reboot-idle': ['windowsBootId', 'idleMinutes', 'interactiveLogin', 'wslState', 'gatewayState', 'telegramResponse', 'messageId'] }, probeId: 'ocpa-live-ac25-v2', source: { windowsBootId: 'id', idleMinutes: 30, interactiveLogin: 'not_observed', wslState: 'active', gatewayState: 'active', telegramResponse: 'observed', messageId: 'id' }, observations: { windowsRebooted: true, idleMinutes: 30, noInteractiveLogin: true, wslActive: true, gatewayActive: true, telegramResponseObserved: true } },
  'AC-26': { phases: ['gateway-call', 'telegram-call', 'refresh-failure', 'revocation'], phaseKeys: { 'gateway-call': ['gatewayCall'], 'telegram-call': ['telegramCall', 'messageId'], 'refresh-failure': ['refreshFailure'], revocation: ['revocation'] }, probeId: 'ocpa-live-ac26-v2', source: { gatewayCall: 'observed', telegramCall: 'observed', refreshFailure: 'closed', revocation: 'closed', messageId: 'id' }, observations: { gatewayModelCall: true, telegramModelCall: true, refreshFailureClosed: true, revocationClosed: true } },
  'AC-27': { phases: ['state-rejection', 'create', 'refresh', 'revoke'], phaseKeys: { 'state-rejection': ['invalidState', 'expiredState', 'reusedState'], create: ['create', 'eventId'], refresh: ['refresh'], revoke: ['revoke', 'postRevoke'] }, probeId: 'ocpa-live-ac27-v2', source: { invalidState: 'rejected', expiredState: 'rejected', reusedState: 'rejected', create: 'observed', refresh: 'observed', revoke: 'observed', postRevoke: 'failed', eventId: 'id' }, observations: { invalidStateRejected: true, expiredStateRejected: true, reusedStateRejected: true, eventCreated: true, tokenRefreshed: true, tokenRevoked: true, postRevocationFailed: true } },
  'AC-32': { phases: ['monthly-restore'], probeId: 'ocpa-live-ac32-v2', source: { sha256: 'verified', git: 'verified', markdown: 'verified', sqlite: 'verified', fullRestore: 'verified', monthlyRecord: 'recorded', archiveId: 'id' }, observations: { sha256Verified: true, gitVerified: true, markdownVerified: true, sqliteVerified: true, fullRestoreVerified: true, monthlyEvidenceRecorded: true } },
};

const targetImplementationSha256 = sha256(readFileSync(join(__dirname, 'live-probe-target.js')));

const PROBES = Object.fromEntries(Object.entries(requirements).map(([criterionId, value]) => {
  const command = { executable: 'node', argv: ['scripts/wsl/live-probe-target.js', '--criterion', criterionId, '--phase', '<phase>'] };
  const base = { criterionId, probeId: value.probeId, phases: value.phases, phaseKeys: value.phaseKeys ?? null,
    command, targetImplementationSha256, source: value.source, observations: value.observations };
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

const forbiddenKey = /^(?:token|access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|apikey|authorization|password|telegram[_-]?token|bearer|basic|oauth[_-]?(?:code|state|verifier)|code|state|verifier|cookie|credential|private[_-]?key)$/i;
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
      || /^(?:token|accesstoken|refreshtoken|clientsecret|apikey|authorization|password|telegramtoken|bearer|basic|oauthcode|oauthstate|oauthverifier|code|state|verifier|cookie|credentials?|privatekey)$/.test(normalizedKey)) throw new Error('secret_key');
    validateSafeValue(value[key], canaries, state, depth + 1);
  }
}

function validateRaw(criterionId, phase, raw, canaries = []) {
  const probe = PROBES[criterionId];
  if (!probe || !probe.phases.includes(phase)) throw new Error('probe_invalid');
  validateSafeValue(raw, canaries);
  const keys = ['capturedAt', 'phase', 'probeId', 'target'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join('\0') !== keys.join('\0')
    || raw.probeId !== probe.probeId || raw.phase !== phase || !fresh(raw.capturedAt)
    || !raw.target || typeof raw.target !== 'object' || Array.isArray(raw.target)) throw new Error('raw_invalid');
  const expectedKeys = [...(probe.phaseKeys?.[phase] ?? Object.keys(probe.source))].sort();
  if (Object.keys(raw.target).sort().join('\0') !== expectedKeys.join('\0')) throw new Error('raw_schema_invalid');
  for (const key of expectedKeys) {
    const expected = probe.source[key];
    const actual = raw.target[key];
    if (expected === 'id') {
      if (typeof actual !== 'string' || !/^[A-Za-z0-9._:-]{6,128}$/.test(actual)) throw new Error('identifier_invalid');
    } else if (key === 'idleMinutes') {
      if (!Number.isInteger(actual) || actual < expected || actual > 1440) throw new Error('idle_invalid');
    } else if (actual !== expected) throw new Error('observation_invalid');
  }
  return raw;
}

function deriveObservations(criterionId, rawByPhase) {
  const probe = PROBES[criterionId];
  if (!probe || Object.keys(rawByPhase).sort().join('\0') !== [...probe.phases].sort().join('\0')) throw new Error('phases_incomplete');
  for (const phase of probe.phases) validateRaw(criterionId, phase, rawByPhase[phase]);
  if (criterionId === 'AC-08') {
    const ids = probe.phases.map(phase => rawByPhase[phase].target.eventId);
    if (new Set(ids).size !== 1) throw new Error('event_identity_mismatch');
  }
  if (criterionId === 'AC-12') {
    const before = rawByPhase['before-restart'].target; const after = rawByPhase['after-restart'].target;
    if (before.windowsBootId === after.windowsBootId || before.wslBootId === after.wslBootId) throw new Error('restart_not_observed');
  }
  if (criterionId === 'AC-23') {
    assertSeoulHour(rawByPhase['observe-0800'].capturedAt, 8);
    assertSeoulHour(rawByPhase['observe-2200'].capturedAt, 22);
    assertSeoulHour(rawByPhase['observe-2300'].capturedAt, 23);
  }
  if (criterionId === 'AC-25') {
    const before = rawByPhase['before-reboot']; const after = rawByPhase['after-reboot-idle'];
    if (before.target.windowsBootId === after.target.windowsBootId
      || new Date(after.capturedAt).valueOf() - new Date(before.capturedAt).valueOf() < 30 * 60_000) throw new Error('reboot_idle_not_observed');
  }
  const observations = { ...probe.observations };
  if (criterionId === 'AC-25') observations.idleMinutes = rawByPhase['after-reboot-idle'].target.idleMinutes;
  return observations;
}

function assertSeoulHour(value, expected) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  if (Number(parts.hour) !== expected || Number(parts.minute) !== 0) throw new Error('cron_time_invalid');
}

function fresh(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const time = new Date(value).valueOf();
  return Number.isFinite(time) && Date.now() - time <= 24 * 3_600_000 && time - Date.now() <= 5 * 60_000;
}

module.exports = {
  MAX_EVIDENCE_BYTES, MAX_RAW_BYTES, PRODUCER, PROBES, PROTOCOL_VERSION, TEST_PRODUCER,
  canonical, deriveObservations, fresh, secureReadFile, sha256, validateRaw, validateSafeValue, within,
};
