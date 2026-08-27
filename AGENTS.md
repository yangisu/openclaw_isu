# Repository Agent Rules

- After completing work linked to a GitHub repository, commit, push, and deploy from the appropriate worktree and branch. If no remote is configured, commit locally and report that push and deployment are unavailable.
- Never use a ChatGPT/Codex Google Calendar app, connector, or `primary` calendar as a fallback for an OpenClaw calendar operation.
- OpenClaw calendar reads and writes must use only the repository's dedicated `assistant_query` and `assistant_calendar_manage` tools backed by the pinned `openclaw_cal` binding. If those tools fail or are unavailable, fail closed and report the error.
- Before any Google Calendar API request, verify that Google's live authenticated identity is the configured `yangisu12@gmail.com` account.
