#!/usr/bin/env node
'use strict';

// Owner-authored files, hashes, identities, adapters, and environment flags are
// not authoritative product attestations. Until OpenClaw exposes such an API,
// no live evidence can be promoted to PASS by this validator.
const LIVE_CRITERIA = new Set([
  'AC-01', 'AC-02', 'AC-03', 'AC-07', 'AC-08', 'AC-12', 'AC-13',
  'AC-14', 'AC-15', 'AC-23', 'AC-25', 'AC-26', 'AC-27', 'AC-32',
]);

const criterionId = process.argv[3];
if (!criterionId || !LIVE_CRITERIA.has(criterionId)) {
  process.stderr.write('live_evidence_usage\n');
  process.exit(64);
}
process.stdout.write(`${JSON.stringify({
  status: 'NOT_VERIFIED', criterionId, reason: 'authoritative_attestation_unavailable',
})}\n`);
process.exit(125);
