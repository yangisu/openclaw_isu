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

Live work must be performed manually on the target PC with `LIVE_TEST=1`. Do not put credentials or credential-bearing URLs in command arguments or evidence. Each live check needs an explicit file named `AC-XX.json` in a private evidence directory with:

```json
{
  "criterionId": "AC-01",
  "status": "PASS",
  "observedArtifactPath": "/absolute/private/path/to/redacted-observation",
  "timestamp": "2026-08-26T00:00:00Z"
}
```

The observed artifact must contain enough redacted facts to independently establish the criterion: command identity, exit code, target identity, relevant state, and time. A narrative claim or an empty file is not evidence. The runner validates the explicit envelope; the operator remains responsible for inspecting the referenced artifact.

```bash
LIVE_TEST=1 ACCEPTANCE_EVIDENCE_DIR=/absolute/private/live-evidence \
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
- `AC-31`: protected NTFS ACL, current-user plus Administrators only, reparse rejection, and production same-open-handle file identity deletion. Also record whether the backup target and WSL virtual disk share a physical device and whether separate physical media exists.

The local test evidence covers the remaining safe criteria, including owner authorization, all five data/tool behaviors, crash recovery, outbox state transitions, untrusted-content isolation, warning deduplication, Markdown round trips, and injected backup corruption. Review each `PASS` artifact rather than relying only on the summary counts.

## Final gate

Before tagging a local release, require:

1. `index.json` has exactly 32 records, no FAIL, and no NOT_VERIFIED.
2. Runtime inspection shows exactly five optional tools.
3. `doctor` reports every durable PoC gate open and unexpired.
4. Reboot plus 30-minute idle, exact 08:00/22:00 observations, one Naver create followed by user deletion, real encrypted isolated restore, ACL/same-handle deletion, and device-disaster status are all directly observed.
5. No secret or credential-bearing URL appears in Git, Markdown, logs, command descriptions, evidence, decrypted manifests, or backup material.

There is no automatic live-workspace restore apply. Any real replacement requires a separately approved manual recovery runbook, a verified backup, separate preservation of the current workspace, and an explicit human checkpoint.
