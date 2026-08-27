# OpenClaw Knowledge Archive and Study Coach Design

## Goal

Extend the existing owner-only OpenClaw personal-assistant plugin with four user-facing workflows:

1. `/save <URL>` and equivalent natural-language requests fetch, analyze, and locally archive web pages and PDFs.
2. `/find <query>` and equivalent natural-language requests search saved resources by title, tags, summary, and extracted text.
3. `/memo <text>` provides a deterministic quick memo path while preserving the existing natural-language note flow.
4. `/study` manages only user-supplied study plans, schedules focus blocks, sends reminders, records responses, and reports progress.

The implementation must remain owner-scoped, local-first, recoverable after restarts, and usable without a paid external service.

## Existing System

The `openclaw-personal-assistant` plugin currently registers four optional owner-scoped tools:

- `assistant_query`
- `assistant_mutate`
- `assistant_calendar_manage`
- `assistant_briefing`

Its Markdown workspace stores tasks, studies, notes, preferences, memories, inbox records, and daily records. SQLite state provides idempotency, health, alert, backup, and calendar ledgers. Telegram is restricted to the configured numeric owner. The existing hourly briefing runs at exact hours from 08:00 through 22:00 Asia/Seoul.

## Chosen Approach

Add a local resource archive and a durable study-coach subsystem to the existing plugin. Reuse OpenClaw's built-in `web_fetch` and `pdf` tools for extraction and its channel delivery runtime for Telegram. Do not add an external vector database, hosted knowledge service, general browser, web search provider, shell access, or paid fallback.

This approach adds two optional plugin tools:

- `assistant_resource_store`
- `assistant_study_manage`

It also extends `assistant_query` with resource search and study-block reads. The active tool allowlist becomes the six plugin tools plus `web_fetch` and `pdf`.

## Security and Trust Boundary

- Every plugin tool, command, button callback, and background study delivery is restricted to the configured numeric Telegram owner.
- External page and PDF content is quoted untrusted data. Text extracted from a source must never be interpreted as instructions, tool arguments, authorization, or configuration.
- `web_fetch` retains OpenClaw's strict SSRF defaults: HTTP(S) only, private/internal destination blocking, DNS pinning, redirect revalidation, bounded redirects, response-size limits, and timeout limits.
- The hardened fetch configuration sets `maxChars` and `maxCharsCap` to 100,000, `maxResponseBytes` to 1,000,000, `timeoutSeconds` to 30, and `maxRedirects` to 3.
- Trusted environment proxy and private-network exceptions remain disabled.
- `pdf` is allowed only under the active agent's bounded PDF limits: at most 10 MB per PDF and 20 pages by default.
- The general browser, web search, X search, shell, elevated tools, runtime config writes, MCP management, and plugin management remain disabled.
- A failed or incomplete extraction must not produce a fabricated analysis or a partially published archive record. The bot may offer to save a link-only note only after the user requests that fallback.
- URLs containing credentials are rejected. Stored URLs must be canonical HTTP(S) URLs without fragments or embedded credentials.
- Saved external content is not loaded into startup context. It is returned only by explicit resource reads or searches and remains marked as untrusted.

## Resource Archive

### Stored data

Each resource has a stable resource ID, canonical URL, title, concise summary, key claims, tags, content type, extraction timestamp, source metadata, and a reference to an extracted-text snapshot. The cleaned extracted text is capped at 100 KB after UTF-8 normalization. Summary, claims, and tags are model-produced fields derived from the fetched content, while the snapshot preserves bounded source material for later search and reuse.

Resource metadata and extracted text live under an owner-private workspace resource directory and participate in the existing Git-backed workspace mutation boundary. Resource state needed for idempotency and indexing lives under the plugin state directory and is included in the existing encrypted backup boundary.

### Save flow

1. `/save <URL>` or a natural-language equivalent routes to the agent.
2. The agent uses `web_fetch` with a 100,000-character request cap for ordinary HTTP(S) pages. It uses `pdf` for a PDF URL or when the response identifies a PDF.
3. The agent treats returned content as data and produces a title, summary, claims, and tags.
4. The agent calls `assistant_resource_store` with an idempotent operation ID, the canonical source URL, structured analysis, and bounded extracted text.
5. The store validates all fields, writes a complete snapshot atomically, updates the local search catalog, commits the workspace mutation, and returns the resource ID.
6. The bot replies with the resource ID and a short summary.

The same canonical URL updates the existing resource rather than creating a duplicate. The resource ID stays stable, the previous committed version remains available through Git history, and an identical retry returns the prior result without another mutation.

JavaScript-only pages, login-protected pages, blocked hosts, unsupported documents, oversized documents, and extraction failures return explicit bounded error codes. No browser or paid scraping fallback is attempted.

### Search flow

`assistant_query` gains a `resource_search` query accepting a non-empty query and a result limit from 1 through 20. `/find` defaults to five results. Search normalizes Korean and English text, tokenizes whitespace and punctuation, and applies deterministic scoring with the following priority:

1. exact and prefix title matches;
2. exact tag matches;
3. summary and key-claim matches;
4. extracted-text matches;
5. stable recency and resource-ID tie breaking.

The first version does not use embeddings or an external search service. Natural-language requests remain useful because the agent can turn the request into one or more concrete search terms, inspect results, and issue a narrower follow-up query. Search results contain resource ID, title, tags, summary, URL, score, and bounded matching excerpts. Full snapshots require an explicit resource read by ID.

The catalog is rebuildable from committed resource files. Corrupt or missing catalog state must fail visibly or rebuild without modifying resource content.

## Study Coach

### Source of truth

The coach manages only plans supplied by the user. It must not invent subjects, targets, deadlines, or study obligations. Existing `study` records remain the durable user-plan source. Scheduled focus blocks reference a study record and live in SQLite state with an audit ledger.

If a user supplies exact times, the plan preserves them. If time is not specified, the agent reads existing study blocks and the dedicated Google calendar, then proposes or creates non-overlapping 50-minute study blocks separated by 10-minute breaks. Internal study blocks are not written to Google Calendar unless the user explicitly requests calendar publication through `assistant_calendar_manage`.

### Study-day boundary

A study day starts at 08:00 Asia/Seoul and ends at 02:00 the following civil day. Times from 00:00 through 01:59 belong to the study day that began the previous morning. Study reminders are suppressed outside that window.

Default settings are:

- focus duration: 50 minutes;
- break duration: 10 minutes;
- first reminder: at block start;
- unanswered follow-ups: after 15 minutes and after 30 minutes;
- maximum follow-ups: two;
- interim progress report: 22:00;
- final study-day report: 02:00.

Settings are owner-editable through `/study settings` and a validated `assistant_study_manage` settings action. Study-day start must remain earlier than the overnight end under the explicit cross-midnight model, and all configured values remain bounded.

### Block state and responses

A block has a stable ID, study-record ID, planned start and end, planned amount when applicable, status, reminder count, snooze state, and completion metadata. Valid states are `planned`, `active`, `completed`, `snoozed`, `skipped`, and `missed`.

At block start, the background service sends the owner a durable Telegram message containing the subject, goal, planned end, and inline buttons for completion, 15-minute snooze, and skip. The message also includes text-command fallbacks. If inline buttons are unavailable, the text fallback remains sufficient.

The plugin claims its namespaced Telegram callback values through an interactive handler before they can reach the model. Button callbacks and commands are idempotent. An expired or already handled action returns current state without applying a second transition. A snooze reschedules the next reminder without shifting unrelated blocks. With no owner response after the two follow-ups, the block becomes `missed`; missed work is reported but is not automatically rescheduled.

### Scheduler and recovery

The plugin registers a background service that calculates the next due study transition and arms a bounded timer instead of invoking the model every few minutes. The service uses the existing durable channel-message runtime and owner target. On gateway start or plugin reload it reads pending blocks, discards replay of stale reminders, marks materially elapsed blocks as missed when required, and schedules only the next valid transition.

All state transitions are transactional and recorded in an append-only audit table with idempotency keys. Gateway restart, WSL resume, retry, or duplicate callback must not produce duplicate reminders or duplicate transitions. Delivery failure records health state and retries only within a bounded active reminder window.

Changing a study plan preserves completed and skipped history. Only future, not-yet-started blocks may be replaced. The 22:00 report is an interim progress check because the study window continues overnight; the 02:00 report is the final report for that study day.

## Commands

All commands are registered by the plugin and are available only to the configured owner.

### `/save <URL>`

Requires exactly one URL. It continues into the agent so extraction and model analysis can occur, then uses `assistant_resource_store`. Missing, extra, unsupported, credential-bearing, or malformed URLs return usage or validation errors without a fetch.

### `/find <query>`

Requires a non-empty query. It runs deterministic local search and returns at most five compact results with IDs, titles, tags, summaries, original links, and excerpts. Natural-language follow-ups can read a selected result by ID.

### `/memo <text>`

Requires non-empty text. It bypasses model analysis and uses the same repository mutation boundary as `assistant_mutate`. Hashtags are removed from the body and stored as deduplicated tags. The first non-empty sentence, bounded to the note title limit, becomes the title. Existing natural-language note creation remains supported.

### `/study`

- `/study`: show the current study day's blocks and progress.
- `/study add <plan>`: continue into the agent, create or update the corresponding user-supplied study record, inspect calendar conflicts, and create blocks.
- `/study done [block-id]`: complete the explicit block or the single current actionable block.
- `/study snooze [minutes] [block-id]`: snooze by 15 minutes when minutes are omitted; require disambiguation when more than one block is actionable.
- `/study skip [block-id]`: skip the explicit block or the single current actionable block.
- `/study settings`: show settings.
- `/study settings <key> <value>`: validate and update one setting.

Malformed, ambiguous, expired, unauthorized, or conflicting actions fail closed with a concise user-facing explanation.

## Tool Contracts

### `assistant_resource_store`

Owner-only optional tool. Supports atomic `save` and `read` operations. `save` requires an idempotent operation ID, canonical URL, structured analysis, and extracted text no longer than 100 KB. `read` requires a resource ID and returns quoted untrusted data.

### `assistant_study_manage`

Owner-only optional tool. Supports block planning, block replacement, status transitions, current-day status, and settings reads/writes. Every mutation requires an idempotent operation ID. Planning inputs reference an existing or concurrently created study record and contain explicit ISO timestamps.

### `assistant_query` extensions

Adds `resource_search`, `resource_read`, `study_blocks`, and `study_day_status` query kinds. Results containing external content use `trust: quoted_untrusted_data`.

## Data Integrity and Backups

- Resource files use atomic temporary-file publication under the existing workspace lock.
- SQLite schemas use explicit versioned migrations and transactions.
- Git commits cover resource content and metadata but never tokens, credentials, callback secrets, or private runtime state.
- The existing backup covers the workspace and plugin state, including resource snapshots, study blocks, settings, audit entries, and search catalog state.
- Restore verification must include resource/catalog consistency and study schema readability without starting reminder delivery inside the isolated restore root.

## Testing

Implementation follows test-driven development. Required automated coverage includes:

- resource input validation, canonical URL deduplication, 100 KB boundary, atomic publication, idempotent retry, update history, and catalog rebuild;
- Korean and English search ranking, tags/title boosts, excerpts, stable ties, corrupt catalog recovery, and result limits;
- command authorization, parsing, `/memo` tag extraction, command-to-agent continuation, and concise validation failures;
- study-day calculation across midnight, conflict rejection, block replacement rules, state transitions, snooze behavior, two-reminder limit, stale-button idempotency, interim/final summaries, delivery failure, restart recovery, and sleeping-time suppression;
- plugin manifest and runtime registration for exactly six optional plugin tools plus the two explicitly allowed built-in read tools;
- hardened configuration validation keeping all unrelated dangerous tools and commands disabled;
- backup and isolated restore compatibility;
- WSL runtime inspection, Telegram command visibility, one bounded resource save/search probe, and one synthetic study reminder lifecycle with cleanup.

Live tests must not leave Google Calendar events, duplicate resource records, study reminders, Cron jobs, or Telegram test actions behind. Google Calendar requests remain subject to the repository rule requiring live identity verification for `yangisu12@gmail.com` and the pinned `openclaw_cal` binding.

## Deployment

Build and validate the mixed plugin, update the hardened OpenClaw configuration allowlist, deploy the plugin into the active WSL installation, restart or reload the user gateway safely, and inspect runtime registration. Preserve the existing hourly briefing and maintenance jobs. The study scheduler is plugin-service owned and must not create a model-backed high-frequency Cron job.

Commit changes on the active repository branch. If no Git remote exists, retain local commits and report that push and remote deployment are unavailable. Deployment to the active local WSL OpenClaw instance remains required.

## Non-Goals

- General-purpose browsing or web search
- Login automation or paywall bypass
- JavaScript browser rendering fallback
- External vector databases or hosted knowledge services
- Automatic invention of study plans or obligations
- Automatic publication of study blocks to Google Calendar
- Automatic rescheduling of missed work
- Changes to the user's primary Google calendar
