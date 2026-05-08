# Slash Commands Reference

## Overview

Pi provides two types of slash commands:

- **Prompt template commands** — defined in the `prompts/` directory, executed by the orchestrator, and may delegate to specialist agents.
- **Extension commands** — defined in TypeScript under `extensions/orchestrator/`, executed directly without an AI roundtrip (unless noted).

All commands support Tab completion for arguments. Completions are cached for 5 minutes.

---

## Implementation Commands

### `/implement`

Runs a scout, planner, and worker agent chain to explore the codebase, plan changes, and implement them.

```
/implement <task>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | string | Yes | Description of the task to implement |

The command executes three agents in sequence:

1. **scout** — explores the codebase and returns a summary of file locations, key functions, and dependencies.
2. **planner** — creates a detailed implementation plan: files to modify, step-by-step changes, edge cases, testing approach.
3. **worker** — implements the plan, making all code changes following project conventions.

```
/implement add pagination to the /users API endpoint
```

---

### `/scout-and-plan`

Runs the scout and planner agents without implementing. Useful for reviewing a plan before committing to changes.

```
/scout-and-plan <task>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | string | Yes | Description of the task to plan |

The command executes two agents in sequence:

1. **scout** — explores the codebase and returns a summary of relevant code.
2. **planner** — creates a detailed implementation plan with files, steps, edge cases, and testing approach.

```
/scout-and-plan migrate the auth middleware to use JWT tokens
```

---

### `/implement-and-review`

Implements a task, runs three parallel code reviewers, then fixes all issues found.

```
/implement-and-review <task>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | string | Yes | Description of the task to implement and review |

The command executes agents in this sequence:

1. **worker** — implements the task.
2. Three review agents run **in parallel**:
   - **code-reviewer-quality** — code quality review
   - **code-reviewer-guidelines** — guideline adherence review
   - **code-reviewer-security** — bugs and security review
3. **worker** — fixes all issues found by reviewers and reports what was fixed.

```
/implement-and-review add rate limiting to the API gateway
```

---

## Code Review Commands

### `/pr-review`

Reviews a GitHub PR using three parallel review agents and posts inline comments.

```
/pr-review [PR number or URL]
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `PR number or URL` | string | No | Auto-detect from current branch | PR number, full URL, or omit for auto-detection |

**Tab completion:** Open PR numbers from the current repository.

**Prerequisites:** `uv` and `myk-pi-tools` must be installed.

**Workflow phases:**

1. **PR Detection** — resolves the PR from the argument or current branch via `gh pr view`.
2. **Data Fetching** — fetches the PR diff and project AGENTS.md using `myk-pi-tools pr diff` and `myk-pi-tools pr claude-md`.
3. **Code Analysis** — delegates to three review agents in parallel (quality, guidelines, security).
4. **User Selection** — presents findings grouped by severity (CRITICAL, WARNING, SUGGESTION). The user selects which to post.
5. **Post Comments** — posts selected findings as inline PR comments via `myk-pi-tools pr post-comment`.
6. **Summary** — displays final counts and links.

```
/pr-review
/pr-review 123
/pr-review https://github.com/owner/repo/pull/123
```

---

### `/review-local`

Reviews uncommitted changes or branch differences using three parallel review agents.

```
/review-local [base branch]
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `base branch` | string | No | `HEAD` (uncommitted changes) | Branch name to compare against |

**Tab completion:** Git branch names (local and remote).

When no argument is provided, reviews all uncommitted changes (staged + unstaged) via `git diff HEAD`. When a branch is specified, compares the current branch against it via `git diff <branch>...HEAD`.

Three review agents run in parallel, analyzing for code quality, guidelines adherence, and security. Results are merged, deduplicated, and presented grouped by severity.

```
/review-local
/review-local main
/review-local feature/auth-refactor
```

---

### `/review-handler`

Processes all review sources (human, Qodo, CodeRabbit) from the current branch's PR and applies fixes.

```
/review-handler [--autorabbit] [URL]
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `--autorabbit` | flag | No | Off | Auto-approve and fix CodeRabbit comments in a polling loop |
| `URL` | string | No | Auto-detect from current branch | Specific review URL |

**Tab completion:** `--autorabbit` flag.

**Prerequisites:** `uv` and `myk-pi-tools` must be installed.

> **Warning:** `--autorabbit` is a command-level flag. It is never passed to `myk-pi-tools` CLI commands.

**Standard workflow:**

1. Fetches reviews from all sources via `myk-pi-tools reviews fetch`.
2. Presents items in a table grouped by source, with global numbering and priority sorting.
3. Collects user decisions (yes/no/all/skip per source).
4. Delegates fixes to appropriate specialist agents.
5. Runs tests (all must pass before proceeding).
6. Commits and pushes changes.
7. Posts replies to GitHub and stores results in the database.

**Autorabbit mode (`--autorabbit`):**

Skips the initial fetch/review cycle and enters a polling loop. CodeRabbit comments are auto-approved without user interaction. The loop runs until CodeRabbit approves the PR or the user explicitly stops it.

```
/review-handler
/review-handler --autorabbit
/review-handler https://github.com/owner/repo/pull/123#pullrequestreview-456
```

---

### `/refine-review`

Refines pending GitHub PR review comments with AI before submitting.

```
/refine-review <PR URL>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `PR URL` | string | Yes | Full GitHub PR URL |

**Prerequisites:** `uv` and `myk-pi-tools` must be installed.

**Workflow:**

1. Fetches pending review comments via `myk-pi-tools reviews pending-fetch`.
2. Refines each comment for clarity, conciseness, and actionability.
3. Presents original and refined versions side-by-side.
4. User selects which refinements to accept (all, specific numbers, keep originals, or custom text).
5. User chooses a review action: Comment, Approve, Request Changes, or keep pending.
6. Submits updates via `myk-pi-tools reviews pending-update`.

```
/refine-review https://github.com/owner/repo/pull/123
```

---

## Release & Integration Commands

### `/release`

Creates a GitHub release with automatic changelog generation and optional version file bumping.

```
/release [version] [flags]
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `version` | string | No | Auto-detected from commits | Explicit version number (e.g., `1.17.1`) |
| `--dry-run` | flag | No | Off | Preview the release without creating it |
| `--prerelease` | flag | No | Off | Mark as prerelease |
| `--draft` | flag | No | Off | Create as draft release |
| `--target <branch>` | flag | No | Current branch | Target branch for the release |
| `--tag-match <pattern>` | flag | No | None | Filter tags to a specific pattern |

**Tab completion:** Recent git tags sorted by version.

**Prerequisites:** `myk-pi-tools` must be installed.

**Workflow:**

1. **Validation** — checks branch status, clean working tree, and remote sync via `myk-pi-tools release info`.
2. **Version Detection** — scans for version files via `myk-pi-tools release detect-versions`.
3. **Changelog** — categorizes commits by conventional commit type and generates formatted changelog with emoji section headers.
4. **User Approval** — presents proposed version, version files to update, and changelog preview. Skipped when an explicit version is provided.
5. **Version Bump** — updates version files via `myk-pi-tools release bump-version`, creates a PR, and merges it.
6. **Create Release** — creates the GitHub release via `myk-pi-tools release create`.

**Version bump logic:**

| Commit Type | Bump |
|-------------|------|
| Breaking changes | MAJOR |
| `feat:` | MINOR |
| `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:` | PATCH |

```
/release
/release 2.0.0
/release --dry-run
/release --prerelease --draft
```

---

### `/coderabbit-rate-limit`

Handles CodeRabbit rate limits by waiting for the cooldown period and re-triggering the review.

```
/coderabbit-rate-limit [PR number or URL]
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `PR number or URL` | string | No | Auto-detect from current branch | PR number or full URL |

**Tab completion:** Open PR numbers from the current repository.

**Prerequisites:** `uv` and `myk-pi-tools` must be installed.

**Workflow:**

1. Detects the PR from arguments or current branch.
2. Checks rate limit status via `myk-pi-tools coderabbit check`.
3. If rate-limited, waits for the cooldown (plus 30-second buffer) and triggers `@coderabbitai review`.
4. Polls until the review starts (max 10 minutes).

```
/coderabbit-rate-limit
/coderabbit-rate-limit 123
/coderabbit-rate-limit https://github.com/owner/repo/pull/123
```

---

### `/query-db`

Queries the reviews database for analytics and insights about PR review history.

```
/query-db <command>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | Query subcommand or raw SQL SELECT |

**Prerequisites:** `myk-pi-tools` must be installed.

**Available subcommands:**

| Subcommand | Description |
|------------|-------------|
| `stats --by-source` | Addressed rate by source (human vs AI) |
| `stats --by-reviewer` | Statistics by individual reviewer |
| `patterns --min <N>` | Find recurring dismissed suggestions (minimum N occurrences) |
| `dismissed --owner <X> --repo <Y>` | All dismissed comments for a specific repo |
| `query "<SQL>"` | Custom SELECT query against the database |
| `find-similar` | Find comments similar to previously dismissed ones (JSON via stdin) |

> **Note:** Only SELECT statements and CTEs are allowed. Modifying queries (INSERT, UPDATE, DELETE, DROP) are blocked.

The database is located at `<project-root>/.claude/data/reviews.db`.

```
/query-db stats --by-source
/query-db stats --by-reviewer
/query-db patterns --min 2
/query-db dismissed --owner myorg --repo myrepo
/query-db query "SELECT * FROM comments WHERE status='skipped' LIMIT 10"
```

---

## External Agent Commands

### `/acpx-prompt`

Runs a prompt through [acpx](https://github.com/openclaw/acpx) to any ACP-compatible coding agent.

```
/acpx-prompt [agent[:model]] [--fix|--peer] <prompt>
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `agent` | string | No | Last saved agent from `.pi/acpx-config.json` | Target agent name |
| `:model` | string | No | Agent default | Model override (e.g., `codex:o3-pro`) |
| `--fix` | flag | No | Off | Grant the agent file write permissions |
| `--peer` | flag | No | Off | Run an AI-to-AI peer review loop |
| `prompt` | string | Yes | — | The prompt to send to the agent |

**Tab completion:** Agent names (`pi`, `openclaw`, `codex`, `claude`, `gemini`, `cursor`, `copilot`, `droid`, `iflow`, `kilocode`, `kimi`, `kiro`, `opencode`, `qwen`) and flags (`--fix`, `--peer`).

**Prerequisites:** `acpx` must be installed (`npm install -g acpx@latest`). The underlying agent CLI must also be installed separately.

**Supported agents:**

| Agent | Wraps |
|-------|-------|
| `pi` | Pi Coding Agent |
| `openclaw` | OpenClaw ACP bridge |
| `codex` | Codex CLI (OpenAI) |
| `claude` | Claude Code |
| `gemini` | Gemini CLI |
| `cursor` | Cursor CLI |
| `copilot` | GitHub Copilot CLI |
| `droid` | Factory Droid |
| `iflow` | iFlow CLI |
| `kilocode` | Kilocode |
| `kimi` | Kimi CLI |
| `kiro` | Kiro CLI |
| `opencode` | OpenCode |
| `qwen` | Qwen Code |

**Modes:**

| Mode | Flag | Permissions |
|------|------|-------------|
| Default (read-only) | none | Agent can read files only |
| Fix | `--fix` | Agent can read and write files |
| Peer review | `--peer` | AI-to-AI debate loop until convergence |

> **Note:** `--fix` and `--peer` are mutually exclusive. Multiple agents with `--fix` is not supported.

**Peer review mode** runs a multi-round debate loop between Claude and the peer agent(s). Claude fixes code based on findings and sends changes back for re-review. The loop continues until all peer agents confirm no remaining issues. With multiple peers, all must agree independently.

**Configuration persistence:** The last-used agent spec is saved to `.pi/acpx-config.json` after successful runs. Subsequent invocations without an agent name use the saved value.

```
/acpx-prompt codex review this function
/acpx-prompt cursor:gpt-4o --fix fix the failing tests
/acpx-prompt cursor,codex --peer review the architecture
/acpx-prompt --peer review this code
```

---

## Memory Commands

### `/dream`

Runs memory consolidation as a background async agent. Analyzes the current session and maintains the `memory.md` file.

```
/dream
```

This command takes no arguments. It runs as a fire-and-forget background agent and does not block the session.

**Operations performed:**

1. Reads the memory file at `<project>/.pi/memory/memory.md`.
2. Extracts learnable items from the current session (lessons, preferences, mistakes, completed work, patterns).
3. Deduplicates and removes stale entries from the Learned section.
4. Keeps the file under 50 entries.
5. Never modifies entries in the Pinned section.

```
/dream
```

---

### `/remember`

Saves a pinned project memory for future sessions.

```
/remember <what to remember>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `what` | string | Yes | The information to save as a pinned memory |

Automatically categorizes the memory as one of: `lesson`, `decision`, `mistake`, `pattern`, `done`, or `preference`. Saved via `myk-pi-tools memory add --pinned`.

Pinned memories are never auto-removed by the `/dream` consolidation process.

```
/remember always run uv lock after changing pyproject.toml
/remember the billing API requires OAuth2 client credentials flow
```

---

## Session Utility Commands

### `/btw`

Asks a quick side question without polluting the conversation history.

```
/btw <question>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `question` | string | Yes | The side question to ask |

Opens an ephemeral overlay that shows the answer. The question and answer are not added to the conversation history. The AI answers based only on existing conversation context with no tool access.

**Overlay controls:**

| Key | Action |
|-----|--------|
| `Esc`, `Space`, `q` | Dismiss |
| `Up` / `k` | Scroll up |
| `Down` / `j` | Scroll down |
| `PgUp` | Scroll up 10 lines |
| `PgDn` | Scroll down 10 lines |

```
/btw what branch am I on?
/btw what was the name of that function we discussed?
```

---

### `/status`

Shows a unified session status snapshot. Executes directly without an AI roundtrip.

```
/status
```

This command takes no arguments.

**Displays:**

- **Async agents** — count and list of running background agents with duration and task preview.
- **Cron tasks** — count and list of active scheduled tasks with schedule and last run time.
- **Git** — current branch, clean/dirty state, number of changed files, and repository name.
- **Container** — whether the session is running inside a container.

```
/status
```

---

### `/async-status`

Shows the status of background async agents. If running agents exist, presents an interactive selector to view live streaming output.

```
/async-status
```

This command takes no arguments.

If all agents are completed, shows a static summary with completion status and duration. If running agents exist, lets you select one to view live output in a scrollable overlay.

**Live output viewer controls:**

| Key | Action |
|-----|--------|
| `Esc`, `Ctrl+C` | Close viewer |
| `Up` / `Down` | Scroll |
| `PgUp` / `PgDn` | Scroll 10 lines |
| `Home` / `End` | Jump to top/bottom |

```
/async-status
```

---

### `/async-kill`

Kills running async agent(s) by name, ID prefix, or all at once. Without an argument, presents an interactive selection menu.

```
/async-kill [name|id|all]
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `target` | string | No | Interactive selection | Agent name, ID prefix, or `all` |

```
/async-kill all
/async-kill Dream
/async-kill worker-1716000000
```

---

### `/dream-auto`

Toggles automatic memory dreaming. When enabled, spawns a worker agent every 3 hours and on session quit to consolidate memories.

```
/dream-auto [on|off]
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `state` | string | No | Shows current status | `on` to enable, `off` to disable |

**Tab completion:** `on`, `off`.

**Environment variable:** `PI_DREAM_INTERVAL_HOURS` — override the dreaming interval (default: `3`, range: `0.5`–`24`).

Auto-dreaming is enabled by default. On session quit, a final dream runs as a detached process.

```
/dream-auto
/dream-auto on
/dream-auto off
```

---

### `/cron`

Schedules recurring tasks within the pi session. Tasks survive `/reload` and `/new` but are terminated on pi exit.

```
/cron <subcommand|natural language>
```

| Subcommand | Description |
|------------|-------------|
| `list` | List scheduled tasks in the current session |
| `list-all` | List cron tasks from all active pi sessions |
| `remove <id> [id...]` | Remove tasks by ID (aliases: `rm`, `delete`, `kill`) |
| `<natural language>` | Add a task using natural language (parsed by AI) |

**Tab completion:** Subcommands (`add`, `list`, `list-all`, `remove`), schedule hints (`every`, `at`), and task IDs for removal.

**Schedule types:**

| Type | Format | Example |
|------|--------|---------|
| Interval-based | `every <duration>` | `every 2h`, `every 30m` |
| Time-based | `at <HH:MM>` | `at 12:00`, `at 09:30` |

**Task types:**

| Type | Prefix | Execution |
|------|--------|-----------|
| Slash command | `/` | Executed as a command in the session |
| Prompt | (any text) | Run as an async background agent |

> **Note:** Minimum interval is 10 seconds. Tasks are persisted to a PID-scoped file and restored after `/reload`.

```
/cron list
/cron list-all
/cron remove 1 3
/cron every 2h run /pr-review
/cron at 09:00 check for new issues
```

The `cron_manage` tool is also available for the AI to manage cron tasks programmatically with structured parameters.

**`cron_manage` tool parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `"add"` \| `"list"` \| `"list-all"` \| `"remove"` | Yes | Action to perform |
| `description` | string | For `add` | Human-readable task description |
| `task` | string | For `add` | What to execute (prompt or `/command`) |
| `interval_seconds` | number | For interval `add` | Run every N seconds (minimum 10) |
| `at_hour` | number (0–23) | For time-based `add` | Hour for daily schedule |
| `at_minute` | number (0–59) | For time-based `add` | Minute for daily schedule |
| `id` | number | For `remove` | Task ID to remove |

---

### `/pidash`

Manages the pidash web dashboard daemon. Pidash provides a browser-based UI for monitoring pi sessions, viewing conversation history, managing async agents and cron tasks, and switching models.

```
/pidash [subcommand]
```

| Subcommand | Description |
|------------|-------------|
| `start` | Start the pidash server |
| `stop` | Stop the pidash server and disconnect |
| `restart` | Stop and restart the pidash server |
| `status` | Show server status, port, and connection state (default) |

**Tab completion:** `start`, `stop`, `restart`, `status`.

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_PIDASH_PORT` | `19190` | Port for the pidash server |
| `PI_PIDASH_ENABLE` | `true` | Set to `false` to disable pidash |

The dashboard is accessible at `http://localhost:19190` (or the configured port). It connects to pi via WebSocket and supports sending prompts from the browser, switching models, aborting operations, and viewing live streaming output.

```
/pidash
/pidash start
/pidash stop
/pidash restart
/pidash status
```

---

### `/pidiff`

Manages the pidiff diff viewer daemon. Pidiff provides a browser-based UI for viewing branch diffs, file trees, and inline review comments.

```
/pidiff [subcommand]
```

| Subcommand | Description |
|------------|-------------|
| `start` | Start the pidiff server |
| `stop` | Stop the pidiff server and disconnect |
| `restart` | Stop and restart the pidiff server |
| `status` | Show server status, port, and connection state (default) |

**Tab completion:** `start`, `stop`, `restart`, `status`.

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_PIDIFF_PORT` | `19290` | Port for the pidiff server |
| `PI_PIDIFF_ENABLE` | `true` | Set to `false` to disable pidiff |

Review comments published from the pidiff browser UI are automatically injected into the pi session as follow-up messages.

```
/pidiff
/pidiff start
/pidiff stop
/pidiff restart
```

---

### `/nvim-changed-files`

Sends git changed files to Neovim's quickfix list. Only available when pi is running inside a Neovim terminal (the `NVIM` environment variable is set).

```
/nvim-changed-files
```

This command takes no arguments.

Collects all changed files (committed on the branch vs. `origin/main` plus uncommitted changes) and sends them to the parent Neovim instance's quickfix list via RPC. Opens the quickfix window automatically.

> **Note:** This command is only registered when the `NVIM` environment variable points to a valid Neovim socket.

```
/nvim-changed-files
```

---

## Quick Reference

| Command | Type | Arguments | Description |
|---------|------|-----------|-------------|
| `/implement` | Prompt | `<task>` | Scout, plan, and implement |
| `/scout-and-plan` | Prompt | `<task>` | Scout and plan without implementing |
| `/implement-and-review` | Prompt | `<task>` | Implement with review and fix cycle |
| `/pr-review` | Prompt | `[#\|URL]` | Review a GitHub PR |
| `/review-local` | Prompt | `[branch]` | Review local changes |
| `/review-handler` | Prompt | `[--autorabbit] [URL]` | Process and fix PR review comments |
| `/refine-review` | Prompt | `<URL>` | Refine pending review comments |
| `/release` | Prompt | `[version] [flags]` | Create a GitHub release |
| `/coderabbit-rate-limit` | Prompt | `[#\|URL]` | Handle CodeRabbit rate limits |
| `/query-db` | Prompt | `<command>` | Query the reviews database |
| `/acpx-prompt` | Prompt | `[agent] [flags] <prompt>` | Run prompt via external agent |
| `/dream` | Prompt | — | Run memory consolidation |
| `/remember` | Prompt | `<what>` | Save a pinned memory |
| `/btw` | Extension | `<question>` | Quick side question (ephemeral) |
| `/status` | Extension | — | Session status snapshot |
| `/async-status` | Extension | — | Background agent status |
| `/async-kill` | Extension | `[target]` | Kill background agent(s) |
| `/dream-auto` | Extension | `[on\|off]` | Toggle automatic dreaming |
| `/cron` | Extension | `<subcommand\|text>` | Schedule recurring tasks |
| `/pidash` | Extension | `[subcommand]` | Manage web dashboard |
| `/pidiff` | Extension | `[subcommand]` | Manage diff viewer |
| `/nvim-changed-files` | Extension | — | Send changed files to Neovim |
