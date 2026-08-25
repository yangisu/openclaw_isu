# Task 9 implementation report

Status: DONE

Fix round 1: DONE

Fix round 2: DONE

Fix round 3: DONE

Fix round 4: DONE

Fix round 5: DONE

Fix round 6: DONE

## Summary

- Added a public repository `quiesce()` operation that holds the existing single-writer lock across the full allowlisted snapshot.
- Added hash/integrity-verified manifests with Git HEAD, exact SQLite user/schema evidence, timestamps, exclusion version, path, size, and SHA-256.
- Added online SQLite backups for operations, calendar outbox, alerts, and subsystem health, with journal normalization and integrity checks.
- Added immutable Task 6 outbox evidence verification before plaintext cleanup and after archive decrypt/verification.
- Added bounded shell-free `age` execution, private exact-target cleanup, stable timeout/abort errors, atomic archive publication, and fake-runner injection for credential-free tests.
- Added strict workspace/Git allowlists, pre-staging canary and Git-history checks, link/nonregular/path traversal/TOCTOU defenses, and encrypted-only final output.
- Added fresh-directory archive verification, Git/Markdown/SQLite/outbox validation, isolated atomic restore, and safe verified retention with a minimum of two archives.
- Added Task 8 health integration: stable `backup_failed` reporting to target `backup`, real briefing-source coverage, and `recover('backup')` only after verified success.
- Added serial Vitest file execution because Windows Git/SQLite integration tests otherwise starve the repository's intentional 10-second production lock deadline.
- Hardened every configured source, allowlisted subtree, and SQLite input with lstat/realpath/reparse/identity checks.
- Replaced the raw Git directory with a minimal reachable `git bundle`, verified by exact HEAD, `git fsck`, history scanning, and credential/dangling-object exclusion tests.
- Replaced the whole-JSON archive with a streaming, length-prefixed, bounded container that rejects oversized headers/files/totals, truncation, trailing bytes, duplicate paths, and traversal.
- Enforced an exact manifest contract and canonical production schema fingerprints for all four databases.
- Added an injectable NTFS ACL verifier, owner-private plaintext staging, failure quarantine with safe next-success cleanup, file/directory durability barriers, and isolated scheduled-restore evidence records.
- Added a fail-closed bounded PowerShell reparse classifier for production D:/WSL-mounted NTFS paths and applied the path-safety seam through retention and restore boundaries, including immediately before unlink.
- Replaced name-based ACL checks with strict SID evidence: current identity must own the protected ACL and only explicit current-user and builtin Administrators ALLOW entries are accepted; SYSTEM and every other principal are deliberately rejected.
- Streamed stable source copying, hashing, and secret scanning in bounded chunks with overlap, rejecting oversized sources before allocation and detecting signatures split across chunk boundaries.
- Validated dated `archive/*.md` files as real daily records and added nonempty archive restore coverage.
- Made scheduled verification evidence substantive: daily mode records an actual parsed record/path/hash, monthly mode records full-tree counts/bytes/hash, both clean their isolated restore, and failures are recorded atomically with fsync.
- Added an uncommitted publication marker, observable Windows directory-sync fallback, safe rollback/quarantine naming, and a distinct operator-action error when rollback itself is impossible.
- Corrected archived Markdown routing: dated archive files are daily records, the six named archive documents retain their root kinds, and unknown/nested archive names fail closed.
- Centralized archive eligibility so verify, restore, scheduled restore, and retention all reject uncommitted-marker archives before decryption or health recovery.
- Added looping `writeAll` semantics for every file-handle write, independent destination hashes after fsync/close, and injected short-write/destination-corruption regressions.
- Kept publication markers logically active through marker unlink and the second directory fsync; unsupported or failed durability rolls back, while stuck finals remain marker-ineligible with high-signal errors.
- Retention now renames only the verified inode to a non-archive tombstone, rechecks identity/reparse/markers, unlinks only the tombstone, fsyncs the directory, safely recovers interrupted tombstones, and quarantines swap mismatches.
- Scheduled verification returns `restoreRetained: false` without a deleted path, atomically compacts evidence before 8 MiB, and cleans exact temporary evidence files on every failure.
- Replaced marker absence as positive eligibility with a strict owner-private `.committed` record that binds version, archive name, size, SHA-256, manifest identity, and manifest hash. Publication fsyncs the encrypted archive, commit record, and each atomic directory transition before health recovery; every recovery consumer revalidates the durable evidence and copied bytes.
- Retention now moves the archive and its commit record into a fresh protected deletion namespace and delegates deletion to an identity-bound interface. The production D:/WSL NTFS implementation uses a fixed no-shell PowerShell/.NET helper that opens with exclusive sharing, compares volume/file identity on the opened handle, rejects reparse points, and sets delete disposition on that same handle. Unsupported filesystems fail closed without pathname unlink fallback.
- Made failed-publication rollback marker-monotonic: the `.uncommitted` marker and containing directory are durable before any final archive appears, rollback/finally never removes it, rollback durability failures surface as `archive_rollback_failed`, and only the fully durable success path may remove it. Recovered archive+commit pairs remain ineligible while the marker exists.
- Replaced the negative-marker rollback protocol with a one-way positive commit point. Commit-record rename is the irreversible attempt and the final namespace mutation; ambiguity from rename/directory durability returns typed `publication_unknown` with `outcome: 'unknown'`, reports stable `BACKUP_PUBLICATION_UNKNOWN`, and leaves archive, commit evidence, and audit marker untouched.
- Added per-backup-root publication/reconciliation coordination. A valid hash/manifest-bound commit record overrides stale audit-marker residue only after full decrypt/layout/SQLite/outbox verification and a fresh directory durability barrier; torn evidence preserves UNKNOWN health, and retention remains disabled until explicit verification reconciles and recovers health.

## Files

- `plugins/openclaw-personal-assistant/src/workspace/repository.ts`
- `plugins/openclaw-personal-assistant/src/ops/backup.ts`
- `plugins/openclaw-personal-assistant/src/ops/manifest.ts`
- `plugins/openclaw-personal-assistant/src/ops/process.ts`
- `plugins/openclaw-personal-assistant/tests/ops/backup.test.ts`
- `plugins/openclaw-personal-assistant/tests/ops/restore.test.ts`
- `plugins/openclaw-personal-assistant/vitest.config.ts`
- `plugins/openclaw-personal-assistant/src/calendar/outbox.ts`
- `plugins/openclaw-personal-assistant/src/state/alerts.ts`
- `plugins/openclaw-personal-assistant/src/state/health.ts`
- `plugins/openclaw-personal-assistant/src/state/operations.ts`

## TDD evidence

RED 1:

- Command: `npm test -- tests/ops/backup.test.ts tests/ops/restore.test.ts`
- Result: exit 1; both suites failed at import because `../../src/ops/backup.js` did not exist.

RED 2:

- Command: `npm test -- tests/ops/restore.test.ts -t "timed-out child"`
- Result: exit 1; expected stable `process_timeout`, received `process_failed`.

GREEN:

- Command: `npm test -- tests/ops/backup.test.ts tests/ops/restore.test.ts`
- Result: exit 0; 2 files passed, 8 tests passed.

Fix-round RED:

- Root/database reparse test initially resolved through the indirect path instead of rejecting it.
- Exact-manifest test initially accepted unknown keys, reordering, and a missing required database.
- Git sanitization test initially found the credential-bearing raw `.git/config` and dangling object in the snapshot.
- Streaming-format tests initially failed while the fake decryptor still expected the former JSON/base64 archive.
- Durability tests exposed Windows `EPERM` behavior for read-only handles and directory sync; production now uses writable file handles and only the documented Windows directory-sync fallback.

Fix-round GREEN:

- `npm test -- tests/ops/backup.test.ts tests/ops/restore.test.ts` — exit 0; 2 files passed, 18 tests passed.

Fix-round-2 RED:

- Production default reparse classification only recognized symlinks and retention did not recheck the injected classifier before unlink.
- ACL verification compared account-name strings and did not prove the current SID, owner SID, protected ACL, or exact principal set.
- Source copying and canary scans allocated entire files, and `archive/*.md` was not decoded as daily Markdown.
- Daily scheduled verification accepted an empty full-tree restore without sampling a record; failed sampling was not recorded or cleaned.
- A post-rename directory-sync failure could leave an apparently eligible final archive if rollback failed.
- The first full fix-round-2 run passed 313/314 tests; the sole failure was the expanded quarantine integration exceeding its former 5-second test timeout. It was assigned a 30-second integration timeout and then passed in the full rerun.

Fix-round-2 GREEN:

- `npm test -- tests/ops/backup.test.ts tests/ops/restore.test.ts` — exit 0; 2 files passed, 26 tests passed.
- `npm test` — exit 0; 19 files passed, 314 tests passed.
- `npm run typecheck` — exit 0.
- `npm run build` — exit 0.
- `npm run plugin:validate` — exit 0; plugin valid.
- `git diff --check` — exit 0 (only Windows LF/CRLF conversion warnings).

Fix-round-3 RED:

- `archive/TASKS.md` was decoded as daily solely because it lived under `archive/`.
- Extraction and streaming-source writes did not share guaranteed complete-write behavior, and streamed destinations lacked an independent post-close comparison.
- A final archive could briefly lose its marker before the second directory sync, and external verify/restore paths did not centrally reject marker-bearing archives.
- Retention unlinked the original verified pathname instead of an atomically renamed verified-inode tombstone.
- Scheduled verification returned a path it had deleted and evidence growth/temp cleanup were not bounded.

Fix-round-3 GREEN:

- `npm test -- tests/ops/backup.test.ts tests/ops/restore.test.ts` — exit 0; 2 files passed, 34 tests passed.
- `npm test` — exit 0; 19 files passed, 323 tests passed.
- `npm run typecheck` — exit 0.
- `npm run build` — exit 0.
- `npm run plugin:validate` — exit 0; plugin valid.
- `git diff --check` — exit 0 (only Windows LF/CRLF conversion warnings).

Fix-round-4 RED:

- `npm test -- --run tests/ops/backup.test.ts -t "durable hash-bound|positive commit record|syncs the encrypted"` — exit 1; 3 expected failures showed that no `.committed` evidence existed, only two files/two directory transitions were synced, and a commit-durability crash was not represented.
- `npm test -- --run tests/ops/backup.test.ts -t "deletes only verified oldest|identity-bound retention deletion"` — exit 1; 2 expected failures showed retention never called the injected identity-bound deleter and did not fail closed when it was unavailable.
- `npm test -- --run tests/ops/backup.test.ts -t "strictly parses production NTFS"` — exit 1; the production NTFS identity evidence parser was absent.
- `npm test -- --run tests/ops/backup.test.ts -t "reconciles success"` — exit 1; post-commit health failure retried recovery instead of returning once from durable evidence.

Fix-round-4 GREEN:

- `npm test -- --run tests/ops/backup.test.ts` — exit 0; 1 file passed, 34 tests passed.
- `npm test` — exit 0; 19 files passed, 331 tests passed.
- `npm run typecheck` — exit 0.
- `npm run build` — exit 0.
- `npm run plugin:validate` — exit 0; plugin valid.
- `git diff --check` — exit 0 (only Windows LF/CRLF conversion warnings).

Fix-round-5 RED:

- `npm test -- --run tests/ops/backup.test.ts -t "every commit-record publication|rollback directory sync|post-rename directory-sync"` — exit 1; 3 expected failures showed rollback deleted `.uncommitted`, swallowed rollback directory-sync failure, and returned the lower-signal publication error.
- `npm test -- --run tests/ops/backup.test.ts -t "syncs the encrypted file"` — exit 1; only three directory barriers were observed because the marker directory entry was not synced before final archive publication.
- `npm test -- --run tests/ops/backup.test.ts -t "every commit-record publication"` — exit 1 after adding marker-recreation failure coverage; received raw `EIO` instead of `archive_rollback_failed` and rollback was skipped.

Fix-round-5 GREEN:

- `npm test -- --run tests/ops/backup.test.ts` — exit 0; 1 file passed, 36 tests passed.
- `npm test` — exit 0; 19 files passed, 333 tests passed.
- `npm run typecheck` — exit 0.
- `npm run build` — exit 0.
- `npm run plugin:validate` — exit 0; plugin valid.
- `git diff --check` — exit 0 (only Windows LF/CRLF conversion warnings).

Fix-round-6 RED:

- `npm test -- --run tests/ops/backup.test.ts -t "returns publication_unknown|blocks concurrent verification through"` — exit 1; commit-directory ambiguity rolled back as `archive_rollback_failed`, while concurrent verification observed the intermediate marker and rejected instead of waiting.
- `npm test -- --run tests/ops/backup.test.ts -t "prevents retention until"` — exit 1; retention accepted an archive while `BACKUP_PUBLICATION_UNKNOWN` was active.
- `npm test -- --run tests/ops/backup.test.ts -t "keeps torn commit"` — exit 1; invalid commit evidence downgraded UNKNOWN health to `backup_failed`.

Fix-round-6 GREEN:

- `npm test -- --run tests/ops/backup.test.ts` — exit 0; 1 file passed, 38 tests passed.
- `npm test` — exit 0; 19 files passed, 335 tests passed.
- `npm run typecheck` — exit 0.
- `npm run build` — exit 0.
- `npm run plugin:validate` — exit 0; plugin valid.
- `git diff --check` — exit 0 (only Windows LF/CRLF conversion warnings).

Fix-round-7 RED:

- `npm test -- --run tests/ops/backup.test.ts -t "deletes only verified oldest|prevents retention until|tracks and reconciles two|serializes two same-date"` — exit 1; all 4 new integration cases exposed missing whole-operation create serialization, retention's stale-audit-sidecar handling, and generic UNKNOWN health identity/recovery.
- The first full backup-suite run after implementation passed 38/41 tests. The remaining regressions showed torn commit evidence creating a second generic UNKNOWN target, archive-specific reconciliation adding a second expected recovery call, and a durability integration exceeding its obsolete 5-second timeout now that the complete publication phase executes.

Fix-round-7 GREEN:

- The publication coordinator now covers the complete create lifecycle from deterministic pathname claims through staging, encryption, verification, durable commit, cleanup, and result. Concurrent same-date creation performs one encryption/publication and deterministically rejects the other with `archive_exists`; verification remains coordinated with publication.
- UNKNOWN health is bound to the canonical archive path plus committed archive/manifest hashes. Verification recovers only that exact publication target and generic backup health; unrelated UNKNOWN publications remain active and gate retention.
- Retention treats archive, hash-bound `.committed`, optional audit `.uncommitted`, and a fsynced transaction journal as one coordinated deletion set. Every artifact is moved into the protected namespace and identity-bound deleted; partial sidecar moves remain quarantined with no deletion fallback.
- `npm test -- --run tests/ops/backup.test.ts -t "deletes only verified oldest|quarantines a partially moved|serializes two same-date|prevents retention until|tracks and reconciles two"` — exit 0; 5 tests passed, 36 skipped.
- `npm test` — exit 0; 19 files passed, 338 tests passed.
- `npm run typecheck` — exit 0.
- `npm run build` — exit 0.
- `npm run plugin:validate` — exit 0; plugin valid.
- `git diff --check` — exit 0 (only Windows LF/CRLF conversion warnings).

Fix-round-8 RED:

- `npm test -- --run tests/ops/backup.test.ts -t "derives publication identity"` — exit 1 as expected because the portable publication-identity helper did not exist and production still hashed the host-specific resolved pathname.
- The first focused integration run after introducing the helper exposed an overly strict assumption that `manifestId` was a SHA-256 rather than the existing bounded created-at/Git-HEAD identifier; UNKNOWN creation and retention correctly failed closed until the canonical contract was corrected.

Fix-round-8 GREEN:

- Publication UNKNOWN identity now hashes only protocol version, normalized archive basename, archive size/SHA-256, and manifest id/SHA-256. It contains no drive, mount point, separator, cwd, casing, inode, or process-local value.
- A direct regression proves equivalent Windows and WSL path spellings produce the same target and can recover the same real health-journal entry, while different dates or archive hashes remain independent. Existing older-archive reconciliation coverage continues proving it cannot clear a different UNKNOWN publication.
- The positive retention integration now creates three independent real backups on distinct dates, including their actual committed and audit sidecars, and proves `keep=2` deletes the oldest set while retaining the newest two.
- `npm test -- --run tests/ops/backup.test.ts -t "derives publication identity|deletes only verified oldest|prevents retention until"` — exit 0; 3 tests passed, 39 skipped.
- `npm test` — exit 0; 19 files passed, 339 tests passed.
- `npm run typecheck` — exit 0.
- `npm run build` — exit 0.
- `npm run plugin:validate` — exit 0; plugin valid.
- `git diff --check` — exit 0 (only Windows LF/CRLF conversion warnings).

## Final verification

- `npm test` — exit 0; 19 files passed, 339 tests passed.
- `npm run typecheck` — exit 0.
- `npm run build` — exit 0.
- `npm run plugin:validate` — exit 0; plugin valid.
- `git diff --check` — exit 0 (Git emitted only existing Windows LF/CRLF conversion warnings).

## Commit

- `e9744f0b10432cb81df6812658e8050a2f38f0fd` (`feat: add encrypted verified backups`)
- `772075edc12f33e44bb8c4e4511459442f2e6451` (`fix: harden verified backup boundaries`)
- `7c68ec6351f62174773e2effb7ee5c491bf98822` (`fix: close backup recovery edge cases`)
- `ea90ad638a77c5c421c5b354cf6e09b45a01321c` (`fix: finalize backup publication safety`)
- `412c2f9ac408d55bc49b25e6f80cd4ef40f8b8e2` (`fix: bind backup publication and retention identity`)
- `140bc799b36ab86c8ac6c2cc8348e8b098d9c9ee` (`fix: retain failed backup publication markers`)
- `9565c6d14308f253c35ab78da590325bb5d89d7b` (`fix: reconcile unknown backup publications`)
- Fix-round-7 commit: this report's commit (`fix: serialize backup publication integration`); exact hash is supplied in the handoff because a commit cannot contain its own final hash.
- Fix-round-8 commit: this report's commit (`fix: make backup publication identity portable`); exact hash is supplied in the handoff because a commit cannot contain its own final hash.

## Concerns and live NOT VERIFIED items

- Real `age` encryption/decryption with the user's public key and offline private identity: NOT VERIFIED. Tests use a faithful reversible fake boundary and no credentials.
- NTFS ACL policy on the real `D:\openclaw_setting\backups` directory: NOT VERIFIED. The bounded no-shell production verifier and injected failure seam were tested; no real backup root was touched.
- NTFS same-handle identity deletion on the real `D:\openclaw_setting\backups` directory: NOT VERIFIED. The fixed PowerShell/.NET helper, strict evidence parser, fail-closed portable seam, mismatch behavior, and success behavior were tested without touching the real backup root.
- Daily scheduled sample restore and monthly full restore against real OpenClaw state: NOT VERIFIED. The deterministic recording API and both modes were tested with isolated fixtures; no scheduler was installed or run.
- Real device-disaster protection / separate physical media replication: NOT VERIFIED.
- No live OpenClaw, Naver, Telegram, OpenAI, credential store, or external service was accessed.
