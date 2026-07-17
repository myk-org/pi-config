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
| `acpx_agents` | string or string[] | `[]` | `ACPX_AGENTS` | acpx agents to register as pi models (e.g. `"cursor"` or `["cursor","claude"]`) |
| `cli_agents` | string or string[] | `[]` | `CLI_AGENTS` | CLI agents to register as `cli-*` providers (e.g. `"cursor"` or `["claude","gemini","cursor"]`). See `dev-docs/cli-provider.md` |
| `pidash_enable` | boolean | `true` | `PI_PIDASH_ENABLE` | Enable pidash web dashboard (`false`/`0`/`no`/`off` disables) |
| `pidiff_enable` | boolean | `true` | `PI_PIDIFF_ENABLE` | Enable pidiff diff viewer (`false`/`0`/`no`/`off` disables) |
| `pidash_port` | number | `19190` | `PI_PIDASH_PORT` | pidash HTTP/WebSocket port |
| `image_model` | string | disabled | `PI_IMAGE_MODEL` | Gemini image model for `generate_image` tool |
| `async_llm_provider` | string | unset | `PI_ASYNC_LLM_PROVIDER` | Provider for detached LLM async children when parent is acpx (dream/cron/fireAndForget). Both this and `async_llm_model` required. |
| `async_llm_model` | string | unset | `PI_ASYNC_LLM_MODEL` | Model id for those children. If unset on acpx, must-async LLM work is skipped. |

Resolution: project file → global `~/.pi/pi-config-settings.json` → env var → default.

Module: `extensions/orchestrator/project-settings.ts`
