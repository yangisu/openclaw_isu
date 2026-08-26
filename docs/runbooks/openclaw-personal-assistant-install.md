# OpenClaw personal assistant installation runbook

This runbook targets Ubuntu 24.04 in WSL2, Node.js 24.15 or newer (but below 25), and the package-local OpenClaw 2026.7.1 installed by this checkout. Run every command locally. Never paste a bot token, OAuth code, client secret, CalDAV application password, or `age` private key into chat, a shell argument, Git, Markdown, or a log.

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

Edit the generated config locally: replace `/home/user` with the real WSL home and replace the documented owner placeholder `123456789` with the one numeric Telegram owner ID. Keep Telegram DMs allowlisted, groups disabled, config writes disabled, shell/config/MCP/plugin commands disabled, elevated tools disabled, the Gateway loopback-only, and exactly these five optional tools:

```text
assistant_query
assistant_mutate
assistant_calendar_prepare
assistant_calendar_confirm
assistant_briefing
```

Register the exact Naver OAuth callback and calendar permission in the Naver developer console. The plugin owns only the Naver OAuth lifecycle; ChatGPT model OAuth remains entirely OpenClaw-managed and is not proven by plugin PoC evidence.

Create a temporary owner-only JSON file with exactly `version`, `clientId`, `clientSecret`, and `redirectUri`, where `version` is `1` and `redirectUri` exactly matches the registered callback. Use a local editor and mode `600`; do not type its contents as shell arguments. Then run the package CLI with the sensitive document on stdin:

```bash
umask 077
editor /absolute/owner-private/naver-client-input.json
node plugins/openclaw-personal-assistant/dist/cli.js oauth configure \
  --client-file "$HOME/.openclaw/secrets/naver-oauth-client" \
  < /absolute/owner-private/naver-client-input.json
node plugins/openclaw-personal-assistant/dist/cli.js oauth begin \
  --client-file "$HOME/.openclaw/secrets/naver-oauth-client" \
  --state "$HOME/.openclaw/state/openclaw-personal-assistant"
```

Complete the displayed authorization URL locally. Put only `{"callbackUrl":"<the complete returned callback URL>"}` in another owner-only temporary file, then pass it on stdin. The CLI requires the exact scheme, host, port, and path, one state, and either one code or one error; state is single-use for ten minutes.

```bash
editor /absolute/owner-private/naver-callback.json
node plugins/openclaw-personal-assistant/dist/cli.js oauth callback \
  --client-file "$HOME/.openclaw/secrets/naver-oauth-client" \
  --token-file "$HOME/.openclaw/secrets/naver-oauth-token" \
  --state "$HOME/.openclaw/state/openclaw-personal-assistant" \
  < /absolute/owner-private/naver-callback.json
node plugins/openclaw-personal-assistant/dist/cli.js oauth status \
  --client-file "$HOME/.openclaw/secrets/naver-oauth-client" \
  --token-file "$HOME/.openclaw/secrets/naver-oauth-token"
```

Securely remove the two temporary input files after the local commands succeed. The versioned app credential and token stores remain under the owner-only secret directory, outside the workspace, Git, and normal backups. `openclaw.personal-assistant.json5` contains only their paths. The production token provider validates and refreshes these stores, but calendar creation is currently disabled: OpenClaw 2026.7.1 does not attest that an owner command was direct rather than forwarded. Neither `/assistant-confirm` nor the `assistant_calendar_confirm` tool can perform an external write, and `AC-09` remains `NOT_VERIFIED`.

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

Runtime inspection must contain exactly five optional tools. A successful command is not a substitute for checking its JSON and exit code.

Install the Windows startup task only after the WSL checks pass. This may request the current Windows user's password because the task must run whether that user is logged on or not:

```powershell
pwsh -File .\scripts\windows\install-wsl-task.ps1 -Distro Ubuntu-24.04 -Confirm
```

Do not change the principal to `SYSTEM`. Do not add a firewall inbound rule or portproxy.

## 5. PoC gates

The legacy `poc` command accepts only a local report containing exactly `status`, `observedChecks`, `redactedErrorCode`, and `timestamp`, with no additional or nested fields. It is report-only: it cannot open a runtime gate and `doctor` does not use it as operational proof. Checks containing control/format characters, URLs, OAuth codes, keys, or token-like values are rejected rather than redacted or persisted:

```bash
node plugins/openclaw-personal-assistant/dist/cli.js poc openai --state "$HOME/.openclaw/state/openclaw-personal-assistant" --evidence /absolute/path/openai-redacted.json
node plugins/openclaw-personal-assistant/dist/cli.js poc caldav --state "$HOME/.openclaw/state/openclaw-personal-assistant" --evidence /absolute/path/caldav-redacted.json
node plugins/openclaw-personal-assistant/dist/cli.js doctor \
  --state "$HOME/.openclaw/state/openclaw-personal-assistant" \
  --naver-client-file "$HOME/.openclaw/secrets/naver-oauth-client" \
  --naver-token-file "$HOME/.openclaw/secrets/naver-oauth-token"
```

`doctor` verifies the real versioned Naver app store and token freshness read-only. `naver-create` remains unknown until authoritative production integration evidence exists; arbitrary `poc --evidence` cannot change it. OpenAI model authentication is inspected with the package-local OpenClaw commands and live Gateway behavior, not claimed as plugin-controlled. Consequently `doctor` remains nonzero while any required gate is unknown, closed, or expired.

Use explicit refresh or revoke locally when required. Neither command accepts a token, code, or secret argument. Revoke attempts the remote request and always invalidates the local token; a remote failure therefore remains fail-closed and requires a new authorization before calendar creation.

```bash
node plugins/openclaw-personal-assistant/dist/cli.js oauth refresh \
  --client-file "$HOME/.openclaw/secrets/naver-oauth-client" \
  --token-file "$HOME/.openclaw/secrets/naver-oauth-token" \
  --state "$HOME/.openclaw/state/openclaw-personal-assistant"
node plugins/openclaw-personal-assistant/dist/cli.js oauth revoke \
  --client-file "$HOME/.openclaw/secrets/naver-oauth-client" \
  --token-file "$HOME/.openclaw/secrets/naver-oauth-token" \
  --state "$HOME/.openclaw/state/openclaw-personal-assistant"
```

There is no automated create PoC while the confirmation boundary is fail-closed. If a future approved OpenClaw release provides direct, non-forwarded owner provenance and the production boundary is implemented and reviewed, create exactly one clearly named test event after the single-use confirmation, verify there is no duplicate, and delete that one event yourself in the Naver app. The assistant does not modify or delete Naver events.

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

Daily maintenance creates and verifies the encrypted archive, performs an isolated sample restore, and only then applies verified retention (latest 30 points, minimum 2). `publication_unknown`, missing media/identity, backup, restore, or durable-health failure closes backup health and performs no retention. Monthly maintenance verifies the exact selected archive and performs a full isolated restore, recording schema/hash-bound evidence; it never applies to the live workspace. A cross-process lock prevents overlap and temporary restore roots are cleaned by the verified restore API. These schedules are installed automation, but their real age/media/ACL execution remains `NOT_VERIFIED` until observed on the target host.

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
