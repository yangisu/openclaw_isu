# OpenClaw Google Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the active Naver/CalDAV calendar path with owner-only CRUD on one Google app-created secondary calendar named `openclaw_cal`.

**Architecture:** A PKCE desktop OAuth client obtains only `calendar.app.created`; a binding file pins the Google-created calendar ID. A bounded REST adapter and SQLite mutation ledger back one `assistant_calendar_manage` tool, while `assistant_query` and briefings read the same pinned calendar. Installer validators fail closed unless the exact Google secrets, four-tool surface, and dedicated-calendar configuration are present.

**Tech Stack:** TypeScript ESM, Node.js 24 built-in `fetch`/`http`/`crypto`/`sqlite`, TypeBox, Vitest, Bash, OpenClaw 2026.7.1.

**Spec:** `docs/superpowers/specs/2026-08-27-openclaw-google-calendar-design.md`

## Global Constraints

- Calendar scope is exactly `https://www.googleapis.com/auth/calendar.app.created`.
- Account login hint is exactly `yangisu12@gmail.com`.
- Calendar summary and timezone are exactly `openclaw_cal` and `Asia/Seoul`.
- Only the calendar ID stored in the owner-private binding file may reach Google event endpoints.
- Only Telegram owner ID `6520016662` may invoke calendar tools.
- No attendee, invite, conference, ACL, sharing, or calendar-delete surface is permitted.
- Update and delete require the caller's last-observed ETag and send `If-Match`.
- All remote requests have a 15-second deadline and bounded response parsing.
- Existing Naver secrets are left untouched but are not referenced by active configuration.
- Node runtime remains `>=24.15.0 <25.0.0`; no new runtime dependency is added.

## File Structure

- `src/calendar/google-oauth.ts`: Google Desktop OAuth PKCE, state lifecycle, token validation and refresh.
- `src/calendar/google-api.ts`: pinned-calendar REST client, event normalization, CRUD and error mapping.
- `src/calendar/google-ledger.ts`: idempotent mutation state and ambiguous-result reconciliation metadata.
- `src/tools/calendar.ts`: the single owner-only calendar CRUD tool and schemas.
- `src/tools/query.ts`: reads events through the Google adapter.
- `src/tools/trust.ts`: parses and validates the Google-only calendar configuration.
- `src/tools/register.ts`: exposes the exact four optional tools.
- `src/cli.ts`: imports credentials, runs loopback OAuth, bootstraps the calendar, probes CRUD, and reports doctor state.
- `tests/calendar/google-oauth.test.ts`: OAuth and secret-state contracts.
- `tests/calendar/google-api.test.ts`: exact REST boundary, normalization, ETag and calendar pinning.
- `tests/calendar/google-ledger.test.ts`: idempotency and state-transition contracts.
- `tests/tools/tools.test.ts`: owner, schema, query and CRUD tool behavior.
- `tests/cli.test.ts`: non-leaking Google CLI flows.
- `config/openclaw.personal-assistant.example.json5`: active Google calendar settings and four-tool allowlist.
- `scripts/wsl/*.js`, `scripts/wsl/install-openclaw.sh`: hardened validation and deployment migration.
- `tests/scripts.test.ts`: executable installer and validator behavior.
- `docs/runbooks/openclaw-personal-assistant-acceptance.md`: operator OAuth and live CRUD verification.

---

### Task 1: Google OAuth PKCE and token lifecycle

**Files:**
- Create: `plugins/openclaw-personal-assistant/src/calendar/google-oauth.ts`
- Create: `plugins/openclaw-personal-assistant/tests/calendar/google-oauth.test.ts`
- Reuse: `plugins/openclaw-personal-assistant/src/calendar/bounded-json.ts`
- Reuse: `plugins/openclaw-personal-assistant/src/secrets/file-store.ts`

**Interfaces:**
- Consumes: `SecretStore<T>`-compatible stores, injected `fetch`, UTC clock, and `stateDbPath`.
- Produces: `GOOGLE_CALENDAR_SCOPE`, `GoogleOAuth.begin(redirectUri)`, `handleCallback(callbackUrl)`, `getValidAccessToken()`, `status()`, `revoke()` and validation helpers.

- [ ] **Step 1: Write failing OAuth contract tests**

  Add literal expectations proving S256 PKCE, exact scope/login hint, ten-minute one-use state, exact loopback callback fields, bounded token responses, refresh-token preservation, 5-minute early refresh, single-flight refresh, scope mismatch rejection, and redacted errors. A representative assertion is:

  ```ts
  expect(new URL(begin.authorizationUrl).searchParams.get('scope'))
    .toBe('https://www.googleapis.com/auth/calendar.app.created');
  expect(new URL(begin.authorizationUrl).searchParams.get('code_challenge_method')).toBe('S256');
  await expect(oauth.handleCallback(`${redirect}?code=x&state=${state}&extra=1`))
    .rejects.toMatchObject({ code: 'google_oauth_callback_invalid' });
  ```

- [ ] **Step 2: Run the OAuth tests and verify RED**

  Run: `npm test -- tests/calendar/google-oauth.test.ts`  
  Expected: FAIL because `google-oauth.ts` does not exist.

- [ ] **Step 3: Implement the minimal OAuth client**

  Define these public types exactly:

  ```ts
  export interface GoogleOAuthClientCredentials {
    version: 1; clientId: string; clientSecret: string;
  }
  export interface GoogleTokenSet {
    version: 1; accessToken: string; refreshToken: string;
    expiresAt: string; scope: typeof GOOGLE_CALENDAR_SCOPE;
  }
  export interface GoogleAuthorization {
    authorizationUrl: string; redirectUri: string; expiresAt: string;
  }
  ```

  Generate verifier/state with `randomBytes`, S256 with `createHash`, persist only hashed state plus encrypted-by-permissions verifier in owner-private SQLite, consume it atomically, and map all outward errors to the `google_oauth_*` code family. Accept only `http://127.0.0.1:<ephemeral>/google/callback`.

- [ ] **Step 4: Run OAuth tests, typecheck, and verify GREEN**

  Run: `npm test -- tests/calendar/google-oauth.test.ts && npm run typecheck`  
  Expected: all new tests pass with zero TypeScript errors.

- [ ] **Step 5: Commit OAuth lifecycle**

  ```bash
  git add plugins/openclaw-personal-assistant/src/calendar/google-oauth.ts plugins/openclaw-personal-assistant/tests/calendar/google-oauth.test.ts
  git commit -m "feat: add Google calendar OAuth lifecycle"
  ```

### Task 2: Pinned Google Calendar REST adapter

**Files:**
- Create: `plugins/openclaw-personal-assistant/src/calendar/google-api.ts`
- Create: `plugins/openclaw-personal-assistant/tests/calendar/google-api.test.ts`
- Modify: `plugins/openclaw-personal-assistant/src/calendar/ical.ts`
- Modify: `plugins/openclaw-personal-assistant/tests/calendar/ical.test.ts`

**Interfaces:**
- Consumes: access-token provider `() => Promise<string>`, `GoogleCalendarBinding`, injected `fetch`.
- Produces: `GoogleCalendarApi.bootstrap`, `verifyBinding`, `listEvents`, `getEvent`, `createEvent`, `updateEvent`, `deleteEvent`.

- [ ] **Step 1: Write failing REST boundary tests**

  Cover exact endpoint/method/query/body literals, encoded IDs, authorization header, 15-second abort, 1 MiB bound, pagination limit, timed/all-day/recurring mapping, deterministic event IDs, and no attendees/conference fields. Assert a foreign ID is rejected before fetch:

  ```ts
  await expect(api.listEvents({ calendarId: 'primary', start, end }))
    .rejects.toMatchObject({ code: 'calendar_scope_violation' });
  expect(fetch).not.toHaveBeenCalled();
  ```

  Add 409/412 conflict, 401 one-refresh, 403/404/429/5xx/timeout mapping and `If-Match` header cases.

- [ ] **Step 2: Run adapter tests and verify RED**

  Run: `npm test -- tests/calendar/google-api.test.ts tests/calendar/ical.test.ts`  
  Expected: FAIL because the Google adapter and Google event fields are absent.

- [ ] **Step 3: Extend the event contract and implement the adapter**

  Add optional `eventId`, `etag`, `description`, and `recurringEventId` fields to the normalized event type. Define:

  ```ts
  export interface GoogleCalendarBinding {
    version: 1; calendarId: string; summary: 'openclaw_cal';
    timeZone: 'Asia/Seoul'; createdAt: string;
  }
  export interface GoogleEventMutation {
    eventId: string; summary: string; dtstart: string; dtend: string;
    location?: string; description?: string; rrule?: RecurrenceRule;
  }
  ```

  `bootstrap` performs `calendars.insert` only when no binding exists, writes the returned ID atomically, and otherwise verifies the stored binding. Event methods never accept an arbitrary calendar ID argument; they close over the validated binding.

- [ ] **Step 4: Run adapter tests and typecheck**

  Run: `npm test -- tests/calendar/google-api.test.ts tests/calendar/ical.test.ts && npm run typecheck`  
  Expected: PASS.

- [ ] **Step 5: Commit the REST adapter**

  ```bash
  git add plugins/openclaw-personal-assistant/src/calendar/google-api.ts plugins/openclaw-personal-assistant/src/calendar/ical.ts plugins/openclaw-personal-assistant/tests/calendar/google-api.test.ts plugins/openclaw-personal-assistant/tests/calendar/ical.test.ts
  git commit -m "feat: add pinned Google calendar client"
  ```

### Task 3: Idempotent CRUD tool

**Files:**
- Create: `plugins/openclaw-personal-assistant/src/calendar/google-ledger.ts`
- Create: `plugins/openclaw-personal-assistant/tests/calendar/google-ledger.test.ts`
- Replace: `plugins/openclaw-personal-assistant/src/tools/calendar.ts`
- Modify: `plugins/openclaw-personal-assistant/src/tools/register.ts`
- Modify: `plugins/openclaw-personal-assistant/tests/tools/tools.test.ts`

**Interfaces:**
- Consumes: `GoogleCalendarApi`, owner-validated tool context, config paths, request UUID.
- Produces: `assistant_calendar_manage` with create/update/delete union and durable mutation outcomes.

- [ ] **Step 1: Write failing ledger state tests**

  Prove first claim, same-request/same-hash replay, same-request/different-hash conflict, legal `pending -> submitting -> succeeded|failed|unknown` transitions, crash recovery, and no event body/token columns. Query the real temporary SQLite schema instead of asserting source text.

- [ ] **Step 2: Run ledger tests and verify RED**

  Run: `npm test -- tests/calendar/google-ledger.test.ts`  
  Expected: FAIL because the ledger does not exist.

- [ ] **Step 3: Implement the ledger and verify GREEN**

  Export:

  ```ts
  export class GoogleCalendarLedger {
    claim(input: MutationClaim): MutationRecord;
    markSubmitting(requestId: string): MutationRecord;
    finish(requestId: string, outcome: MutationOutcome): MutationRecord;
    get(requestId: string): MutationRecord | undefined;
    close(): void;
  }
  ```

  Use `BEGIN IMMEDIATE`, `journal_mode=WAL`, constraints for state/action, canonical payload SHA-256, and exact request/event ID uniqueness.

- [ ] **Step 4: Write failing tool behavior tests**

  Define the desired union with `action: create|update|delete`. Test owner rejection before disk/network, invalid update with zero fields, stale ETag, recurring-instance rejection, successful CRUD, deterministic duplicate create, uncertain-result reconciliation, and abort propagation. Assert the registered set is exactly:

  ```ts
  ['assistant_briefing', 'assistant_calendar_manage', 'assistant_mutate', 'assistant_query']
  ```

- [ ] **Step 5: Run tool tests and verify RED**

  Run: `npm test -- tests/tools/tools.test.ts`  
  Expected: FAIL because `assistant_calendar_manage` is not registered.

- [ ] **Step 6: Implement the manage tool and verify GREEN**

  Create a TypeBox union without `calendarId`, attendees, conference data, ACL or notification fields. For create derive `eventId = "oc" + requestId.replaceAll("-", "")`; for update/delete require lowercase-safe event ID plus quoted ETag. Reconcile only according to the design's bounded GET rules.

- [ ] **Step 7: Run focused tests and typecheck**

  Run: `npm test -- tests/calendar/google-ledger.test.ts tests/tools/tools.test.ts && npm run typecheck`  
  Expected: PASS.

- [ ] **Step 8: Commit the CRUD tool**

  ```bash
  git add plugins/openclaw-personal-assistant/src/calendar/google-ledger.ts plugins/openclaw-personal-assistant/src/tools/calendar.ts plugins/openclaw-personal-assistant/src/tools/register.ts plugins/openclaw-personal-assistant/tests/calendar/google-ledger.test.ts plugins/openclaw-personal-assistant/tests/tools/tools.test.ts
  git commit -m "feat: add idempotent Google calendar CRUD tool"
  ```

### Task 4: Google query, health isolation, and configuration

**Files:**
- Modify: `plugins/openclaw-personal-assistant/src/tools/query.ts`
- Modify: `plugins/openclaw-personal-assistant/src/tools/trust.ts`
- Modify: `plugins/openclaw-personal-assistant/src/tools/briefing.ts`
- Modify: `plugins/openclaw-personal-assistant/src/tools/register.ts`
- Modify: `plugins/openclaw-personal-assistant/tests/tools/tools.test.ts`
- Modify: `plugins/openclaw-personal-assistant/tests/briefing/build.test.ts`

**Interfaces:**
- Consumes: exact Google config fields and `GoogleCalendarApi`.
- Produces: Google calendar reads and `google-calendar` health signals without affecting local records.

- [ ] **Step 1: Add failing configuration and read-path tests**

  Test exact-field parsing, provider literal, safe absolute distinct secret paths, exact account, unknown Naver/CalDAV field rejection, 31-day range, Google event output, and calendar-only failure isolation. Include a real local record query beside a failing Google reader to prove local availability.

- [ ] **Step 2: Run focused tests and verify RED**

  Run: `npm test -- tests/tools/tools.test.ts tests/briefing/build.test.ts`  
  Expected: FAIL on the absent Google configuration contract.

- [ ] **Step 3: Implement Google config and query wiring**

  Replace `CalendarToolConfig` with:

  ```ts
  export interface CalendarToolConfig {
    provider: 'google'; googleOAuthClientFile: string; googleTokenFile: string;
    googleCalendarBindingFile: string; expectedAccount: 'yangisu12@gmail.com';
  }
  ```

  Open the same token/binding stores for query and manage tools, report fixed `google-oauth` or `google-calendar` health targets, and preserve quoted-untrusted-data output.

- [ ] **Step 4: Run focused tests and typecheck**

  Run: `npm test -- tests/tools/tools.test.ts tests/briefing/build.test.ts && npm run typecheck`  
  Expected: PASS.

- [ ] **Step 5: Commit configuration and read migration**

  ```bash
  git add plugins/openclaw-personal-assistant/src/tools plugins/openclaw-personal-assistant/tests/tools/tools.test.ts plugins/openclaw-personal-assistant/tests/briefing/build.test.ts
  git commit -m "feat: switch calendar reads to Google"
  ```

### Task 5: Operator CLI for credential import, OAuth, bootstrap, and live PoC

**Files:**
- Modify: `plugins/openclaw-personal-assistant/src/cli.ts`
- Modify: `plugins/openclaw-personal-assistant/tests/cli.test.ts`
- Modify: `plugins/openclaw-personal-assistant/package.json`

**Interfaces:**
- Consumes: Desktop OAuth JSON from stdin and secret paths from validated absolute options.
- Produces: `google oauth configure|authorize|status|revoke`, `google calendar bootstrap|poc`, and Google-aware `doctor`.

- [ ] **Step 1: Write failing CLI tests**

  Test Desktop JSON normalization, refusal of web/service-account credentials, no secret argv, loopback listener timeout/abort, redacted output, status without network, bootstrap idempotency, PoC create→update→delete→zero residue, and doctor open/closed/Testing warnings. Use injected stores, fetch, listener factory and literal responses; assert captured stdout never contains client secret, access token, refresh token or authorization code.

- [ ] **Step 2: Run CLI tests and verify RED**

  Run: `npm test -- tests/cli.test.ts`  
  Expected: FAIL because `google` commands are unknown.

- [ ] **Step 3: Implement CLI commands**

  Keep secrets in stdin or mode-600 files. `authorize` binds `127.0.0.1` on an ephemeral port, prints the authorization URL, serves one callback, returns a fixed success/failure HTML page, and exits after 10 minutes. `poc` uses summary `[OpenClaw PoC]`, updates it to `[OpenClaw PoC updated]`, deletes it with the last ETag, then lists the exact deterministic ID and requires zero matches.

- [ ] **Step 4: Run CLI tests, typecheck and build**

  Run: `npm test -- tests/cli.test.ts && npm run typecheck && npm run build`  
  Expected: PASS.

- [ ] **Step 5: Commit operator CLI**

  ```bash
  git add plugins/openclaw-personal-assistant/src/cli.ts plugins/openclaw-personal-assistant/tests/cli.test.ts plugins/openclaw-personal-assistant/package.json
  git commit -m "feat: add Google calendar setup CLI"
  ```

### Task 6: Hardened installer and runtime contract migration

**Files:**
- Modify: `config/openclaw.personal-assistant.example.json5`
- Modify: `scripts/wsl/install-openclaw.sh`
- Modify: `scripts/wsl/validate-hardened-config.js`
- Modify: `scripts/wsl/validate-runtime-tools.js`
- Modify: `scripts/wsl/run-acceptance.sh`
- Modify: `plugins/openclaw-personal-assistant/tests/scripts.test.ts`

**Interfaces:**
- Consumes: exact four-tool plugin and three owner-private Google secret files.
- Produces: repeatable prepare/finish/check deployment without deleting Naver files.

- [ ] **Step 1: Add failing executable installer tests**

  Run validators against controlled JSON5 and secret trees. Test exact four tools, exact provider/account/path values, rejection of Naver active fields, missing/linked/over-permissive Google secrets, dry-run wording, and the fact that an unrelated existing Naver secret survives finish. Do not grep source strings as the primary assertion; execute scripts and inspect exit code/effects.

- [ ] **Step 2: Run script tests and verify RED**

  Run: `npm test -- tests/scripts.test.ts`  
  Expected: FAIL because validators still require Naver/CalDAV and five tools.

- [ ] **Step 3: Update active config and deployment scripts**

  Change `tools.allow` and validator literals to the four-tool set. Replace the active calendar object with Google fields. `validate_secret_tree` requires telegram plus the three Google files, while leaving extra Naver files untouched. Prepare output gives only safe file-path commands and never accepts a secret CLI value. Finish validates Google OAuth status and binding before config patch and restart.

- [ ] **Step 4: Run script tests and plugin validation**

  Run: `npm test -- tests/scripts.test.ts && npm run plugin:validate`  
  Expected: PASS with exact four runtime tools.

- [ ] **Step 5: Commit installer migration**

  ```bash
  git add config scripts/wsl plugins/openclaw-personal-assistant/tests/scripts.test.ts
  git commit -m "feat: deploy hardened Google calendar configuration"
  ```

### Task 7: Acceptance documentation and full verification

**Files:**
- Modify: `docs/runbooks/openclaw-personal-assistant-acceptance.md`
- Modify: `docs/superpowers/specs/2026-08-25-openclaw-personal-assistant-design.md`
- Modify: `README.md` if present and containing active Naver setup instructions.

**Interfaces:**
- Consumes: completed implementation and setup CLI.
- Produces: one operator path from Google Cloud credentials through live zero-residue CRUD evidence.

- [ ] **Step 1: Update the runbook and superseded design statements**

  Document Calendar API enablement, Desktop client creation, test-user selection, the 7-day Testing refresh-token limitation, Production transition, local credential import, browser consent, bootstrap, install, doctor, PoC and revoke. Mark the 2026-08-27 design as superseding only the Naver calendar portions of the 2026-08-25 design.

- [ ] **Step 2: Run document and diff checks**

  Run: `rg -n "Naver|CalDAV|assistant_calendar_prepare|assistant_calendar_confirm" config scripts/wsl docs/runbooks plugins/openclaw-personal-assistant/src/tools`  
  Expected: no active-path references; historical/superseded references must be explicitly labeled.  
  Run: `git diff --check`  
  Expected: exit 0.

- [ ] **Step 3: Run the complete automated verification suite**

  Run: `npm test && npm run typecheck && npm run build && npm run plugin:validate` from `plugins/openclaw-personal-assistant`.  
  Expected: zero failures; the only permitted skip is the existing platform-specific Windows/Linux skip.

- [ ] **Step 4: Commit docs and any verification fixes**

  ```bash
  git add docs README.md
  git commit -m "docs: add Google calendar operations runbook"
  ```

- [ ] **Step 5: Deploy to WSL and verify the installed boundary**

  Sync the committed branch to `/home/user/openclaw-setting-linux`, build there, run `bash scripts/wsl/install-openclaw.sh --finish`, then:

  ```bash
  bash scripts/wsl/install-openclaw.sh --check
  plugins/openclaw-personal-assistant/node_modules/.bin/openclaw plugins inspect openclaw-personal-assistant --runtime --json
  systemctl --user is-active openclaw-gateway.service
  ```

  Expected: `CHECK_OK`, exactly four optional tools, and `active` service state.

- [ ] **Step 6: Run the authorized live Google PoC**

  After local browser consent and bootstrap, run the CLI `google calendar poc` with secret paths supplied only as file-path options. Expected JSON evidence: create success, update success with changed ETag, delete success, and `remaining: 0`. Then query the dedicated calendar and require no `[OpenClaw PoC]` events.

- [ ] **Step 7: Verify Git delivery state**

  Run: `git status --short && git log -1 --oneline && git remote -v`  
  Expected: clean feature worktree and final local commit. If no remote is configured, record that push is impossible instead of inventing one; otherwise push `codex/google-calendar`.

## Self-Review

- Spec coverage: Tasks 1–7 cover OAuth, pinned calendar, CRUD/idempotency, read/briefing isolation, CLI, installer, live PoC and delivery.
- Scope boundary: no interface accepts an arbitrary calendar ID after bootstrap; no attendee/ACL/calendar-delete input exists.
- Type consistency: `GoogleCalendarBinding`, `GoogleTokenSet`, `GoogleCalendarApi` and `GoogleCalendarLedger` names are used consistently across tasks.
- Placeholder scan: the plan contains no deferred implementation markers; operator-provided secrets are referenced only as local files/stdin.
- Test quality: each production behavior has an observable failing test before implementation; external Google calls are mocked only at the HTTPS boundary with complete response fixtures.
