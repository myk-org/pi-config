# Project-Level Settings

Settings file: `.pi/pi-config-settings.jsonc` (preferred) or `.pi/pi-config-settings.json`.
Both extensions supported; `.jsonc` allows comments. Per-project settings override global.

| Setting | Type | Default | Env var | Description |
|---|---|---|---|---|
| `commit_trailer` | string | disabled | `PI_COMMIT_TRAILER` | Commit trailer name: `"Assisted-by"` = adds `Assisted-by: PI (<model>)`, `"A, B"` = ask user which trailer |
| `allow_push_to_protected_branches` | boolean | disabled | `PI_ALLOW_PUSH_TO_PROTECTED_BRANCHES` | Allow commits/pushes to protected branches |
| `use_worktrees` | boolean | disabled | `PI_USE_WORKTREES` | Force worktree-only workflow |
| `dream_interval_hours` | number | 3 | `PI_DREAM_INTERVAL_HOURS` | Dream frequency |
| `dco` | boolean | disabled | `PI_DCO` | Add --signoff to all commits (DCO) |
| `comment_signature` | boolean | disabled | — | Append AI signature to all PR comments |
| `review_loop_enforcement` | boolean | disabled | `PI_REVIEW_LOOP_ENFORCEMENT` | Block git commit until all 5 reviewers approve (review loop enforcement) |
| `orchestrator_edit_write_block` | boolean | `false` | — | Block orchestrator from using edit and write tools directly (must delegate to subagents). |
| `review_loop_max_cycles` | number | `3` | `PI_REVIEW_LOOP_MAX_CYCLES` | Max review-loop cycles when `review_loop_enforcement` is enabled. Accepts JSON integers `1`-`10`, or digit strings `"1"`-`"10"` only (after trim). Rejects out-of-range values and non-digit forms (`"01"`, `"10.0"`, `"1e1"`, hex/binary, `"inf"`, `Infinity`, …) — those fall through to the next resolution layer / default `3`. Injected into orchestrator rules text via `{{REVIEW_LOOP_MAX_CYCLES}}` (prompt/LLM compliance only; see `rule-placeholders.ts`). Disable the review loop via `review_loop_enforcement: false`, not via max_cycles. Reaching the cap blocks re-dispatch (step 2 / all 6 agents, including test-automator) after 5a — no further verification dispatch unless `review_loop_max_cycles` is raised; report **Not fixed** (explained why not → outstanding) vs **Fixed** (verification blocked by the cap — cannot re-dispatch to confirm clean). When cap is reached with `status: has_findings`, empty `reviewers_pending`, and `tests_passed: true`, `isCommitAllowed` allows commit (nothing more to review). |
| `acpx_agents` | string or string[] | `[]` | `ACPX_AGENTS` | acpx agents to register as `acpx-*` models via createProvider (pi ≥ 0.84.0). Ambient auth when configured (`agents.has`); `/login` stores optional marker. See `dev-docs/async-internals.md` |
| `cli_agents` | string or string[] | `[]` | `CLI_AGENTS` | CLI agents to register as `cli-*` providers via createProvider (pi ≥ 0.84.0; e.g. `"cursor"` or `["claude","gemini","cursor"]`). Ambient auth when configured (PATH + AgentState); `/login` optional marker. See `dev-docs/cli-provider.md` |
| `pidash_enable` | boolean | `true` | `PI_PIDASH_ENABLE` | Enable pidash web dashboard (`false`/`0`/`no`/`off` disables) |
| `pidiff_enable` | boolean | `true` | `PI_PIDIFF_ENABLE` | Enable pidiff diff viewer (`false`/`0`/`no`/`off` disables) |
| `pidash_port` | number | `19190` | `PI_PIDASH_PORT` | pidash HTTP/WebSocket port |
| `image_model` | string | disabled | `PI_IMAGE_MODEL` | Gemini image model for `generate_image` tool |
| `internal_operations_provider` | string | unset | `PI_INTERNAL_OPERATIONS_PROVIDER` | Provider for detached LLM async children when parent is acpx (dream/cron/fireAndForget). Both this and `internal_operations_model` required. |
| `internal_operations_model` | string | unset | `PI_INTERNAL_OPERATIONS_MODEL` | Model id for those children. If unset on acpx, must-async LLM work is skipped. |
| `agent_provider` | string | `""` | — | Default provider for all subagents (e.g. `cli-cursor`). |
| `agent_model` | string | `""` | — | Default model for all subagents (e.g. `cursor:cursor-grok-4.5-high-fast`). |
| `agent_overrides` | object | `{}` | — | Per-agent provider/model overrides. `null` values = use parent model (skip global setting). |
| `vertex_claude_1m` | boolean | `false` | `VERTEX_CLAUDE_1M` | Enable 1M context window variants for Vertex Claude models |
| `sidecar_log_level` | string | `info` | `PI_SIDECAR_LOG_LEVEL` | Pi-sidecar log level: `debug`, `info`, `warn`, `error` |
| `async_debug` | boolean | `false` | `PI_ASYNC_DEBUG` | Enable debug logging for async agents |
| `enforcement_allowed_commands` | string | `""` | `PI_ENFORCEMENT_ALLOWED_COMMANDS` | Colon-separated command allowlist for enforcement. Empty = allow all |
| `coms_max_hops` | number | `5` | `PI_COMS_MAX_HOPS` | Max message relay hops for P2P coms (1-50) |
| `coms_timeout_ms` | number | `1800000` | `PI_COMS_TIMEOUT_MS` | P2P coms message response timeout in milliseconds |
| `coms_ping_interval_ms` | number | `10000` | `PI_COMS_PING_INTERVAL_MS` | P2P coms peer ping interval in milliseconds |
| `coms_dir` | string | `""` | `PI_COMS_DIR` | P2P coms data directory. Empty = `~/.pi/coms` |
| `coms_net_port` | number | `0` | `PI_COMS_NET_PORT` | Coms-net server listen port. `0` = OS picks a random free port |
| `coms_net_host` | string | `127.0.0.1` | `PI_COMS_NET_HOST` | Coms-net server bind host (use `0.0.0.0` for LAN access — requires auth token) |
| `coms_net_auth_token` | string | `""` | `PI_COMS_NET_AUTH_TOKEN` | Coms-net auth token for remote access. Empty = auto-generated for loopback |
| `coms_net_public_url` | string | `""` | `PI_COMS_NET_PUBLIC_URL` | Coms-net public URL for remote peers to connect to |
| `coms_net_server_url` | string | `""` | `PI_COMS_NET_SERVER_URL` | Remote coms-net server URL to connect to (client mode) |
| `coms_net_max_hops` | number | `5` | `PI_COMS_NET_MAX_HOPS` | Max message relay hops for coms-net (1-50) |
| `coms_net_message_ttl_ms` | number | `1800000` | `PI_COMS_NET_MESSAGE_TTL_MS` | Coms-net message time-to-live in milliseconds |
| `coms_net_max_inbox` | number | `100` | `PI_COMS_NET_MAX_INBOX` | Max queued messages per agent (1-10000) |
| `coms_net_heartbeat_ms` | number | `10000` | `PI_COMS_NET_HEARTBEAT_MS` | Coms-net heartbeat interval in milliseconds |
| `coms_net_stale_after_ms` | number | `30000` | `PI_COMS_NET_STALE_AFTER_MS` | Coms-net stale peer threshold in milliseconds |
| `coms_net_offline_after_ms` | number | `60000` | `PI_COMS_NET_OFFLINE_AFTER_MS` | Coms-net offline peer threshold in milliseconds |
| `coms_net_log_heartbeat` | boolean | `false` | `PI_COMS_NET_LOG_HEARTBEAT` | Log coms-net heartbeat traffic (very noisy) |
| `coms_net_log_quiet` | boolean | `false` | `PI_COMS_NET_LOG_QUIET` | Suppress all coms-net logs except startup/shutdown |

Resolution: project file → global `~/.pi/pi-config-settings.jsonc` or `.json` → env var → default.

Model resolution priority (highest wins): explicit subagent `model` param > `agent_overrides[name]` > agent frontmatter > `agent_provider`/`agent_model` setting > parent model.

Module: `extensions/orchestrator/project-settings.ts`

## Settings Keys Definition

All setting keys, types, env vars, and defaults are defined in `settings-keys.json` (repo root).
Both TypeScript and Python implementations derive from this single source of truth.

## CLI

```bash
uv run myk-pi-tools settings get              # all keys as JSON
uv run myk-pi-tools settings get dco use_worktrees  # specific keys
```

## Agent Prompt Injection

Use `{{SETTINGS:key1,key2}}` in agent `.md` files to inject resolved values at prompt assembly time.
The placeholder is replaced by `substituteSettingsPlaceholders` in `rule-placeholders.ts`
before the system prompt reaches any model (native or CLI/ACPX).

Never instruct agents to read `pi-config-settings.jsonc`/`.json` manually.

## TUI Editor

The `/pi-config-settings [project|global]` slash command opens an interactive TUI overlay for editing settings.

- **Two scopes:** `project` (writes to `<repo>/.pi/pi-config-settings.json`) and `global` (writes to `~/.pi/pi-config-settings.json`). Press Tab to switch.
- **Source indicators:** Each setting shows its source: `P` (project file), `G` (global file), `E` (env var), `D` (default).
- **Smart pickers:** Provider and model fields use fuzzy-searchable `SelectList` from `ctx.modelRegistry`.
- **Agent lists:** `acpx_agents` and `cli_agents` use multi-select with ☑/☐ toggles.
- **Agent overrides:** Nested per-agent provider/model editor.
- **Secret masking:** Keys matching `token|secret|password|auth` are masked in the list and never prefilled in the editor.
- **JSONC preservation:** TUI always writes to `.json` (not `.jsonc`) to preserve user comments in `.jsonc` files.
- **Immediate save:** Each change writes immediately with `clearSettingsCache()`.

Files: `extensions/orchestrator/settings-tui.ts`, `settings-tui-helpers.ts`, `settings-tui-submenus.ts`.
