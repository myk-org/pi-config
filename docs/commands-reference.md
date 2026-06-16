# Slash Commands and Extension Commands Reference

This page is the definitive reference for every slash command available in pi-config — both **prompt template commands** (defined in `prompts/`) and **extension commands** (registered by TypeScript extensions in `extensions/`).

For an introduction to how slash commands work and when to use them, see [Using Slash Commands and Prompt Templates](slash-commands.html). For the agents these commands delegate to, see [Specialist Agents Reference](agents-reference.html).

---

## Command Types

| Type | Source | How it works |
|------|--------|--------------|
| **Prompt template** | `prompts/*.md` | Loaded as system-prompt instructions; the AI executes the workflow |
| **Extension command** | `extensions/**/*.ts` | Runs TypeScript handler code directly — no AI roundtrip unless noted |

---

## Prompt Template Commands

### `/implement`

Scouts the codebase, plans, and implements a task using a 3-agent chain.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | string | yes | Description of the task to implement |

**Agent chain:** `scout` → `planner` → `worker`

```text
/implement add pagination to the user list endpoint
```

---

### `/implement-and-review`

Implements a task, runs 3 parallel code reviewers, then fixes all findings.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | string | yes | Description of the task to implement |

**Agent chain:** `worker` → `code-reviewer-quality` + `code-reviewer-guidelines` + `code-reviewer-security` (parallel) → `worker` (fix round)

```text
/implement-and-review refactor the auth middleware to use JWT
```

---

### `/scout-and-plan`

Explores the codebase and produces a detailed implementation plan without making any changes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | string | yes | Description of what to plan |

**Agent chain:** `scout` → `planner`

```text
/scout-and-plan migrate the database layer from SQLite to PostgreSQL
```

---

### `/pr-review`

Reviews a GitHub PR using 3 parallel review agents and posts inline comments.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `PR number or URL` | string | no | Auto-detect from current branch | The PR to review |

**Phases:** PR detection → clone & checkout → past review check → 3 parallel reviewers → merge findings → user selection → post comments → store comments → summary

**Prerequisites:** `myk-pi-tools`, `gh` CLI

```text
/pr-review
/pr-review 123
/pr-review https://github.com/owner/repo/pull/123
```

---

### `/review-local`

Reviews uncommitted changes or changes compared to a branch using 3 parallel review agents.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `base branch` | string | no | `HEAD` (uncommitted changes) | Branch to compare against |

```text
/review-local
/review-local main
/review-local feature/auth
```

---

### `/review-handler`

Processes all review sources (human, Qodo, CodeRabbit) from the current branch's PR.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `--autorabbit` | flag | no | Auto-fix CodeRabbit comments in a polling loop |
| `--autoqodo` | flag | no | Auto-fix Qodo comments in a polling loop |
| `PR URL` | string | no | Specific review URL to process |

**Phases:** Fetch reviews → user decisions → execute fixes → test → commit & push → post replies → auto polling loop (if `--autorabbit`/`--autoqodo`)

**Prerequisites:** `myk-pi-tools`, `gh` CLI

> **Note:** `--autorabbit` and `--autoqodo` are command-level flags. They are **never** passed to the `myk-pi-tools` CLI.

```text
/review-handler
/review-handler --autorabbit
/review-handler --autoqodo
/review-handler --autorabbit --autoqodo
/review-handler https://github.com/owner/repo/pull/123#pullrequestreview-456
```

---

### `/review-handler-status`

Shows live status of running review-handler agents (autorabbit/autoqodo).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | — | — | No arguments |

Finds running `reviews poll` agents via `/async-status`, then generates an HTML status report per PR.

```text
/review-handler-status
```

---

### `/release`

Creates a GitHub release with automatic changelog generation from conventional commits.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `version` | string | no | Auto-detect from commits | Explicit version (e.g., `1.17.1`) |
| `--dry-run` | flag | no | — | Preview without creating |
| `--prerelease` | flag | no | — | Mark as prerelease |
| `--draft` | flag | no | — | Create draft release |
| `--target` | string | no | Current branch | Target branch for the release |
| `--tag-match` | string | no | — | Filter tags by pattern |

**Phases:** Validation → version detection → changelog → user approval → version bump → create release → summary

**Prerequisites:** `myk-pi-tools`, `gh` CLI

```text
/release
/release 2.0.0
/release --dry-run
/release --prerelease
/release --draft
/release --target v2.10
/release --target main --tag-match "v2.*"
```

---

### `/external-ai`

Runs a prompt through an external AI CLI (Cursor, Claude, Gemini) via `ai-cli-runner`.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `agent` | string | no | Last saved agent | Provider name: `cursor`, `claude`, `gemini`, or comma-separated list |
| `--model` | string | no | Provider default | Model ID (e.g., `gpt-5.4-high`, `claude-4.6-opus-max-thinking`) |
| `--fix` | flag | no | — | Allow the agent to modify files |
| `--peer` | flag | no | — | AI-to-AI peer review loop |
| `--resume` | flag | no | — | Continue most recent session |
| `prompt` | string | yes | — | The prompt to send |

**Default models per provider:**

| Provider | Default Model |
|----------|---------------|
| `cursor` | `composer-2-fast` |
| `claude` | `claude-sonnet-4-6` |
| `gemini` | `gemini-2.5-flash` |

**Flag constraints:**

- `--fix` and `--peer` are mutually exclusive
- `--resume` and `--peer` are mutually exclusive
- `--fix` requires a single agent (not multi-agent)

**Prerequisites:** `myk-pi-tools`

> **Tip:** For providers not listed here (codex, copilot, droid, kiro, etc.), use `/acpx-prompt` instead.

```text
/external-ai cursor fix the tests
/external-ai claude --model claude-4.6-opus-max-thinking review this code
/external-ai cursor --fix fix the code quality issues
/external-ai cursor --peer review this code
/external-ai cursor,claude review this code
/external-ai cursor --resume explain the last change
/external-ai --peer review this
```

For details on external AI workflows, see [Using External AI Agents (Cursor, Claude, Gemini)](external-ai-agents.html).

---

### `/refine-review`

Refines pending GitHub PR review comments with AI before submitting.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `PR URL` | string | yes | GitHub PR URL to refine pending comments for |

**Phases:** Fetch pending review → refine comments → side-by-side preview → user approval → update JSON → submit decision → execute → store comments → summary

**Prerequisites:** `myk-pi-tools`

```text
/refine-review https://github.com/owner/repo/pull/123
```

---

### `/query-db`

Queries the reviews database for analytics and insights about PR review history.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Subcommand or SQL query |

**Subcommands:**

| Subcommand | Description |
|------------|-------------|
| `stats --by-source` | Address rate by source (human vs AI) |
| `stats --by-reviewer` | Statistics by individual reviewer |
| `patterns --min <N>` | Find recurring dismissed patterns (minimum N occurrences) |
| `dismissed --owner <X> --repo <Y>` | All dismissed comments for a repo |
| `query "<SQL>"` | Run a custom SELECT query |
| `find-similar` | Find similar dismissed comments (JSON via stdin) |

> **Note:** Only `SELECT` statements and CTEs are allowed — the database is read-only for analytics.

**Prerequisites:** `myk-pi-tools`

```text
/query-db stats --by-source
/query-db stats --by-reviewer
/query-db patterns --min 2
/query-db query "SELECT * FROM comments WHERE status='skipped' LIMIT 10"
```

---

### `/remember`

Saves a memory as a pinned entry for future sessions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `what to remember` | string | yes | The memory to save |

The AI determines the best category (`lesson`, `decision`, `mistake`, `pattern`, `done`, `preference`) and saves it as a pinned memory via `myk-pi-tools memory add`.

```text
/remember always use ruff instead of flake8 for linting
/remember the API rate limit is 100 requests per minute
```

For details on the memory system, see [Working with Project Memory](memory-system.html).

---

### `/coderabbit-rate-limit`

Handles CodeRabbit rate limits by waiting for the cooldown period and re-triggering the review.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `PR number or URL` | string | no | Auto-detect from current branch | The PR to handle |

**Prerequisites:** `myk-pi-tools`, `gh` CLI

```text
/coderabbit-rate-limit
/coderabbit-rate-limit 123
/coderabbit-rate-limit https://github.com/owner/repo/pull/123
```

---

### `/create-coms-feature-manager`

Generates a project-specific coms feature manager prompt from the template.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | — | — | No arguments — interactive workflow |

Creates `.pi/prompts/coms-feature-manager.md` customized for the current project. The feature manager coordinates between a manager agent (reviewer) and a coder agent (implementer) via coms.

```text
/create-coms-feature-manager
```

For details on coms, see [Communicating Between Pi Sessions](inter-agent-communication.html).

---

### `/create-skill`

Creates a reusable skill from a successful workflow in the current conversation.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | no | Skill name (prompted if not provided) |

**Name format:** lowercase, hyphenated, max 64 characters (e.g., `debug-container-build`).

The AI asks whether to create the skill as **Global** (`~/.agents/skills/`) or **Project** (`.pi/skills/`) scoped.

```text
/create-skill debug-container-build
/create-skill
```

For details on customization, see [Customization and Extension Recipes](customization-recipes.html).

---

## Extension Commands

### `/btw`

Ask a quick side question without polluting conversation history. Uses a lightweight LLM call with no tool access — answers based on conversation context only.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `question` | string | yes | The side question to ask |

The answer displays in a scrollable overlay. Press `Esc`, `Space`, or `q` to dismiss. Use `↑`/`↓`/`j`/`k` to scroll, `PgUp`/`PgDn` for fast scroll.

```text
/btw what was the name of the function we changed earlier?
/btw which branch am I on?
```

---

### `/status`

Shows a unified session status snapshot. Direct handler — no AI roundtrip.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | — | — | No arguments |

**Displays:**

- Async agents (count and names)
- Cron tasks (count, schedule, last run)
- Git status (branch, changed files count)
- Container indicator (if running in Docker)
- Loaded resources (context files, skills, tools, guidelines)

```text
/status
```

---

### `/async-status`

Shows status of background async agents with a live output viewer.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | — | — | No arguments |

If agents are running, presents a selection list. Selecting an agent opens a live scrollable overlay showing the agent's output in real-time. Press `Esc` or `q` to close.

```text
/async-status
```

For details on async agents, see [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html).

---

### `/async-kill`

Kills running async agent(s) by name, ID, or all.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `target` | string | no | Agent name, ID, or `all`. If omitted, shows interactive selection |

Kills the entire process tree (parent + children) using `SIGKILL`.

```text
/async-kill
/async-kill all
/async-kill worker-abc123
```

---

### `/cron`

Schedules recurring tasks. Supports both natural language and structured subcommands.

| Subcommand | Description |
|------------|-------------|
| `list` | List scheduled tasks for this session |
| `list-all` | List cron tasks across all active pi sessions |
| `remove <id>` | Remove a task by ID (aliases: `rm`, `delete`, `kill`) |
| `<natural language>` | AI parses and creates a scheduled task |

**Subcommand: `list`**

```text
/cron list
```

**Subcommand: `list-all`**

```text
/cron list-all
```

**Subcommand: `remove`**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | yes | Task ID(s) to remove (space-separated for multiple) |

```text
/cron remove 1
/cron remove 1 2 3
/cron kill 5
```

**Natural language scheduling:**

The AI parses the request and calls the `cron_manage` tool with structured parameters.

| Parameter (tool) | Type | Description |
|-------------------|------|-------------|
| `interval_seconds` | number | Run every N seconds (minimum: 10) |
| `at_hour` | number | Hour (0–23) for daily schedule |
| `at_minute` | number | Minute (0–59) for daily schedule |
| `task` | string | What to execute — a prompt or `/slash-command` |
| `description` | string | Human-readable description |

- Tasks starting with `/` execute as slash commands
- Other tasks run as async `worker` agents

```text
/cron every 30 minutes check for new issues
/cron at 09:00 run /review-handler --autorabbit
/cron every 2h run git fetch --all
```

> **Note:** Cron tasks are process-scoped — they survive `/reload` and `/new` but stop on pi exit. Not available in one-shot modes (`print`/`json`).

For details, see [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html).

---

### `/dream`

Triggers memory consolidation immediately as a background task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | — | — | No arguments |

Spawns a fire-and-forget `worker` agent that reads session history, extracts durable knowledge, and writes topic files under `.pi/memory/topics/`.

```text
/dream
```

---

### `/dream-auto`

Toggles automatic memory dreaming (runs every 3 hours and on session end).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `on` or `off` | string | no | Enable or disable. If omitted, shows current status |

The dream interval is configurable via the `dream_interval_hours` project setting or `PI_DREAM_INTERVAL_HOURS` env var (range: 0.5–24 hours, default: 3).

```text
/dream-auto on
/dream-auto off
/dream-auto
```

For details on memory consolidation, see [Working with Project Memory](memory-system.html).

---

### `/coms`

Manages P2P agent communication between pi sessions.

| Subcommand | Description |
|------------|-------------|
| `start` | Start P2P communication |
| `stop` | Stop coms |
| `status` | Show coms status |

**Start options:**

| Flag | Type | Description |
|------|------|-------------|
| `--name` | string | Agent name |
| `--purpose` | string | Agent purpose description |
| `--project` | string | Project namespace (default: derived from cwd) |
| `--color` | string | Hex color `#RRGGBB` |
| `--explicit` | flag | Hide from auto-discovery |

```text
/coms start
/coms start --name reviewer --purpose "code review"
/coms stop
/coms status
```

---

### `/coms-net`

Manages networked agent communication with a hub server.

| Subcommand | Description |
|------------|-------------|
| `start` | Start local server and connect |
| `connect` | Connect to a running server |
| `disconnect` | Disconnect from server (keep server running) |
| `stop` | Stop coms-net and kill server |
| `status` | Show coms-net and server status |

**Start options:**

| Flag | Type | Description |
|------|------|-------------|
| `--name` | string | Agent name |
| `--purpose` | string | Agent purpose description |
| `--project` | string | Project namespace (default: derived from cwd) |
| `--color` | string | Hex color `#RRGGBB` |
| `--explicit` | flag | Hide from auto-discovery |
| `--port` | string | Server port (default: OS-assigned) |
| `--host` | string | Server bind address (e.g., `0.0.0.0` for LAN) |

**Connect options:**

| Flag | Type | Description |
|------|------|-------------|
| `--name` | string | Agent name |
| `--purpose` | string | Agent purpose description |
| `--project` | string | Project namespace |
| `--color` | string | Hex color `#RRGGBB` |
| `--explicit` | flag | Hide from auto-discovery |
| `--url` | string | Hub server URL |
| `--auth-token` | string | Bearer token for the hub |

> **Note:** `start` auto-manages the hub server (spawns via Bun if not already running). `connect` connects to an existing server without managing its lifecycle. Use `disconnect` when you didn't start the server; use `stop` when you did.

```text
/coms-net start
/coms-net start --name planner --port 8080
/coms-net connect --url http://192.168.1.5:8080 --auth-token mytoken
/coms-net disconnect
/coms-net stop
/coms-net status
```

For details on inter-agent communication, see [Communicating Between Pi Sessions](inter-agent-communication.html).

---

### `/pidash`

Manages the pidash web dashboard daemon.

| Subcommand | Description |
|------------|-------------|
| `start` | Start the pidash server |
| `stop` | Stop the pidash server |
| `restart` | Restart the pidash server |
| `status` | Show server status (default when no argument) |

**Default port:** `19190` (override with `PI_PIDASH_PORT` env var)

**Status output includes:** server running/stopped, port, extension connected/disconnected, URL.

> **Note:** Disable pidash entirely by setting `PI_PIDASH_ENABLE=false`.

```text
/pidash start
/pidash stop
/pidash restart
/pidash status
/pidash
```

For details on the web dashboard, see [Using the Web Dashboard and Diff Viewer](dashboards-and-diffs.html).

---

### `/pidiff`

Manages the pidiff diff viewer daemon.

| Subcommand | Description |
|------------|-------------|
| `start` | Start the pidiff server |
| `stop` | Stop the pidiff server |
| `restart` | Restart the pidiff server |
| `status` | Show server status (default when no argument) |

**Default port:** `19290` (override with `PI_PIDIFF_PORT` env var)

> **Note:** Disable pidiff entirely by setting `PI_PIDIFF_ENABLE=false`.

```text
/pidiff start
/pidiff stop
/pidiff restart
/pidiff status
```

For details on the diff viewer, see [Using the Web Dashboard and Diff Viewer](dashboards-and-diffs.html).

---

### `/repair`

Repairs a broken session by fixing orphaned tool calls that break API requests.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | — | — | No arguments |

Scans the session file for tool calls on the active branch that have no corresponding tool result. Injects synthetic `toolResult` entries with error messages to satisfy API requirements, then re-parents subsequent entries. Reports the number of orphans found and patched.

```text
/repair
```

---

### `/nvim-changed-files`

Sends git changed files to Neovim's quickfix list. Only available when running inside a Neovim terminal (`NVIM` env var is set).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | — | — | No arguments |

Detects changed files relative to `origin/main` (or `HEAD` if on main) and opens the quickfix window in the parent Neovim instance.

```text
/nvim-changed-files
```

---

### `/external-ai-models-refresh`

Clears cached AI CLI model lists and re-fetches from all providers.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | — | — | No arguments |

Refreshes the autocomplete model cache for `cursor`, `claude`, and `gemini` providers.

```text
/external-ai-models-refresh
```

---

## Quick Reference Table

| Command | Type | Arguments | Description |
|---------|------|-----------|-------------|
| `/implement` | Prompt | `<task>` | Scout → plan → implement |
| `/implement-and-review` | Prompt | `<task>` | Implement → review → fix |
| `/scout-and-plan` | Prompt | `<task>` | Scout → plan (no changes) |
| `/pr-review` | Prompt | `[PR#/URL]` | Review a GitHub PR |
| `/review-local` | Prompt | `[branch]` | Review local changes |
| `/review-handler` | Prompt | `[--autorabbit] [--autoqodo]` | Process PR review comments |
| `/review-handler-status` | Prompt | — | Status of running review handlers |
| `/release` | Prompt | `[version] [flags]` | Create GitHub release |
| `/external-ai` | Prompt | `<agent> [flags] <prompt>` | Route to external AI CLI |
| `/refine-review` | Prompt | `<PR URL>` | Polish pending review comments |
| `/query-db` | Prompt | `<query>` | Query review database |
| `/remember` | Prompt | `<memory>` | Save a pinned memory |
| `/coderabbit-rate-limit` | Prompt | `[PR#/URL]` | Handle CodeRabbit rate limits |
| `/create-coms-feature-manager` | Prompt | — | Generate coms feature manager |
| `/create-skill` | Prompt | `[name]` | Save workflow as reusable skill |
| `/btw` | Extension | `<question>` | Quick side question (no tools) |
| `/status` | Extension | — | Session status snapshot |
| `/async-status` | Extension | — | Background agent status |
| `/async-kill` | Extension | `[target]` | Kill async agent(s) |
| `/cron` | Extension | `<subcommand/text>` | Schedule recurring tasks |
| `/dream` | Extension | — | Trigger memory consolidation |
| `/dream-auto` | Extension | `[on/off]` | Toggle auto-dreaming |
| `/coms` | Extension | `start/stop/status` | P2P agent communication |
| `/coms-net` | Extension | `start/connect/...` | Networked agent communication |
| `/pidash` | Extension | `start/stop/restart/status` | Web dashboard daemon |
| `/pidiff` | Extension | `start/stop/restart/status` | Diff viewer daemon |
| `/repair` | Extension | — | Fix orphaned tool calls |
| `/nvim-changed-files` | Extension | — | Send changed files to Neovim |
| `/external-ai-models-refresh` | Extension | — | Refresh AI model cache |

## Related Pages

- [Using Slash Commands and Prompt Templates](slash-commands.html)
- [Specialist Agents Reference](agents-reference.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
- [Communicating Between Pi Sessions](inter-agent-communication.html)
- [Using the Web Dashboard and Diff Viewer](dashboards-and-diffs.html)
