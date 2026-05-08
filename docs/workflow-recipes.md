# Common Workflow Recipes

Copy-paste patterns for everyday tasks. Each recipe is self-contained — paste it into your pi session and go.

For full workflow explanations, see Orchestrator Workflows. For agent details, see Specialist Agents Reference.

---

## Implement a Feature End-to-End

Scouts the codebase, plans, and implements — all in one command.

```text
/implement add retry logic with exponential backoff to the HTTP client in src/api.py
```

The orchestrator chains three agents: **scout** explores the codebase for relevant files, **planner** creates a step-by-step implementation plan, and **worker** makes all the code changes. The code review loop runs automatically after implementation.

- For planning without implementing, use `/scout-and-plan <task>` instead
- For implementation without the scout/plan phase, use `/implement-and-review <task>`

---

## Implement and Review in a Loop

Writes code and runs three parallel reviewers until all approve, then runs tests.

```text
/implement-and-review add input validation to the /users API endpoint
```

The **worker** implements the task, then three review agents run in parallel: **code-reviewer-quality** (readability, DRY), **code-reviewer-guidelines** (project style), and **code-reviewer-security** (bugs, vulnerabilities). If any reviewer has comments, the worker fixes and re-reviews. The loop ends only when all three approve and tests pass.

> **Tip:** This is the fastest path when you already know what needs to change. Skip the scout/plan overhead.

---

## Review a GitHub PR

Fetches a PR diff, runs three parallel reviewers, and posts inline comments.

```text
/pr-review 42
```

Or auto-detect from the current branch:

```text
/pr-review
```

Or use a full URL:

```text
/pr-review https://github.com/your-org/your-repo/pull/42
```

Three review agents analyze the diff in parallel. Findings are merged, deduplicated, and grouped by severity (CRITICAL, WARNING, SUGGESTION). You choose which to post as inline PR comments.

> **Note:** Requires `myk-pi-tools`. Install with `uv tool install myk-pi-tools` if not available.

---

## Fix All Review Comments on a PR

Processes review comments from all sources — human reviewers, Qodo, and CodeRabbit — and fixes them.

```text
/review-handler
```

Or with a specific review URL:

```text
/review-handler https://github.com/your-org/your-repo/pull/42#pullrequestreview-456
```

Fetches all review threads, presents them grouped by source and priority, then lets you approve or skip each one. Approved items are delegated to specialist agents for fixing. After fixes, tests run, changes are committed, and replies are posted to GitHub.

---

## Auto-Fix CodeRabbit Comments in a Loop

Automatically addresses CodeRabbit review comments and polls until CodeRabbit approves.

```text
/review-handler --autorabbit
```

All CodeRabbit comments are auto-approved and fixed without prompting. Human and Qodo comments still require your input. After fixing, the loop polls for new CodeRabbit comments every 5 minutes and processes them automatically. The loop exits only when CodeRabbit approves or you explicitly stop it.

> **Tip:** This runs as a background polling loop — you can continue working in the same session while it waits.

---

## Review Local Changes Before Pushing

Reviews uncommitted changes or a branch diff without creating a PR.

Review uncommitted changes (staged + unstaged):

```text
/review-local
```

Review all changes compared to a branch:

```text
/review-local main
```

Three review agents analyze the diff in parallel, just like `/pr-review`, but against local changes. Findings are grouped by severity: critical, warnings, and suggestions.

---

## Handle Multiple PRs Simultaneously

Uses git worktrees to work on multiple PRs without branch conflicts.

```bash
# Create isolated worktrees for each PR
git worktree add .worktrees/pr-42 origin/fix/issue-42
git worktree add .worktrees/pr-43 origin/feat/issue-43

# Run review-handler in each worktree
# (delegate as subagents with cwd set to each worktree)

# Clean up when done
git worktree remove .worktrees/pr-42
git worktree remove .worktrees/pr-43
```

Never switch branches in the main worktree when working on multiple PRs — it corrupts parallel agent work. Each worktree gets its own isolated directory. The `.worktrees/` directory is gitignored by default.

> **Warning:** Branch switching in the main worktree while agents are running causes agents to see the wrong branch, producing wrong diffs and wrong commits.

---

## Save a Memory for Future Sessions

Persists a fact, preference, or lesson that pi will remember across sessions.

```text
/remember always use uv run, never python directly
```

This saves a **pinned** memory that dreaming will never auto-remove. Pinned memories are user-controlled and permanent. Available categories: `lesson`, `decision`, `mistake`, `pattern`, `done`, `preference`.

For programmatic use:

```bash
uv run myk-pi-tools memory add -c preference -s "always use uv run, never python directly" --pinned
```

---

## Run Memory Consolidation Manually

Triggers background memory dreaming — extracts lessons from the current session and cleans up stale entries.

```text
/dream
```

Dreaming runs as a fire-and-forget background agent. It reads the session, extracts lessons, preferences, mistakes, and patterns, deduplicates entries, removes stale items, and keeps the memory file under 50 entries. Pinned memories are never touched.

- Dreaming also runs automatically every 3 hours (configurable via `PI_DREAM_INTERVAL_HOURS`)
- Toggle auto-dreaming with `/dream-auto on` or `/dream-auto off`

> **Tip:** Run `/dream` before ending a long session to capture what you learned.

---

## Create a GitHub Release

Generates a changelog from conventional commits and creates a release.

Preview without creating:

```text
/release --dry-run
```

Create a release (auto-detects version bump from commits):

```text
/release
```

Create with an explicit version:

```text
/release 2.1.0
```

Create a prerelease or draft:

```text
/release --prerelease
/release --draft
```

The command validates branch state, detects version files, categorizes commits into a changelog, bumps version files, creates a PR for the version bump, and publishes the release.

---

## Schedule a Recurring Task

Sets up a cron-like scheduled task that runs within the pi session.

```text
/cron add "every 30m" /review-handler --autorabbit
```

```text
/cron add "daily at 09:00" /dream
```

Manage scheduled tasks:

```text
/cron list
/cron remove <id>
```

Cron tasks run as async agents within the current pi process. They survive `/reload` but stop when pi exits. Tasks can be slash commands or free-text prompts.

---

## Run a Prompt via an External AI Agent

Delegates a prompt to Codex, Cursor, Gemini, or other ACP-compatible agents via acpx.

```text
/acpx-prompt codex review the error handling in src/api.py
```

With a specific model:

```text
/acpx-prompt codex:o3-pro review the architecture
```

Send to multiple agents in parallel:

```text
/acpx-prompt cursor,gemini analyze the test coverage gaps
```

The external agent runs in read-only mode by default. Use `--fix` to allow file modifications, or `--peer` for an AI-to-AI debate loop.

> **Note:** Requires `acpx` (`npm install -g acpx@latest`) and the underlying agent CLI to be installed.

---

## Fix Code with an External Agent

Lets an external AI agent modify files directly, then shows you the diff.

```text
/acpx-prompt codex --fix fix the failing tests in tests/test_api.py
```

The agent runs with full write permissions. After it completes, pi shows a diff summary of all changes and suggests verification steps. A checkpoint commit is recommended before running fix mode.

---

## Peer Review with External AI Agents

Runs an AI-to-AI debate loop where external agents review and Claude fixes until convergence.

```text
/acpx-prompt gemini --peer review the authentication middleware
```

Multi-agent peer review:

```text
/acpx-prompt cursor,codex --peer review the database migration safety
```

Claude and the external agent(s) go back and forth: the agent reviews, Claude fixes or pushes back with technical reasoning, the agent re-reviews. The loop exits only when all peer agents confirm no remaining issues. A summary table shows addressed findings, agreements reached after debate, and any unresolved disagreements.

---

## Check Background Agent Status

Shows the status of all running async agents.

```text
/async-status
```

Lists all background agents with their current state: running, completed, or failed. Results from completed agents are delivered to the session automatically.

---

## Handle CodeRabbit Rate Limits

Waits for the rate limit to expire and re-triggers the CodeRabbit review automatically.

```text
/coderabbit-rate-limit
```

Or for a specific PR:

```text
/coderabbit-rate-limit 42
```

Checks whether the PR is rate-limited, waits for the cooldown (plus a 30-second buffer), posts `@coderabbitai review` to re-trigger, and polls until the review starts.

---

## View Session Status

Gets a unified snapshot of the current session.

```text
/status
```

Shows git status, active async agents, cron tasks, and session metadata in one view.

---

## Quick Reference: Workflow Cheat Sheet

| Task | Command |
|------|---------|
| Full feature (scout + plan + implement) | `/implement <task>` |
| Implement with review loop | `/implement-and-review <task>` |
| Plan without implementing | `/scout-and-plan <task>` |
| Review a GitHub PR | `/pr-review [number\|url]` |
| Review local changes | `/review-local [branch]` |
| Fix all review comments | `/review-handler` |
| Auto-fix CodeRabbit loop | `/review-handler --autorabbit` |
| Create a release | `/release [version]` |
| Save a memory | `/remember <what>` |
| Run memory consolidation | `/dream` |
| Schedule a task | `/cron add "<schedule>" <command>` |
| External agent prompt | `/acpx-prompt <agent> <prompt>` |
| External agent fix | `/acpx-prompt <agent> --fix <prompt>` |
| External agent peer review | `/acpx-prompt <agent> --peer <prompt>` |
| Check async agents | `/async-status` |
| Session overview | `/status` |

For configuration and environment variables, see Configuration Reference. For the dashboard and diff viewer, see Dashboard and Monitoring.
