# Your First Coding Workflow

You want to go from a feature idea to a merged pull request using pi's orchestrator, specialist agents, and automated code review. This guide walks you through the complete cycle so you can see every stage in action.

## Prerequisites

- A running pi session connected to a Git repository (see [Installing and Starting Your First Session](quickstart.html))
- GitHub CLI (`gh`) authenticated — pi's `github-expert` agent uses it for issues and PRs
- At least one commit on a `main` branch pushed to a remote

## Quick Example

The fastest way to implement a feature end-to-end:

```text
You: Add a --verbose flag to the export command
```

That single sentence triggers the full workflow: the orchestrator investigates the code, creates a GitHub issue, branches, delegates to the right specialist agent, runs three parallel code reviewers, fixes findings, runs tests, commits, pushes, and opens a PR — all automatically.

## Step-by-Step: The Full Feature Workflow

### Step 1 — Describe what you want

Tell pi what to build in plain language:

```text
You: Add rate limiting to the /api/users endpoint — max 100 requests per minute per IP
```

The orchestrator reads your request and begins the **issue-first workflow**. It will not start writing code immediately.

### Step 2 — Root cause investigation

Before creating anything, the orchestrator reads the relevant source code to understand what exists. It identifies the files, functions, and dependencies involved. This prevents issues based on misunderstandings and ensures the implementation plan is grounded in reality.

You'll see it delegate to a **scout** agent to explore the codebase:

```text
 scout  Exploring codebase for rate limiting context...
```

### Step 3 — Issue creation

The orchestrator delegates to the `github-expert` agent to create a tracked GitHub issue with:

- A clear title (`feat: add rate limiting to /api/users`)
- Problem description and requirements
- A **Done** checklist — the contract for when the issue can be closed

```text
 github-expert  Creating issue...
```

Once created, pi asks for confirmation:

```text
Issue #42 created: feat: add rate limiting to /api/users
URL: https://github.com/your-org/your-repo/issues/42

Do you want to work on it now?
```

### Step 4 — Branch creation

After you confirm, the orchestrator delegates to the `git-expert` to create an issue branch:

```text
 git-expert  git fetch origin main
 git-expert  git checkout -b feat/issue-42-rate-limiting origin/main
```

Branch names follow the convention `<type>/issue-<number>-<short-description>`:

| Change type | Branch prefix |
|-------------|---------------|
| New feature | `feat/issue-42-...` |
| Bug fix | `fix/issue-42-...` |
| Refactoring | `refactor/issue-42-...` |
| Documentation | `docs/issue-42-...` |

### Step 5 — Implementation

The orchestrator routes the task to the appropriate **specialist agent** based on the files involved. You don't choose the agent — routing is automatic.

| File type | Agent selected |
|-----------|----------------|
| Python (`.py`) | `python-expert` |
| TypeScript/JavaScript | `ts-expert` |
| Go (`.go`) | `go-expert` |
| Shell scripts (`.sh`) | `bash-expert` |
| Dockerfile | `docker-expert` |
| Markdown (`.md`) | `technical-documentation-writer` |

If no specialist matches, the `worker` agent handles it. See [Understanding Agent Routing and Delegation](agent-routing.html) for the full routing table.

```text
 python-expert  Adding rate limiter middleware to api/users.py...
```

The specialist agent writes code directly — it doesn't explain what it will do first. Agents follow an "execute first, explain after" philosophy.

### Step 6 — Automated code review (3 reviewers in parallel)

After implementation, the orchestrator launches **three code review agents simultaneously** as background (async) tasks:

| Reviewer | Focus area |
|----------|------------|
| `code-reviewer-quality` | Clean code, DRY, readability, proper abstractions |
| `code-reviewer-guidelines` | Project conventions, AGENTS.md compliance, documentation updates |
| `code-reviewer-security` | Bugs, logic errors, edge cases, security vulnerabilities |

```text
 code-reviewer-quality       Reviewing changes (async)...
 code-reviewer-guidelines    Reviewing changes (async)...
 code-reviewer-security      Reviewing changes (async)...
```

All three run as async agents — they don't block your session. You can continue chatting while they work. Results surface automatically when each reviewer finishes.

Each reviewer produces findings with severity levels:

```text
[CRITICAL] api/users.py:45 — Rate limit key uses X-Forwarded-For without validation
  Risk: Attacker can bypass rate limiting by spoofing the header
  Suggestion: Validate and sanitize the forwarded IP, fall back to connection IP

[WARNING] api/users.py:62 — Missing error handling for Redis connection failure
  Suggestion: Add try/except with fallback to in-memory counter

[SUGGESTION] api/users.py:30 — Magic number 100 should be a named constant
  Suggestion: Extract to RATE_LIMIT_MAX_REQUESTS = 100
```

### Step 7 — Fix-and-review loop

If **any** reviewer has findings, the orchestrator delegates fixes to the specialist agent and sends the code through all three reviewers again. This loop continues until every reviewer approves:

```text
Code change → 3 reviewers in parallel → findings? → fix → 3 reviewers again → approved ✅
```

The orchestrator deduplicates findings across reviewers automatically. If two reviewers flag the same issue, only the most actionable version is kept.

> **Note:** The review loop is mandatory — it cannot be skipped. Code is not considered ready until all three reviewers report "approved."

### Step 8 — Test execution

Once reviewers approve, the orchestrator delegates to the `test-automator` agent:

```text
 test-automator  Running test suite...
```

The test agent compares results against a **baseline** (tests on the branch before your changes). Only **new failures** introduced by your code block the workflow. Pre-existing failures are noted but don't block.

If tests fail:
- Minor test/config fixes → re-run tests only (skip re-review)
- Substantive code changes → full re-review from step 6

### Step 9 — Commit and push

With reviews approved and tests passing, the orchestrator delegates to `git-expert`:

```text
 git-expert  git add api/users.py api/middleware.py tests/test_rate_limit.py
 git-expert  git commit -F - (feat: add rate limiting to /api/users endpoint)
 git-expert  git push -u origin feat/issue-42-rate-limiting
```

Commits follow these conventions:
- Specific files are staged individually (never `git add .`)
- Commit messages use conventional format (`feat:`, `fix:`, `refactor:`)
- No AI attribution in commit messages

### Step 10 — Pull request creation

The orchestrator delegates to `github-expert` to create the PR:

```text
 github-expert  gh pr create --title "feat: add rate limiting to /api/users" --body "..."
```

The PR links back to issue #42. When the PR merges, the issue's Done checklist items are checked off and the issue is closed.

## Using Slash Commands

For common workflows, slash commands provide structured shortcuts instead of free-form prompts.

### `/implement` — Scout, plan, and build

```text
/implement add rate limiting to the /api/users endpoint
```

This runs a three-agent chain automatically:
1. **scout** — finds relevant files and dependencies
2. **planner** — creates a detailed implementation plan
3. **worker** — implements the plan

### `/implement-and-review` — Build with automatic review

```text
/implement-and-review add rate limiting to the /api/users endpoint
```

Same as `/implement`, but adds the three parallel reviewers plus a fix pass — the entire code review loop in one command.

### `/review-local` — Review before committing

```text
/review-local
/review-local main
```

Reviews your uncommitted changes (or changes vs. a branch) using all three reviewers in parallel. Use this to catch issues before pushing.

### `/scout-and-plan` — Explore without changing anything

```text
/scout-and-plan add rate limiting to the /api/users endpoint
```

Runs only the scout and planner agents — no code is written. Use this when you want to understand the codebase and see a plan before committing to implementation.

See [Using Slash Commands and Prompt Templates](slash-commands.html) for the full command reference.

## Monitoring Progress

### Task tracking

For multi-step workflows, the orchestrator creates a task list that persists across turns. You can see exactly where you are:

```text
✅ Investigate root cause in api/users.py
✅ Create GitHub issue with root cause analysis
✅ Create branch feat/issue-42-rate-limiting from origin/main
✅ Implement rate limiting middleware
⏳ Run code review loop (3 async reviewers)
⬚ Fix review findings (if any)
⬚ Run test-automator
⬚ Commit and push changes
⬚ Create PR with description
```

If you ask a side question mid-workflow ("What's the Redis connection timeout?"), the orchestrator answers and then **immediately resumes** from the next unchecked task.

### `/status` — Session snapshot

```text
/status
```

Shows async agents currently running, cron tasks, git branch, and session context in one view.

### `/async-status` — Background agent details

```text
/async-status
```

Shows all background agents with elapsed time and task descriptions.

## Advanced Usage

### Skipping the issue-first workflow

For quick fixes where tracking overhead isn't needed, tell pi to skip the workflow:

```text
You: Just fix the typo in README.md — "recieve" should be "receive"
```

The orchestrator recognizes signals like "just do it", "quick fix", or single-line trivial changes and skips issue creation, going directly to implementation.

### Working on an existing issue

```text
You: Work on issue #42
```

The orchestrator picks up the existing issue, creates a branch (if one doesn't exist), and starts working through the Done checklist.

### Reviewing a GitHub PR

```text
/pr-review 123
/pr-review https://github.com/your-org/repo/pull/123
```

Reviews an existing PR and optionally posts inline comments. See [Running the Automated Code Review Loop](code-review-loop.html) for details.

### Handling review comments from external reviewers

```text
/review-handler
/review-handler --autorabbit
/review-handler --autoqodo
```

Processes comments from human reviewers, CodeRabbit, and Qodo on the current PR. The `--autorabbit` and `--autoqodo` flags enter a fully automated polling loop that fixes comments, pushes, and re-polls until the reviewer approves.

See [Common Workflow Recipes](workflow-recipes.html) for more patterns.

### Creating a release after merging

```text
/release
/release 2.1.0
```

Generates a changelog from conventional commits, optionally bumps version files, and creates a GitHub release. See [Common Workflow Recipes](workflow-recipes.html) for release patterns.

### Multi-PR parallel work

When handling multiple PRs simultaneously, pi uses git worktrees to avoid branch-switching conflicts:

```text
You: Handle reviews for PR #42 and PR #43
```

Each PR gets its own isolated worktree directory under `.worktrees/`. Agents working on PR #42 never interfere with agents working on PR #43.

### Teaching pi your preferences

Pi remembers your preferences across sessions. State them naturally and they're auto-extracted:

```text
You: I always want tests before implementation
You: Never use print statements for debugging — always use the logging module
You: I prefer functional style over classes when possible
```

These become part of pi's memory and influence future workflows. See [Working with Project Memory](memory-system.html) for details.

## Troubleshooting

**The orchestrator is writing code directly instead of delegating.**
The orchestrator should never use `edit`, `write`, or `bash` (except for `mcpl`). If this happens, it's a routing issue. Mention the expected agent: "Delegate this to the python-expert."

**Reviews are taking too long.**
All three reviewers run as async background agents. Check their status with `/async-status`. If a reviewer is stuck, you can kill it and re-trigger the review.

**Tests fail but they were already failing before my changes.**
The test runner compares against a baseline. Only **new** failures block the workflow. If you're seeing pre-existing failures blocking, mention it and the orchestrator will re-run the baseline comparison.

**The wrong specialist agent was chosen.**
Routing is based on task intent, not just file type. If the orchestrator routes incorrectly, tell it directly: "Use the python-expert for this." See [Understanding Agent Routing and Delegation](agent-routing.html) for routing details.

**Side question made pi forget what it was doing.**
Task tracking prevents this — the task list is injected every turn. If tasks exist, the orchestrator resumes automatically after answering. If it doesn't, say "continue with the tasks" to nudge it back.

## Related Pages

- [Installing and Starting Your First Session](quickstart.html)
- [Understanding Agent Routing and Delegation](agent-routing.html)
- [Running the Automated Code Review Loop](code-review-loop.html)
- [Using Slash Commands and Prompt Templates](slash-commands.html)
- [Working with Project Memory](memory-system.html)
