#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const { PROBES } = require('./live-probe-contract.js');

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--criterion' || args[2] !== '--phase') process.exit(64);
const criterionId = args[1]; const phase = args[3]; const probe = PROBES[criterionId];
if (!probe || !probe.supported || !probe.phases.includes(phase)) notVerified();

try {
  const commandResults = criterionId === 'AC-01' ? systemHealth() : criterionId === 'AC-12' ? restartHealth() : undefined;
  if (!commandResults) notVerified();
  process.stdout.write(`${JSON.stringify({
    probeId: probe.probeId, phase, capturedAt: new Date().toISOString(), adapter: probe.adapter, commandResults,
  })}\n`);
} catch { notVerified(); }

function systemHealth() {
  return [
    capture('os-release', 'cat', ['/etc/os-release']),
    capture('pid1', 'ps', ['-p', '1', '-o', 'comm=']),
    capture('gateway-active', 'systemctl', ['--user', 'is-active', 'openclaw-gateway.service']),
  ];
}

function restartHealth() {
  return [
    capture('windows-boot-id', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString("o")']),
    capture('wsl-boot-id', 'cat', ['/proc/sys/kernel/random/boot_id']),
    capture('gateway-active', 'systemctl', ['--user', 'is-active', 'openclaw-gateway.service']),
  ];
}

function capture(commandId, executable, argv) {
  const result = spawnSync(executable, argv, {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:TOKEN|SECRET|PASSWORD|AUTHORIZATION|COOKIE)/i.test(key))),
  });
  if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== 'string' || result.stdout.length < 1) notVerified();
  return { commandId, exitCode: result.status, stdoutLines: result.stdout.replace(/\r/g, '').replace(/\n$/, '').split('\n') };
}

function notVerified() {
  process.stderr.write('target_probe_not_verified\n');
  process.exit(125);
}
