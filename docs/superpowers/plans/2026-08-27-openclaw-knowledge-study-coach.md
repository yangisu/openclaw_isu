# OpenClaw Knowledge Archive and Study Coach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add owner-only local URL/PDF archiving and search, deterministic memo commands, and a restart-safe study coach with Telegram reminders to the existing OpenClaw personal-assistant plugin.

**Architecture:** Extend the existing Git-backed workspace transaction path for resource snapshots, maintain a rebuildable SQLite search catalog, and add a separate transactional SQLite study store. Register two new agent tools, four plugin commands, one Telegram interactive handler, and one timer-driven background service; reuse OpenClaw `web_fetch`, `pdf`, message-presentation, and durable channel delivery contracts.

**Tech Stack:** TypeScript 7, Node.js 24 `node:sqlite`, TypeBox, Vitest, OpenClaw 2026.7.1 Plugin SDK, Git, WSL2 Ubuntu 24.04, Telegram.

**Spec:** `docs/superpowers/specs/2026-08-27-openclaw-knowledge-study-coach-design.md`

## Global Constraints

- Node.js must remain `>=24.15.0 <25`; OpenClaw must remain package-local version `2026.7.1`.
- Owner identity is the configured numeric Telegram ID; groups remain disabled.
- Google Calendar access remains pinned to `yangisu12@gmail.com` and the app-created `openclaw_cal`; no primary-calendar fallback is permitted.
- Only `assistant_query`, `assistant_mutate`, `assistant_calendar_manage`, `assistant_briefing`, `assistant_resource_store`, `assistant_study_manage`, `web_fetch`, and `pdf` may appear in the hardened tool allowlist.
- Shell, elevated tools, config writes, MCP management, plugin management, browser, `web_search`, and `x_search` remain disabled.
- `web_fetch` keeps strict SSRF defaults with `maxChars=100000`, `maxCharsCap=100000`, `maxResponseBytes=1000000`, `timeoutSeconds=30`, and `maxRedirects=3`.
- PDF analysis remains bounded to 10 MB and 20 pages.
- Extracted resource text is quoted untrusted data and is capped at 100,000 UTF-8 characters after normalization.
- Study plans originate only from user input. The study day is 08:00 through 02:00 the following civil day in `Asia/Seoul`.
- Default focus/break/reminder values are 50 minutes, 10 minutes, and two 15-minute follow-ups; 22:00 is interim reporting and 02:00 is final reporting.
- Every mutation is transactional or recoverable, idempotent when an operation/callback ID is available, and included in the existing workspace/state backup boundary.
- Implementation uses test-driven development: add one failing behavior test, observe the expected failure, implement only enough to pass, and rerun the focused and affected suites before each commit.

---

## File Map

### New production files

- `src/resources/types.ts` — resource IDs, metadata, save/read/search result contracts, URL canonicalization.
- `src/resources/codec.ts` — strict JSON metadata and bounded UTF-8 snapshot encoding/decoding.
- `src/resources/catalog.ts` — rebuildable SQLite catalog and deterministic Korean/English ranking.
- `src/tools/resource.ts` — `assistant_resource_store` TypeBox schema and tool factory.
- `src/study/types.ts` — block/settings/action contracts and state transition types.
- `src/study/clock.ts` — Seoul study-day mapping, quiet-window, and report-time calculations.
- `src/study/store.ts` — versioned SQLite schema, operations, audit ledger, block transitions, and next-due queries.
- `src/study/delivery.ts` — reminder/report presentation payloads and durable Telegram delivery.
- `src/study/service.ts` — one bounded timer, startup recovery, due processing, and clean shutdown.
- `src/tools/study.ts` — `assistant_study_manage` TypeBox schema and tool factory.
- `src/commands/register.ts` — `/save`, `/find`, `/memo`, and `/study` registration and parsing.
- `src/commands/telegram-study.ts` — `ocstudy:` callback validation and direct state transition.

### New test files

- `tests/resources/codec.test.ts`
- `tests/resources/catalog.test.ts`
- `tests/resources/repository.test.ts`
- `tests/tools/resource.test.ts`
- `tests/study/clock.test.ts`
- `tests/study/store.test.ts`
- `tests/study/delivery.test.ts`
- `tests/study/service.test.ts`
- `tests/tools/study.test.ts`
- `tests/commands/commands.test.ts`
- `tests/commands/telegram-study.test.ts`

### Existing files to modify

- `src/workspace/repository.ts` — add resource save/read through the existing prepared mutation, recovery, lock, and Git commit path.
- `src/tools/query.ts` — add resource search/read and study-block/status queries.
- `src/tools/register.ts` — register six optional plugin tools.
- `src/index.ts` — register tools, commands, interactive handler, and study service.
- `openclaw.plugin.json` — declare the two new tool contracts and metadata.
- `scripts/validate-mixed-entry.mjs` — require six tools, four commands, one service, and one Telegram handler.
- `config/openclaw.personal-assistant.example.json5` — allow six plugin tools plus `web_fetch` and `pdf`, bounded fetch/PDF settings, and DM inline buttons.
- `scripts/wsl/validate-hardened-config.js` — enforce the exact eight-tool and bounded web/PDF contract.
- `scripts/wsl/validate-runtime-tools.js` — enforce exactly six optional plugin tools.
- `scripts/wsl/install-openclaw.sh` — install/check the new configuration and preserve existing Cron jobs.
- `src/ops/backup.ts`, `src/ops/maintenance.ts`, and their tests — validate resource/catalog and study schema during isolated restore without starting the service.
- `docs/runbooks/openclaw-personal-assistant-install.md` and `docs/runbooks/openclaw-personal-assistant-acceptance.md` — document commands, limits, probes, cleanup, and recovery.

---

### Task 1: Resource contracts, canonical URLs, and bounded codec

**Files:**
- Create: `plugins/openclaw-personal-assistant/src/resources/types.ts`
- Create: `plugins/openclaw-personal-assistant/src/resources/codec.ts`
- Create: `plugins/openclaw-personal-assistant/tests/resources/codec.test.ts`

**Interfaces:**
- Produces: `canonicalizeResourceUrl(raw: string): string`
- Produces: `validateResourceId(id: string): string`
- Produces: `encodeResourceFiles(input: ResourceSaveInput, identity: ResourceIdentity): { metadata: string; content: string }`
- Produces: `decodeResourceFiles(metadata: string, content: string): StoredResource`
- Resource IDs match `^R-[0-9]{8}-[0-9]{3}$`.

- [ ] **Step 1: Write failing URL and size-boundary tests**

```ts
it('canonicalizes one public HTTP URL without credentials or fragments', () => {
  expect(canonicalizeResourceUrl('HTTPS://Example.COM:443/a?b=2#frag'))
    .toBe('https://example.com/a?b=2');
  expect(() => canonicalizeResourceUrl('https://owner:secret@example.com/a')).toThrow(/credentials/);
  expect(() => canonicalizeResourceUrl('file:///etc/passwd')).toThrow(/http/);
});

it('accepts exactly 100000 normalized characters and rejects 100001', () => {
  expect(encodeResourceFiles(resourceInput('가'.repeat(100_000)), identity()).content)
    .toHaveLength(100_001); // one final newline
  expect(() => encodeResourceFiles(resourceInput('가'.repeat(100_001)), identity()))
    .toThrow(/100000/);
});
```

- [ ] **Step 2: Run the codec test and verify RED**

Run: `npm test -- tests/resources/codec.test.ts`
Expected: FAIL because `src/resources/codec.ts` and exported contracts do not exist.

- [ ] **Step 3: Implement strict contracts and deterministic serialization**

```ts
export interface ResourceSaveInput {
  operationId: string;
  url: string;
  title: string;
  summary: string;
  claims: string[];
  tags: string[];
  contentType: 'web' | 'pdf';
  extractedText: string;
  extractedAt: string;
}

export function canonicalizeResourceUrl(raw: string): string {
  const value = new URL(raw);
  if (!['http:', 'https:'].includes(value.protocol)) throw resourceError('invalid_url');
  if (value.username || value.password) throw resourceError('url_credentials');
  value.hash = '';
  if ((value.protocol === 'https:' && value.port === '443') ||
      (value.protocol === 'http:' && value.port === '80')) value.port = '';
  return value.href;
}
```

Validate exact metadata keys, printable one-line titles, summary/claim/tag limits, unique tags, RFC 3339 extraction time, controls, `###` record-heading injection, JSON size, and a final newline. Normalize CRLF to LF and reject disallowed controls rather than silently deleting them.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -- tests/resources/codec.test.ts && npm run typecheck`
Expected: PASS with no warnings.

- [ ] **Step 5: Commit**

```bash
git add plugins/openclaw-personal-assistant/src/resources plugins/openclaw-personal-assistant/tests/resources/codec.test.ts
git commit -m "feat: define bounded resource archive format"
```

### Task 2: Git-backed resource mutation and recovery

**Files:**
- Modify: `plugins/openclaw-personal-assistant/src/workspace/repository.ts`
- Create: `plugins/openclaw-personal-assistant/tests/resources/repository.test.ts`

**Interfaces:**
- Consumes: resource codec from Task 1.
- Produces: `WorkspaceRepository.saveResource(operationId: string, input: ResourceSaveInput): Promise<ResourceMutationResult>`
- Produces: `WorkspaceRepository.readResource(id: string): Promise<StoredResource>`
- Produces: `WorkspaceRepository.listResources(): Promise<StoredResource[]>`
- `ResourceMutationResult` is `{ operationId, id, replayed, resource, gitCommit? }`.

- [ ] **Step 1: Write failing add, duplicate-URL update, replay, and crash-recovery tests**

```ts
it('keeps one stable ID when the same canonical URL is saved again', async () => {
  const first = await repo.saveResource('resource-save-1', resourceInput('https://example.test/a#one'));
  const second = await repo.saveResource('resource-save-2', resourceInput('https://EXAMPLE.test/a#two', 'updated'));
  expect(second.id).toBe(first.id);
  expect(second.resource.summary).toBe('updated');
  expect(gitLogFor(`resources/${first.id}`)).toHaveLength(2);
});

it.each(['beforeRename', 'afterRename', 'afterGitCommit'] as const)(
  'recovers an interrupted resource mutation at %s', async checkpoint => {
    await expect(interruptedRepo(checkpoint).saveResource('recover-resource', input)).rejects.toThrow();
    const recovered = await freshRepo().saveResource('recover-resource', input);
    expect(recovered.id).toMatch(/^R-/);
    expect(await freshRepo().readResource(recovered.id)).toMatchObject({ summary: input.summary });
  },
);
```

- [ ] **Step 2: Run the repository test and verify RED**

Run: `npm test -- tests/resources/repository.test.ts`
Expected: FAIL because the workspace repository has no resource methods or `save-resource` prepared action.

- [ ] **Step 3: Extend the existing prepared mutation pipeline**

Add `save-resource` to the prepared action union and allow prepared results to be a discriminated record/resource result. Under the existing `.assistant.lock`, operation ledger, rename verification, exact-tree Git recovery, and commit-message path:

```ts
const relativeRoot = `resources/${resourceId}`;
const files = [
  preparedFile(`${relativeRoot}/resource.json`, oldMetadata, encoded.metadata),
  preparedFile(`${relativeRoot}/content.md`, oldContent, encoded.content),
];
```

Allocate the next `R-YYYYMMDD-NNN` by scanning both active resource directories and operation-ledger prepared results. Find an existing resource by canonical URL before allocating. On replay, verify both committed hashes before returning. Reject symlinks, path traversal, dirty overlapping Git paths, conflicting URL/ID mappings, and a resource directory missing either file.

- [ ] **Step 4: Run resource and existing workspace recovery suites**

Run: `npm test -- tests/resources/repository.test.ts tests/workspace/repository.test.ts tests/workspace/lock-coordinator.test.ts`
Expected: PASS and existing record recovery semantics unchanged.

- [ ] **Step 5: Commit**

```bash
git add plugins/openclaw-personal-assistant/src/workspace/repository.ts plugins/openclaw-personal-assistant/tests/resources/repository.test.ts
git commit -m "feat: persist resource snapshots through workspace journal"
```

### Task 3: Rebuildable catalog and deterministic search

**Files:**
- Create: `plugins/openclaw-personal-assistant/src/resources/catalog.ts`
- Create: `plugins/openclaw-personal-assistant/tests/resources/catalog.test.ts`

**Interfaces:**
- Consumes: `WorkspaceRepository.listResources()`.
- Produces: `ResourceCatalog.sync(resources: StoredResource[]): void`
- Produces: `ResourceCatalog.search(query: string, limit: number): ResourceSearchHit[]`
- Produces: `ResourceCatalog.close(): void`

- [ ] **Step 1: Write failing Korean/English ranking and rebuild tests**

```ts
it('ranks title then tags then summary then body with stable ties', () => {
  catalog.sync([
    resource({ id: 'R-20260827-001', title: '에이전트 메모리', tags: ['AI'], summary: '기억 구조', text: '검색' }),
    resource({ id: 'R-20260827-002', title: '기타', tags: ['에이전트'], summary: 'AI 기억 구조', text: '메모리' }),
  ]);
  expect(catalog.search('에이전트', 5).map(hit => hit.id))
    .toEqual(['R-20260827-001', 'R-20260827-002']);
});

it('rebuilds a missing or corrupt catalog only from committed files', () => {
  corruptCatalogFile();
  expect(openAndSyncCatalog(resources).search('memory', 5)).toHaveLength(1);
});
```

- [ ] **Step 2: Run catalog tests and verify RED**

Run: `npm test -- tests/resources/catalog.test.ts`
Expected: FAIL because `ResourceCatalog` does not exist.

- [ ] **Step 3: Implement the versioned SQLite cache and scorer**

Create `resource-catalog.sqlite3` with `schema_meta` and `resources` tables. Store the resource content hash, normalized title/tags/summary/claims/text, and extraction time. Rebuild by replacing catalog rows in one transaction when schema/version/hash mismatches occur.

Use Unicode NFKC + lowercase normalization, split on Unicode punctuation/space, retain Hangul tokens, deduplicate terms, and compute an integer score per term: exact title 100, title prefix/substring 70, exact tag 60, summary/claim 30, content 10. Produce a control-free excerpt of at most 240 characters around the first match. Sort score descending, extraction time descending, then ID ascending.

- [ ] **Step 4: Run catalog tests and typecheck**

Run: `npm test -- tests/resources/catalog.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/openclaw-personal-assistant/src/resources/catalog.ts plugins/openclaw-personal-assistant/tests/resources/catalog.test.ts
git commit -m "feat: add local resource search catalog"
```

### Task 4: Resource tool and query integration

**Files:**
- Create: `plugins/openclaw-personal-assistant/src/tools/resource.ts`
- Modify: `plugins/openclaw-personal-assistant/src/tools/query.ts`
- Modify: `plugins/openclaw-personal-assistant/src/tools/register.ts`
- Create: `plugins/openclaw-personal-assistant/tests/tools/resource.test.ts`
- Modify: `plugins/openclaw-personal-assistant/tests/tools/tools.test.ts`

**Interfaces:**
- Produces: optional tool `assistant_resource_store` with `save` and `read` actions.
- Extends: `assistant_query` with `resource_search` and `resource_read`. Task 6 adds the study query actions only after their dependencies exist.

- [ ] **Step 1: Write failing owner, schema, trust, and catalog-reconciliation tests**

```ts
it('stores only owner-supplied bounded analysis and marks reads untrusted', async () => {
  const tool = createResourceTool(api, { requesterSenderId: 'tg:123' }, deps);
  const saved = await tool.execute('call-1', saveParams, undefined);
  expect(saved.details).toMatchObject({ id: 'R-20260827-001', replayed: false });
  const read = await tool.execute('call-2', { action: 'read', resourceId: 'R-20260827-001' }, undefined);
  expect(read.details).toMatchObject({ trust: 'quoted_untrusted_data' });
});
```

- [ ] **Step 2: Run focused tool tests and verify RED**

Run: `npm test -- tests/tools/resource.test.ts tests/tools/tools.test.ts`
Expected: FAIL because the tool and query branches are absent.

- [ ] **Step 3: Implement the schemas and factories**

Use TypeBox `additionalProperties: false`, existing `assertOwner`, operation IDs matching the current 128-byte rule, exact resource ID patterns, arrays capped at 32 claims/64 tags, and `extractedText` `maxLength: 100000`. After every save/replay, sync the catalog from committed resources before returning. Search limit is 1–20 and defaults to 5.

- [ ] **Step 4: Run tools, repository, and catalog tests**

Run: `npm test -- tests/tools/resource.test.ts tests/tools/tools.test.ts tests/resources`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/openclaw-personal-assistant/src/tools plugins/openclaw-personal-assistant/tests/tools
git commit -m "feat: expose resource archive and search tools"
```

### Task 5: Study clock and transactional state machine

**Files:**
- Create: `plugins/openclaw-personal-assistant/src/study/types.ts`
- Create: `plugins/openclaw-personal-assistant/src/study/clock.ts`
- Create: `plugins/openclaw-personal-assistant/src/study/store.ts`
- Create: `plugins/openclaw-personal-assistant/tests/study/clock.test.ts`
- Create: `plugins/openclaw-personal-assistant/tests/study/store.test.ts`

**Interfaces:**
- Produces: `studyDayKey(now: Date): string`
- Produces: `isStudyWindow(now: Date, settings: StudySettings): boolean`
- Produces: `StudyStore.plan(operationId, studyId, blocks): StudyPlanResult`
- Produces: `StudyStore.transition(operationId, blockId, action, now): StudyTransitionResult`
- Produces: `StudyStore.current(now): StudyDayStatus`
- Produces: `StudyStore.nextDue(now): StudyDueAction | null`
- Produces: `StudyStore.consumeDue(now): StudyDueAction | null`
- Produces: `StudyStore.recover(now): StudyRecoveryResult`

- [ ] **Step 1: Write failing cross-midnight clock tests**

```ts
it.each([
  ['2026-08-27T08:00:00+09:00', '2026-08-27'],
  ['2026-08-28T01:59:59+09:00', '2026-08-27'],
  ['2026-08-28T02:00:00+09:00', '2026-08-28'],
])('maps %s to study day %s', (instant, expected) => {
  expect(studyDayKey(new Date(instant))).toBe(expected);
});
```

- [ ] **Step 2: Write failing transition and recovery tests**

```ts
it('sends only two unanswered follow-ups then marks the block missed', () => {
  store.plan('p1', 'S-20260827-001', [blockAt('2026-08-27T10:00:00+09:00')]);
  expect(store.consumeDue(at('10:00'))?.kind).toBe('start');
  expect(store.consumeDue(at('10:15'))?.kind).toBe('follow_up');
  expect(store.consumeDue(at('10:30'))?.kind).toBe('follow_up');
  expect(store.consumeDue(at('10:45'))).toMatchObject({ kind: 'missed' });
});

it('preserves completed history while replacing only future planned blocks', () => {
  completeFirstBlock(store);
  store.replaceFuture('replace-1', studyId, replacement, at('12:00'));
  expect(store.get(firstId).status).toBe('completed');
});
```

- [ ] **Step 3: Run clock/store tests and verify RED**

Run: `npm test -- tests/study/clock.test.ts tests/study/store.test.ts`
Expected: FAIL because the study modules do not exist.

- [ ] **Step 4: Implement versioned STRICT SQLite tables and transitions**

Create `study.sqlite3` with `study_settings`, `study_blocks`, `study_operations`, `study_audit`, and `study_reports`. Use `BEGIN IMMEDIATE`, exact operation payload hashes, unique block IDs `B-YYYYMMDD-NNN`, unique audit operation IDs, and status checks enforced in code plus SQL constraints.

Allowed transitions are:

```ts
const TRANSITIONS = {
  planned: new Set(['active', 'skipped', 'missed']),
  active: new Set(['completed', 'snoozed', 'skipped', 'missed']),
  snoozed: new Set(['active', 'completed', 'skipped', 'missed']),
  completed: new Set(), skipped: new Set(), missed: new Set(),
} as const;
```

Validate non-overlapping blocks, exact `+09:00` timestamps, positive durations, the 08:00–02:00 window, existing study IDs, snooze 1–120 minutes, focus 10–180, break 0–60, follow-up 5–60, and maximum follow-ups 0–5. Recovery does not replay reminders older than the current active reminder window.

- [ ] **Step 5: Run focused and state regression tests**

Run: `npm test -- tests/study tests/state && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/openclaw-personal-assistant/src/study plugins/openclaw-personal-assistant/tests/study
git commit -m "feat: add durable study block state machine"
```

### Task 6: Study management tool

**Files:**
- Create: `plugins/openclaw-personal-assistant/src/tools/study.ts`
- Modify: `plugins/openclaw-personal-assistant/src/tools/query.ts`
- Modify: `plugins/openclaw-personal-assistant/src/tools/register.ts`
- Create: `plugins/openclaw-personal-assistant/tests/tools/study.test.ts`

**Interfaces:**
- Produces: optional `assistant_study_manage` actions `plan`, `replace_future`, `transition`, `status`, `settings_get`, and `settings_set`.
- Completes: query kinds `study_blocks` and `study_day_status` from Task 4.

- [ ] **Step 1: Write failing owner and plan-boundary tests**

```ts
it('rejects a block that does not reference an existing user study record', async () => {
  const tool = createStudyTool(api, ownerContext, depsWithoutStudyRecord);
  await expect(tool.execute('x', planParams, undefined)).rejects.toMatchObject({ code: 'study_not_found' });
});

it('does not write Google Calendar while planning internal blocks', async () => {
  await createStudyTool(api, ownerContext, deps).execute('x', planParams, undefined);
  expect(deps.calendarWrites).toBe(0);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/tools/study.test.ts`
Expected: FAIL because `assistant_study_manage` is absent.

- [ ] **Step 3: Implement strict TypeBox actions**

Require operation IDs for every mutation, resource-style exact object schemas, explicit ISO timestamps for every planned block, and a repository lookup proving the referenced record is an active `study`. Return compact block/status data and no external content trust marker. Do not call calendar mutation code.

- [ ] **Step 4: Run study tool, query, and store suites**

Run: `npm test -- tests/tools/study.test.ts tests/tools/tools.test.ts tests/study`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/openclaw-personal-assistant/src/tools plugins/openclaw-personal-assistant/tests/tools
git commit -m "feat: expose owner study management tool"
```

### Task 7: Commands and Telegram study buttons

**Files:**
- Create: `plugins/openclaw-personal-assistant/src/commands/register.ts`
- Create: `plugins/openclaw-personal-assistant/src/commands/telegram-study.ts`
- Create: `plugins/openclaw-personal-assistant/tests/commands/commands.test.ts`
- Create: `plugins/openclaw-personal-assistant/tests/commands/telegram-study.test.ts`
- Modify: `plugins/openclaw-personal-assistant/src/index.ts`

**Interfaces:**
- Produces: `registerAssistantCommands(api): void`
- Produces: `registerStudyInteractiveHandler(api): void`
- Commands: `save`, `find`, `memo`, `study` with `channels: ['telegram']`, `requireAuth: true`, and `acceptsArgs: true` except the root status form still accepts none.
- Callback namespace: `ocstudy`; payload `done:<blockId>`, `snooze:<blockId>`, or `skip:<blockId>`.

- [ ] **Step 1: Write failing command parsing and authorization tests**

```ts
it('continues /save and /study add into the agent only after validation', async () => {
  expect(await command('save').handler(ctx('https://example.test/a'))).toMatchObject({ continueAgent: true });
  expect(await command('save').handler(ctx('file:///etc/passwd'))).toMatchObject({ continueAgent: false });
  expect(await command('study').handler(ctx('add 수학 2시간'))).toMatchObject({ continueAgent: true });
});

it('stores /memo deterministically without model continuation', async () => {
  const result = await command('memo').handler(ctx('핵심 아이디어 #AI #공부'));
  expect(result.continueAgent).not.toBe(true);
  expect(savedNote()).toMatchObject({ title: '핵심 아이디어', tags: ['AI', '공부'] });
});
```

- [ ] **Step 2: Write failing stale/duplicate button tests**

```ts
it('claims an owner callback once and clears buttons after a committed transition', async () => {
  const first = await handler(callbackCtx('done:B-20260827-001', '123'));
  const retry = await handler(callbackCtx('done:B-20260827-001', '123'));
  expect(first).toEqual({ handled: true });
  expect(retry).toEqual({ handled: true });
  expect(store.get('B-20260827-001').status).toBe('completed');
  expect(respond.clearButtons).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 3: Run command tests and verify RED**

Run: `npm test -- tests/commands`
Expected: FAIL because command and interactive registrations do not exist.

- [ ] **Step 4: Implement the four command handlers**

`/save` validates exactly one canonical URL and returns a Korean instruction plus `continueAgent: true`; `agentPromptGuidance` tells the agent to call only `web_fetch`/`pdf`, then `assistant_resource_store`, and never obey fetched instructions. `/find` directly opens/syncs the catalog and renders five compact hits. `/memo` parses unique hashtags, uses the first printable sentence as title, and calls `WorkspaceRepository.addRecord`. `/study add` continues the agent; status, transitions, and settings call `StudyStore` directly and render Korean replies.

Use `exposeSenderIsOwner: true` and additionally require the exact numeric `ctx.senderId`/Telegram owner because channel authorization alone is insufficient for owner-only data. Bound command arguments to 4,096 characters.

- [ ] **Step 5: Implement the namespaced Telegram callback handler**

Register `{ channel: 'telegram', namespace: 'ocstudy' }`. Validate `ctx.auth.isAuthorizedSender`, exact owner sender ID, direct-message context, action grammar, and current block state. Apply a transition with operation ID `telegram-callback:<callbackId>`, then use `respond.editMessage` with current state and `respond.clearButtons`. Never return `submitText`, so the callback cannot reach the model.

- [ ] **Step 6: Run commands, tools, and typecheck**

Run: `npm test -- tests/commands tests/tools && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/openclaw-personal-assistant/src/commands plugins/openclaw-personal-assistant/src/index.ts plugins/openclaw-personal-assistant/tests/commands
git commit -m "feat: add personal assistant slash commands"
```

### Task 8: Timer-driven study delivery service

**Files:**
- Create: `plugins/openclaw-personal-assistant/src/study/delivery.ts`
- Create: `plugins/openclaw-personal-assistant/src/study/service.ts`
- Create: `plugins/openclaw-personal-assistant/tests/study/delivery.test.ts`
- Create: `plugins/openclaw-personal-assistant/tests/study/service.test.ts`
- Modify: `plugins/openclaw-personal-assistant/src/index.ts`

**Interfaces:**
- Produces: `buildStudyReminder(block, kind): ReplyPayload`
- Produces: `buildStudyReport(status, kind): ReplyPayload`
- Produces: `createStudyCoachService(api, deps?): OpenClawPluginService`
- Service ID: `openclaw-personal-assistant-study-coach`.

- [ ] **Step 1: Write failing presentation and fallback tests**

```ts
it('builds namespaced completion, snooze, and skip actions with text fallback', () => {
  const payload = buildStudyReminder(block, 'start');
  expect(payload.text).toContain('/study done B-20260827-001');
  expect(payload.presentation?.blocks).toContainEqual(expect.objectContaining({
    type: 'buttons',
    buttons: expect.arrayContaining([
      expect.objectContaining({ action: { type: 'callback', value: 'ocstudy:done:B-20260827-001' } }),
    ]),
  }));
});
```

- [ ] **Step 2: Write failing timer/restart/delivery tests with a fake clock**

```ts
it('arms only the next due transition and does not replay a stale reminder after restart', async () => {
  const service = createStudyCoachService(api, fakeRuntime(at('2026-08-27T10:40:00+09:00')));
  await service.start!(context);
  expect(sentMessages()).toEqual([]);
  expect(nextTimerAt()).toBe('2026-08-27T22:00:00+09:00');
});

it('records delivery failure and retries only inside the active reminder window', async () => {
  sender.failOnce();
  await runDueStart();
  expect(health.active('study-delivery')).toBeDefined();
  await advanceMinutes(5);
  expect(sender.attempts).toBe(2);
});
```

- [ ] **Step 3: Run delivery/service tests and verify RED**

Run: `npm test -- tests/study/delivery.test.ts tests/study/service.test.ts`
Expected: FAIL because service and presentation builders are absent.

- [ ] **Step 4: Implement durable presentation delivery**

Use `sendDurableMessageBatch({ cfg, channel: 'telegram', to: ownerId, payloads: [{ text, presentation }], durability: 'required' })`. Callback values must remain under Telegram's 64-byte cap. If inline buttons degrade, the text contains complete `/study` fallbacks. Acknowledge store delivery only for sent payload outcomes; report bounded public health codes on failure.

- [ ] **Step 5: Implement one bounded timer and recovery loop**

On `start`, load config, open the study store, run recovery, and schedule the earliest block reminder/retry/missed transition or 22:00/02:00 report. Arm at most one timer and cap each wait to one hour so wall-clock changes are re-evaluated. On callback completion or tool/command mutation, notify the in-process service through a module-local scheduler signal to recalculate. On `stop`, clear the timer, unsubscribe the signal, and close stores. Never create a Cron job or model call.

- [ ] **Step 6: Run study, delivery, command, and health suites**

Run: `npm test -- tests/study tests/commands tests/state/health.test.ts && npm run typecheck`
Expected: PASS without real waits or network calls.

- [ ] **Step 7: Commit**

```bash
git add plugins/openclaw-personal-assistant/src/study plugins/openclaw-personal-assistant/src/index.ts plugins/openclaw-personal-assistant/tests/study
git commit -m "feat: deliver restart-safe study coaching"
```

### Task 9: Manifest, hardening, installer, and backup compatibility

**Files:**
- Modify: `plugins/openclaw-personal-assistant/openclaw.plugin.json`
- Modify: `plugins/openclaw-personal-assistant/scripts/validate-mixed-entry.mjs`
- Modify: `plugins/openclaw-personal-assistant/tests/scripts.test.ts`
- Modify: `config/openclaw.personal-assistant.example.json5`
- Modify: `scripts/wsl/validate-hardened-config.js`
- Modify: `scripts/wsl/validate-runtime-tools.js`
- Modify: `scripts/wsl/install-openclaw.sh`
- Modify: `plugins/openclaw-personal-assistant/src/ops/backup.ts`
- Modify: `plugins/openclaw-personal-assistant/src/ops/maintenance.ts`
- Modify: `plugins/openclaw-personal-assistant/tests/ops/backup.test.ts`
- Modify: `plugins/openclaw-personal-assistant/tests/ops/maintenance.test.ts`

**Interfaces:**
- Runtime registration contract: six optional plugin tools, four commands, one service, one Telegram interactive handler, zero unapproved hooks.
- Hardened active tool allowlist: exactly eight names from Global Constraints.

- [ ] **Step 1: Change contract tests first and verify RED**

Update expected plugin tools to:

```js
const expectedTools = [
  'assistant_briefing', 'assistant_calendar_manage', 'assistant_mutate',
  'assistant_query', 'assistant_resource_store', 'assistant_study_manage',
];
```

Require command names `find`, `memo`, `save`, `study`; service ID `openclaw-personal-assistant-study-coach`; handler `{ channel: 'telegram', namespace: 'ocstudy' }`; and active config tools plus `web_fetch` and `pdf`.

Run: `npm test -- tests/scripts.test.ts tests/ops/backup.test.ts tests/ops/maintenance.test.ts`
Expected: FAIL against the four-tool manifest/config and restore checks.

- [ ] **Step 2: Update manifest and mixed-entry validator**

Add the two tool contracts and optional metadata. Extend the validator fake API with `registerInteractiveHandler`, require exactly the approved registrations, call command handlers only in unit tests, and keep zero unrelated hooks.

- [ ] **Step 3: Harden web/PDF and Telegram button configuration**

In the example and generated active config add:

```json5
tools: {
  allow: [
    'assistant_query', 'assistant_mutate', 'assistant_calendar_manage',
    'assistant_briefing', 'assistant_resource_store', 'assistant_study_manage',
    'web_fetch', 'pdf',
  ],
  web: { fetch: {
    enabled: true, maxChars: 100000, maxCharsCap: 100000,
    maxResponseBytes: 1000000, timeoutSeconds: 30, maxRedirects: 3,
    useTrustedEnvProxy: false,
  } },
  elevated: { enabled: false },
},
agents: { defaults: { pdfMaxBytesMb: 10, pdfMaxPages: 20 } },
channels: { telegram: { capabilities: { inlineButtons: 'dm' } } },
```

The validator must reject extra web providers, proxy/private-network exceptions, browser/search tools, broader inline-button scopes, non-exact limits, and tool list drift.

- [ ] **Step 4: Extend isolated restore verification**

After restore, open resource files/catalog and study schema read-only, rebuild catalog only inside the isolated restored state when missing, and assert no service/timer/channel delivery starts. Add tampered resource metadata/content and corrupt study schema fixtures that fail verification without applying to the live workspace.

- [ ] **Step 5: Run contract, config, backup, and installer suites**

Run: `npm test -- tests/scripts.test.ts tests/config tests/ops tests/config.test.ts && npm run plugin:validate`
Expected: PASS with `optionalToolCount: 6`.

- [ ] **Step 6: Commit**

```bash
git add plugins/openclaw-personal-assistant/openclaw.plugin.json plugins/openclaw-personal-assistant/scripts plugins/openclaw-personal-assistant/tests plugins/openclaw-personal-assistant/src/ops config scripts/wsl
git commit -m "chore: harden knowledge and study runtime"
```

### Task 10: Runbooks, full verification, local commit, and WSL deployment

**Files:**
- Modify: `docs/runbooks/openclaw-personal-assistant-install.md`
- Modify: `docs/runbooks/openclaw-personal-assistant-acceptance.md`
- Modify: `scripts/wsl/run-acceptance.sh`
- Modify: `scripts/wsl/run-live-probe.js`

**Interfaces:**
- Produces documented owner flows for `/save`, `/find`, `/memo`, `/study`, failure recovery, limits, and cleanup.
- Produces live evidence for six plugin tools, four commands, one service, one handler, resource round trip, and synthetic study transition.

- [ ] **Step 1: Add failing acceptance expectations**

Add non-live criteria for resource codec/search, study clock/store/service, command registration, hardening, and restore compatibility. Add live criteria that inspect registrations and perform bounded probes without Google Calendar writes.

Run: `npm test -- tests/scripts.test.ts`
Expected: FAIL until the scripts emit the new exact criteria and counts.

- [ ] **Step 2: Update runbooks and acceptance scripts**

Document that `/save` is best-effort for public non-JavaScript pages, PDF limits, 100 KB local snapshots, no paid/browser fallback, resource IDs, study-day cross-midnight behavior, button text fallbacks, and how to disable the plugin service without deleting data. Live probes create one example-domain resource and one future synthetic block, verify search/transition, then archive the resource and remove/cancel the synthetic block through public repository APIs. They must not call any Google Calendar API.

- [ ] **Step 3: Run the complete local verification suite**

From `plugins/openclaw-personal-assistant`:

```bash
npm run typecheck
npm test
npm run plugin:validate
```

From the repository root in Git Bash/WSL:

```bash
bash scripts/wsl/run-acceptance.sh --non-live
bash scripts/wsl/install-openclaw.sh --dry-run
```

Expected: all tests pass, mixed-entry validation reports six tools, non-live acceptance has zero failures, and dry run reports no mutation.

- [ ] **Step 4: Commit documentation and acceptance changes**

```bash
git add docs/runbooks scripts/wsl
git commit -m "docs: add knowledge and study coach operations"
```

- [ ] **Step 5: Verify the exact repository and active WSL targets before deployment**

Run:

```powershell
git status --short --branch
git remote -v
wsl.exe -d Ubuntu-24.04 -- bash -lc 'systemctl --user is-active openclaw-gateway.service; readlink -f ~/openclaw-setting-linux'
```

Expected: only intended changes, no detached HEAD, gateway active, and the WSL deployment checkout resolves to `/home/user/openclaw-setting-linux`. If no Git remote is configured, continue with local deployment and report push unavailable.

- [ ] **Step 6: Deploy through the repository installer and inspect runtime**

Synchronize committed source to the existing `/home/user/openclaw-setting-linux` checkout using the repository's established deployment path, then run:

```bash
bash scripts/wsl/install-openclaw.sh --finish
bash scripts/wsl/install-openclaw.sh --check
plugins/openclaw-personal-assistant/node_modules/.bin/openclaw plugins inspect openclaw-personal-assistant --runtime --json
plugins/openclaw-personal-assistant/node_modules/.bin/openclaw cron list --json
systemctl --user is-active openclaw-gateway.service
```

Expected: exactly six optional plugin tools, commands `find/memo/save/study`, one study service, Telegram handler namespace `ocstudy`, existing briefing/daily/monthly Cron jobs unchanged, and gateway active.

- [ ] **Step 7: Run bounded isolated resource and study probes with cleanup**

Use the acceptance live-probe entrypoint with an explicitly created owner-private temporary workspace and state directory. Save `https://example.com/`, find its unique probe tag, schedule a synthetic block at least five minutes ahead, exercise one direct `done` transition without waiting for Telegram, and verify audit/catalog state. Resolve and validate the exact temporary root before removing it. Confirm the active workspace was not mutated, no Google API request occurred, and no extra Cron job exists.

- [ ] **Step 8: Final verification and push/deployment report**

Run:

```powershell
git status --short --branch
git log -10 --oneline --decorate
git remote -v
```

If a remote exists, push the active branch and verify success. If none exists, do not invent one; report local commit hashes, successful local WSL deployment, and that push/remote deployment are unavailable.

---

## Completion Gate

Do not claim completion until all of the following are true:

- Every new production behavior had a failing test first and the expected RED failure was observed.
- `npm run typecheck`, `npm test`, and `npm run plugin:validate` pass cleanly.
- Non-live acceptance reports zero failures.
- Hardened config permits exactly six plugin tools plus `web_fetch` and `pdf` and rejects browser/search/shell expansion.
- Resource save/read/search and catalog rebuild pass bounded probes.
- Study clock, transitions, restart recovery, delivery failure, buttons, and reports pass fake-clock tests.
- Backup/restore verifies resources and study state without starting delivery.
- Active WSL gateway reports the intended registrations and stays active.
- Existing briefing and maintenance Cron jobs remain unchanged and no high-frequency study Cron exists.
- Git worktree is clean except for intentionally untracked user files, commits are present on the active branch, and push/deployment availability is accurately reported.
