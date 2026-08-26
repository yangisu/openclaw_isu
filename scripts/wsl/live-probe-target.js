#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { PROBES } = require('./live-probe-contract.js');

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--criterion' || args[2] !== '--phase') process.exit(64);
const criterionId = args[1]; const phase = args[3]; const probe = PROBES[criterionId];
if (!probe || !probe.phases.includes(phase)) process.exit(64);

try {
  const system = systemProbe(criterionId, phase);
  if (system) emit(system);
  const records = auditRecords();
  const rule = ACTIONS[`${criterionId}:${phase}`];
  if (!rule) throw new Error('probe_not_implemented');
  const record = records.filter(rule.matches).sort((a, b) => timestamp(b) - timestamp(a))[0];
  if (!record || Date.now() - timestamp(record) > 24 * 3_600_000) throw new Error('probe_record_missing');
  const keys = probe.phaseKeys?.[phase] ?? Object.keys(probe.source);
  const target = Object.fromEntries(keys.map(key => [key, probe.source[key] === 'id' ? identifier(record, key) : probe.source[key]]));
  emit({ probeId: probe.probeId, phase, capturedAt: new Date(timestamp(record)).toISOString(), target });
} catch {
  process.stderr.write('target_probe_not_verified\n');
  process.exit(125);
}

function systemProbe(id, currentPhase) {
  if (id === 'AC-01') {
    const release = Object.fromEntries(readFileSync('/etc/os-release', 'utf8').split(/\r?\n/)
      .filter(line => line.includes('=')).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).replace(/^"|"$/g, '')]; }));
    return { probeId: PROBES[id].probeId, phase: currentPhase, capturedAt: new Date().toISOString(), target: {
      ubuntuVersion: release.VERSION_ID,
      pid1: execFileSync('ps', ['-p', '1', '-o', 'comm='], textOptions()).trim(),
      gatewayState: execFileSync('systemctl', ['--user', 'is-active', 'openclaw-gateway.service'], textOptions()).trim(),
    } };
  }
  if (id === 'AC-12') {
    const windowsBootId = windowsBootIdentity(); const wslBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const target = currentPhase === 'before-restart' ? { windowsBootId, wslBootId } : {
      windowsBootId, wslBootId, windowsRecovery: 'observed', wslRecovery: 'observed',
      gatewayState: execFileSync('systemctl', ['--user', 'is-active', 'openclaw-gateway.service'], textOptions()).trim(),
    };
    return { probeId: PROBES[id].probeId, phase: currentPhase, capturedAt: new Date().toISOString(), target };
  }
  if (id === 'AC-25' && currentPhase === 'before-reboot') {
    return { probeId: PROBES[id].probeId, phase: currentPhase, capturedAt: new Date().toISOString(), target: { windowsBootId: windowsBootIdentity() } };
  }
  return undefined;
}

function auditRecords() {
  const openclaw = join(__dirname, '../../plugins/openclaw-personal-assistant/node_modules/.bin', process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw');
  if (!existsSync(openclaw)) throw new Error('openclaw_missing');
  const value = JSON.parse(execFileSync(openclaw, ['audit', '--json', '--limit', '500'], textOptions()));
  const records = value.records ?? value.items ?? value.data;
  if (!Array.isArray(records) || records.length > 500) throw new Error('audit_invalid');
  return records;
}

function action(operation, status = 'succeeded') {
  return { matches: record => record?.kind === 'tool_action' && record?.status === status
    && record?.metadata?.operation === operation && record?.metadata?.liveProbe === true };
}

const ACTIONS = {
  'AC-02:model-call': action('openai_model_response'),
  'AC-03:owner-request': action('telegram_owner_request'), 'AC-03:owner-response': action('telegram_owner_response'),
  'AC-07:caldav-read': action('caldav_existing_event_read'),
  'AC-08:before-create': action('naver_create_confirmed'), 'AC-08:after-create': action('naver_create_observed'), 'AC-08:after-user-delete': action('naver_user_delete_observed'),
  'AC-13:backup': action('age_backup_verified'), 'AC-13:isolated-restore': action('isolated_restore_verified'),
  'AC-14:canary-scan': action('credential_canary_scan_clean'),
  'AC-15:caldav-shapes': action('caldav_event_shapes_observed'), 'AC-15:failure-injection': action('caldav_failure_limited_mode'),
  'AC-23:observe-0800': action('cron_0800_observed'), 'AC-23:observe-2200': action('cron_2200_observed'),
  'AC-23:observe-2300': action('cron_2300_absence_observed'), 'AC-23:after-wake': action('cron_no_catchup_observed'),
  'AC-25:after-reboot-idle': action('reboot_idle_telegram_observed'),
  'AC-26:gateway-call': action('oauth_gateway_call'), 'AC-26:telegram-call': action('oauth_telegram_call'),
  'AC-26:refresh-failure': action('oauth_refresh_failure_closed', 'failed'), 'AC-26:revocation': action('oauth_revocation_closed', 'failed'),
  'AC-27:state-rejection': action('naver_state_rejections'), 'AC-27:create': action('naver_create_response'),
  'AC-27:refresh': action('naver_refresh_response'), 'AC-27:revoke': action('naver_revoke_response'),
  'AC-32:monthly-restore': action('monthly_full_restore_verified'),
};

function identifier(record, key) {
  const value = record?.metadata?.[key] ?? record?.[key] ?? record?.id ?? record?.sequence;
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('id_missing');
  const result = String(value);
  if (!/^[A-Za-z0-9._:-]{6,128}$/.test(result)) throw new Error('id_invalid');
  return result;
}
function timestamp(record) { const value = new Date(record?.timestamp ?? record?.createdAt ?? record?.startedAt).valueOf(); return Number.isFinite(value) ? value : 0; }
function windowsBootIdentity() {
  const value = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString("o")'], textOptions()).trim();
  return require('node:crypto').createHash('sha256').update(value).digest('hex');
}
function textOptions() {
  return { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:TOKEN|SECRET|PASSWORD|AUTHORIZATION|COOKIE)/i.test(key))) };
}
function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); process.exit(0); }
