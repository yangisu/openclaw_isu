# Task 10 implementation report

Date: 2026-08-26 (Asia/Seoul)

## Outcome

Implemented the package CLI, safe Windows/WSL installation automation, exact 32-criterion acceptance runner, and executable install/acceptance/rollback runbooks. No live OpenClaw state, credentials, services, scheduled tasks, firewall, Naver, Telegram, or other external services were mutated.

The built ESM CLI now provides deterministic JSON and exit codes for `init`, PoC gates, `doctor`, `backup`, `backup reconcile`, and isolated `restore`. Backup and restore delegate to the real Task 9 APIs. `publication_unknown` is a distinct non-success result and requires explicit reconciliation. Restore has no live apply path.

## TDD evidence

Initial RED command:

```text
npm test -- tests/cli.test.ts tests/scripts.test.ts
```

Initial result: 2 suites failed with 5 failures because the CLI and all three requested script entry points did not exist.

Additional focused RED cases were added and observed for expired doctor evidence, explicit loopback configuration, exact-hour/no-catch-up scheduling, indirect symlink ancestry, protected Windows ACLs, complete `--all` indexing when live evidence is absent, interactive scheduled-task credentials, Windows CLI path handling, and repeatable private-directory initialization.

Final focused ACL/idempotency GREEN:

```text
npm test -- tests/cli.test.ts -t "initializes only private"
```

Result: 1 passed, 6 skipped, 3.42 seconds.

## Final verification

```text
npm run typecheck; npm run build; npm test
```

Result after review fixes: exit 0; typecheck passed; build passed; 21/21 test files and 376/376 tests passed in 544.61 seconds.

```text
node_modules/.bin/openclaw.cmd plugins validate --entry ./dist/index.js
```

Result: exit 0, `Plugin openclaw-personal-assistant is valid.` This used the package-local OpenClaw 2026.7.1 installation.

```text
git diff --check
```

Result: exit 0 (only the checkout's expected LF-to-CRLF notices).

A repository scan for OpenAI-style keys, Telegram bot tokens, and long bearer credentials returned no matches outside excluded dependency/build/acceptance output directories.

Earlier isolated package-local runtime inspection linked the built plugin into a temporary `OPENCLAW_STATE_DIR` and inspected it through OpenClaw 2026.7.1. The runtime exposed exactly five optional tools: `assistant_query`, `assistant_mutate`, `assistant_calendar_prepare`, `assistant_calendar_confirm`, and `assistant_briefing`. The temporary state was removed and the portable non-secret fixture was restored.

## Acceptance result

The latest safe acceptance evidence contained exactly 32 stable IDs (`AC-01` through `AC-32`):

- PASS: 16 non-live criteria
- FAIL: 0
- NOT_VERIFIED: 16 criteria (14 live-only criteria and 2 honestly unverified product gaps)

All live-only items remain honestly NOT VERIFIED. These include real OpenAI/Telegram/CalDAV/Naver behavior, exact 08:00/22:00 observations, reboot and 30-minute idle recovery, real age archive/restore, target ACL/same-handle deletion, and physical-media/durability checks as applicable. AC-05 and AC-09 also remain NOT_VERIFIED because the current product does not implement every mutation kind or executable-response boundary those criteria require. `--all` without `LIVE_TEST=1` and complete explicit evidence exits nonzero and still writes a complete 32-row index. Generated `artifacts/acceptance/*` directories were deleted after verification and remain ignored.

## Security and operational notes

- `init` requires an absolute in-scope path, rejects symlink/reparse ancestry, uses owner-private permissions/ACLs, creates only directories and non-secret templates, and does not overwrite existing data.
- PoCs use the stable `{status, observedChecks, redactedErrorCode, timestamp}` envelope and redact credential-bearing URLs and token-like values.
- `doctor` is read-only and nonzero for closed, unknown, missing, or expired gates.
- Windows scheduled-task installation uses `SupportsShouldProcess`, exact distro enumeration, the current interactive user, a startup trigger, password logon (run whether logged on or not), one-minute restart, and the exact `wsl.exe -d <distro> --exec /bin/sleep infinity` action. It does not alter networking.
- WSL installation uses strict mode, validates Ubuntu 24.04/Node/systemd/lingering/OpenClaw 2026.7.1, pauses before secrets/OAuth, and validates the exact guarded briefing Cron definition. The trigger prevents startup catch-up outside the exact Asia/Seoul hour.
- Live replacement after restore is deliberately deferred to an approved manual runbook; no unsafe apply command was invented.

## Concerns / deferred evidence

There are no known non-live test failures. The 14 live acceptance criteria require an authorized operator on the target machine with `LIVE_TEST=1` and explicit evidence. Windows Git emits benign LF-to-CRLF warnings from disposable backup test repositories; these are not failures and did not modify the real workspace.

## Review fix round 1

All Critical, Important, and Minor review findings were addressed without touching live state:

- PoC evidence now accepts only the exact four-field schema, constructs a fresh sanitized envelope, rejects extra/nested fields and unsafe checks, and enforces valid, non-future, fresh timestamps. Regression tests prove credential-like extras are neither persisted nor printed.
- Live acceptance promotion now validates criterion-specific evidence under an explicit absolute private `LIVE_EVIDENCE_DIR`: exact ID/status/generator, freshness, exit 0, ordinary non-link private files, canonical containment, required observations, artifact existence and privacy, and current SHA-256. Invalid, fabricated, stale, wrong-ID, missing, permission-bad, and secret-bearing evidence remains NOT_VERIFIED with exit 125.
- CLI backup and reconciliation now require `stateDir`, use the real `SubsystemHealthStore`, close resources reliably, preserve archive-bound `publication_unknown`, and clear only the exactly reconciled archive.
- AC-16, AC-17, AC-30, and AC-31 now execute the exact concurrency/preservation, interruption-before-replace, one-byte mismatch, and retention/link clauses. Every acceptance label was reconciled to the approved design; unsupported AC-05 and AC-09 clauses are honestly NOT_VERIFIED.
- Installer check mode is read-only but validates the installed build freshness, source type-check, package-local plugin validation/runtime, hardened active config, exact five optional tools, service/systemd/linger state, and exact single no-catch-up Cron row. The Node range is exactly `>=24.15.0 <25.0.0`.
- Initialization enforces and verifies privacy on the root and every existing child. Secret validation requires direct canonical regular files under the secret root, current ownership, stable identity, no symlink, and exact mode 0600.
- The restore runbook creates the isolated restore root with mode 0700 before use.

Review-fix TDD RED evidence included eight initial CLI/privacy/health failures, a future-timestamp doctor failure, a missing live-evidence validator, and a retention test showing a 29-day recovery point was deleted. Each was observed before its implementation fix. Focused suites then passed, including 17 CLI tests, 15 script tests, the strengthened backup tests, and the AC-16/17 repository cases.

Fresh final commands and results:

```text
npm run typecheck; npm run build; npm test
```

Exit 0; 21 files and 376 tests passed in 544.61 seconds.

```text
C:\Program Files\Git\bin\bash.exe scripts/wsl/run-acceptance.sh --non-live
```

Exit 0; exactly 32 rows: 16 PASS, 0 FAIL, 16 NOT_VERIFIED. Every NOT_VERIFIED row used documented non-success code 125. All 14 live items were NOT_VERIFIED.

Package-local `openclaw plugins validate --entry dist/index.js` exited 0. A fresh isolated runtime inspection through OpenClaw 2026.7.1 loaded exactly five optional tools: `assistant_query`, `assistant_mutate`, `assistant_calendar_prepare`, `assistant_calendar_confirm`, and `assistant_briefing`. The isolated runtime directory and all generated acceptance artifacts were removed after verification. A production/docs credential-shape scan found zero files; deliberate hostile token fixtures remain confined to tests.

## Review fix round 2

Local fix commit: `2b0d244` (`fix: authenticate live acceptance probes`). It was intentionally not pushed; branch-wide review and publication remain with the root agent.

The remaining authenticity, secret-handling, TOCTOU, installer, CLI, and corrupted-restore findings were addressed with a second separate change set.

- Live evidence is no longer operator-authored. `run-live-probe.js` executes only a fixed criterion/phase target, validates structured raw output before persistence, records a private phase ledger, and emits PASS only after all required phases and cross-phase identity/time rules succeed. The probe digest binds the criterion schema, expected derived observations, fixed argv, and SHA-256 of the target implementation. OpenClaw audit-derived records require fixed criterion-specific operation/status metadata; system/reboot probes derive service and boot identities directly.
- The validator securely reads the evidence, ledger, and every raw record with pre-allocation size caps, no-follow open where supported, fstat owner/type/mode/identity checks, bounded reads, re-fstat, current-path identity verification, canonical containment, nesting/count/string/total-byte caps, and no reopen for parsing or hashing. It independently verifies the producer/protocol/probe digest and re-derives observations from exact per-phase raw schemas.
- Recursive secret rejection covers short and nested secret-bearing keys, Basic/Bearer, Telegram tokens, JWTs, private-key PEM, provider keys, credential URLs/query parameters, and an optional private operator canary file. The generator rejects before persistence and the validator repeats the same checks.
- Manual reboot/idle, exact-hour Cron, Naver deletion, OAuth lifecycle, and monthly restore checks use fixed stateful phase ledgers. An incomplete ledger exits 125 and remains NOT_VERIFIED.
- Finish/check installation validates the config as a direct canonical stable current-owner mode-0600 file. The hardened template is validated read-only before patching, and the active config is validated again before Gateway installation/start. Cron validation requires exactly one enabled job and byte-for-byte trigger script identity with its current SHA-256; a disabled job or malicious substring wrapper fails.
- `init` preserves every managed file while enforcing/verifying mode 0600 or protected current-user/Administrators ACLs. Backup/reconcile validates every option and direct stable path before creating/opening `SubsystemHealthStore`; malformed or symlinked state cannot create SQLite state.
- AC-30 now invokes corrupted `restoreBackup` directly and proves the isolated restore root is empty, no new temporary restore directory remains, and its plaintext canary is absent.

TDD RED observations included: permissive existing managed files remained inherited, malformed reconcile created its state directory before rejecting the archive, the live probe/secure-read modules were absent, multi-stage raw validation incorrectly demanded future-phase fields, Cron accepted no exact external validator, and unsafe config validation was absent. Each focused failure was observed before its corresponding implementation.

Fresh round-2 verification:

```text
npm run typecheck; npm run build; npm test
```

Exit 0; typecheck and build passed; 21/21 test files and 387/387 tests passed in 351.46 seconds. Focused script tests passed 19/19, CLI tests passed 20/20, and the direct AC-30 restore-cleanup test passed.

```text
C:\Program Files\Git\bin\bash.exe scripts/wsl/run-acceptance.sh --non-live
```

Exit 0; exactly 32 unique rows (`AC-01` through `AC-32`): 16 PASS, 0 FAIL, 16 NOT_VERIFIED. Every NOT_VERIFIED row used code 125 and all 14 live criteria remained NOT_VERIFIED.

Package-local OpenClaw 2026.7.1 plugin validation exited 0. A fresh isolated runtime inspection found exactly five tools and all were optional: `assistant_briefing`, `assistant_calendar_confirm`, `assistant_calendar_prepare`, `assistant_mutate`, and `assistant_query`. A production/docs scan for credential shapes and the two test canaries found zero files. Generated acceptance evidence and isolated runtime state were removed. No live OpenClaw state, credentials, services, scheduled tasks, firewall, Naver, Telegram, or external service was touched.

AC-05 and AC-09 remain honest non-live product gaps and therefore NOT_VERIFIED. Live probe evidence is deliberately absent until an authorized target run executes every required fixed phase.

## Review fix round 3

Local fix commit: `855ee5e` (`fix: bind live probes to authoritative output`). It was intentionally not pushed; branch-wide review and publication remain with the root agent.

The live evidence contract was reconciled against the installed OpenClaw 2026.7.1 implementation rather than the earlier assumed audit shape. The package-local `openclaw audit --help`, `docs/cli/audit.md`, `dist/audit-event-store-2NJ7FlT1.js`, and `dist/audit-CqE8An_t.js` show that JSON pages are exactly `{events,nextCursor?}` and expose metadata-only `action`, `toolName`, `occurredAt`, lifecycle status, and provenance. They do not contain tool arguments, results, command output, messages, calendar outcomes, canary scan results, or backup/restore verification. The former `records|items|data`, `metadata.operation`, and `metadata.liveProbe` assumptions and all expected-result synthesis were removed.

Automated PASS evidence is now supported only where fixed commands provide authoritative raw output: `AC-01` records `/etc/os-release`, PID 1, and the user Gateway service output; `AC-12` records before/after Windows and WSL boot identities and the Gateway service output. Raw stdout is retained as bounded `stdoutLines`, and all observations are re-parsed from those lines. The other twelve live criteria exit 125 before adapter execution and cannot create PASS evidence, even if an operator supplies a matching audit event, JSON, text, or environment assertion. The runbook now states this limited support and the future product-command requirement explicitly.

Recursive secret-key normalization now also rejects `secret`, `secretValue`, and `passwordHash` under arbitrary case and separator variants, including nested values. Cron validation requires the selected row's exact declaration key in addition to its exact enabled schedule, delivery, and trigger bytes. Installer `--check` invokes the same full hardened-config validator as finish after direct owner/mode/stability validation, covering Telegram enablement, exact CalDAV/Naver secret-file paths, and placeholders.

During final isolated runtime inspection, the installed CLI exposed tools as `tools[].names`, not the older assumed `tools[].name`. A focused RED proved the installer would reject the real runtime response. A bounded `validate-runtime-tools.js` now consumes the actual OpenClaw response and requires exactly the five optional tool names.

Round-3 TDD RED evidence consisted of 16 focused failures for the obsolete live raw shape, missing audit parser, secret normalization gaps, unsupported criteria returning 1, wrong Cron declaration keys being accepted, and missing check-mode hardening. After the initial fixes, eight remaining failures exposed newline-bearing raw stdout; the contract was corrected to structured `stdoutLines`. A separate runtime-shape RED then caught the `names` array mismatch. All corresponding focused tests passed after implementation.

Fresh final verification after all round-3 changes:

```text
npm run typecheck; npm run build; npm test
```

Exit 0; typecheck and build passed; 21/21 test files and 397/397 tests passed in 321.72 seconds.

```text
C:\Program Files\Git\bin\bash.exe scripts/wsl/run-acceptance.sh --non-live
```

Exit 0; exactly 32 unique rows (`AC-01` through `AC-32`): 16 PASS, 0 FAIL, 16 NOT_VERIFIED. Every NOT_VERIFIED row used exit code 125 and all 14 live rows remained NOT_VERIFIED.

Package-local plugin validation passed. A fresh isolated OpenClaw runtime inspection loaded exactly five optional tools: `assistant_briefing`, `assistant_calendar_confirm`, `assistant_calendar_prepare`, `assistant_mutate`, and `assistant_query`. No live OpenClaw state or external service was used. Generated acceptance and isolated runtime artifacts were removed before commit.

## Review fix round 4

The round-3 live support claim was withdrawn. Installed OpenClaw 2026.7.1 exposes no authoritative acceptance-result or attestation API. Its audit API remains metadata-only and cannot prove command output or criterion outcomes; direct OS/service output is also owner-controlled rather than an authoritative product attestation. Therefore all 14 live IDs, including `AC-01` and `AC-12`, are now automated-unsupported. Both production `run-live-probe.js` and `validate-live-evidence.js` return `NOT_VERIFIED` with exit 125 before executing PATH commands, adapters, or reading operator evidence. They create and promote no PASS artifact. The old live target, test-adapter producer path, raw-result derivation, ledger/hash promotion, and audit-to-PASS code were removed. A forged production AC-01 fixture containing matching-looking identity and SHA-256 fields, test flags, and a hostile PATH remains exit 125 and invokes nothing.

The installer now pins `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` to the same explicit active file (`$OPENCLAW_HOME/openclaw.json`) for config commands and Gateway installation. This follows installed source behavior: `paths-BMBAvkNf.js` resolves the override directly, `config-cli-ClpzD-HN.js` implements `openclaw config file` from the active snapshot, and `runtime-paths-C6MOwQ_j.js` copies `env.OPENCLAW_CONFIG_PATH` into the Gateway service environment. Check mode resolves that actual path using the package-local `openclaw config file`, rejects path drift, verifies a direct canonical stable current-owner mode-0600 file, and runs the full hardened validator on the active file. Finish separately validates the patch source, applies it to the pinned active file, then repeats active path/privacy/full-hardening checks before Gateway installation or start. Cross-platform path-contract tests cover absolute POSIX, `~`, and Windows paths; hardened tests cover disabled Telegram, wrong CalDAV/Naver paths, and placeholders. Static contract tests cover missing/link/owner/mode/identity drift and read-only check ordering.

TDD RED was observed before implementation: the new AC-01 unsupported and forged-fixture tests failed because the validator returned 1 and the producer still exposed its adapter path; three active-config tests failed because check mode validated the patch source and the active-path validator did not exist. Focused GREEN then passed 25 relevant tests, followed by the complete verification below.

```text
npm run typecheck; npm run build; npm test
```

Exit 0; typecheck and build passed; 21/21 test files and 408/408 tests passed in the final fresh 316.88-second run.

```text
C:\Program Files\Git\bin\bash.exe scripts/wsl/run-acceptance.sh --non-live
```

Exit 0; exactly 32 unique ordered rows (`AC-01` through `AC-32`): 16 PASS, 0 FAIL, 16 NOT_VERIFIED. Every NOT_VERIFIED row used exit code 125, and all 14 live rows were NOT_VERIFIED. The generated index was inspected and then removed.

Package-local OpenClaw 2026.7.1 plugin validation exited 0. A fresh isolated runtime inspection passed the bounded runtime validator and exposed exactly five optional tools: `assistant_briefing`, `assistant_calendar_confirm`, `assistant_calendar_prepare`, `assistant_mutate`, and `assistant_query`. Bash/Node syntax checks, installer dry-run, `git diff --check`, and a production/docs credential-shape plus canary scan passed. The isolated runtime directory and all acceptance artifacts were removed. No real OpenClaw state, config, credential, service, scheduled task, firewall, Naver, Telegram, or external service was touched.
