# OpenClaw personal assistant acceptance runbook

Installation is complete only when all 32 design criteria have current observed evidence. Unit tests and `--non-live` runs establish safe local contracts; they do not prove credentials, external services, Windows Task Scheduler behavior, a real `age` archive, NTFS ACL/same-handle deletion, physical media, reboot recovery, idle survival, or exact wall-clock Cron behavior.

## Non-live suite

From the repository root:

```bash
bash scripts/wsl/run-acceptance.sh --non-live
```

The runner creates an owner-private `artifacts/acceptance/<UTC>/` directory. `index.json` contains exactly `AC-01` through `AC-32`. Every criterion records a redacted command description, numeric exit code, `PASS|FAIL|NOT_VERIFIED`, SHA-256 for redacted stdout and stderr, an observed artifact path, and a timestamp. Raw command output is removed. A non-live run succeeds only when every executed check passes; live-only rows and known production-integration gaps remain `NOT_VERIFIED`, never `PASS`.

Generated acceptance artifacts are intentionally Git-ignored. Treat them as local audit material and move the final redacted evidence bundle to an owner-controlled location if it must survive checkout cleanup.

## Live evidence rules

All 14 live criteria (`AC-01`, `AC-02`, `AC-03`, `AC-07`, `AC-08`, `AC-12`, `AC-13`, `AC-14`, `AC-15`, `AC-23`, `AC-25`, `AC-26`, `AC-27`, and `AC-32`) are currently unsupported for automated PASS. Installed OpenClaw 2026.7.1 has no authoritative criterion-result or attestation API. Its audit page is metadata-only (`{events,nextCursor?}` with fields such as `action`, `toolName`, and `occurredAt`) and cannot prove command output, message delivery, calendar outcome, reboot recovery, backup integrity, or restoration.

Consequently, the acceptance runner directly records every live row as `NOT_VERIFIED` with exit code 125. It does not invoke a live producer or validator and ignores `LIVE_TEST`, `LIVE_EVIDENCE_DIR`, PATH substitutions, and any evidence files. The standalone `scripts/wsl/run-live-probe.js` writes no evidence and exits 125; `scripts/wsl/validate-live-evidence.js` likewise accepts nothing and exits 125. Automated PASS remains disabled until an approved product command or attestation API provides authoritative criterion-specific results.

The following command demonstrates the fail-closed state; it returns `NOT_VERIFIED` with exit 125 and creates no PASS artifact:

```bash
install -d -m 700 /absolute/private/live-evidence
node scripts/wsl/run-live-probe.js --criterion AC-01 --output-dir /absolute/private/live-evidence
```

```bash
bash scripts/wsl/run-acceptance.sh --all
```

`--all` exits nonzero and records all live rows as `NOT_VERIFIED`. Setting live-related environment variables or supplying evidence cannot change those rows.

## Required target observations

The following observations are still required by the approved design. They are manual checkpoints only and cannot promote an acceptance row to PASS with the current product commands. Capture no tokens or passwords:

- `AC-01`, `AC-12`, and `AC-25`: Ubuntu 24.04, systemd PID 1, lingering, the exact current-user Windows startup task, `wsl.exe -d <distro> --exec /bin/sleep infinity`, restart-after-one-minute settings, Gateway active after reboot and 30 idle minutes without interactive login, and a fresh Telegram response.
- `AC-02` and `AC-26`: a real ChatGPT OAuth Gateway and Telegram model response, injected refresh failure, approval revocation, and confirmed closed behavior after revocation.
- `AC-03`: response to the owner from `@Yangisu_openclaw_bot`.
- `AC-07` and `AC-15`: real CalDAV authentication, calendar listing, and single, all-day, recurring, and alternate-timezone reads; a failed probe must show limited mode rather than PASS.
- `AC-08` and `AC-27`: invalid, expired, and reused OAuth state rejection; token create/refresh/revoke; exactly one confirmed Naver test event; no duplicate retry; revoked-token failure. Delete the one test event yourself in the Naver app after verification.
- `AC-13`, `AC-14`, and `AC-32`: a real `age` encryption and isolated decrypt; all manifest SHA-256 values; Git, Markdown, and SQLite checks; monthly-full restore evidence; canary scans of Git-tracked files, redacted logs, decrypted manifests, and encrypted archives. Do not retain plaintext or a canary.
- `AC-23`: actual observations at Asia/Seoul 08:00 and 22:00, absence at 23:00, `staggerMs: 0`, and no catch-up/replay after sleep.
- `AC-31` is a non-live retention contract: only verified archives older than 30 days are eligible, at least two recovery points remain, and symlink/junction targets are rejected. Separately record protected NTFS ACL, current-user plus Administrators only, production same-open-handle deletion, device identity, and physical-media availability before enabling retention on the target.

The local test evidence covers the remaining safe component contracts, including owner authorization, outbox state transitions, untrusted-content isolation, warning deduplication, Markdown round trips, exact one-byte backup corruption, and retention boundaries. Component tests are diagnostic evidence only when the acceptance criterion also requires production wiring. In particular, a green unit test cannot promote these rows:

- `AC-18` remains `NOT_VERIFIED` until the built plugin's production startup path recovers and reconciles the durable calendar outbox, with an owner warning sink, without duplicate creation or premature success.
- `AC-20` remains `NOT_VERIFIED` until the built plugin runtime connects OAuth refresh and CalDAV failures to the durable calendar-only gate and owner-facing reason while local functions stay available.
- `AC-29` remains `NOT_VERIFIED` until the built plugin's production startup path invokes stale-submission recovery without replay and confirmation consumption is bound to that runtime flow.

`AC-05` remains `NOT_VERIFIED` until every requested local record kind has a real add-and-query path; the current mutation tool adds tasks only. `AC-09` also remains `NOT_VERIFIED`: OpenClaw 2026.7.1 does not attest that an owner command was direct rather than forwarded, so both confirmation entry points remain non-writing and no single-use confirmation can be consumed. Review each artifact rather than relying only on summary counts.

## Final gate

Before tagging a local release, require:

1. `index.json` has exactly 32 records, no FAIL, and no NOT_VERIFIED.
2. Runtime inspection shows exactly five optional tools.
3. `doctor` reports every durable PoC gate open and unexpired.
4. Reboot plus 30-minute idle, exact 08:00/22:00 observations, one Naver create followed by user deletion, real encrypted isolated restore, ACL/same-handle deletion, and device-disaster status are all directly observed.
5. No secret or credential-bearing URL appears in Git, Markdown, logs, command descriptions, evidence, decrypted manifests, or backup material.

There is no automatic live-workspace restore apply. Any real replacement requires a separately approved manual recovery runbook, a verified backup, separate preservation of the current workspace, and an explicit human checkpoint.
