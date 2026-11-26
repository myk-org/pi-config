# Configuration & Settings

Every key below is declared in `settings-keys.json` at the repository root, which is the source of truth for types, defaults, ranges, and env var names. This page covers the common ones; `settings-keys.json` lists the rest.

## Settings Files

Both settings files use the same name, `pi-config-settings.json` — plain JSON. It is the only settings filename read, project and global; a legacy `pi-config-settings.jsonc` is migrated into it once and then ignored (see [Project Settings Internals](project-settings.html)).

### Project settings file

| Parameter | Type | Default | Description | Effect |
|---|---|---|---|---|
| Path | string | none | `.pi/pi-config-settings.json` in the repository root. | Highest-precedence settings source for the current project. |

```json
{
  "pidash_enable": true,
  "pidash_port": 19190
}
```

### Global settings file

| Parameter | Type | Default | Description | Effect |
|---|---|---|---|---|
| Path | string | none | `~/.pi/pi-config-settings.json` in the current user's home directory. | Fallback settings source for all projects when a key is not set in the project file. |

```json
{
  "dream_interval_hours": 6,
  "review_loop_enforcement": true
}
```

### Resolution order

| Parameter | Type | Default | Description | Effect |
|---|---|---|---|---|
| Resolution order | ordered list | built-in default last | Settings resolve in this order: project file → global file → environment variable → default. | Determines which value is used when the same key appears in multiple places. |

```text
project file -> global file -> environment variable -> default
```

### Editing settings without a text editor

| Parameter | Type | Default | Description | Effect |
|---|---|---|---|---|
| `/pi-config-settings` | slash command | none | Opens an interactive settings TUI over the same keys. | Saves to the file for the scope you are editing (project or global), and shows the valid values and env var for every key. |

```text
/pi-config-settings
```

Use it when you would rather not guess an env var name or a numeric range — the TUI shows the valid values for every key. For the internals — source indicators, smart pickers, and how writes are performed — see [Project Settings Internals](project-settings.html).

## Git & Workflow Keys

### `commit_trailer`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `commit_trailer` | string or `false` | `false` | `PI_COMMIT_TRAILER` | Commit trailer name, or a comma-separated list of trailer names. | Injects a trailer into `git commit` commands when a string value is set. |

> **Note:** A comma-separated string such as `"Assisted-by,Co-authored-by"` is treated as a list of trailer names; the user picks one per session and the choice is reused. The injected value is `<Trailer>: PI (<model-id>)`.

```json
{
  "commit_trailer": "Assisted-by"
}
```

```bash
export PI_COMMIT_TRAILER="Assisted-by"
```

### `allow_push_to_protected_branches`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `allow_push_to_protected_branches` | boolean | `false` | `PI_ALLOW_PUSH_TO_PROTECTED_BRANCHES` | Allows commits and pushes to protected branches. | Disables the protected-branch block in git enforcement. |

```json
{
  "allow_push_to_protected_branches": true
}
```

```bash
export PI_ALLOW_PUSH_TO_PROTECTED_BRANCHES=true
```

### `use_worktrees`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `use_worktrees` | boolean | `false` | `PI_USE_WORKTREES` | Forces worktree-only branch workflows. | Blocks `git switch` and branch-changing `git checkout`; file restores such as `git checkout -- <path>` still pass. Suggests `git worktree add .worktrees/<name> -b <branch> <main>`. |

```json
{
  "use_worktrees": true
}
```

```bash
export PI_USE_WORKTREES=true
```

### `dco`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `dco` | boolean | `false` | `PI_DCO` | Enables Developer Certificate of Origin signing. | Adds `--signoff` to `git commit` when the flag is not already present. |

```json
{
  "dco": true
}
```

```bash
export PI_DCO=true
```

### `orchestrator_edit_write_block`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `orchestrator_edit_write_block` | boolean | `false` | none | Blocks the top-level orchestrator from calling `edit` and `write` directly. | File changes must be delegated through the `subagent` tool. Subagent child processes are not blocked by this key. |

```json
{
  "orchestrator_edit_write_block": true
}
```

See [Managing Custom Agents](managing-custom-agents.html) for details.

## Review & PR Keys

### `comment_signature`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `comment_signature` | boolean | `false` | none | Enables an AI signature on PR comments posted through the review CLI helpers. | Sets the `PI_COMMENT_SIGNATURE` process variable on session start for review tooling to read. |

```json
{
  "comment_signature": true
}
```

See [Automating Code Reviews](automating-code-reviews.html) for details.

### `review_loop_enforcement`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `review_loop_enforcement` | boolean | `false` | `PI_REVIEW_LOOP_ENFORCEMENT` | Enables review-loop enforcement. | Blocks `git commit` until the review state is clean and tests have passed. Also enables the review status UI slot. |

```json
{
  "review_loop_enforcement": true
}
```

```bash
export PI_REVIEW_LOOP_ENFORCEMENT=true
```

See [Automating Code Reviews](automating-code-reviews.html) for details.

### `review_loop_max_cycles`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `review_loop_max_cycles` | integer `1`-`10` | `3` | `PI_REVIEW_LOOP_MAX_CYCLES` | Maximum number of review-loop cycles when review-loop enforcement is enabled. | Caps reviewer re-dispatch count **for the subject under review** — the open PR at its head commit, else the local commit, or the plan/issue a caller names explicitly. A different subject starts counting at 1, and a loop that finishes clean restarts, so the cap can never latch onto unrelated work. Invalid values fall through to the next resolution layer or the default. |

> **Warning:** Accepted values are integers `1` through `10`, or digit strings `"1"` through `"10"`. Values such as `0`, `11`, `"01"`, `"10.0"`, `"1e1"`, and `"inf"` are ignored.

```json
{
  "review_loop_max_cycles": 5
}
```

```bash
export PI_REVIEW_LOOP_MAX_CYCLES=7
```

See [Automating Code Reviews](automating-code-reviews.html) for details.

### `pr_retro_on_merge`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `pr_retro_on_merge` | boolean | `false` | `PI_PR_RETRO_ON_MERGE` | Enables opt-in post-merge PR retrospective triggers. | When `true`, injects the `{{IF:pr_retro_on_merge}}` rule block and watches successful `gh pr merge` completions (bash and `github-expert` subagent) to run the `$0` collector (`scripts/pr-retro-collect.mjs`) and dispatch a read-only background retrospective writing `.pi/data/retros/pr-<N>.md`. Zero prompt tokens and zero runtime overhead when `false`. Manual `/retro [pr-number]` works regardless of this setting. |

```json
{
  "pr_retro_on_merge": true
}
```

```bash
export PI_PR_RETRO_ON_MERGE=true
```

### `advisor_enabled`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `advisor_enabled` | boolean | `false` | `PI_ADVISOR_ENABLED` | Enables the opt-in background read-only advisor/watchdog model. | Defaults to `false` so extra LLM tokens are never spent unless opted in. When `true`, periodically reviews recent transcript deltas in the background with zero tools (read-only) and injects a concise hidden course-correction note on the next turn only when it finds a concrete bug, spec drift, or stuck retry loop (silent when clean). Always skipped for subagent children (`PI_SUBAGENT_CHILD=1`) and skipped in headless/RPC hosts unless `PI_ADVISOR_ALLOW_HEADLESS=1` is set. Token usage and cost are logged via `createLogger("advisor")`. |

```json
{
  "advisor_enabled": true
}
```

```bash
export PI_ADVISOR_ENABLED=true
```

### `advisor_model`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `advisor_model` | string (`provider/model-id` or `""`) | `""` | `PI_ADVISOR_MODEL` | Explicit `provider/model-id` for the background advisor LLM (for example `google/gemini-2.5-flash` or `anthropic/claude-sonnet-4-5`). | Empty string inherits the active session model. Non-empty values are validated as `provider/model-id` and editable via the fuzzy model picker in `/pi-config-settings`. Invalid or unavailable models fail soft (log warning, never block the session). |

```json
{
  "advisor_model": "google/gemini-2.5-flash"
}
```

```bash
export PI_ADVISOR_MODEL="google/gemini-2.5-flash"
```

### `advisor_interval_turns`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `advisor_interval_turns` | integer `1`-`50` | `5` | `PI_ADVISOR_INTERVAL_TURNS` | Number of completed turns between scheduled background advisor checkpoints. | Controls watchdog cadence to bound extra token spend. Consecutive error/retry loops (3+ error turns in a row) can also trigger an early check. |

```json
{
  "advisor_interval_turns": 5
}
```

```bash
export PI_ADVISOR_INTERVAL_TURNS=5
```

## Provider Registration & Model Routing

### `agent_provider`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `agent_provider` | string | `""` | none | Default provider for subagents. | Used when a per-agent override and agent frontmatter do not provide a provider. |

```json
{
  "agent_provider": "google"
}
```

### `agent_model`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `agent_model` | string | `""` | none | Default model ID for subagents. | Used when a per-agent override and agent frontmatter do not provide a model. |

```json
{
  "agent_model": "cursor:cursor-grok-4.5-high-fast"
}
```

### `agent_overrides`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `agent_overrides` | object | `{}` | none | Per-agent provider/model overrides. | Highest-precedence settings layer for subagent model routing. |
| `provider` | string or `null` | inherited | none | Provider override for a named agent. | `null` means inherit the parent provider directly. |
| `model` | string or `null` | inherited | none | Model override for a named agent. | `null` means inherit the parent model directly. |

| Resolution priority | Source |
|---|---|
| 1 | `agent_overrides[name]` |
| 2 | Agent frontmatter (`provider`, `model`) |
| 3 | `agent_provider` / `agent_model` |
| 4 | Parent session provider/model |

```json
{
  "agent_provider": "google",
  "agent_model": "gemini-2.5-pro",
  "agent_overrides": {
    "debugger": {
      "provider": null,
      "model": null
    },
    "reviewer": {
      "provider": "anthropic",
      "model": "claude-sonnet"
    }
  }
}
```

See [Managing Custom Agents](managing-custom-agents.html) for details.

### `vertex_claude_1m`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `vertex_claude_1m` | boolean | `false` | `VERTEX_CLAUDE_1M` | Registers the Vertex AI Claude models with their 1M-token context window. | Sets `VERTEX_CLAUDE_1M=true` in the process environment on session start, so the Vertex Claude provider advertises the extended context instead of the standard one. |

```json
{
  "vertex_claude_1m": true
}
```

```bash
export VERTEX_CLAUDE_1M=true
```

See [Vertex Claude Provider](vertex-claude-provider.html) for details.

## Dashboard & UI Keys

### `pidash_enable`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `pidash_enable` | boolean | `true` | `PI_PIDASH_ENABLE` | Enables the global dashboard extension. | Controls `/pidash` availability and daemon connection behavior. |

> **Note:** Environment values `false`, `0`, `no`, and `off` disable pidash.

```json
{
  "pidash_enable": false
}
```

```bash
export PI_PIDASH_ENABLE=false
```

### `pidiff_enable`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `pidiff_enable` | boolean | `true` | `PI_PIDIFF_ENABLE` | Enables the diff viewer extension. | Controls `/pidiff` availability and per-project diff server startup. |

> **Note:** Environment values `false`, `0`, `no`, and `off` disable pidiff.

```json
{
  "pidiff_enable": false
}
```

```bash
export PI_PIDIFF_ENABLE=off
```

### `pidash_port`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `pidash_port` | integer | `19190` | `PI_PIDASH_PORT` | HTTP and WebSocket port for pidash. | Sets the port used when spawning or reconnecting to the pidash daemon. |

> **Warning:** Only integer values in the range `1`-`65535` are accepted. Invalid values fall back to the next resolution layer or the default.

```json
{
  "pidash_port": 19191
}
```

```bash
export PI_PIDASH_PORT=19191
```

See [Using the Web Dashboard](using-the-web-dashboard.html) for details.

### `pidiff_daemon_startup_timeout_s`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `pidiff_daemon_startup_timeout_s` | integer `10`-`300` | `60` | `PI_PIDIFF_DAEMON_STARTUP_TIMEOUT_S` | Seconds to wait for the pidiff diff server to accept connections. | Bounds the startup probe after a spawn or reconnect; once it elapses, pidiff gives up on that attempt instead of hanging the caller. Raise it on slow machines or busy containers. |

> **Warning:** Only integer values in the range `10`-`300` are accepted. Invalid values fall back to the next resolution layer or the default.

```json
{
  "pidiff_daemon_startup_timeout_s": 120
}
```

```bash
export PI_PIDIFF_DAEMON_STARTUP_TIMEOUT_S=120
```

### `pidiff_stale_lock_timeout_ms`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `pidiff_stale_lock_timeout_ms` | integer | `60000` | `PI_PIDIFF_STALE_LOCK_TIMEOUT_MS` | Timeout for a stale pidiff spawning lockfile (ms). | If a previous pidiff process died while holding the spawn lock, the lock is treated as abandoned after this long and the next spawn may proceed. 60 seconds. |

```json
{
  "pidiff_stale_lock_timeout_ms": 60000
}
```

```bash
export PI_PIDIFF_STALE_LOCK_TIMEOUT_MS=60000
```

### `image_model`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `image_model` | string | `""` | `PI_IMAGE_MODEL` | Gemini image generation model name. | Enables the `generate_image` tool to call the Gemini API. Requires `GEMINI_API_KEY` or `GOOGLE_API_KEY` to be set. |

```json
{
  "image_model": "gemini-3-pro-image"
}
```

```bash
export PI_IMAGE_MODEL=gemini-3-pro-image
```

See [Image Generation](image-generation.html) for details.

## Code Map Keys

### `trail_enable`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `trail_enable` | boolean | `true` | `PI_TRAIL_ENABLE` | Enables the local Trail-code map integration. | Adds the map-first `trail_*` tools to main agents and to every subagent's toolset, so agents look code up in the map before grepping. In a worktree the setting is inherited from the main checkout when the worktree has no `.pi` settings file. Requires the `trail` binary on `PATH`; without it the tools are absent. |

```json
{
  "trail_enable": true
}
```

```bash
export PI_TRAIL_ENABLE=true
```

## Background & Async Keys

### `dream_auto_enable`

| Parameter | Type | Default | Environment variable | Description | Effect |
| --- | --- | --- | --- | --- | --- |
| `dream_auto_enable` | bool | `true` | `PI_DREAM_AUTO_ENABLE` | Enable automatic background memory dreaming (periodic + session end). | When `false`, skips periodic and session-quit dreaming passes. |

```json
{
  "dream_auto_enable": true
}
```

```bash
export PI_DREAM_AUTO_ENABLE=false
```

### `dream_interval_hours`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `dream_interval_hours` | number | `3` | `PI_DREAM_INTERVAL_HOURS` | Interval between automatic dream passes. | Controls how frequently background memory consolidation is scheduled. |

```json
{
  "dream_interval_hours": 6
}
```

```bash
export PI_DREAM_INTERVAL_HOURS=6
```

See [Background Memory Consolidation (Dreaming)](background-dreaming.html) for details.

### Memory tuning keys

These keys tune the memory system's budgets and similarity gates (issue #915).
All defaults match the pre-setting hardcoded values.

| Parameter | Type | Default | Environment variable | Description |
|---|---|---|---|---|
| `memory_token_budget` | number | `1700` | `PI_MEMORY_TOKEN_BUDGET` | Token budget for the situation report injected into the system prompt. |
| `memory_inject_similarity` | number | `0.65` | `PI_MEMORY_INJECT_SIMILARITY` | Vector similarity threshold for contextual memory auto-injection. |
| `memory_near_duplicate_threshold` | number | `0.9` | `PI_MEMORY_NEAR_DUPLICATE_THRESHOLD` | Similarity above which `memory_add` reinforces an existing entry instead of adding. |
| `memory_conflict_similarity` | number | `0.55` | `PI_MEMORY_CONFLICT_SIMILARITY` | Similarity floor for contradiction candidates in the conflict gate. |
| `memory_max_active_entries` | int | `40` | `PI_MEMORY_MAX_ACTIVE_ENTRIES` | Total cap on active entries applied during rebuild. |

```json
{
  "memory_token_budget": 2000,
  "memory_inject_similarity": 0.7
}
```

See [Memory Architecture](memory-architecture.html) for what each gate does.

### `internal_operations_provider`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `internal_operations_provider` | string | `""` | `PI_INTERNAL_OPERATIONS_PROVIDER` | Optional provider override for background internal operations (dreaming). | When set together with `internal_operations_model`, overrides the session model used by dreaming. |

```json
{
  "internal_operations_provider": "openai"
}
```

```bash
export PI_INTERNAL_OPERATIONS_PROVIDER=openai
```

### `internal_operations_model`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `internal_operations_model` | string | `""` | `PI_INTERNAL_OPERATIONS_MODEL` | Model ID paired with `internal_operations_provider`. | When set together with `internal_operations_provider`, overrides the session model used by dreaming. |

```json
{
  "internal_operations_model": "gpt-5.4"
}
```

```bash
export PI_INTERNAL_OPERATIONS_MODEL=gpt-5.4
```

> **Note:** Both `internal_operations_provider` and `internal_operations_model` must be set together to override the session model for background dreaming. Cron jobs use the worker's normal model resolution chain (`agent_overrides`, frontmatter, `agent_provider`/`agent_model`) unless pinned via `/cron`.

See [Background Memory Consolidation (Dreaming)](background-dreaming.html) for details.

### `sync_agent_max_seconds`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `sync_agent_max_seconds` | integer `10`-`300` | `60` | `PI_SYNC_AGENT_MAX_SECONDS` | Estimated runtime at which a subagent must be dispatched asynchronously. | A `subagent` call whose `estimatedSeconds` meets or exceeds this limit is rejected with "Use async: true instead." The same limit scales the parallel and chain fan-out timeouts. |

> **Warning:** Only integer values in the range `10`-`300` are accepted. Invalid values fall back to the next resolution layer or the default.

```json
{
  "sync_agent_max_seconds": 120
}
```

```bash
export PI_SYNC_AGENT_MAX_SECONDS=120
```

### `async_poll_interval_ms`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `async_poll_interval_ms` | integer `500`-`30000` | `3000` | `PI_ASYNC_POLL_INTERVAL_MS` | How often the async agent poller re-reads job state. | Sets the cadence of the status sweep that refreshes the async widget, delivers completed results, and drops finished jobs older than 30 seconds. Lower values track jobs more closely at the cost of more frequent settings reads. |

> **Warning:** Only integer values in the range `500`-`30000` are accepted. Invalid values fall back to the next resolution layer or the default.

```json
{
  "async_poll_interval_ms": 5000
}
```

```bash
export PI_ASYNC_POLL_INTERVAL_MS=5000
```

### `async_phantom_timeout_ms`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `async_phantom_timeout_ms` | integer `5000`-`120000` | `30000` | `PI_ASYNC_PHANTOM_TIMEOUT_MS` | Grace period before an async job with no status file is declared dead. | Once it elapses the job is failed with "Agent process timed out — no status file" and that job's failure is delivered on its own, without waiting for any other job. While the worker PID is still alive, the same window suppresses the failure. |

> **Warning:** Only integer values in the range `5000`-`120000` are accepted. Invalid values fall back to the next resolution layer or the default.

```json
{
  "async_phantom_timeout_ms": 60000
}
```

```bash
export PI_ASYNC_PHANTOM_TIMEOUT_MS=60000
```

See [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) for details.

## Provider Stream Logging

### `log_providers`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `log_providers` | string | `info` | `PI_LOG_PROVIDERS` | Log level for the provider diagnostics namespace. | Logs provider HTTP 4xx/5xx responses at `warn` by default. Set to `debug` to also capture every parsed `provider_stream_event` chunk for stream-level diagnosis. |

```bash
export PI_LOG_PROVIDERS=debug
```

`registerProviderStreamLog` writes to `~/.pi/logs/providers/<session-id>/main.log` under a `[provider-stream]` prefix and redacts credential-shaped fields. Via `after_provider_response`, it logs provider HTTP 4xx/5xx error responses and safe retry headers (`retry-after`, `x-request-id`, `cf-ray`) at `warn` level, which is active at the default `info` setting. Chunk-level `provider_stream_event` logging runs on every parsed chunk, so that hook stays gated behind `log_providers: "debug"` and adds no overhead at the default level.

Every other `log_<module>` key follows the same shape — `log_pidash`, `log_pidiff`, `log_coms`, `log_subagent`, `log_dreaming`, `log_enforcement`, `log_trail`, and others — with env vars `PI_LOG_<MODULE>` and default `info`. The remaining module log levels are listed in [Module File Logging](#module-file-logging) below.

## Safety Enforcement Keys

### `enforcement_sleep_threshold_s`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `enforcement_sleep_threshold_s` | integer `1`-`300` | `60` | `PI_ENFORCEMENT_SLEEP_THRESHOLD_S` | Longest `sleep` allowed in a single foreground command. | A standalone `bash` command sleeping longer than this is blocked with a message pointing at `async: true`. Only enforced when the parent session provider supports async LLM calls. |

```json
{
  "enforcement_sleep_threshold_s": 30
}
```

```bash
export PI_ENFORCEMENT_SLEEP_THRESHOLD_S=30
```

### `enforcement_loop_sleep_threshold_s`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `enforcement_loop_sleep_threshold_s` | integer `1`-`300` | `60` | `PI_ENFORCEMENT_LOOP_SLEEP_THRESHOLD_S` | Longest `sleep` allowed inside a `while`/`for`/`until` loop. | A polling loop whose `sleep` exceeds this is blocked, forcing polling and monitoring work into an async subagent instead of tying up the session. Only enforced when the parent session provider supports async LLM calls. |

```json
{
  "enforcement_loop_sleep_threshold_s": 10
}
```

```bash
export PI_ENFORCEMENT_LOOP_SLEEP_THRESHOLD_S=10
```

### `enforcement_allowed_commands`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `enforcement_allowed_commands` | string | `""` | `PI_ENFORCEMENT_ALLOWED_COMMANDS` | Comma-separated bash commands exempt from enforcement blocking. | A listed command bypasses the guards that would otherwise block it. Empty means no exemptions. |

```json
{
  "enforcement_allowed_commands": "sleep 5, ls -la"
}
```

```bash
export PI_ENFORCEMENT_ALLOWED_COMMANDS="sleep 5,ls -la"
```

> **Warning:** this is an exemption list for the enforcement guards. Anything added here runs past them, so keep it as narrow as the task allows.

See [Safety Enforcements](safety-enforcements.html) for details.

## Inter-Agent Communication Keys

### `coms_task_heartbeat_ms`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `coms_task_heartbeat_ms` | integer (min `10000`) | `300000` | `PI_COMS_TASK_HEARTBEAT_MS` | How often a joined coms session re-announces its task state. | Sets the timer interval for the periodic task-status broadcast to peers, so the shared task board stays fresh while the session is open. |

```json
{
  "coms_task_heartbeat_ms": 60000
}
```

```bash
export PI_COMS_TASK_HEARTBEAT_MS=60000
```

### `coms_probe_timeout_ms`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `coms_probe_timeout_ms` | integer `100`-`10000` | `1000` | `PI_COMS_PROBE_TIMEOUT_MS` | How long to wait when probing a peer's socket for liveness. | If the socket does not connect within this window it is reported stale and its registry entry becomes prunable. Only `ECONNREFUSED`/`ENOENT` count as stale, so transient errors are treated as live. |

```json
{
  "coms_probe_timeout_ms": 500
}
```

```bash
export PI_COMS_PROBE_TIMEOUT_MS=500
```

### `coms_timeout_ms`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `coms_timeout_ms` | integer | `1800000` | `PI_COMS_TIMEOUT_MS` | Coms session inactivity timeout before cleanup. | A session that has been idle this long is torn down and its socket and registry entry are released. 30 minutes. |

```json
{
  "coms_timeout_ms": 1800000
}
```

```bash
export PI_COMS_TIMEOUT_MS=1800000
```

### `coms_max_hops`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `coms_max_hops` | integer | `5` | `PI_COMS_MAX_HOPS` | Maximum message relay hops between peers. | Caps how many times a message may be relayed across the network, which bounds routing loops when peers cannot reach each other directly. |

```json
{
  "coms_max_hops": 5
}
```

```bash
export PI_COMS_MAX_HOPS=5
```

### `coms_entry_grace_period_ms`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `coms_entry_grace_period_ms` | integer | `30000` | `PI_COMS_ENTRY_GRACE_PERIOD_MS` | Grace period for new registry entries before a stale check applies. | A freshly announced peer is not probed for staleness during this window, so a slow start cannot get its entry pruned before it is reachable. 30 seconds. |

```json
{
  "coms_entry_grace_period_ms": 30000
}
```

```bash
export PI_COMS_ENTRY_GRACE_PERIOD_MS=30000
```

### `coms_dir`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `coms_dir` | string | `""` | `PI_COMS_DIR` | Override the default coms registry directory. | Relocates the peer registry and sockets from the default under `~/.pi/coms/`. Empty means auto-detect. |

```json
{
  "coms_dir": "/run/user/1000/coms"
}
```

```bash
export PI_COMS_DIR=/run/user/1000/coms
```

See [Inter-Agent Communication](inter-agent-communication.html) for details.

## Sidecar Server Logging

### `sidecar_log_level`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `sidecar_log_level` | string | `info` | `PI_SIDECAR_LOG_LEVEL` | Log level for the pi-sidecar server. | The resolved value is written into the process environment on session start, where both the Node sidecar and the Python client read it. An empty value clears the variable and lets the sidecar fall back to its own default. |

```json
{
  "sidecar_log_level": "debug"
}
```

```bash
export PI_SIDECAR_LOG_LEVEL=debug
```

See [Pi-Sidecar](pi-sidecar.html) for details.

## Module File Logging

Each key below is a **level string**, not a boolean. Accepted values are `off`, `debug`, `info`, `warn`, and `error`; anything else is ignored and the next resolution layer is used. `off` disables the module's file log entirely.

A module resolves its level in this order: the `log_<module>` setting → the `PI_LOG_<MODULE>` environment variable → `info`. Lines below that level are dropped before the file is touched, and the resolved level is cached for 30 seconds.

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `log_pitasks` | string | `info` | `PI_LOG_PITASKS` | Log level for the pitasks module. | Controls the verbosity of `~/.pi/logs/pitasks/<session-id>/main.log` — task list operations and reminder fires. |
| `log_orchestrator` | string | `info` | `PI_LOG_ORCHESTRATOR` | Log level for the orchestrator module. | Controls the verbosity of `~/.pi/logs/orchestrator/<session-id>/main.log` — delegation, settings resolution, and enforcement decisions. |
| `log_async_agents` | string | `info` | `PI_LOG_ASYNC_AGENTS` | Log level for the async-agents module. | Controls the verbosity of `~/.pi/logs/async_agents/<parent-session-id>/<job-id>.log` — spawn, poll, and delivery events for background agents. |
| `log_rules` | string | `info` | `PI_LOG_RULES` | Log level for the rules module. | Controls the verbosity of `~/.pi/logs/rules/<session-id>/main.log` — rule loading, placeholder substitution, and rule-matched events. |
| `log_memory` | string | `info` | `PI_LOG_MEMORY` | Log level for the memory module. | Controls the verbosity of `~/.pi/logs/memory/<session-id>/main.log` — memory capture, scoring, and promotion decisions. |
| `log_settings_tui` | string | `info` | `PI_LOG_SETTINGS_TUI` | Log level for the settings-tui module. | Controls the verbosity of `~/.pi/logs/settings_tui/<session-id>/main.log` — `/pi-config-settings` reads and writes. |
| `log_cron` | string | `info` | `PI_LOG_CRON` | Log level for the cron module. | Controls the verbosity of `~/.pi/logs/cron/<session-id>/main.log` — scheduled job registration and fires. |
| `log_oneshot` | string | `info` | `PI_LOG_ONESHOT` | Log level for the oneshot argv helpers. | Controls the verbosity of `~/.pi/logs/oneshot/<session-id>/main.log` — one-shot runs of `pi -p` and `--mode json`. |

> **Note:** Async agent logs nest under the parent pi session directory, not the subagent's own session id, so a whole job tree stays in one place. Subagent and child-process logs use the same `<name>/<parent-session-id>/<file>` layout.

```json
{
  "log_orchestrator": "debug",
  "log_async_agents": "debug"
}
```

```bash
export PI_LOG_ORCHESTRATOR=debug
```

> **Tip:** The Settings TUI renders each of these as a select list from the schema enum, so the valid values never have to be remembered.

## Task Lifecycle Keys

### `task_auto_clear_enabled`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `task_auto_clear_enabled` | boolean | `true` | `PI_TASK_AUTO_CLEAR_ENABLED` | Enables time-based removal of completed tasks. | When on, a one-minute sweep deletes completed tasks older than `task_auto_clear_minutes` and refreshes the task widget. Set to `false` to keep the history. |

```json
{
  "task_auto_clear_enabled": false
}
```

```bash
export PI_TASK_AUTO_CLEAR_ENABLED=false
```

### `task_auto_clear_minutes`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `task_auto_clear_minutes` | integer `1`-`1440` | `10` | `PI_TASK_AUTO_CLEAR_MINUTES` | How long a completed task is kept before removal. | Measured from the task's `completed_at` timestamp, not from session start. Only used while `task_auto_clear_enabled` is on. |

> **Warning:** Only integer values in the range `1`-`1440` are accepted. Invalid values fall back to the next resolution layer or the default.

```json
{
  "task_auto_clear_minutes": 60
}
```

### `task_reminder_enabled`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `task_reminder_enabled` | boolean | `true` | `PI_TASK_REMINDER_ENABLED` | Enables the periodic nudge when tasks are pending but none is in progress. | When on, a `task-focus-reminder` message is injected to restart the turn. Requires at least one active task, no `in_progress` task, and an idle agent. Set to `false` to silence it. |

```json
{
  "task_reminder_enabled": false
}
```

```bash
export PI_TASK_REMINDER_ENABLED=false
```

### `task_reminder_interval_minutes`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `task_reminder_interval_minutes` | integer `1`-`60` | `10` | `PI_TASK_REMINDER_INTERVAL_MINUTES` | Minimum gap between two pending-task reminders. | The sweep itself runs every minute; this key is the throttle that decides when a reminder is actually delivered. Only used while `task_reminder_enabled` is on. |

> **Warning:** Only integer values in the range `1`-`60` are accepted. Invalid values fall back to the next resolution layer or the default.

```json
{
  "task_reminder_interval_minutes": 30
}
```

### `task_stale_in_progress_enabled`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `task_stale_in_progress_enabled` | boolean | `true` | `PI_TASK_STALE_IN_PROGRESS_ENABLED` | Enables reminders for tasks stuck `in_progress` for too long. | When on, a stale reminder fires when an agent-assigned task without a running or queued async agent has been `in_progress` longer than `task_stale_in_progress_minutes`. Set to `false` to disable the stale check. |

```json
{
  "task_stale_in_progress_enabled": false
}
```

```bash
export PI_TASK_STALE_IN_PROGRESS_ENABLED=false
```

### `task_stale_in_progress_minutes`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `task_stale_in_progress_minutes` | integer `5`-`1440` | `30` | `PI_TASK_STALE_IN_PROGRESS_MINUTES` | How long a task may stay `in_progress` before it counts as stale. | Acts as both the staleness threshold and the cooldown between stale reminders. Only used while `task_stale_in_progress_enabled` is on. |

> **Warning:** Only integer values in the range `5`-`1440` are accepted. Invalid values fall back to the next resolution layer or the default.

```json
{
  "task_stale_in_progress_minutes": 60
}
```

### Task storage environment variables

Task store location is selected once at extension registration through environment variables rather than `pi-config-settings.json`,
and advertised to `coms` peers via `task_store_path`.

| Environment variable | Values | Default | Effect |
|---|---|---|---|
| `PI_TASK_SCOPE` | `session` or `project` | `session` | `session` stores tasks in `.pi/tasks/tasks-<sessionId>.json`; `project` shares `.pi/tasks/tasks.json` under the project directory. |
| `PI_TASKS` | file path, list id, or `off` | unset | Overrides `PI_TASK_SCOPE`. Absolute and `./`-relative paths resolve to that file, a bare id uses `~/.pi/tasks/<id>.json`, and `off` keeps tasks in memory only. |

```bash
export PI_TASK_SCOPE=project
export PI_TASKS=./.pi/tasks/custom-board.json
```

See [Managing Custom Agents](managing-custom-agents.html) for details.

## Reload handshake

The interactive session watches `.pi/run/reload.flag`, with `.pi/tmp/reload.flag` as a
legacy fallback. It claims one pathname by rename into `.pi/run` before reading its nonce, parks an
owner- and `startToken`-stamped `reload.pending`, waits for idle, then reloads through the public command
API. The replacement runtime publishes that pending nonce to `reload.done`, mirrored
best-effort to the legacy directory (mirror write errors log `reload_legacy_mirror_failed` —
at `debug` when `.pi/tmp` is absent and `warn` otherwise —
without retaining `reload.pending`). A newer flag remains for another reload. Consuming
one directory's request never removes the other directory's request.

Manual `/reload` has no trustworthy public pre-load nonce boundary. Without pending
state it leaves any sitting flag untouched for a conservative extra reload. It does
not publish an unproven confirmation. Fresh-start inspection removes only corrupt
`reload.pending` records (empty or missing a valid `pid:session` owner), preserving
both unconfirmed requests and `reload.done` completion markers regardless of age so a
requester polling after a long turn never loses completion proof. Reload failures
re-enable the owner's watcher with exponential backoff (`1s` doubling up to `30s`,
reset immediately when a new flag nonce appears). Non-reload shutdown atomically
releases the departing owner's pending into a claim whose filename records that
owner's release intent. It never overwrites a newer pending publication. Live foreign
pending owners are never taken over based on age.

Publication contract: every writer must finish a unique temporary file in the target
directory, close it, then atomically rename it to `reload.flag`. Never truncate the
published file or keep writing through an open descriptor after publication. Consumers
cannot freeze such descriptors, so shell redirection and in-place writes are unsupported.
The flag is a latest-publication slot, not a lossless queue for simultaneous publishers.
A requester must poll for its exact nonce, never treat any completion marker as success.

Unreadable claims, failed pending publication, and restoration collisions retain their
`.claim` files in `.pi/run`. Watchers scan retained `.pi/run` claims in filename order
and check legacy `.pi/tmp` control files by exact path without scanning `.pi/tmp`,
retrying retained claims before newly claimed flags. Recovery parks an owned pending and performs
another reload before confirmation. Exclusive pending publication prevents replacement of
an existing current pending; a failed attempt retains the claim. A crash after pending
publication but before claim removal can cause an extra reload, never an unproven completion.
Empty or syntactically invalid `reload.pending` files are safely removed as corrupt
(`reload_pending_corrupt`) so deploys never wedge, whereas transiently unreadable files
(such as `EACCES`) remain untouched and retry with backoff. Live foreign pending claims stay
with their owner unless that owner explicitly released them, its process has exited, or a
mismatched OS `startToken` proves PID reuse (`reload_pending_pid_reused`).
Keep `.pi/run` intact across retries; deleting runtime files discards recoverable requests.
Legacy `.pi/tmp` compatibility remains subject to that directory's throwaway cleanup policy.
Oneshot and headless RPC sessions never touch handshake state, and linked git worktrees do not auto-reload.

## Project Temp Cleanup Keys

`.pi/tmp` is swept at session start when it grows past the size cap. Size is the only trigger and age is the
safety floor, so a project under the cap is never touched however old its entries are. Nothing in `.pi/tmp` is
exempt: daemon control files (`pidiff.pid`, `pidiff.port`, `reload.flag`, `reload.done`, `reload.pending`) and
the sweep lock live in `.pi/run`, outside the swept directory. A symlink is unlinked without following it, a
sweep whose `.pi/tmp` resolves outside the checkout is refused, and the sweep is skipped in one-shot sessions
(`pi -p`, `--mode json`, piped print sessions).

### `project_tmp_max_size`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `project_tmp_max_size` | string | `"2G"` | `PI_PROJECT_TMP_MAX_SIZE` | Size cap for `.pi/tmp`. Accepted forms: `2G`, `2GB`, `2GiB`, `2048M`, `100M`, `1.5G`, or a bare number in MB (`2048` = 2G). `"0"` disables the sweep. | Above the cap, the sweep deletes top-level entries oldest-first until the directory fits again. |

> **Warning:** An unparsable value (`2Q`, `2gig`, empty) logs a warning and deletes nothing on that run — a bad
> value may only ever clean less, never more.

```json
{
  "project_tmp_max_size": "4G"
}
```

```bash
export PI_PROJECT_TMP_MAX_SIZE=4G
```

### `project_tmp_retention_days`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `project_tmp_retention_days` | integer `1`-`365` | `7` | `PI_PROJECT_TMP_RETENTION_DAYS` | Safety floor: size pressure may only delete entries older than this many days. | Never a trigger — an over-cap directory whose entries are all younger deletes nothing. A directory is aged by its newest nested file, so an actively used task dir is not swept for being created long ago. |

```json
{
  "project_tmp_retention_days": 14
}
```

## Session Spill, Blob Externalization, and Pre-Compaction Elision Keys

Long-running sessions keep session `.jsonl` files lean by spilling oversized text `tool_result` outputs to `<sessionFile-without-.jsonl>/local/<N>.log` (falling back to `.pi/tmp/session-local/<sessionId>/` when running with `--no-session`), externalizing oversized or repeated image blocks into the content-addressed store `~/.pi/blobs/<sha256>` (plus a typed `.ext` sidecar when the MIME type is known), and mechanically eliding older bulky `toolResult` text blocks before full LLM compaction when context usage crosses a high-water threshold.

Elision never rewrites user messages, assistant prose, thinking/reasoning blocks, images, small tool results, or turns inside the protected recent window; every elided block links to a recoverable spill file (reusing an existing spill file when already spilled) and preserves tool-call / tool-result pairing. Ordinary turns below the high-water threshold are never mutated so provider prompt caches stay intact.

### `session_spill_enabled`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `session_spill_enabled` | boolean | `true` | `PI_SESSION_SPILL_ENABLED` | Enable spilling oversized text tool results to disk. | When `true`, text `tool_result` blocks exceeding `session_spill_threshold_chars` are written atomically to `<session-dir>/local/<N>.log` and replaced inline with a bounded head/tail preview + spill path. |

### `session_spill_threshold_chars`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `session_spill_threshold_chars` | integer `1000`-`5000000` | `50000` | `PI_SESSION_SPILL_THRESHOLD_CHARS` | Character threshold for spilling text tool results. | Text blocks at or below this length remain inline untouched; longer blocks are spilled and previewed. |

### `session_blob_externalize`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `session_blob_externalize` | boolean | `true` | `PI_SESSION_BLOB_EXTERNALIZE` | Enable content-addressed image externalization for tool results. | Oversized (>512 KiB decoded) or repeated image blocks in a session are deduplicated into `~/.pi/blobs/<sha256>` (with a typed `.ext` sidecar when MIME type is known) and replaced with a hash/path pointer; first-time normal-sized images remain inline so the model can view them. |

### `pre_compaction_elision`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `pre_compaction_elision` | boolean | `true` | `PI_PRE_COMPACTION_ELISION` | Enable deterministic zero-LLM-cost elision of old bulky tool results before compaction. | Commits `context_edit` drafts at `turn_end` (before Pi's automatic compaction threshold checks) and guards `context` once usage crosses `pre_compaction_elision_threshold_pct`, reclaiming headroom without an LLM compaction call. |

### `pre_compaction_elision_threshold_pct`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `pre_compaction_elision_threshold_pct` | integer `30`-`95` | `70` | `PI_PRE_COMPACTION_ELISION_THRESHOLD_PCT` | High-water context usage percentage that triggers elision. | Below this threshold (with no prior elisions), the `context` hook returns without modifying messages. |

### `pre_compaction_elision_keep_turns`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `pre_compaction_elision_keep_turns` | integer `1`-`50` | `6` | `PI_PRE_COMPACTION_ELISION_KEEP_TURNS` | Number of most recent user turns kept completely intact. | Every assistant/tool exchange inside the last N user turns is never elided. |

### `pre_compaction_elision_min_chars`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `pre_compaction_elision_min_chars` | integer `200`-`500000` | `2000` | `PI_PRE_COMPACTION_ELISION_MIN_CHARS` | Minimum character length for an older `toolResult` text block to be elided. | Smaller older tool results stay inline untouched. |

```json
{
  "session_spill_enabled": true,
  "session_spill_threshold_chars": 50000,
  "session_blob_externalize": true,
  "pre_compaction_elision": true,
  "pre_compaction_elision_threshold_pct": 70,
  "pre_compaction_elision_keep_turns": 6,
  "pre_compaction_elision_min_chars": 2000
}
```

## Per-Turn Thinking Magic Keywords

### `magic_keywords`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `magic_keywords` | boolean | `true` | `PI_MAGIC_KEYWORDS` | Enables per-turn magic keywords (`ultrathink` / `chillax`) in user prose. | When `true`, standalone lowercase `ultrathink` temporarily raises thinking effort to the current model's highest supported level for that turn (with a hidden careful-reasoning notice) and `chillax` lowers thinking effort to the model's lowest active reasoning level (such as `minimal` or `low`, never turning reasoning completely off and never enabling thinking when off). The previous thinking level is restored on `turn_end`, `agent_end`, error, or abort without overwriting persisted thinking preferences. Fenced code blocks, inline code spans, HTML/XML tags/comments, URLs, paths, identifiers (`ultrathink.ts`, `foo::chillax`, `ultrathink()`), and synthetic prompts are ignored, with zero prompt-cache impact when no keyword matches. |

```json
{
  "magic_keywords": true
}
```

```bash
export PI_MAGIC_KEYWORDS=false
```

## Environment-only Process Flag

### `PI_SUBAGENT_CHILD`

| Parameter | Type | Default | Description | Effect |
|---|---|---|---|---|
| `PI_SUBAGENT_CHILD` | string | unset | Process flag set to `"1"` for subagent child processes. | Disables parent-session-only startup behavior such as pidash/pidiff registration and settings cache reset hooks in child processes. |

```bash
PI_SUBAGENT_CHILD=1
```

See [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) for details.

## Related Pages

- [Installation & Quickstart](quickstart.html)
- [Daemon & Websocket Networking](daemon-and-websockets.html)
- [Curating Project Memory](curating-project-memory.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
