#!/usr/bin/env node
'use strict';

const { posix, win32 } = require('node:path');

try {
  const [expected, home] = process.argv.slice(2);
  if (process.argv.length !== 4 || !absolute(expected) || !absolute(home)) throw new Error('usage');
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { text += chunk; if (text.length > 64 * 1024) process.exit(1); });
  process.stdin.on('end', () => {
    try {
      const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      if (lines.length < 1) throw new Error('empty');
      const reported = lines.at(-1);
      const expanded = reported.startsWith('~/') || reported.startsWith('~\\')
        ? join(home, reported.slice(2), windows(expected)) : reported;
      if (!absolute(expanded) || normalize(expanded, windows(expected)) !== normalize(expected, windows(expected))) throw new Error('mismatch');
      process.stdout.write(`${expected}\n`);
    } catch { fail(); }
  });
} catch {
  fail();
}

function windows(value) { return /^[A-Za-z]:[\\/]/.test(value); }
function absolute(value) { return typeof value === 'string' && (windows(value) || value.startsWith('/')); }
function normalize(value, isWindows) { return (isWindows ? win32 : posix).normalize(value); }
function join(root, child, isWindows) { return (isWindows ? win32 : posix).join(root, child); }
function fail() { process.stderr.write('active_config_path_mismatch\n'); process.exit(1); }
