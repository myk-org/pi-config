# Configuration & Settings

Every key below is declared in `settings-keys.json` at the repository root, which is the source of truth for types, defaults, ranges, and env var names. This page covers the common ones; `settings-keys.json` lists the rest.

## Settings Files

Both settings files accept `.jsonc` (JSON with comments) or plain `.json`. If a directory contains both names, the `.jsonc` file is used and the `.json` file is ignored.

### Project settings file

| Parameter | Type | Default | Description | Effect |
|---|---|---|---|---|
| Path | string | none | `.pi/pi-config-settings.jsonc` (or `.pi/pi-config-settings.json`) in the repository root. | Highest-precedence settings source for the current project. |

```json
{
  "pidash_enable": true,
  "pidash_port": 19190,
  "cli_agents": ["claude", "cursor"]
}
```

### Global settings file

| Parameter | Type | Default | Description | Effect |
|---|---|---|---|---|
| Path | string | none | `~/.pi/pi-config-settings.jsonc` (or `~/.pi/pi-config-settings.json`) in the current user's home directory. | Fallback settings source for all projects when a key is not set in the project file. |

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

Use it when you would rather not guess an env var name or a numeric range — the TUI shows the valid values for every key.

## Git & Workflow Keys

### `commit_trailer`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `commit_trailer` | string or `false` | `false` | `PI_COMMIT_TRAILER` | Commit trailer name, or a comma-separated list of trailer names. | Injects a trailer into `git commit` commands when a string value is set. |

> **Note:** A comma-separated string such as `"Assisted-by,Co-authored-by"` is treated as a list of trailer names; the user picks one per session and the choice is reused. The injected value is `<Trailer>: PI (<model-id>) <noreply@pi.dev>`.

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
| `review_loop_max_cycles` | integer `1`-`10` | `3` | `PI_REVIEW_LOOP_MAX_CYCLES` | Maximum number of review-loop cycles when review-loop enforcement is enabled. | Caps reviewer re-dispatch count. Invalid values fall through to the next resolution layer or the default. |

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

## Provider Registration & Model Routing

### `cli_agents`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `cli_agents` | string or string[] | `[]` | `CLI_AGENTS` | List of CLI-backed agent names. | Registers `cli-<agent>` providers in the unified provider extension. |

| Supported built-in value | Registered provider ID |
|---|---|
| `claude` | `cli-claude` |
| `gemini` | `cli-gemini` |
| `cursor` | `cli-cursor` |

> **Note:** Values are lowercased, deduplicated, and invalid names are filtered out.


> **Tip:** Set an explicit empty array (`[]`) in the project file to override inherited global or environment values.

```json
{
  "cli_agents": ["claude", "cursor"]
}
```

```bash
export CLI_AGENTS="Cursor,Gemini"
```

See [External AI Agents & CLI](external-ai-agents.html) for details.

### `acpx_agents`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `acpx_agents` | string or string[] | `[]` | `ACPX_AGENTS` | List of ACPX agent names to register. | Registers `acpx-<agent>` providers in the unified provider extension. |

> **Note:** Values are lowercased, deduplicated, and any name that is not `[a-z0-9_-]+` is dropped. Unlike `cli_agents`, the name is not checked against a built-in list — it must match an agent the `acpx` binary can launch.

```json
{
  "acpx_agents": ["cursor"]
}
```

```bash
export ACPX_AGENTS="cursor,claude"
```

See [ACPX Provider Integration](acpx-provider.html) for details.

### `agent_provider`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `agent_provider` | string | `""` | none | Default provider for subagents. | Used when a per-agent override and agent frontmatter do not provide a provider. |

```json
{
  "agent_provider": "cli-cursor"
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
  "agent_provider": "cli-cursor",
  "agent_model": "cursor:cursor-grok-4.5-high-fast",
  "agent_overrides": {
    "debugger": {
      "provider": null,
      "model": null
    },
    "reviewer": {
      "provider": "cli-claude",
      "model": "claude-sonnet"
    }
  }
}
```

See [Managing Custom Agents](managing-custom-agents.html) for details.

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

## Code Graph Key

### `graft_enable`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `graft_enable` | boolean | `false` | `PI_GRAFT_ENABLE` | Enables the local Graft repository graph integration. | Adds the `graft_*` tools to every subagent's toolset, so agents can look code up in the graph before grepping. Requires the `graft` binary on `PATH`. |

```json
{
  "graft_enable": true
}
```

```bash
export PI_GRAFT_ENABLE=true
```

## Background & Async Keys

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

### `internal_operations_provider`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `internal_operations_provider` | string | `""` | `PI_INTERNAL_OPERATIONS_PROVIDER` | Provider pi-config uses for its own detached LLM work when the session provider cannot do it. | Combined with `internal_operations_model` to define the sidecar provider. Used by dreaming, cron, and fire-and-forget async agents. |

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
| `internal_operations_model` | string | `""` | `PI_INTERNAL_OPERATIONS_MODEL` | Model ID paired with `internal_operations_provider`. | Combined with `internal_operations_provider` to define the sidecar model. |

```json
{
  "internal_operations_model": "gpt-5.4"
}
```

```bash
export PI_INTERNAL_OPERATIONS_MODEL=gpt-5.4
```

> **Warning:** Both `internal_operations_provider` and `internal_operations_model` must be set together. If either is missing, must-async work is skipped.

> **Warning:** `internal_operations_provider` cannot be an `acpx-*` provider ID. Non-must-async work is coerced to sync instead of using the sidecar.

See [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) for details.

## Provider Stream Logging

### `log_providers`

| Parameter | Type | Default | Environment variable | Description | Effect |
|---|---|---|---|---|---|
| `log_providers` | string | `info` | `PI_LOG_PROVIDERS` | Log level for the provider diagnostics namespace. | Set to `debug` to capture every parsed provider stream event, which is how a misbehaving provider is diagnosed from the stream rather than reconstructed from rendered output. |

```bash
export PI_LOG_PROVIDERS=debug
```

The stream is written to `~/.pi/logs/providers/<session-id>/main.log` under a `[provider-stream]` prefix, with one line per event and credential-shaped fields redacted. Capturing every event has a real cost, so the hook only registers at `debug` and costs nothing at the default level.

Every other `log_<module>` key follows the same shape — `log_pidash`, `log_pidiff`, `log_coms`, `log_subagent`, `log_dreaming`, `log_enforcement`, `log_graft`, and others — with env vars `PI_LOG_<MODULE>` and default `info`.

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
- [ACPX Provider Integration](acpx-provider.html)
