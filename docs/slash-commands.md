# Using Slash Commands and Prompt Templates

Slash commands let you trigger multi-step workflows in a single line — from implementing features to creating GitHub releases. This guide shows you how to use every built-in command and how prompt templates work under the hood.

## Prerequisites

- A running pi session (see [Installing and Starting Your First Session](quickstart.html))
- `myk-pi-tools` installed (`uv tool install myk-pi-tools`) — required by most commands
- GitHub CLI (`gh`) authenticated — needed for PR and release commands

## Quick Example

Type a slash command directly in your pi session:

```
/implement add a retry mechanism to the HTTP client
```

Pi scouts the codebase, creates a plan, and implements the change — all in one step.

## Prompt Template Commands

Prompt templates are markdown files that define multi-step workflows. When you type a `/command`, pi loads the matching template and follows its instructions. Arguments you pass replace the `$ARGUMENTS` placeholder in the template.

### /implement — Scout, Plan, and Build

Chains three specialist agents in sequence: scout → planner → worker.

```
/implement <task description>
```

**Examples:**

```
/implement add pagination to the users API endpoint
/implement refactor the auth middleware to support JWT
```

The scout explores relevant code, the planner creates a step-by-step plan, and the worker implements it.

### /scout-and-plan — Explore Without Changing Code

Like `/implement` but stops after planning — no code changes are made.

```
/scout-and-plan <task description>
```

**Examples:**

```
/scout-and-plan migrate the database layer to async
/scout-and-plan what would it take to add WebSocket support
```

Use this when you want to understand the scope of a change before committing to it.

### /implement-and-review — Build With Automated Review

Implements a task, then runs all three code reviewers in parallel, and fixes any issues found.

```
/implement-and-review <task description>
```

The workflow:
1. Worker implements the task
2. Three reviewers run in parallel: quality, guidelines, and security
3. Worker fixes all review findings

### /pr-review — Review a GitHub PR

Reviews a GitHub PR using three parallel reviewers and posts inline comments.

```
/pr-review                       # Review PR from current branch
/pr-review 123                   # Review PR #123
/pr-review https://github.com/owner/repo/pull/123
```

**Workflow:**
1. Clones the PR's repo and checks out the PR branch (reviewers get full repo access)
2. Checks past review comments — verifies whether previously posted comments were addressed, resolved correctly, or still unresolved
3. Runs three reviewers in parallel (quality, guidelines, security) — each reviewer reads project guidelines (AGENTS.md/CLAUDE.md) independently
4. Merges and deduplicates findings from all reviewers and past comment analysis
5. Presents findings grouped by severity (CRITICAL → WARNING → SUGGESTION), including past unresolved and incorrectly resolved comments
6. Lets you choose which findings to post as inline comments
7. Stores posted comments in a local database for tracking across review cycles

> **Tip:** Tab-completion is available — press Tab after `/pr-review` to see open PRs.

### /review-local — Review Uncommitted Changes

Reviews your local changes without touching GitHub.

```
/review-local                    # Review uncommitted changes (staged + unstaged)
/review-local main               # Review changes compared to main branch
/review-local feature/auth       # Review changes compared to a specific branch
```

All three reviewers run in parallel and findings are grouped by severity. No comments are posted anywhere — this is purely local feedback.

> **Tip:** Press Tab after `/review-local` to autocomplete branch names.

### /release — Create a GitHub Release

Creates a GitHub release with automatic changelog generation and optional version bumping.

```
/release                         # Auto-detect version bump from commits
/release 2.1.0                   # Release with explicit version (skips approval)
/release --dry-run               # Preview without creating
/release --prerelease            # Create a prerelease
/release --draft                 # Create a draft release
/release --target v2.10          # Target a specific branch
```

**Workflow:**
1. Validates the branch (must be default or target branch, clean, synced)
2. Detects version files (pyproject.toml, package.json, Cargo.toml, etc.)
3. Categorizes commits by conventional commit type and generates a changelog
4. Asks for approval (unless an explicit version was given)
5. Bumps version files, creates a PR, merges it
6. Creates the GitHub release with the changelog

> **Tip:** Tab-completion shows recent git tags and flags like `--dry-run`, `--prerelease`, `--draft`, and `--target`.

### /review-handler — Process All PR Review Comments

Fetches and processes review comments from all sources — human reviewers, Qodo, and CodeRabbit.

```
/review-handler                              # Process current PR's reviews
/review-handler --autorabbit                 # Auto-fix CodeRabbit comments in a loop
/review-handler --autoqodo                   # Auto-fix Qodo comments in a loop
/review-handler --autorabbit --autoqodo      # Auto-fix both in a loop
```

In manual mode, each review comment is presented with its severity and you decide which to address. In auto mode (`--autorabbit`/`--autoqodo`), the command enters a polling loop that automatically fixes comments, pushes changes, and waits for the reviewer to re-evaluate — fully unattended.

> **Note:** The `--autorabbit` and `--autoqodo` flags are command-level flags for pi, not CLI arguments. They control the behavior of the polling loop.

For multi-PR scenarios, the command uses `git worktree` to isolate each PR rather than switching branches, which prevents interference with other running agents.

### /external-ai — Run Prompts via External AI CLIs

Sends prompts to external AI agents (Cursor, Claude, Gemini) via ai-cli-runner.

```
/external-ai cursor review the error handling
/external-ai claude explain this function
/external-ai gemini --model gemini-2.5-pro analyze the architecture
/external-ai cursor --fix fix the failing tests
/external-ai cursor --peer review this code
/external-ai cursor,claude review this code          # Multi-agent
/external-ai cursor --resume explain the last change  # Continue session
```

**Modes:**

| Flag | Behavior |
|------|----------|
| *(none)* | Read-only — agent cannot modify files |
| `--fix` | Agent can modify, create, and delete files |
| `--peer` | AI-to-AI debate loop until both agents agree |
| `--resume` | Continue most recent session context |
| `--model <name>` | Override the default model |

In **peer mode**, pi orchestrates an iterative review loop: the external agent reviews, pi acts on findings (fixing or counter-arguing), sends results back, and repeats until convergence. With multiple agents (e.g., `cursor,claude`), each agent reviews independently and all must agree before the loop exits.

For a deeper dive, see [Using External AI Agents (Cursor, Claude, Gemini)](external-ai-agents.html).

### /refine-review — Polish Pending PR Review Comments

Refines your pending GitHub PR review comments with AI before submitting.

```
/refine-review https://github.com/owner/repo/pull/123
```

Fetches your unsubmitted review comments, generates improved versions, and shows side-by-side comparisons. You pick which refinements to accept, optionally submit with "Request Changes," and the command updates comments on GitHub.

When the review is submitted, comments are automatically stored in the local PR review database — enabling future `/pr-review` runs to track which comments were posted and verify they were addressed.

### /query-db — Query the Reviews Database

Runs analytics queries against your local review history database.

```
/query-db stats --by-source
/query-db stats --by-reviewer
/query-db patterns --min 2
/query-db dismissed --owner myorg --repo myrepo
/query-db SELECT * FROM comments WHERE status='skipped' LIMIT 10
```

The database stores all processed review comments from `/review-handler`, enabling you to find recurring patterns, track addressed rates by source, and run custom SQL queries.

> **Note:** Only SELECT statements are allowed — the database is read-only for safety.

### /remember — Save a Memory

Saves a pinned memory for future sessions.

```
/remember always run tests with --verbose flag
/remember the auth service requires Redis to be running
/remember we decided to use UTC timestamps everywhere
```

Pi determines the best category (lesson, decision, mistake, pattern, preference, done) and persists it. See [Working with Project Memory](memory-system.html) for more on the memory system.

### /coderabbit-rate-limit — Handle CodeRabbit Rate Limits

Waits for a CodeRabbit rate limit to expire and re-triggers the review automatically.

```
/coderabbit-rate-limit             # Current branch's PR
/coderabbit-rate-limit 123         # Specific PR number
```

### /review-handler-status — Check Running Review Agents

Shows the live state of running autoqodo/autorabbit review-handler agents.

```
/review-handler-status
```

Looks for active `reviews poll` agents and generates an HTML status report.

### /create-skill — Save a Workflow as a Reusable Skill

Captures a successful workflow from the current conversation and saves it as a reusable skill.

```
/create-skill debug-container-build
/create-skill                       # Prompts for a name
```

You choose whether the skill is **global** (`~/.agents/skills/`) or **project-scoped** (`.pi/skills/`). See [Customization and Extension Recipes](customization-recipes.html) for more on creating custom skills.

### /create-coms-feature-manager — Generate a Coms Feature Manager

Creates a project-specific coms feature manager prompt for coordinating between a manager agent and a coder agent via inter-agent communication.

```
/create-coms-feature-manager
```

See [Communicating Between Pi Sessions](inter-agent-communication.html) for details on the coms system.

## Extension Commands

Extension commands are registered by the orchestrator extension and execute directly — no prompt template involved. They're faster because they don't need an AI roundtrip.

### /btw — Quick Side Questions

Ask a quick question without disrupting your conversation history.

```
/btw what was the name of the config file we edited earlier?
/btw what port is the dev server running on?
```

The answer appears in a scrollable overlay and disappears when you dismiss it (Esc, Space, or q). Your main conversation context is not affected.

### /status — Session Status Snapshot

Shows a unified view of your current session state.

```
/status
```

Output includes:
- **Async agents** — count and status of background agents
- **Cron tasks** — active scheduled tasks with last run times
- **Git state** — current branch, dirty file count
- **Container status** — whether you're running inside a container
- **Loaded resources** — context files, skills, tools, and guidelines

### /async-status — Background Agent Status

Shows the status of all running background agents.

```
/async-status
```

See [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) for managing async agents.

### /cron — Scheduled Tasks

Schedule recurring tasks that run on an interval or at specific times.

```
/cron add every 2h run the test suite
/cron add at 09:00 check for new issues
/cron list
/cron list-all
/cron remove 3
```

Tasks survive `/reload` and `/new` but stop when pi exits. See [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) for details.

### /dream — Memory Consolidation

Trigger memory consolidation manually, or toggle automatic dreaming.

```
/dream                  # Run consolidation now
/dream-auto on          # Enable auto-dreaming (default: every 3h + session end)
/dream-auto off         # Disable auto-dreaming
```

See [Working with Project Memory](memory-system.html) for how dreaming fits into the memory lifecycle.

### /coms and /coms-net — Inter-Agent Communication

Manage P2P and networked communication between pi sessions.

```
/coms start             # Start P2P communication
/coms-net connect       # Connect to the network hub
```

See [Communicating Between Pi Sessions](inter-agent-communication.html) for the full guide.

### /pidash and /pidiff — Web Dashboard and Diff Viewer

Manage the web dashboard and diff viewer daemons.

```
/pidash start           # Launch the web dashboard
/pidiff start           # Launch the diff viewer
```

See [Using the Web Dashboard and Diff Viewer](dashboards-and-diffs.html) for setup and usage.

### /external-ai-models-refresh — Refresh Model Cache

Clears the cached model lists for all AI CLI providers and re-fetches them.

```
/external-ai-models-refresh
```

Useful when new models become available and Tab-completion isn't showing them.

## Tab Completion

Most commands support Tab-completion for arguments. Press Tab after the command name to see available options:

| Command | Tab completes |
|---------|---------------|
| `/external-ai` | Provider names, flags (`--fix`, `--peer`, `--model`), model IDs |
| `/pr-review` | Open PR numbers with titles |
| `/review-local` | Git branch names |
| `/release` | Recent git tags, flags (`--dry-run`, `--prerelease`, `--draft`, `--target`, `--tag-match`) |
| `/review-handler` | `--autorabbit`, `--autoqodo` |
| `/coderabbit-rate-limit` | Open PR numbers |
| `/cron` | Subcommands (`add`, `list`, `remove`), task IDs for removal |
| `/dream-auto` | `on`, `off` |

Completions are cached for 5 minutes. Model lists for `/external-ai` are pre-fetched when the session starts.

## How Prompt Templates Work

Prompt templates are markdown files in the `prompts/` directory with YAML frontmatter. When you type a slash command, pi:

1. Loads the matching `.md` file
2. Substitutes `$ARGUMENTS` with whatever you typed after the command name
3. Follows the instructions in the template

The orchestrator **always maintains control** of the prompt workflow. It never delegates the entire command to a specialist agent — only sub-tasks get routed to agents as the template directs.

### Anatomy of a Prompt Template

Every prompt template has this structure:

```markdown
---
description: "Short description — /command-name <args>"
argument-hint: "<task>"
---

## Raw Arguments

‍```text
$ARGUMENTS
‍```

> **Bug Reporting Policy:** If you encounter ANY error...

# Command Title

Instructions for the orchestrator to follow...
```

| Field | Purpose |
|-------|---------|
| `description` | Shown in the command list and autocomplete |
| `argument-hint` | Placeholder text shown in the input bar |
| `$ARGUMENTS` | Replaced with user input at runtime |
| Bug Reporting Policy | Standard block ensuring issues are reported, not silently worked around |

### Project-Level Prompt Templates

You can create custom prompt templates in your project's `.pi/prompts/` directory. Any `.md` file with YAML frontmatter automatically registers as a slash command.

For example, creating `.pi/prompts/deploy-staging.md`:

```markdown
---
description: "Deploy to staging — /deploy-staging [version]"
argument-hint: "[version]"
---

## Raw Arguments

‍```text
$ARGUMENTS
‍```

# Deploy to Staging

1. Run `make build`
2. Run `make deploy-staging VERSION=$ARGUMENTS`
3. Verify health check at https://staging.example.com/health
```

After creating the file, run `/reload` to register the new command.

> **Tip:** Use `/create-skill` to capture successful workflows as reusable skills, or write prompt templates directly for more complex multi-step commands. See [Customization and Extension Recipes](customization-recipes.html) for guidance on both approaches.

## Advanced Usage

### Chaining Commands

You can use the output of one command as context for another:

```
/scout-and-plan add rate limiting to the API
```

Review the plan, then:

```
/implement add rate limiting to the API following the plan above
```

Or use `/implement-and-review` to combine implementation with automated review in a single step.

### Auto-Mode Review Workflows

For fully unattended review handling, combine `--autorabbit` and `--autoqodo`:

```
/review-handler --autorabbit --autoqodo
```

This enters a polling loop that:
1. Fetches new comments from CodeRabbit and Qodo
2. Automatically fixes each finding
3. Commits and pushes changes
4. Waits for reviewers to re-evaluate
5. Repeats until all reviewers approve

The loop runs in the background — you can continue working in the same session. It exits only when all automated reviewers approve or you explicitly stop it.

### Peer Review With Multiple Agents

Run a multi-agent peer review debate:

```
/external-ai cursor,claude --peer review the error handling in src/api/
```

Each agent reviews independently, pi synthesizes findings, fixes code, and sends results back. The loop continues until all agents agree — with full group context so each agent sees what the others said.

### Release With Version Branch Targeting

For projects using version branches:

```
/release --target v2.10 --tag-match "v2.10.*"
```

This targets the `v2.10` branch and filters tags to that version range. On a version branch, automatic detection works without flags:

```
git checkout v2.10
/release
```

## Troubleshooting

**"myk-pi-tools is required" error**
Most commands need the `myk-pi-tools` CLI. Install it:
```
uv tool install myk-pi-tools
```

**Tab completion not showing results**
Completions are cached for 5 minutes. Run `/external-ai-models-refresh` to force a refresh of model lists, or wait for the cache to expire for PR and branch lists.

**"Unknown provider" error with /external-ai**
Only `cursor`, `claude`, and `gemini` are supported. For other agents (Codex, Copilot, Droid, Kiro, etc.), use the ACPX provider instead.

**PR detection fails for /pr-review or /review-handler**
Ensure you're on a branch with an open PR and `gh` is authenticated:
```bash
gh auth status
gh pr view
```

For the full command reference with all arguments and options, see [Slash Commands and Extension Commands Reference](commands-reference.html).

## Related Pages

- [Slash Commands and Extension Commands Reference](commands-reference.html)
- [Common Workflow Recipes](workflow-recipes.html)
- [Your First Coding Workflow](first-workflow.html)
- [Using External AI Agents (Cursor, Claude, Gemini)](external-ai-agents.html)
- [Customization and Extension Recipes](customization-recipes.html)
