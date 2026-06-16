# Common Workflow Recipes

Copy-paste patterns for the most common pi workflows. Each recipe is self-contained — run exactly as shown.

> **Note:** All recipes assume `myk-pi-tools` is installed. If not, run `uv tool install myk-pi-tools` first. See [Installing and Starting Your First Session](quickstart.html) for full setup.

---

## Implement a Feature End-to-End

The most common workflow: scout the codebase, plan changes, and implement in one command.

```
/implement add pagination to the /api/users endpoint
```

This chains three agents sequentially: **scout** explores the codebase to find relevant files and dependencies, **planner** creates a detailed implementation plan, and **worker** executes the plan. Use this when you know what you want built and want pi to handle the full cycle.

- For tasks where you want to review the plan before coding, use `/scout-and-plan` instead (see below)
- The orchestrator will follow the [code review loop](code-review-loop.html) automatically after implementation

---

## Implement with Automatic Code Review

Implement a change and immediately run the three parallel code reviewers, then auto-fix any findings.

```
/implement-and-review refactor the database connection pool to use async context managers
```

This chains: **worker** implements the task → three review agents (**code-reviewer-quality**, **code-reviewer-guidelines**, **code-reviewer-security**) run in parallel → **worker** fixes all findings. Use this when you want a single-command implement-and-polish cycle without manual intervention.

- Reviewers are enforced as async subagents — they run in the background without blocking your session
- See [Running the Automated Code Review Loop](code-review-loop.html) for details on how the three reviewers work

---

## Scout and Plan Without Implementing

Explore the codebase and get a detailed plan before committing to changes.

```
/scout-and-plan migrate the authentication module from JWT to session-based auth
```

This chains two agents: **scout** maps out relevant files, functions, and dependencies, then **planner** produces a step-by-step implementation plan with edge cases and testing approach. Use this when you want to understand the scope of a change before writing any code.

- The plan output includes specific file paths, function names, and line numbers
- After reviewing the plan, you can run `/implement` with the plan as context

---

## Review a GitHub PR

Review an open PR and optionally post inline comments on GitHub.

```
/pr-review 42
```

Or let pi auto-detect the PR from your current branch:

```
/pr-review
```

Or use a full URL:

```
/pr-review https://github.com/owner/repo/pull/42
```

This clones the PR's repository, checks past review comments from previous cycles, then sends all three code review agents in parallel — each with full repo access. Reviewers independently read the project's AGENTS.md (or CLAUDE.md) for guideline compliance. After analysis, pi presents findings grouped by severity (CRITICAL, WARNING, SUGGESTION) and lets you choose which to post as inline GitHub comments. Posted comments are stored in a local database for tracking across review cycles.

- Requires `gh` CLI to be authenticated
- Past review comments (resolved and unresolved) are verified against the current diff
- See [Using Slash Commands and Prompt Templates](slash-commands.html) for all command variants

---

## Review Local Uncommitted Changes

Run the three-reviewer code review on local changes without creating a PR.

Review uncommitted changes (staged + unstaged):

```
/review-local
```

Review changes compared to a specific branch:

```
/review-local main
```

This runs all three code review agents in parallel against your local diff. Findings are grouped by severity. Use this as a pre-commit quality check before pushing.

---

## Handle PR Reviews (Human, CodeRabbit, Qodo)

Process and respond to all review comments on your current branch's PR.

```
/review-handler
```

This fetches review comments from all sources (human reviewers, CodeRabbit, Qodo), presents them in a table grouped by source and priority, and lets you decide which to address. For each approved comment, pi delegates to the appropriate specialist agent, runs tests, commits fixes (always as new commits — never amends), and posts replies on GitHub.

> **Tip:** You can also target a specific review URL:
> ```
> /review-handler https://github.com/owner/repo/pull/42#pullrequestreview-789
> ```

---

## Auto-Fix CodeRabbit Comments

Automatically address all CodeRabbit comments in a polling loop — no manual approval needed.

```
/review-handler --autorabbit
```

This skips the manual decision phase for CodeRabbit comments, auto-approving all of them. After fixing and pushing, pi enters a polling loop that watches for new CodeRabbit comments triggered by your push. The loop runs until CodeRabbit approves the PR or you explicitly stop it.

- Human review comments are still presented for manual decision
- The session remains interactive while the polling loop runs in the background

---

## Auto-Fix Qodo Comments

Automatically address all Qodo review findings — every finding gets a code fix or an issue spec update.

```
/review-handler --autoqodo
```

Every Qodo finding type (`qodo_bug`, `qodo_rule_violation`, `qodo_requirement_gap`, etc.) must be addressed — none are optional. Findings result in either a code fix or a GitHub issue spec update via `gh issue edit`.

- Combine both automated reviewers: `/review-handler --autorabbit --autoqodo`
- Human comments are always presented for manual decision, even in auto modes

> **Warning:** `--autorabbit` and `--autoqodo` are command-level flags for pi — they are never passed to the `myk-pi-tools` CLI.

---

## Check Review Handler Status

See the live state of running autorabbit/autoqodo review agents.

```
/review-handler-status
```

This checks `/async-status` for agents running `reviews poll`, then generates an HTML status report for each active PR. Use this to monitor long-running auto-fix loops.

---

## Create a GitHub Release

Generate a changelog from conventional commits and create a GitHub release.

Auto-detect version bump from commit types:

```
/release
```

Release with an explicit version (skips approval):

```
/release 2.1.0
```

Preview without creating:

```
/release --dry-run
```

This analyzes commits since the last tag, categorizes them by conventional commit type (`feat:` → MINOR, `fix:` → PATCH, breaking changes → MAJOR), generates a formatted changelog with emoji section headers, and creates the GitHub release. If version files are detected (e.g., `pyproject.toml`, `package.json`), pi bumps them via a PR before creating the release.

- Use `--prerelease` for pre-release versions or `--draft` for draft releases
- Use `--target <branch>` to release from a branch other than the default
- See [Slash Commands and Extension Commands Reference](commands-reference.html) for all flags

---

## Refine Pending PR Review Comments

Polish your in-progress GitHub review comments with AI before submitting.

```
/refine-review https://github.com/owner/repo/pull/42
```

This fetches your pending (unsubmitted) review comments from the PR, uses the diff context to generate refined versions that are clearer and more actionable, presents original vs. refined side-by-side, and lets you accept, reject, or customize each refinement. Optionally submits the review as "Request Changes". If submitted, comments are stored in the PR review database for future cycle tracking.

- You must have a pending review on the PR (started via GitHub UI but not yet submitted)
- You can provide custom replacement text for any comment during the approval step

---

## Query the Review Database

Analyze your PR review history with built-in analytics queries.

Stats by review source (human, CodeRabbit, Qodo):

```
/query-db stats --by-source
```

Stats by individual reviewer:

```
/query-db stats --by-reviewer
```

Find recurring dismissed suggestions:

```
/query-db patterns --min 2
```

Run a custom SQL query (read-only):

```
/query-db query "SELECT source, status, COUNT(*) as cnt FROM comments GROUP BY source, status ORDER BY cnt DESC"
```

Find comments similar to previously dismissed ones:

```
/query-db find-similar < comments.json
```

The review database stores all processed review comments with their status, source, priority, and replies. Only `SELECT` statements and CTEs are allowed — the database is read-only for queries. See [myk-pi-tools CLI Reference](cli-reference.html) for all `db` subcommands.

---

## Handle a CodeRabbit Rate Limit

Automatically wait out a CodeRabbit rate limit and re-trigger the review.

```
/coderabbit-rate-limit
```

Or target a specific PR:

```
/coderabbit-rate-limit 42
```

This checks if the PR is currently rate-limited by CodeRabbit, waits for the cooldown period (plus a 30-second buffer), then posts `@coderabbitai review` to re-trigger. It polls until the review starts. Use this when CodeRabbit hits its hourly limit during active development.

---

## Save a Memory for Future Sessions

Persist a lesson, preference, or decision so pi remembers it across sessions.

```
/remember always use ruff instead of flake8 for Python linting
```

```
/remember the payment service uses idempotency keys — never retry without checking
```

This saves the text as a **pinned** memory entry, automatically categorized (lesson, preference, decision, mistake, pattern, or done). Pinned memories resist decay and are injected into future session context. See [Working with Project Memory](memory-system.html) for the full memory system.

---

## Route a Task to an External AI Agent

Send a prompt to Cursor, Claude, or Gemini CLI for a second opinion or peer review.

Read-only review (no file changes):

```
/external-ai cursor review the error handling in src/api/
```

Fix mode (agent can modify files):

```
/external-ai claude --fix refactor the retry logic in src/client.py
```

AI-to-AI peer review loop:

```
/external-ai cursor --peer review the authentication module
```

Multi-agent review:

```
/external-ai cursor,claude review the database migration
```

Select a specific model:

```
/external-ai cursor --model gpt-5.4-high review the architecture
```

This runs your prompt through [ai-cli-runner](https://github.com/myk-org/ai-cli-runner), which calls the AI CLI tool as a subprocess. In `--peer` mode, pi orchestrates an iterative debate loop where the external agent reviews code, pi fixes findings, and the agent re-reviews until convergence. See [Using External AI Agents (Cursor, Claude, Gemini)](external-ai-agents.html) for the full guide.

> **Tip:** Your last-used agent and model are saved to `.pi/external-ai-config.json`. Run `/external-ai` without an agent name to reuse them.

---

## Handle Reviews for Multiple PRs

Use git worktrees to process reviews for multiple PRs in parallel without branch switching.

```
git worktree add .worktrees/pr-42 origin/fix/issue-42
git worktree add .worktrees/pr-43 origin/feat/issue-43
```

Then run `/review-handler` in each worktree directory. When done:

```
git worktree remove .worktrees/pr-42
git worktree remove .worktrees/pr-43
```

Branch switching in the main worktree corrupts parallel agent work. Always use `.worktrees/` — it's in the global gitignore. See [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) for more on parallel agent patterns.

---

## Save a Reusable Skill from a Workflow

Turn a successful workflow into a reusable skill that pi can apply in future sessions.

```
/create-skill debug-container-build
```

This analyzes the current conversation, extracts the steps you followed (commands, pitfalls, verification), and writes a `SKILL.md` file. You choose whether the skill is **global** (`~/.agents/skills/`) or **project-scoped** (`.pi/skills/`). See [Customization and Extension Recipes](customization-recipes.html) for more on extending pi.

> **Tip:** Skills are matched to tasks by their one-line description. Make it specific: "Debug Docker build failures caused by missing system dependencies" beats "Debug Docker".

## Related Pages

- [Using Slash Commands and Prompt Templates](slash-commands.html)
- [Running the Automated Code Review Loop](code-review-loop.html)
- [Your First Coding Workflow](first-workflow.html)
- [Using External AI Agents (Cursor, Claude, Gemini)](external-ai-agents.html)
- [Working with Project Memory](memory-system.html)
