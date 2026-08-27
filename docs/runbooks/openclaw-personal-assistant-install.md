# OpenClaw personal assistant installation runbook

This runbook targets Ubuntu 24.04 in WSL2, Node.js 24.15 or newer (but below 25), and the package-local OpenClaw 2026.7.1 installed by this checkout. Run every command locally. Never paste a bot token, OAuth code, OAuth client JSON, refresh token, or `age` private key into chat, a shell argument, Git, Markdown, or a log.

## 1. Preflight without changing state

From the repository root in PowerShell 7, validate the exact WSL distribution name:

```powershell
wsl.exe --list --quiet
pwsh -File .\scripts\windows\install-wsl-task.ps1 -Distro Ubuntu-24.04 -WhatIf
```

`-WhatIf` still rejects a distribution that is not an exact row in `wsl.exe --list --quiet`. The plan must name the current interactive Windows principal, `AtStartup`, `wsl.exe -d "Ubuntu-24.04" --exec /bin/sleep infinity`, and restart interval `PT1M`. It must not name `SYSTEM`, a firewall rule, or portproxy.

In Ubuntu WSL, preview the installer:

```bash
bash scripts/wsl/install-openclaw.sh --dry-run
```

The preview is non-mutating. The real preflight later rejects any release other than Ubuntu 24.04, Node older than 24.15, a non-systemd PID 1, disabled lingering that cannot be enabled, or a package-local OpenClaw version other than 2026.7.1.

## 2. Create non-secret local structure

Build the CLI, then initialize a new absolute root. `init` refuses relative, symlink, junction, reparse, and redirected roots. It creates owner-private directories and missing non-secret templates only; it never overwrites an existing file.

```bash
cd plugins/openclaw-personal-assistant
npm ci
npm run build
node dist/cli.js init --root "$HOME/.openclaw/personal-assistant-bootstrap"
cd ../..
bash scripts/wsl/install-openclaw.sh
```

The installer intentionally stops with exit code 2 at `STOP_INTERACTIVE`. This is a checkpoint, not installation success.

## 3. Interactive credential checkpoint

Perform the printed commands in the local terminal. Use a hidden prompt or an editor that does not retain secrets in history. Owner-only secret files must be mode `600`; their directory and OpenClaw configuration must be mode `700`/`600`. Complete ChatGPT login using the package-local command:

```bash
plugins/openclaw-personal-assistant/node_modules/.bin/openclaw models auth login
```

Edit the generated config locally: replace `/home/user` with the real WSL home. Keep Telegram DMs allowlisted to `6520016662`, groups disabled, config writes disabled, inline buttons limited to DMs, shell/config/MCP/plugin commands disabled, elevated tools disabled, the Gateway loopback-only, and exactly these six optional plugin tools plus the bounded built-in fetch/PDF readers:

```text
assistant_query
assistant_mutate
assistant_calendar_manage
assistant_briefing
assistant_resource_store
assistant_study_manage
web_fetch
pdf
```

Keep web fetch limited to 100,000 characters, 1,000,000 response bytes, 30 seconds, and three redirects with trusted environment proxies disabled. Keep PDF input limited to 10 MB and 20 pages. Do not enable browser, search, shell, private-network, or paid-provider fallbacks for link collection.

In Google Cloud, enable Google Calendar API, configure the OAuth consent screen for `yangisu12@gmail.com`, and create an OAuth client of type **Desktop app**. Download its JSON file to an owner-private location. The CLI requests `openid email` for exact account verification and `https://www.googleapis.com/auth/calendar.app.created` as its only Calendar data scope; this permits calendar creation and event access only in calendars created by this app.

```bash
umask 077
node plugins/openclaw-personal-assistant/dist/cli.js google oauth configure \
  --client-file "$HOME/.openclaw/secrets/google-oauth-client" \
  < /absolute/owner-private/google-desktop-client.json
node plugins/openclaw-personal-assistant/dist/cli.js google oauth authorize \
  --client-file "$HOME/.openclaw/secrets/google-oauth-client" \
  --token-file "$HOME/.openclaw/secrets/google-oauth-token" \
  --state "$HOME/.openclaw/state/openclaw-personal-assistant"
```

Open the displayed URL locally, verify that Google shows exactly `yangisu12@gmail.com`, and approve access. The loopback callback validates PKCE, exact state, and the exact returned scope before atomically storing an owner-only token; the least-privilege Calendar-only scope cannot independently disclose the account email, so the displayed-account check is an explicit operator gate. If the consent screen remains in Google **Testing** status, its refresh token normally expires after seven days; publish the app to Production for durable unattended use.

```bash
node plugins/openclaw-personal-assistant/dist/cli.js google oauth status \
  --client-file "$HOME/.openclaw/secrets/google-oauth-client" \
  --token-file "$HOME/.openclaw/secrets/google-oauth-token" \
  --state "$HOME/.openclaw/state/openclaw-personal-assistant"
node plugins/openclaw-personal-assistant/dist/cli.js google calendar bootstrap \
  --client-file "$HOME/.openclaw/secrets/google-oauth-client" \
  --token-file "$HOME/.openclaw/secrets/google-oauth-token" \
  --binding-file "$HOME/.openclaw/secrets/google-calendar-binding" \
  --state "$HOME/.openclaw/state/openclaw-personal-assistant"
```

`google oauth status` is read-only. Bootstrap creates one secondary calendar named `openclaw_cal` with timezone `Asia/Seoul`, records only its returned ID in the owner-private binding, and is idempotent. It never adopts a pre-existing user-created calendar, even if it has the same name. Delete the temporary downloaded OAuth client JSON only after the hardened copy is verified.

## 4. Finish installation

```bash
bash scripts/wsl/install-openclaw.sh --finish
bash scripts/wsl/install-openclaw.sh --check
```

The finish phase builds the mixed plugin, validates its built registration contract, links it, and then validates the installed plugin through package-local OpenClaw runtime inspection. OpenClaw 2026.7.1's `plugins build/validate --entry` commands are for simple `defineToolPlugin` entries and are not used for this mixed `definePluginEntry`. The installer then validates the hardened config, installs/enables the user Gateway service, and declares the idempotent isolated briefing Cron job with:

- expression `0 8-22 * * *`
- timezone `Asia/Seoul`
- exact scheduling (`staggerMs: 0`)
- message `Call assistant_briefing once. Deliver only when send=true.`
- Telegram announce delivery to the configured numeric owner
- the checked-in exact-hour trigger, with `cron.triggers.enabled`, suppressing OpenClaw 2026.7.1 startup catch-up outside minute 00 so sleeping-time briefings are not replayed

It also declares two non-model `payload.kind=command` jobs. Inspection of the installed OpenClaw 2026.7.1 cron source confirms that command payloads execute an argv array directly without a shell. The daily job is `0 3 * * *`; the monthly job is `0 4 1 * *`; both use `Asia/Seoul`, `staggerMs: 0`, exact trigger scripts, no delivery, no secret environment, and argv containing only the package-local Node/CLI paths, `maintenance daily|monthly`, and the private config path. These times are the deterministic installation ruling because the approved design specifies daily/monthly frequency but not wall-clock times.

Inspect the result locally:

```bash
plugins/openclaw-personal-assistant/node_modules/.bin/openclaw plugins inspect openclaw-personal-assistant --runtime --json
plugins/openclaw-personal-assistant/node_modules/.bin/openclaw cron list --json
systemctl --user is-active openclaw-gateway.service
loginctl show-user "$USER" -p Linger
```

Runtime inspection must contain exactly six optional plugin tools. The active allowlist additionally contains only `web_fetch` and `pdf`. A successful command is not a substitute for checking its JSON and exit code.

## Personal assistant commands

- `/save URL` reads a public HTTP(S) page or PDF as untrusted data and stores at most 100,000 extracted characters under a stable `R-YYYYMMDD-NNN` ID. It is best-effort for public non-JavaScript pages; login walls, client-rendered pages, oversized files, and inaccessible URLs fail without a browser or paid fallback.
- `/find 검색어` searches local titles, tags, summaries, claims, and saved text. `/memo 내용 #태그` stores a quick local note.
- `/study add 계획` divides only the owner-supplied plan into blocks. The study day is 08:00 through the following 02:00 in `Asia/Seoul`, with 50-minute focus, 10-minute breaks, 15-minute follow-ups up to twice, a 22:00 interim report, and a 02:00 final report. Use `/study status|done|snooze|skip`; reminder buttons map to the same actions and print text fallbacks.

To stop coaching without deleting data, disable the plugin and restart the Gateway. Re-enabling it resumes from persisted resources, notes, study history, and settings.

Install the Windows startup task only after the WSL checks pass. This may request the current Windows user's password because the task must run whether that user is logged on or not:

```powershell
pwsh -File .\scripts\windows\install-wsl-task.ps1 -Distro Ubuntu-24.04 -Confirm
```

Do not change the principal to `SYSTEM`. Do not add a firewall inbound rule or portproxy.

## 5. PoC gates

After bootstrap, run the bounded live PoC. It creates one uniquely named event in the pinned app-created calendar, updates that event conditionally with its ETag, deletes it conditionally, and verifies that no matching event remains:

```bash
node plugins/openclaw-personal-assistant/dist/cli.js google calendar poc \
  --client-file "$HOME/.openclaw/secrets/google-oauth-client" \
  --token-file "$HOME/.openclaw/secrets/google-oauth-token" \
  --binding-file "$HOME/.openclaw/secrets/google-calendar-binding" \
  --state "$HOME/.openclaw/state/openclaw-personal-assistant"
```

Success ends with `remaining: 0`. Runtime writes are exposed only through `assistant_calendar_manage` and require the exact numeric Telegram owner. The tool accepts `create`, `update`, or `delete`, never accepts a calendar ID or attendees, always uses the pinned binding, requires ETags for update/delete, and records a metadata-only idempotency ledger before and after remote mutation. A stale ETag fails closed instead of overwriting a concurrent change.

To disconnect Google Calendar, revoke remotely first and remove the local token only after a verified success:

```bash
node plugins/openclaw-personal-assistant/dist/cli.js google oauth revoke \
  --client-file "$HOME/.openclaw/secrets/google-oauth-client" \
  --token-file "$HOME/.openclaw/secrets/google-oauth-token" \
  --state "$HOME/.openclaw/state/openclaw-personal-assistant"
```

Timeout, transport loss, or a non-success response retains the private token for an explicit retry. The dedicated Google calendar and its events are not deleted by revoke or uninstall.

## 6. Backup and restore boundary

The backup CLI requires absolute workspace, state, backup directory, and identity-file paths and delegates to the verified Task 9 API. `age` recipients may be passed because they are public; private identities remain files outside WSL, Git, and the backup target.

```bash
node plugins/openclaw-personal-assistant/dist/cli.js backup \
  --workspace "$HOME/.openclaw/workspace" \
  --state "$HOME/.openclaw/state/openclaw-personal-assistant" \
  --backup-dir /mnt/d/openclaw_setting/backups \
  --identity /absolute/offline/age-identity \
  --recipient age1REPLACE_WITH_PUBLIC_RECIPIENT

install -d -m 700 /absolute/new/isolated-restore-root
node plugins/openclaw-personal-assistant/dist/cli.js restore \
  --archive /absolute/path/YYYY-MM-DD.age \
  --restore-root /absolute/new/isolated-restore-root \
  --identity /absolute/offline/age-identity
```

Restore always creates and verifies an isolated destination. There is deliberately no live-workspace apply command. Preserve the existing workspace separately and use the approved manual recovery procedure before any replacement.

If backup exits with code 3 and `publication_unknown`, do not count it, alert on it, or run retention. Reconcile that exact archive only:

```bash
node plugins/openclaw-personal-assistant/dist/cli.js backup reconcile \
  --archive /absolute/path/YYYY-MM-DD.age \
  --state "$HOME/.openclaw/state/openclaw-personal-assistant" \
  --identity /absolute/offline/age-identity
```

Reconciliation performs the full archive/commit/manifest/Git/SQLite/outbox verification and clears only the hash-bound matching unknown publication.

Before enabling retention, verify the target NTFS ACL is protected and allows only the current user and Administrators, directory durability is supported, and the production same-handle file-identity deletion succeeds. If any proof is unavailable, retention must stay closed. Compare the Windows disk unique IDs for the WSL virtual disk and `D:`. If they share a physical device, the backup does not protect against device failure or ransomware; maintain a weekly copy of the same encrypted archive on separately managed physical media.

Automated maintenance reads the public age recipient and the identity-file path from the owner-private `~/.openclaw/maintenance.json`; the identity value is never stored in config, argv, output, or logs. During the prepare pause, replace all `/home/user` example paths with the current owner's actual paths. The installer creates the default private restore root, but an operator-selected alternative must also be created owner-private before finish. The identity must be a direct, stable, current-owner mode-0600 file on separately managed mounted media outside the workspace, state, Git, and `D:` backup root. Validate it locally before finish:

```bash
node plugins/openclaw-personal-assistant/dist/cli.js maintenance check --config "$HOME/.openclaw/maintenance.json"
```

Daily maintenance creates and verifies the encrypted archive, including strict resource file pairs and study state, performs an isolated sample restore, and only then applies verified retention (latest 30 points, minimum 2). A missing resource search catalog is rebuilt only inside that isolated restore. `publication_unknown`, missing media/identity, resource/hash/schema damage, backup, restore, or durable-health failure closes backup health and performs no retention. Monthly maintenance verifies the exact selected archive and performs a full isolated restore, recording schema/hash-bound evidence; it never applies to the live workspace. A cross-process lock prevents overlap and temporary restore roots are cleaned by the verified restore API. These schedules are installed automation, but their real age/media/ACL execution remains `NOT_VERIFIED` until observed on the target host.

## 7. Rollback and uninstall

Rollback never deletes user data, secrets, backups, or isolated restore evidence automatically.

```bash
plugins/openclaw-personal-assistant/node_modules/.bin/openclaw cron list --json
plugins/openclaw-personal-assistant/node_modules/.bin/openclaw cron rm <verified-job-id>
plugins/openclaw-personal-assistant/node_modules/.bin/openclaw plugins disable openclaw-personal-assistant
plugins/openclaw-personal-assistant/node_modules/.bin/openclaw plugins uninstall openclaw-personal-assistant
plugins/openclaw-personal-assistant/node_modules/.bin/openclaw gateway uninstall
```

In an elevated PowerShell, remove only the verified exact managed task:

```powershell
Get-ScheduledTask -TaskName 'OpenClaw Personal Assistant WSL Keepalive'
Unregister-ScheduledTask -TaskName 'OpenClaw Personal Assistant WSL Keepalive' -Confirm
```

Archive or manually remove owner data only after a separately verified backup and restore. Never use a recursively constructed path or a wildcard cleanup command.
