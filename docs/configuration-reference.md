# Configuration and Environment Variables Reference

All configuration options for pi-config: project settings, environment variables, rules loading, and CodeRabbit setup.

For Docker-specific deployment configuration, see [Running Pi in a Docker Container](docker-deployment.html).
For agent definitions and routing, see [Specialist Agents Reference](agents-reference.html).
For rule content and behavior, see [Orchestrator Rules Reference](rules-reference.html).

---

## Project Settings File

**Location:** `.pi/pi-config-settings.json` (relative to project root)

Project-level settings override environment variables and defaults. The file is loaded once and cached for 30 seconds before re-checking for changes.

**Resolution order:** Project file → Environment variable → Default

### Settings Fields

| Field | Type | Default | Env Var Fallback | Description |
|---|---|---|---|---|
| `co_author` | `boolean` | `false` | `PI_CO_AUTHOR` | Appends a `Co-authored-by: PI (<model>) <noreply@pi.dev>` trailer to git commits |
| `use_worktrees` | `boolean` | `false` | `PI_USE_WORKTREES` | Blocks `git checkout` and `git switch`; forces worktree-only branching workflow |
| `dream_interval_hours` | `number` | `3` | `PI_DREAM_INTERVAL_HOURS` | Hours between automatic memory dreaming cycles. Clamped to range `0.5`–`24` |

### Example File

```json
{
  "co_author": true,
  "use_worktrees": false,
  "dream_interval_hours": 3
}
```

> **Note:** Unknown keys in the file are preserved during migration but ignored by the settings loader. Only the three fields above are read.

### Legacy Migration

If a `.pi-co-author` file exists in the project root, the settings module automatically migrates it to `pi-config-settings.json` with `co_author: true` on `session_start`, then deletes the legacy file. Symlink attacks are detected and skipped.

---

## Environment Variables

### Core Project Settings

These environment variables serve as fallbacks when the corresponding field is not set in `.pi/pi-config-settings.json`.

| Variable | Type | Default | Description |
|---|---|---|---|
| `PI_CO_AUTHOR` | `boolean` | `false` | Enable co-author trailers in git commits. Accepted values: `true`, `1`, `yes`, `on` (case-insensitive) |
| `PI_USE_WORKTREES` | `boolean` | `false` | Force worktree-only workflow, blocking `git checkout` and `git switch` |
| `PI_DREAM_INTERVAL_HOURS` | `number` | `3` | Hours between automatic dreaming cycles. Must be between `0.5` and `24` |

```bash
export PI_CO_AUTHOR=true
export PI_USE_WORKTREES=false
export PI_DREAM_INTERVAL_HOURS=3
```

### ACPX Provider

| Variable | Type | Default | Description |
|---|---|---|---|
| `ACPX_AGENTS` | `string` | `""` (empty) | Comma-separated list of ACPX agent names to register as LLM providers. Each agent appears as `acpx-<name>` in the model list |

```bash
# Single agent
export ACPX_AGENTS="cursor"

# Multiple agents
export ACPX_AGENTS="cursor,claude,gemini,copilot"
```

Agent names are validated against the pattern `/^[a-z0-9_-]+$/i`. Invalid names are silently filtered out. Each registered agent creates a provider named `acpx-<agent>` with models discovered at session start via the ACPX runtime library.

> **Note:** ACPX providers are skipped entirely in subagent processes (`PI_SUBAGENT_CHILD=1`). Subagents use the parent session's model via `--model` flag.

### Image Generation

| Variable | Type | Default | Description |
|---|---|---|---|
| `PI_IMAGE_MODEL` | `string` | — (required) | Gemini model name for image generation (e.g., `gemini-2.0-flash-exp`) |
| `GEMINI_API_KEY` | `string` | — | Google Gemini API key. Falls back to `GOOGLE_API_KEY` if unset |
| `GOOGLE_API_KEY` | `string` | — | Fallback API key for Gemini. Used only when `GEMINI_API_KEY` is not set |

```bash
export PI_IMAGE_MODEL="gemini-2.0-flash-exp"
export GEMINI_API_KEY="your-key-here"
```

> **Warning:** Both `PI_IMAGE_MODEL` and an API key (`GEMINI_API_KEY` or `GOOGLE_API_KEY`) must be set for the `generate_image` tool to function. Missing either variable returns an error message to the LLM.

### Dashboard and Diff Viewer

| Variable | Type | Default | Description |
|---|---|---|---|
| `PI_PIDASH_PORT` | `number` | `19190` | Port for the pidash web dashboard server |
| `PI_PIDASH_ENABLE` | `string` | — (enabled) | Set to `false`, `0`, `no`, or `off` to disable pidash entirely |
| `PI_PIDIFF_PORT` | `number` | `19290` | Port for the pidiff diff viewer server |
| `PI_PIDIFF_ENABLE` | `string` | — (enabled) | Set to `false`, `0`, `no`, or `off` to disable pidiff entirely |

```bash
export PI_PIDASH_PORT=19190
export PI_PIDIFF_PORT=19290

# Disable dashboards
export PI_PIDASH_ENABLE=false
export PI_PIDIFF_ENABLE=false
```

For more on dashboards, see [Using the Web Dashboard and Diff Viewer](dashboards-and-diffs.html).

### Discord Bot Integration

These variables configure the Discord bot embedded in the pidash daemon server.

| Variable | Type | Default | Description |
|---|---|---|---|
| `DISCORD_BOT_TOKEN` | `string` | — | Discord bot token. If unset, the Discord bot is disabled entirely |
| `DISCORD_ALLOWED_USERS` | `string` | — (all users) | Comma-separated list of Discord user IDs allowed to interact with the bot |

```bash
export DISCORD_BOT_TOKEN="your-discord-bot-token"
export DISCORD_ALLOWED_USERS="123456789,987654321"
```

> **Warning:** If `DISCORD_ALLOWED_USERS` is not set, all DMs to the bot are accepted.

Alternatively, credentials can be placed in `~/.pi/discord.env` as `KEY=VALUE` lines (one per line). The pidash server reads this file at startup.

### P2P Communication (Coms)

| Variable | Type | Default | Description |
|---|---|---|---|
| `PI_COMS_DIR` | `string` | `~/.pi/coms` | Directory for P2P coms registry files |
| `PI_COMS_MAX_HOPS` | `number` | `5` | Maximum message relay hops |
| `PI_COMS_TIMEOUT_MS` | `number` | `1800000` (30 min) | Message delivery timeout in milliseconds |
| `PI_COMS_PING_INTERVAL_MS` | `number` | `10000` (10s) | Peer ping interval in milliseconds |

```bash
export PI_COMS_DIR="$HOME/.pi/coms"
export PI_COMS_MAX_HOPS=5
```

For more on inter-agent communication, see [Communicating Between Pi Sessions](inter-agent-communication.html).

### Networked Communication (Coms-Net)

#### Client Variables

| Variable | Type | Default | Description |
|---|---|---|---|
| `PI_COMS_NET_SERVER_URL` | `string` | — | Hub server URL for remote connections (auto-discovered from `server.json` for local) |
| `PI_COMS_NET_AUTH_TOKEN` | `string` | — | Authentication token for the hub server |
| `PI_COMS_NET_PROJECT` | `string` | `"default"` | Project namespace for agent grouping |
| `PI_COMS_NET_MAX_HOPS` | `number` | `5` | Maximum message relay hops |
| `PI_COMS_NET_HEARTBEAT_MS` | `number` | `10000` (10s) | Heartbeat interval in milliseconds |
| `PI_COMS_NET_MESSAGE_TTL_MS` | `number` | `1800000` (30 min) | Message time-to-live in milliseconds |

#### Server Variables

| Variable | Type | Default | Description |
|---|---|---|---|
| `PI_COMS_NET_HOST` | `string` | `"127.0.0.1"` | Bind address for the hub server |
| `PI_COMS_NET_PORT` | `number` | `0` (auto) | Listening port (`0` = OS-assigned) |
| `PI_COMS_NET_PUBLIC_URL` | `string` | — | Public URL for the server (used when behind a proxy) |
| `PI_COMS_NET_MAX_INBOX` | `number` | `100` | Maximum queued messages per agent |
| `PI_COMS_NET_STALE_AFTER_MS` | `number` | `30000` (30s) | Time without heartbeat before marking an agent stale |
| `PI_COMS_NET_OFFLINE_AFTER_MS` | `number` | `60000` (60s) | Time without heartbeat before marking an agent offline |
| `PI_COMS_NET_LOG_QUIET` | `string` | — | Set to `"1"` to suppress all log output except startup/shutdown |
| `PI_COMS_NET_LOG_HEARTBEAT` | `string` | — | Set to `"1"` to include heartbeat events in logs (very verbose) |

```bash
# Local auto-discovery (default)
# No env vars needed — client reads ~/.pi/coms-net/server.json

# Remote connection
export PI_COMS_NET_SERVER_URL="http://hub.example.com:8080"
export PI_COMS_NET_AUTH_TOKEN="your-auth-token"
export PI_COMS_NET_PROJECT="my-project"
```

### Container and Docker

| Variable | Type | Default | Description |
|---|---|---|---|
| `PI_HOST_USER` | `string` | `"node"` | Host username. Creates `/home/<user>` inside the container with symlinks so host-mounted paths resolve correctly |
| `AGENT_BROWSER_ARGS` | `string` | `"--no-sandbox,--disable-dev-shm-usage"` | Chromium flags for `agent-browser` (comma-separated). Set in Dockerfile |

```bash
export PI_HOST_USER=myakove
```

When `PI_HOST_USER` is set to a value other than `"node"`, the init entrypoint:

1. Creates `/home/<PI_HOST_USER>` with correct ownership
2. Symlinks container tool directories (`.npm-global`, `.cache`, `.local`, etc.) into the new HOME
3. Creates reverse symlinks in `/home/node` pointing to mounted content
4. Sets `HOME` and updates `PATH` to include the new home-based directories

### Git and SSH

| Variable | Type | Default | Description |
|---|---|---|---|
| `GIT_SSH_COMMAND` | `string` | `ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10` | SSH command with keepalive and timeout settings. Set automatically by both `entrypoint.sh` and `utils.ts` if unset |

> **Note:** The SSH timeout configuration detects dead connections during git fetch/push/pull. The keepalive sends a probe every 15 seconds, gives up after 3 missed responses (45 seconds total), and fails connections that don't establish within 10 seconds.

### Debugging and Internal

| Variable | Type | Default | Description |
|---|---|---|---|
| `PI_ASYNC_DEBUG` | `boolean` | `false` | Enable debug logging for async agent infrastructure |
| `PI_SUBAGENT_CHILD` | `string` | — | Set to `"1"` internally when running as a subagent. Disables orchestrator-only features (dreaming, memory writes, autocomplete, ACPX providers, dashboard connections) |
| `PI_AGENT_NAME` | `string` | — | Internal. Set to the current agent's name. Used by enforcement to allow git commit/push only from `git-expert` |
| `PI_PIDASH_PORT` | `number` | `19190` | Also used by the async runner to connect to pidash for status updates |
| `NVIM` | `string` | — | Neovim socket path. Automatically set by Neovim when launching pi from within Neovim. Enables the nvim integration (quickfix, changed files) |
| `PI_GIT_BIN` | `string` | `"git"` | Custom git binary path for the pidiff server |

> **Warning:** Do not set `PI_SUBAGENT_CHILD` or `PI_AGENT_NAME` manually — they are managed internally by the subagent spawning system.

---

## Rules Loading Order

Orchestrator rules are auto-loaded from the `rules/` directory in **alphabetical order** on every `before_agent_start` event. Files must end in `.md`. Numeric prefixes control ordering.

| File | Priority | Domain |
|---|---|---|
| `00-orchestrator-core.md` | 0 | Core orchestrator behavior — delegation rules, forbidden actions |
| `05-issue-first-workflow.md` | 5 | Issue-first development workflow |
| `10-agent-routing.md` | 10 | Task → agent routing table |
| `15-mcp-launchpad.md` | 15 | MCP server discovery and connection |
| `20-code-review-loop.md` | 20 | 3-reviewer parallel code review system |
| `25-documentation-updates.md` | 25 | Documentation update requirements |
| `30-prompt-templates.md` | 30 | Slash command and prompt template handling |
| `35-memory.md` | 35 | Memory system usage rules |
| `40-critical-rules.md` | 40 | Critical safety and behavioral rules |
| `45-file-preview.md` | 45 | File preview via HTTP server |
| `50-agent-bug-reporting.md` | 50 | Bug reporting policy for agent errors |
| `55-coms-protocol.md` | 55 | Inter-agent communication protocol |
| `60-task-tracking.md` | 60 | Task tracking integration |

> **Note:** Rules are loaded into the orchestrator system prompt only — specialist agents (subagents) do not receive orchestrator rules. Subagents receive only the memory situation report.

For detailed rule content, see [Orchestrator Rules Reference](rules-reference.html).

### Adding a Custom Rule

Place a `.md` file in `rules/` with a numeric prefix to control ordering:

```bash
# Loads after agent routing but before code review loop
rules/12-my-custom-rule.md
```

Changes take effect on the **next pi session** — running sessions are not affected.

---

## Agent Discovery Order

Agents are discovered from three sources in priority order (later sources override earlier):

| Priority | Source | Path | Description |
|---|---|---|---|
| 1 (lowest) | Package | `<pi-config>/agents/` | Bundled agent definitions shipped with pi-config |
| 2 | User | `~/.pi/agent/agents/` | User-global custom agents |
| 3 (highest) | Project | `.pi/agents/` (searched up from cwd) | Project-specific agent overrides |

Agent files use Markdown with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, write, edit, bash
model: optional-model-override
---

System prompt instructions here...
```

| Frontmatter Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Agent identifier (used in routing and subagent calls) |
| `description` | `string` | Yes | One-sentence description of the agent's purpose |
| `tools` | `string` | No | Comma-separated list of tools the agent can use |
| `model` | `string` | No | Override the default LLM model for this agent |

For the full list of bundled agents, see [Specialist Agents Reference](agents-reference.html).

### Async-Only Agents

The following agents are enforced to run with `async: true` only. Synchronous calls are automatically promoted to async by the subagent tool:

- `code-reviewer-quality`
- `code-reviewer-guidelines`
- `code-reviewer-security`

This list is defined in the `ASYNC_ONLY_AGENTS` set in `extensions/orchestrator/subagent-tool.ts`.

---

## CodeRabbit Configuration

**Location:** `.coderabbit.yaml` (project root)

Pi-config ships a CodeRabbit configuration for local AI code reviews via the CodeRabbit CLI (`cr` command).

```yaml
language: en-US
reviews:
  profile: assertive
  poem: false
  sequence_diagrams: false
  auto_review:
    enabled: false  # Uses CLI, not PR auto-review
```

### Enabled Linters

| Linter | Language/Purpose |
|---|---|
| `shellcheck` | Shell scripts |
| `ruff` | Python |
| `hadolint` | Dockerfiles |
| `actionlint` | GitHub Actions |
| `markdownlint` | Markdown |
| `eslint` | JavaScript/TypeScript |
| `biome` | JavaScript/TypeScript |
| `gitleaks` | Secret detection |
| `trufflehog` | Secret detection |

### Disabled Linters

PHP (`phpstan`, `phpmd`, `phpcs`), Ruby (`rubocop`), Swift (`swiftlint`), Kotlin (`detekt`), Java (`pmd`), Protobuf (`buf`), SQL (`sqlfluff`), Terraform (`tflint`), IaC (`checkov`), Rust (`clippy`).

### Knowledge Base

```yaml
knowledge_base:
  code_guidelines:
    enabled: true  # Auto-picks up AGENTS.md
```

---

## Memory System Files

The memory system uses several files under `.pi/memory/`. These are not directly edited but are referenced by configuration.

| Path | Description |
|---|---|
| `.pi/memory/topics/*.md` | Topic files — one per category (preferences, lessons, patterns, decisions, completions, mistakes) |
| `.pi/memory/memory-scores.json` | Stability scores for all memory entries |
| `.pi/memory/embeddings.json` | Vector embeddings for semantic memory search |
| `.pi/memory/.dream-watermark` | Timestamp of last dreaming cycle processed |
| `.pi/data/memory-telemetry.jsonl` | Retrieval telemetry log (capped at 500KB) |
| `.pi/data/session-search.json` | Past session summaries index for keyword search |

> **Tip:** Add `.pi/memory/` to your global gitignore to prevent committing memory data. The container entrypoint does this automatically.

For memory system internals, see [Memory Scoring, Embeddings, and Situation Reports](memory-internals.html).

---

## Temp Directory Structure

All runtime data lives under project-scoped temp directories.

**Base path:** `/tmp/pi-data/<project>/`

Project name format: cwd with `/` replaced by `__` (e.g., `home__user__git__my-project`).

| Path | Description |
|---|---|
| `debug.log` | Async debug log |
| `cron-<pid>.json` | Cron task state (per-process) |
| `.repeat-<pid>.json` | Repeat command detection state |
| `async-results-pid-<pid>/` | Async agent completion results |
| `worker-<id>/` | Async agent working directory |
| `worker-<id>/status.json` | Agent state (`running` / `complete` / `failed`) |
| `worker-<id>/output.log` | Agent output |
| `worker-<id>/system-prompt.md` | Agent system prompt |

The helper function `getProjectTmpDir(cwd)` in `extensions/orchestrator/utils.ts` creates and returns the project temp directory.

---

## Mode-Aware Feature Guards

Pi operates in four modes. Extensions use `ctx.mode` to conditionally enable features.

| Mode | Description |
|---|---|
| `"tui"` | Interactive terminal UI |
| `"rpc"` | Programmatic/API access |
| `"json"` | Structured JSON output (one-shot) |
| `"print"` | Plain text output (one-shot) |

| Feature | Active Modes | Guard |
|---|---|---|
| Daemon connections (pidash, pidiff) | `tui` only | `ctx.mode === "tui"` |
| Autocomplete providers | `tui` only | `ctx.mode === "tui"` |
| Cron scheduling | `tui`, `rpc` | `ctx.mode !== "print" && ctx.mode !== "json"` |
| Dreaming (auto timer) | `tui`, `rpc` | `ctx.mode !== "print" && ctx.mode !== "json"` |
| UI notifications | `tui`, `rpc` | `ctx.hasUI` |

---

## Extension Registration Order

The orchestrator extension (`extensions/orchestrator/index.ts`) registers modules in a specific order. Some modules depend on others being registered first.

1. `registerExtendedAutocomplete` — Must be first (wraps `registerCommand` for completions)
2. `registerAskUser` — `ask_user` tool
3. `registerAsyncAgents` — Background agent infrastructure (provides `spawnAsyncAgent`)
4. `registerSubagentTool` — Subagent tool (depends on async agents)
5. `registerProjectSettings` — Settings migration and cache
6. `registerEnforcement` — Command blocking rules
7. `registerRules` — Rule injection and memory loading (depends on async agent job list)
8. `registerStatusLine` — Git status, container indicator
9. `registerBtw` — `/btw` side questions
10. `registerDreaming` — Memory consolidation (depends on `spawnAsyncAgent`)
11. `registerCron` — Scheduled tasks (depends on `spawnAsyncAgent`)
12. `registerSessionValidation` — Tool checks, upgrade notifications
13. `registerGithubAutocomplete` — GitHub issue `#` autocomplete
14. `registerStatus` — `/status` command
15. `registerNvim` — Neovim integration
16. `registerPreferenceExtractor` — Auto-extract user preferences
17. `registerMemoryTools` — AI-accessible memory tools
18. `registerSessionSearch` — Session history keyword search

---

## Required and Optional CLI Tools

Checked on `session_start` by the session validation module.

### Required

| Tool | Purpose | Install |
|---|---|---|
| `uv` | Python package/runtime management | [docs.astral.sh/uv](https://docs.astral.sh/uv/) |

### Optional

| Tool | Purpose | Install | Condition |
|---|---|---|---|
| `gh` | GitHub CLI | [cli.github.com](https://cli.github.com/) | Always checked |
| `mcpl` | MCP Launchpad | [mcp-launchpad](https://github.com/kenneth-liao/mcp-launchpad) | Always checked |
| `myk-pi-tools` | PR/release/review CLI | `uv tool install git+https://github.com/myk-org/pi-config` | Always checked |
| `prek` | Pre-commit wrapper | [github.com/j178/prek](https://github.com/j178/prek) | Only if `.pre-commit-config.yaml` exists |
| `agent-browser` skill | Browser automation | `npx skills add vercel-labs/agent-browser@agent-browser -g -y` | Checks `~/.agents/skills/agent-browser/SKILL.md` or `~/.pi/agent/skills/agent-browser/SKILL.md` |

## Related Pages

- [Running Pi in a Docker Container](docker-deployment.html)
- [Customization and Extension Recipes](customization-recipes.html)
- [Working with Project Memory](memory-system.html)
- [Orchestrator Rules Reference](rules-reference.html)
- [Extension Architecture and Lifecycle Hooks](extension-architecture.html)
