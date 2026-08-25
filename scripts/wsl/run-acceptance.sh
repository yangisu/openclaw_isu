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

not_verified() {
  local id="$1" title="$2" reason="$3"
  local out="$ARTIFACT_DIR/$id.stdout.redacted" err="$ARTIFACT_DIR/$id.stderr.redacted"
  printf '%s\n' "$reason" >"$out"; : >"$err"
  write_record "$id" "$title" '[live command redacted; see acceptance runbook]' 0 NOT_VERIFIED "$out" "$err" "$ARTIFACT_REL/$id.stdout.redacted"
}

run_live_evidence() {
  local id="$1" title="$2" evidence_dir="${ACCEPTANCE_EVIDENCE_DIR:-}" evidence raw_out raw_err out err code=0 status=NOT_VERIFIED
  if [[ "$MODE" != --all || "${LIVE_TEST:-0}" != 1 || -z "$evidence_dir" ]]; then
    not_verified "$id" "$title" 'LIVE_TEST=1 and ACCEPTANCE_EVIDENCE_DIR with explicit target evidence are required.'
    return
  fi
  evidence="$evidence_dir/$id.json"
  raw_out="$ARTIFACT_DIR/$id.stdout.raw"; raw_err="$ARTIFACT_DIR/$id.stderr.raw"
  out="$ARTIFACT_DIR/$id.stdout.redacted"; err="$ARTIFACT_DIR/$id.stderr.redacted"
  : >"$raw_out"; : >"$raw_err"
  if [[ -f "$evidence" ]] && node -e '
    const fs=require("node:fs"); const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    if(x.criterionId!==process.argv[2]||x.status!=="PASS"||!x.observedArtifactPath||!x.timestamp) process.exit(1)
  ' "$evidence" "$id" >"$raw_out" 2>"$raw_err"; then
    status=PASS
    printf '%s\n' "validated explicit evidence for $id" >"$raw_out"
  else
    code=2
    printf '%s\n' "explicit evidence missing or invalid for $id" >"$raw_out"
  fi
  redact_file "$raw_out" "$out"; redact_file "$raw_err" "$err"; rm -f -- "$raw_out" "$raw_err"
  write_record "$id" "$title" '[live target evidence validation; command and credentials redacted]' "$code" "$status" "$out" "$err" "$ARTIFACT_REL/$id.stdout.redacted"
}

# Target, credential, time-bound, reboot, and physical-media checks are live-only.
run_live_evidence AC-01 'Ubuntu systemd and Gateway active'
run_live_evidence AC-02 'ChatGPT OAuth model response'
run_live_evidence AC-03 'Owner Telegram response'
run_safe AC-04 'Unauthorized Telegram user denied' 'vitest security boundary (no credentials)' npm test -- tests/config/security.test.ts
run_safe AC-05 'All local record kinds add and query' 'vitest tool and workspace behavior' npm test -- tests/tools/tools.test.ts
run_safe AC-06 'Task and study mutation/archive' 'vitest repository mutation behavior' npm test -- tests/workspace/repository.test.ts -t 'updates, queries, and archives a record'
run_live_evidence AC-07 'Real CalDAV calendar read'
run_live_evidence AC-08 'Exactly one confirmed Naver create'
run_safe AC-09 'Calendar update/delete boundary' 'vitest tool boundary behavior' npm test -- tests/tools/tools.test.ts -t 'no generic command or delete surface'
run_safe AC-10 'Manual briefing sections' 'vitest briefing construction' npm test -- tests/briefing/build.test.ts -t 'selects and orders'
run_safe AC-11 'Empty briefing suppressed' 'vitest briefing construction' npm test -- tests/briefing/build.test.ts -t 'stays silent'
run_live_evidence AC-12 'Windows and WSL restart recovery'
run_live_evidence AC-13 'Real age backup and isolated restore'
run_live_evidence AC-14 'Target files logs and encrypted archive secret scan'
run_live_evidence AC-15 'Real CalDAV event-shape PoC and limited mode'
run_safe AC-16 'Ten concurrent adds and reads' 'vitest workspace concurrency' npm test -- tests/workspace/repository.test.ts -t 'allocates ten unique IDs'
run_safe AC-17 'Crash before replacement preserves original' 'vitest workspace crash injection' npm test -- tests/workspace/repository.test.ts -t 'recovers a dead child process lock'
run_safe AC-18 'Lost create response reconciles without duplicate' 'vitest outbox uncertain-send recovery' npm test -- tests/calendar/outbox.test.ts -t 'maps a server response|succeeds only for one exact'
run_safe AC-19 'Invalid and expired calendar confirmations rejected' 'vitest calendar validation and confirmation' npm test -- tests/calendar/ical.test.ts tests/calendar/outbox.test.ts -t 'rejects invalid event values|expires confirmation|changed payload hash'
run_safe AC-20 'OAuth and CalDAV failure isolation' 'vitest injected calendar failures' npm test -- tests/calendar/oauth.test.ts tests/calendar/caldav.test.ts tests/state/health.test.ts -t 'refresh|timeout|active failure'
run_safe AC-21 'DM group config shell and elevated denied' 'vitest hardened security configuration' npm test -- tests/config/security.test.ts
run_safe AC-22 'Untrusted content cannot cause side effects' 'vitest trust boundary' npm test -- tests/tools/tools.test.ts -t 'returns imported instructions'
run_live_evidence AC-23 'Exact 08:00 and 22:00 target Cron observation'
run_safe AC-24 'CalDAV failure warning sent once' 'vitest durable briefing warning behavior' npm test -- tests/briefing/durable-outbound.test.ts
run_live_evidence AC-25 'Reboot and 30-minute idle recovery'
run_live_evidence AC-26 'ChatGPT renewal failure and revocation'
run_live_evidence AC-27 'Real Naver OAuth lifecycle and create'
run_safe AC-28 'Markdown field bounds round trip' 'vitest Markdown codec contract' npm test -- tests/markdown/codec.test.ts
run_safe AC-29 'Gateway crash outbox recovery and single-use confirmation' 'vitest outbox recovery state machine' npm test -- tests/calendar/outbox.test.ts -t 'stale submitting|consumes one confirmation'
run_safe AC-30 'Consistent backup and corrupt-manifest rejection' 'vitest backup snapshot and restore corruption' npm test -- tests/ops/backup.test.ts tests/ops/restore.test.ts -t 'consistent online SQLite backup|post-encryption verification failure|wrong key'
run_live_evidence AC-31 'Target ACL retention and same-handle deletion'
run_live_evidence AC-32 'Real age full isolated restore and monthly evidence'

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
