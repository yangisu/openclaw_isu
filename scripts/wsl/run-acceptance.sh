#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

MODE="${1:---non-live}"
[[ "$MODE" == --non-live || "$MODE" == --all ]] || { printf '%s\n' 'usage: run-acceptance.sh [--non-live|--all]' >&2; exit 64; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
PLUGIN_ROOT="$REPO_ROOT/plugins/openclaw-personal-assistant"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARTIFACT_REL="artifacts/acceptance/$STAMP"
ARTIFACT_DIR="$REPO_ROOT/$ARTIFACT_REL"
if [[ -e "$ARTIFACT_DIR" ]]; then ARTIFACT_REL="$ARTIFACT_REL-$$"; ARTIFACT_DIR="$REPO_ROOT/$ARTIFACT_REL"; fi
node -e 'const fs=require("node:fs");fs.mkdirSync(process.argv[1],{recursive:true,mode:0o700});fs.chmodSync(process.argv[1],0o700)' "$ARTIFACT_DIR"
if [[ "${OS:-}" == Windows_NT ]]; then
  ARTIFACT_WIN="$(cygpath -w "$ARTIFACT_DIR")"
  ACL_SCRIPT_WIN="$(cygpath -w "$REPO_ROOT/scripts/windows/set-private-directory-acl.ps1")"
  pwsh.exe -NoProfile -NonInteractive -File "$ACL_SCRIPT_WIN" -DirectoryPath "$ARTIFACT_WIN"
fi

redact_file() {
  sed -E \
    -e 's#(https?://)[^/@[:space:]]+:[^/@[:space:]]+@#\1[REDACTED]@#g' \
    -e 's/([?&](token|code|secret|key)=)[^&[:space:]]+/\1[REDACTED]/Ig' \
    -e 's/(Bearer[[:space:]]+)[A-Za-z0-9_.-]+/\1[REDACTED]/Ig' \
    -e 's/([A-Za-z0-9_-]{32,})/[REDACTED]/g' "$1" > "$2"
}

write_record() {
  local id="$1" title="$2" command="$3" exit_code="$4" status="$5" stdout_file="$6" stderr_file="$7" observed="$8"
  local out_hash err_hash record="$ARTIFACT_DIR/$id.json"
  out_hash="$(sha256sum "$stdout_file" | awk '{print $1}')"
  err_hash="$(sha256sum "$stderr_file" | awk '{print $1}')"
  node - "$record" "$id" "$title" "$command" "$exit_code" "$status" "$out_hash" "$err_hash" "$observed" <<'NODE'
const fs = require('node:fs');
const [record, criterionId, title, command, exitCode, status, stdoutSha256, stderrSha256, observedArtifactPath] = process.argv.slice(2);
fs.writeFileSync(record, JSON.stringify({
  criterionId, title, command, exitCode: Number(exitCode), status, stdoutSha256, stderrSha256,
  observedArtifactPath, timestamp: new Date().toISOString().replace('.000Z', 'Z'),
}) + '\n', { mode: 0o600 });
NODE
  chmod 600 "$record" "$stdout_file" "$stderr_file"
}

run_safe() {
  local id="$1" title="$2" description="$3"; shift 3
  local raw_out="$ARTIFACT_DIR/$id.stdout.raw" raw_err="$ARTIFACT_DIR/$id.stderr.raw"
  local out="$ARTIFACT_DIR/$id.stdout.redacted" err="$ARTIFACT_DIR/$id.stderr.redacted" code=0 status
  (cd "$PLUGIN_ROOT" && "$@") >"$raw_out" 2>"$raw_err" || code=$?
  redact_file "$raw_out" "$out"; redact_file "$raw_err" "$err"
  rm -f -- "$raw_out" "$raw_err"
  [[ "$code" -eq 0 ]] && status=PASS || status=FAIL
  write_record "$id" "$title" "$description" "$code" "$status" "$out" "$err" "$ARTIFACT_REL/$id.stdout.redacted"
}

run_safe_unverified() {
  local id="$1" title="$2" description="$3" reason="$4"; shift 4
  local raw_out="$ARTIFACT_DIR/$id.stdout.raw" raw_err="$ARTIFACT_DIR/$id.stderr.raw"
  local out="$ARTIFACT_DIR/$id.stdout.redacted" err="$ARTIFACT_DIR/$id.stderr.redacted" code=0 status=NOT_VERIFIED
  (cd "$PLUGIN_ROOT" && "$@") >"$raw_out" 2>"$raw_err" || code=$?
  if [[ "$code" -eq 0 ]]; then printf '\n%s\n' "$reason" >>"$raw_out"; code=125; else status=FAIL; fi
  redact_file "$raw_out" "$out"; redact_file "$raw_err" "$err"
  rm -f -- "$raw_out" "$raw_err"
  write_record "$id" "$title" "$description" "$code" "$status" "$out" "$err" "$ARTIFACT_REL/$id.stdout.redacted"
}

not_verified() {
  local id="$1" title="$2" reason="$3"
  local out="$ARTIFACT_DIR/$id.stdout.redacted" err="$ARTIFACT_DIR/$id.stderr.redacted"
  printf '%s\n' "$reason" >"$out"; : >"$err"
  write_record "$id" "$title" '[live command not run; see acceptance runbook]' 125 NOT_VERIFIED "$out" "$err" "$ARTIFACT_REL/$id.stdout.redacted"
}

run_live_evidence() {
  not_verified "$1" "$2" 'Automated live PASS and evidence acceptance are unsupported pending an authoritative product result or attestation API.'
}

# Target, credential, time-bound, reboot, and physical-media checks are live-only.
run_live_evidence AC-01 'Ubuntu 24.04 WSL2 systemd and OpenClaw Gateway are healthy'
run_live_evidence AC-02 'ChatGPT OAuth produces a real model response'
run_live_evidence AC-03 'The owner receives a response from @Yangisu_openclaw_bot'
run_safe AC-04 'An unauthorized Telegram user ID cannot access the assistant' 'vitest exact Telegram owner allowlist and pre-read rejection' npm test -- tests/config/security.test.ts tests/tools/tools.test.ts -t 'allows only one numeric Telegram owner|repository read and side effect for a non-owner'
run_safe AC-05 'Tasks, notes, preferences, long-term memory, and study plans can be added and queried' 'vitest AC-05 typed local add/query and fail-closed boundaries' npm test -- tests/tools/tools.test.ts tests/workspace/repository.test.ts -t 'routes a typed .* add with a trusted derived source|schema-rejects (inbox add|daily add)|rejects a direct sensitive-memory add|adds and queries a typed .* record'
run_safe AC-06 'Task and study progress can be updated, completed, and archived' 'vitest AC-06 task completion and study progress/archive contract' npm test -- tests/workspace/repository.test.ts -t 'AC-06'
run_live_evidence AC-07 'Events are read only from the app-created Google openclaw_cal calendar'
run_live_evidence AC-08 'One deterministic Google event is created, updated, deleted, and leaves zero residue'
run_safe AC-09 'Calendar create, update, and delete are owner-only, pinned, and ETag conditional' 'vitest Google CRUD owner and ETag boundary' npm test -- tests/tools/google-calendar.test.ts tests/calendar/google-api.test.ts -t 'non-owner|conditional update|updates and deletes'
run_safe AC-10 'A manual hourly briefing separates calendar, task, and study sections' 'vitest briefing section selection and ordering' npm test -- tests/briefing/build.test.ts -t 'selects and orders'
run_safe AC-11 'An empty briefing is not delivered' 'vitest empty briefing suppression' npm test -- tests/briefing/build.test.ts -t 'stays silent'
run_live_evidence AC-12 'Gateway automatically recovers after Windows and WSL restart'
run_live_evidence AC-13 'An age backup is created and restored to an isolated test location'
run_live_evidence AC-14 'Tracked files, logs, and encrypted backup contain no credentials or tokens'
run_live_evidence AC-15 'The Google Calendar PoC reads all required event shapes and closes only calendar functionality on failure'
run_safe AC-16 'Ten concurrent task adds and briefing reads preserve unique IDs, parseable Markdown, and uncommitted changes' 'vitest AC-16 concurrency and preservation contract' npm test -- tests/workspace/repository.test.ts -t 'AC-16'
run_safe AC-17 'Interruption immediately before replacement preserves the original and never promotes a temporary file' 'vitest AC-17 interruption-before-replace contract' npm test -- tests/workspace/repository.test.ts -t 'AC-17'
run_safe_unverified AC-18 'A lost Google mutation response closes unknown without duplicate or premature success' 'vitest mutation-ledger coverage before recording unattested built-runtime behavior' 'NOT VERIFIED: component and built-runtime tests pass, but complete production ambiguous-result recovery has not yet been attested by an acceptance boundary.' npm test -- tests/calendar/google-ledger.test.ts tests/tools/google-calendar.test.ts -t 'durable submitting|deterministic event'
run_safe AC-19 'Invalid event title, range, recurrence, ID, and stale ETag are rejected' 'vitest Google event and ETag validation boundaries' npm test -- tests/calendar/google-api.test.ts tests/tools/google-calendar.test.ts -t 'stale ETags|complete change|recurring instance'
run_safe_unverified AC-20 'Google OAuth refresh and API timeout close calendar only while local functions continue with a reason' 'vitest component failure isolation before recording missing runtime Google gate wiring' 'NOT VERIFIED: component tests pass, but the built plugin runtime does not yet attest Google refresh/API failure isolation and owner-facing reason.' npm test -- tests/tools/tools.test.ts tests/calendar/google-oauth.test.ts tests/calendar/google-api.test.ts -t 'keeps local briefing output|refreshes inside|timeout'
run_safe AC-21 'Unauthorized DMs, groups, config writes, shell, elevated, and plugin commands are denied' 'vitest complete hardened Telegram and command boundary' npm test -- tests/config/security.test.ts
run_safe AC-22 'Instructions in imported calendar or document content cause no side effect or secret read' 'vitest imported instructions remain inert structured data' npm test -- tests/tools/tools.test.ts tests/briefing/build.test.ts -t 'imported instructions'
run_live_evidence AC-23 'The real Cron runs at 08:00 and 22:00, not 23:00, with no wake catch-up replay'
run_safe AC-24 'A Google Calendar failure with no event data sends one synchronization warning' 'vitest durable one-time calendar warning delivery' npm test -- tests/briefing/durable-outbound.test.ts tests/tools/tools.test.ts -t 'warns only once|Google Calendar failure'
run_live_evidence AC-25 'After reboot and 30 idle minutes WSL and Gateway run without login and Telegram responds'
run_live_evidence AC-26 'ChatGPT OAuth works through Gateway and Telegram and closes after refresh failure or revocation'
run_live_evidence AC-27 'Google PKCE OAuth rejects invalid state and proves create, refresh, revoke, and post-revoke failure'
run_safe AC-28 'Minimum, maximum, and optional Markdown fields round-trip with types, unknown fields, LF, and unique IDs' 'vitest complete Markdown codec contract' npm test -- tests/markdown/codec.test.ts
run_safe_unverified AC-29 'Restart preserves terminal mutation replay without duplicate submission' 'vitest Google ledger replay coverage before recording unattested built-runtime behavior' 'NOT VERIFIED: component and built-runtime tests pass, but restart/no-duplicate behavior has not yet been attested by an acceptance boundary.' npm test -- tests/calendar/google-ledger.test.ts tests/tools/google-calendar.test.ts -t 'replays the same claim|replays a completed request'
run_safe AC-30 'Concurrent backup is consistent and one-byte manifest corruption rejects restore without plaintext or secrets' 'vitest AC-30 one-byte corruption, snapshot consistency, and plaintext cleanup' npm test -- tests/ops/backup.test.ts -t 'AC-30|consistent online SQLite backup|quarantines staged plaintext'
run_safe AC-31 'Only backups older than 30 days are deleted while at least two points remain and links are rejected' 'vitest AC-31 age/point retention and link rejection' npm test -- tests/ops/backup.test.ts -t 'AC-31|never deletes link'
run_live_evidence AC-32 'A full isolated restore verifies SHA-256, Git, Markdown, SQLite, and monthly evidence'

INDEX="$ARTIFACT_DIR/index.json"
node - "$ARTIFACT_DIR" "$INDEX" <<'NODE'
const fs=require('node:fs'), path=require('node:path');
const [dir,index]=process.argv.slice(2);
const criteria=fs.readdirSync(dir).filter(x=>/^AC-\d\d\.json$/.test(x)).sort().map(x=>JSON.parse(fs.readFileSync(path.join(dir,x),'utf8')));
if(criteria.length!==32||criteria.some((x,i)=>x.criterionId!==`AC-${String(i+1).padStart(2,'0')}`)) process.exit(70);
fs.writeFileSync(index,JSON.stringify({version:1,criteria},null,2)+'\n',{mode:0o600});
NODE
chmod 600 "$INDEX"

SUMMARY="$(node - "$INDEX" "$ARTIFACT_REL/index.json" <<'NODE'
const fs=require('node:fs'); const [index,indexPath]=process.argv.slice(2); const c=JSON.parse(fs.readFileSync(index,'utf8')).criteria;
const count=s=>c.filter(x=>x.status===s).length;
process.stdout.write(JSON.stringify({total:c.length,pass:count('PASS'),fail:count('FAIL'),notVerified:count('NOT_VERIFIED'),index:indexPath}));
NODE
)"
printf '%s\n' "$SUMMARY"
FAIL_COUNT="$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x.fail))' "$SUMMARY")"
NV_COUNT="$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x.notVerified))' "$SUMMARY")"
[[ "$FAIL_COUNT" -eq 0 ]] || exit 1
if [[ "$MODE" == --all && "$NV_COUNT" -ne 0 ]]; then exit 2; fi
exit 0
