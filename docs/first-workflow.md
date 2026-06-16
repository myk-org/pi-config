# Your First Coding Workflow

You want to go from a feature idea to a merged pull request using pi's orchestrator. This guide walks you through the full cycle — asking pi to implement a change, watching it delegate to specialist agents, iterating through code review, and creating a PR.

## Prerequisites

- A running pi session in a Git repository (see [Installing and Starting Your First Session](quickstart.html))
- GitHub CLI (`gh`) authenticated — pi uses it for issues and PRs
- A remote `origin` configured for your repository

## Quick Example

Type a request in plain language. Pi handles the rest:

```
Add a --verbose flag to the export command that prints each file as it's processed
```

Pi will:

1. Investigate the codebase to understand the current export command
2. Create a GitHub issue describing the feature
3. Create a feature branch (`feat/issue-12-verbose-flag`)
4. Delegate code changes to the right specialist agent (e.g., `python-expert`)
5. Run three parallel code reviewers
6. Fix any findings and re-review until all pass
7. Run tests
8. Commit, push, and open a PR

You stay in control at each checkpoint — pi asks before proceeding.

## Step-by-Step Walkthrough

### Step 1: Describe What You Want

Just tell pi what you need. Be specific about the behavior you want, not how to implement it:

```
The /stats endpoint should return results sorted by date descending instead of ascending
```

Pi reads the relevant source code first to understand the current behavior before doing anything else.

### Step 2: Issue Creation and Branch Setup

Pi creates a GitHub issue with a root cause analysis, requirements, and a checklist of deliverables. It then asks for confirmation:

```
Issue #24 created: fix: /stats endpoint returns results in ascending order

URL: https://github.com/yourorg/yourrepo/issues/24

Do you want to work on it now?
```

Answer **yes** and pi fetches `main`, creates an issue branch (`fix/issue-24-stats-sort-order`), and starts working.

> **Tip:** If you want to skip the issue-first workflow for a trivial change, say "just do it" or "quick fix" — pi will go straight to implementation.

### Step 3: Watch the Orchestrator Delegate

The orchestrator never writes code directly. It routes work to specialist agents based on what the task involves:

| What's happening | Agent pi delegates to |
|---|---|
| Editing Python files | `python-expert` |
| Editing TypeScript/React files | `ts-expert` |
| Editing Go files | `go-expert` |
| Editing shell scripts | `bash-expert` |
| Git operations (branch, commit) | `git-expert` |
| GitHub operations (PR, issue) | `github-expert` |
| Writing or updating tests | `test-automator` |
| Exploring a codebase for context | `scout` |
| No specialist matches | `worker` |

Pi picks the right agent automatically — you don't need to specify. See [Understanding Agent Routing and Delegation](agent-routing.html) for the full routing table.

### Step 4: Code Review Loop

After the code changes are made, pi sends the diff to **three review agents in parallel**:

| Reviewer | Focus |
|---|---|
| `code-reviewer-quality` | Readability, abstractions, DRY, error handling |
| `code-reviewer-guidelines` | Project conventions (AGENTS.md compliance), documentation updates |
| `code-reviewer-security` | Bugs, logic errors, security vulnerabilities, edge cases |

These reviewers run as background agents — pi doesn't block while waiting. When all three return, pi merges and deduplicates their findings, then categorizes them by severity:

- **Critical** — must fix before proceeding
- **Warning** — should fix
- **Suggestion** — nice to have

If there are findings, pi sends them to the appropriate specialist to fix, then re-runs all three reviewers on the updated code. This loop repeats until all reviewers approve.

> **Note:** You don't need to trigger reviews manually during implementation — they run automatically after every code change. See [Running the Automated Code Review Loop](code-review-loop.html) for details on the review system.

### Step 5: Tests

Once all reviewers approve, pi delegates to the `test-automator` to run the project's test suite. Only **new** test failures block the workflow — pre-existing failures are noted but don't stop progress.

If tests fail:

- **Minor fix** (test config, import path): pi fixes and re-runs tests
- **Code change needed**: pi fixes the code and goes back through the full review loop

### Step 6: Commit, Push, and PR

When reviews pass and tests are green, pi:

1. Delegates to `git-expert` to stage specific files and commit with a clear message
2. Pushes the branch to origin
3. Delegates to `github-expert` to create a pull request with a description linking back to the issue

Pi checks off deliverables on the GitHub issue as they're completed, and closes the issue when everything is done.

## Using the /implement Shortcut

For a streamlined experience, use the `/implement` command. It chains three agents together automatically — scout, planner, then worker:

```
/implement Add a --verbose flag to the export command
```

This runs:

1. **Scout** — rapidly explores your codebase to find the relevant files, functions, and dependencies
2. **Planner** — creates a detailed implementation plan with files to change, edge cases, and testing approach
3. **Worker** — executes the plan, making all the code changes

The code review loop runs automatically after the worker finishes.

> **Tip:** Want a plan without implementation? Use `/scout-and-plan` instead — it runs only the scout and planner steps so you can review the approach before committing to it.

## Using /review-local to Review Before Committing

You can trigger a review at any time on your uncommitted changes:

```
/review-local
```

Or compare against a specific branch:

```
/review-local main
```

This spawns the same three parallel reviewers and presents findings grouped by severity, without modifying any code. See [Using Slash Commands and Prompt Templates](slash-commands.html) for all available commands.

## Task Tracking During the Workflow

For multi-step workflows, pi creates a visible task list and tracks progress through each step. If you ask a side question mid-workflow, pi answers it and then **resumes from exactly where it left off** — the task list ensures nothing gets forgotten.

You can check the current session state at any time:

```
/status
```

## Advanced Usage

### Reviewing an Existing Pull Request

Use `/pr-review` to review a PR that's already on GitHub:

```
/pr-review 42
/pr-review https://github.com/owner/repo/pull/42
```

Pi clones the PR branch, runs the three reviewers against the full repo context, lets you select which findings to post, and submits them as inline review comments on the PR. See [Common Workflow Recipes](workflow-recipes.html) for more review patterns.

### Skipping the Issue-First Workflow

The issue-first workflow is skipped automatically for:

- Typos and single-line fixes
- Questions or explorations (no code changes)
- Urgent hotfixes when you indicate time pressure
- When you say "just do it" or "quick fix"

### Multiple PRs in Parallel

When working on more than one PR or branch at the same time, pi uses `git worktree` to keep each branch isolated:

```bash
# Pi creates separate worktrees automatically
.worktrees/pr-42/   # One branch
.worktrees/pr-43/   # Another branch
```

This prevents branch switching from corrupting parallel agent work.

### Teaching Pi Your Preferences

Pi remembers your conventions across sessions. When you correct it or state a preference, it's saved automatically:

```
Always use conventional commits. Never put issue numbers in commit titles.
```

These preferences influence future sessions — including how code is written, reviewed, and committed. See [Working with Project Memory](memory-system.html) for more on the memory system.

## Troubleshooting

- **Pi tries to write code directly instead of delegating** — This shouldn't happen, but if it does, say "delegate this to the appropriate specialist agent."
- **Review loop seems stuck** — Reviewers run as background agents. Use `/async-status` to check their progress. See [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html).
- **Pi skipped the issue/branch step** — It may have classified your request as trivial. Say "use the issue-first workflow" to force it.
- **Tests fail that were already failing** — Pi compares against a baseline. Only new failures caused by your changes block the workflow. Pre-existing failures are noted but don't stop progress.
- **Wrong specialist agent picked** — Pi routes by task intent, not file extension. If routing seems wrong, you can say "use the python-expert for this" to override.

## Related Pages

- [Installing and Starting Your First Session](quickstart.html)
- [Understanding Agent Routing and Delegation](agent-routing.html)
- [Running the Automated Code Review Loop](code-review-loop.html)
- [Using Slash Commands and Prompt Templates](slash-commands.html)
- [Working with Project Memory](memory-system.html)
