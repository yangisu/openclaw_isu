#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const { lstatSync, readFileSync, readSync, realpathSync } = require('node:fs');
const { isAbsolute, posix, resolve } = require('node:path');

try {
  const [dailyTrigger, monthlyTrigger, nodeBin, cliPath, pluginRoot, configPath] = process.argv.slice(2);
  if (process.argv.length !== 8 || [dailyTrigger, monthlyTrigger]
    .some(path => !isAbsolute(path) || resolve(path) !== path)
    || [nodeBin, cliPath, pluginRoot, configPath].some(path => !contractAbsolute(path))) throw new Error('usage');
  const triggers = { daily: safeScript(dailyTrigger), monthly: safeScript(monthlyTrigger) };
  const parsed = JSON.parse(readBoundedStdin(1024 * 1024));
  const all = parsed.jobs ?? parsed;
  if (!Array.isArray(all)) throw new Error('jobs');
  const expected = {
    daily: { expression: '0 3 * * *', trigger: triggers.daily },
    monthly: { expression: '0 4 1 * *', trigger: triggers.monthly },
  };
  for (const kind of ['daily', 'monthly']) {
    const key = `openclaw-personal-assistant-${kind}-maintenance`;
    const name = `Personal assistant ${kind} maintenance`;
    const matches = all.filter(job => job.declarationKey === key || job.name === name);
    const job = matches[0];
    const payload = job?.payload;
    const expectedArgv = [nodeBin, cliPath, 'maintenance', kind, '--config', configPath];
    const payloadKeys = ['argv', 'cwd', 'kind', 'noOutputTimeoutSeconds', 'outputMaxBytes', 'timeoutSeconds'];
    if (matches.length !== 1 || job.declarationKey !== key || job.name !== name || job.enabled !== true
      || job.schedule?.expr !== expected[kind].expression || job.schedule?.tz !== 'Asia/Seoul'
      || job.schedule?.staggerMs !== 0 || job.sessionTarget !== 'isolated'
      || payload?.kind !== 'command' || JSON.stringify(payload.argv) !== JSON.stringify(expectedArgv)
      || payload.cwd !== pluginRoot || payload.timeoutSeconds !== 1800
      || payload.noOutputTimeoutSeconds !== 600 || payload.outputMaxBytes !== 65536
      || Object.keys(payload).sort().join('\0') !== payloadKeys.join('\0')
      || job.delivery?.mode !== 'none' || Object.keys(job.delivery).join('\0') !== 'mode'
      || job.trigger?.script !== expected[kind].trigger.script
      || createHash('sha256').update(job.trigger.script).digest('hex') !== expected[kind].trigger.sha256) {
      throw new Error('contract');
    }
  }
  process.stdout.write(`${JSON.stringify({ status: 'PASS', jobs: 2 })}\n`);
} catch {
  process.stderr.write('maintenance_cron_contract_invalid\n');
  process.exit(1);
}

function safeScript(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 256 * 1024
    || realpathSync(path) !== path
    || (process.platform !== 'win32' && typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('trigger');
  }
  const script = readFileSync(path, 'utf8');
  return { script, sha256: createHash('sha256').update(script).digest('hex') };
}

function contractAbsolute(path) {
  return typeof path === 'string' && ((isAbsolute(path) && resolve(path) === path)
    || (path.startsWith('/') && posix.isAbsolute(path) && posix.normalize(path) === path));
}

function readBoundedStdin(cap) {
  const chunks = []; let total = 0; const buffer = Buffer.alloc(16 * 1024);
  for (;;) {
    const count = readSync(0, buffer, 0, buffer.length, null);
    if (count === 0) break;
    total += count; if (total > cap) throw new Error('stdin_too_large');
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return Buffer.concat(chunks, total).toString('utf8');
}
