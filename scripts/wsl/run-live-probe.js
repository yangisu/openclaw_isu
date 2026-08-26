#!/usr/bin/env node
'use strict';

// No installed OpenClaw 2026.7.1 command or project API emits an authoritative
// acceptance attestation for these live-only criteria. Fail closed before
// reading PATH, adapters, operator evidence, or creating an artifact directory.
const LIVE_CRITERIA = new Set([
  'AC-01', 'AC-02', 'AC-03', 'AC-07', 'AC-08', 'AC-12', 'AC-13',
  'AC-14', 'AC-15', 'AC-23', 'AC-25', 'AC-26', 'AC-27', 'AC-32',
]);

const criterionId = optionValue(process.argv.slice(2), '--criterion');
if (!criterionId || !LIVE_CRITERIA.has(criterionId)) {
  process.stderr.write('probe_usage\n');
  process.exit(64);
}
process.stdout.write(`${JSON.stringify({
  status: 'NOT_VERIFIED', criterionId, reason: 'authoritative_probe_unavailable',
})}\n`);
process.exit(125);

function optionValue(args, name) {
  const at = args.indexOf(name);
  return at >= 0 && at + 1 < args.length && !args[at + 1].startsWith('--') ? args[at + 1] : undefined;
}
