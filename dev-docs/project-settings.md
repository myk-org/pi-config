# Project-Level Settings

Settings file: `.pi/pi-config-settings.json` — per-project configuration overriding global env vars.

| Setting | Type | Default | Env var | Description |
|---|---|---|---|---|
| `commit_trailer` | string | disabled | `PI_COMMIT_TRAILER` | Commit trailer name: `"Assisted-by"` = adds `Assisted-by: PI (<model>)`, `"A, B"` = ask user which trailer |
| `allow_push_to_protected_branches` | boolean | disabled | `PI_ALLOW_PUSH_TO_PROTECTED_BRANCHES` | Allow commits/pushes to protected branches |
| `use_worktrees` | boolean | disabled | `PI_USE_WORKTREES` | Force worktree-only workflow |
| `dream_interval_hours` | number | 3 | `PI_DREAM_INTERVAL_HOURS` | Dream frequency |
| `dco` | boolean | disabled | `PI_DCO` | Add --signoff to all commits (DCO) |
| `comment_signature` | boolean | disabled | — | Append AI signature to all PR comments |
| `review_loop_enforcement` | boolean | disabled | `PI_REVIEW_LOOP_ENFORCEMENT` | Block git commit until all 5 reviewers approve (review loop enforcement) |

Resolution: project file → global `~/.pi/pi-config-settings.json` → env var → default.

Module: `extensions/orchestrator/project-settings.ts`
