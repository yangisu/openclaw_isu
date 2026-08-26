#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const { lstatSync, readFileSync, realpathSync } = require('node:fs');
const { isAbsolute, resolve } = require('node:path');

try {
  const [triggerPath, declarationKey, expression, message, ownerId] = process.argv.slice(2);
  if (process.argv.length !== 7 || !isAbsolute(triggerPath) || resolve(triggerPath) !== triggerPath
    || !/^[1-9][0-9]{0,18}$/.test(ownerId)) throw new Error('usage');
  const info = lstatSync(triggerPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 256 * 1024
    || realpathSync(triggerPath) !== triggerPath
    || (process.platform !== 'win32' && typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('trigger');
  const installedScript = readFileSync(triggerPath, 'utf8');
  const installedHash = createHash('sha256').update(installedScript).digest('hex');
  const input = readBoundedStdin(1024 * 1024);
  const value = JSON.parse(input);
  const jobs = (value.jobs ?? value).filter(job => job.declarationKey === declarationKey || job.name === 'Personal assistant hourly briefing');
  const job = jobs[0];
  if (jobs.length !== 1 || job.enabled !== true || job.schedule?.expr !== expression
    || job.schedule?.tz !== 'Asia/Seoul' || job.schedule?.staggerMs !== 0 || job.sessionTarget !== 'isolated'
    || job.payload?.message !== message || job.delivery?.mode !== 'announce' || job.delivery?.channel !== 'telegram'
    || String(job.delivery?.to) !== ownerId || typeof job.trigger?.script !== 'string'
    || job.trigger.script !== installedScript
    || createHash('sha256').update(job.trigger.script).digest('hex') !== installedHash) throw new Error('contract');
  process.stdout.write(`${JSON.stringify({ status: 'PASS', triggerSha256: installedHash })}\n`);
} catch {
  process.stderr.write('cron_contract_invalid\n');
  process.exit(1);
}

function readBoundedStdin(cap) {
  const chunks = []; let total = 0; const buffer = Buffer.alloc(16 * 1024);
  for (;;) {
    const count = require('node:fs').readSync(0, buffer, 0, buffer.length, null);
    if (count === 0) break;
    total += count; if (total > cap) throw new Error('stdin_too_large');
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return Buffer.concat(chunks, total).toString('utf8');
}
