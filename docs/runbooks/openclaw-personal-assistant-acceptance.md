# OpenClaw personal assistant acceptance runbook

Installation is complete only when all 32 design criteria have current observed evidence. Unit tests and `--non-live` runs establish safe local contracts; they do not prove credentials, external services, Windows Task Scheduler behavior, a real `age` archive, NTFS ACL/same-handle deletion, physical media, reboot recovery, idle survival, or exact wall-clock Cron behavior.

## Non-live suite

From the repository root:

```bash
bash scripts/wsl/run-acceptance.sh --non-live
```

The runner creates an owner-private `artifacts/acceptance/<UTC>/` directory. `index.json` contains exactly `AC-01` through `AC-32`. Every criterion records a redacted command description, numeric exit code, `PASS|FAIL|NOT_VERIFIED`, SHA-256 for redacted stdout and stderr, an observed artifact path, and a timestamp. Raw command output is removed. A non-live run succeeds only when every safe check passes; all live-only rows remain `NOT_VERIFIED`, never `PASS`.

Generated acceptance artifacts are intentionally Git-ignored. Treat them as local audit material and move the final redacted evidence bundle to an owner-controlled location if it must survive checkout cleanup.

## Live evidence rules

Live work must be performed on the target PC. Never hand-write or edit an `AC-XX.json` envelope. The only authorized producer is `scripts/wsl/run-live-probe.js`, which executes the fixed criterion/phase command described by the versioned probe contract, derives observations from bounded structured raw results, and writes the raw records, stateful ledger, hashes, target identity, and final evidence. The validator independently reopens nothing by path after its bounded no-follow read, verifies stable file identity and privacy, checks the fixed probe ID/digest, and re-derives every observation from the raw records.

Create the evidence directory and optional canary list locally. Canary values and credentials must never be command arguments:

```bash
install -d -m 700 /absolute/private/live-evidence
install -m 600 /dev/stdin /absolute/private/live-canaries
export OCPA_LIVE_CANARY_FILE=/absolute/private/live-canaries
node scripts/wsl/run-live-probe.js --criterion AC-01 --output-dir /absolute/private/live-evidence
```

For multi-stage criteria, run the listed fixed phases in order. The producer records `NOT_VERIFIED` and exits 125 until every phase is present; it emits final PASS evidence only after cross-phase identity/time checks succeed:

- `AC-03`: `owner-request`, then `owner-response`.
- `AC-08`: `before-create`, `after-create`, then `after-user-delete` after the user deletes the one event in Naver.
- `AC-12`: `before-restart`, restart Windows and WSL, then `after-restart`.
- `AC-13`: `backup`, then `isolated-restore`.
- `AC-15`: `caldav-shapes`, then `failure-injection`.
- `AC-23`: `observe-0800`, `observe-2200`, `observe-2300`, then `after-wake`.
- `AC-25`: `before-reboot`, reboot and remain logged out/idle for at least 30 minutes, then `after-reboot-idle`.
- `AC-26`: `gateway-call`, `telegram-call`, `refresh-failure`, then `revocation`.
- `AC-27`: `state-rejection`, `create`, `refresh`, then `revoke`.

Example phase invocation:

```bash
node scripts/wsl/run-live-probe.js --criterion AC-25 --phase before-reboot --output-dir /absolute/private/live-evidence
```

The producer and validator reject unknown fields, secret-bearing keys at any nesting depth, credential-shaped values, canaries, credential URLs, symlinks, non-private files, oversized input, stale evidence, path swaps, wrong IDs/digests, missing phases, and raw/evidence hash mismatches. `--test-adapter` evidence is explicitly test-only and is never accepted by the acceptance runner.

```bash
LIVE_TEST=1 LIVE_EVIDENCE_DIR=/absolute/private/live-evidence \
  bash scripts/wsl/run-acceptance.sh --all
```

`--all` without `LIVE_TEST=1`, without the evidence directory, or with any missing/invalid live evidence exits nonzero and records the affected rows as `NOT_VERIFIED`. It never promotes a skipped check to PASS.

## Required target observations

Capture these live observations without tokens or passwords:

- `AC-01`, `AC-12`, and `AC-25`: Ubuntu 24.04, systemd PID 1, lingering, the exact current-user Windows startup task, `wsl.exe -d <distro> --exec /bin/sleep infinity`, restart-after-one-minute settings, Gateway active after reboot and 30 idle minutes without interactive login, and a fresh Telegram response.
- `AC-02` and `AC-26`: a real ChatGPT OAuth Gateway and Telegram model response, injected refresh failure, approval revocation, and confirmed closed behavior after revocation.
- `AC-03`: response to the owner from `@Yangisu_openclaw_bot`.
- `AC-07` and `AC-15`: real CalDAV authentication, calendar listing, and single, all-day, recurring, and alternate-timezone reads; a failed probe must show limited mode rather than PASS.
- `AC-08` and `AC-27`: invalid, expired, and reused OAuth state rejection; token create/refresh/revoke; exactly one confirmed Naver test event; no duplicate retry; revoked-token failure. Delete the one test event yourself in the Naver app after verification.
- `AC-13`, `AC-14`, and `AC-32`: a real `age` encryption and isolated decrypt; all manifest SHA-256 values; Git, Markdown, and SQLite checks; monthly-full restore evidence; canary scans of Git-tracked files, redacted logs, decrypted manifests, and encrypted archives. Do not retain plaintext or a canary.
- `AC-23`: actual observations at Asia/Seoul 08:00 and 22:00, absence at 23:00, `staggerMs: 0`, and no catch-up/replay after sleep.
- `AC-31` is a non-live retention contract: only verified archives older than 30 days are eligible, at least two recovery points remain, and symlink/junction targets are rejected. Separately record protected NTFS ACL, current-user plus Administrators only, production same-open-handle deletion, device identity, and physical-media availability before enabling retention on the target.

The local test evidence covers the remaining safe criteria, including owner authorization, crash recovery, outbox state transitions, untrusted-content isolation, warning deduplication, Markdown round trips, exact one-byte backup corruption, and retention boundaries. `AC-05` remains `NOT_VERIFIED` until every requested local record kind has a real add-and-query path; the current mutation tool adds tasks only. `AC-09` also remains `NOT_VERIFIED`: update/delete tools are absent, but an executable response path has not yet proven the exact Naver-app guidance. Review each artifact rather than relying only on summary counts.

## Final gate

Before tagging a local release, require:

1. `index.json` has exactly 32 records, no FAIL, and no NOT_VERIFIED.
2. Runtime inspection shows exactly five optional tools.
3. `doctor` reports every durable PoC gate open and unexpired.
4. Reboot plus 30-minute idle, exact 08:00/22:00 observations, one Naver create followed by user deletion, real encrypted isolated restore, ACL/same-handle deletion, and device-disaster status are all directly observed.
5. No secret or credential-bearing URL appears in Git, Markdown, logs, command descriptions, evidence, decrypted manifests, or backup material.

There is no automatic live-workspace restore apply. Any real replacement requires a separately approved manual recovery runbook, a verified backup, separate preservation of the current workspace, and an explicit human checkpoint.
