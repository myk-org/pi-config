# Running the Automated Code Review Loop

Run your code changes through pi's 3-reviewer parallel code review system to catch quality issues, guideline violations, and security bugs before they land — and iterate until every reviewer approves.

## Prerequisites

- A working pi session with the orchestrator (see [Installing and Starting Your First Session](quickstart.html))
- Code changes ready for review (staged, unstaged, or on a branch)
- Familiarity with how the orchestrator delegates to agents (see [Understanding Agent Routing and Delegation](agent-routing.html))

## Quick Example

Ask pi to review your uncommitted changes:

```
/review-local
```

Or review changes compared to a specific branch:

```
/review-local main
```

Pi spawns three review agents in parallel, merges the findings, and presents them grouped by severity. That's the review loop in action.

## The Three Reviewers

Every code review dispatches three specialist agents simultaneously. Each focuses on a different dimension:

| Reviewer | Focus Area | What It Checks |
|----------|-----------|----------------|
| `code-reviewer-quality` | Code quality & maintainability | Readability, DRY violations, complexity, error handling, dead code, observability anti-patterns |
| `code-reviewer-guidelines` | Project guidelines & style | AGENTS.md compliance, documentation updates, naming conventions, file structure consistency |
| `code-reviewer-security` | Bugs, logic errors & security | Logic errors, null references, race conditions, injection flaws, resource leaks, edge cases |

The overlapping scope is intentional — multiple reviewers examining similar areas reduces the chance of missed issues. Duplicate findings are merged automatically.

> **Note:** All three reviewers are read-only agents. They use `read` and `bash` tools to inspect your code but never modify files.

## How the Loop Works

The review loop follows a strict cycle that repeats until all three reviewers approve:

1. **Code is written or modified** by a specialist agent (or you)
2. **All 3 reviewers run in parallel** as async background agents
3. **Findings are merged and deduplicated** across all reviewers
4. **If any reviewer has comments** → fix the code, go back to step 2
5. **All reviewers approve** → run tests via `test-automator`
6. **Tests pass** → done. Tests fail → fix and determine whether to re-review or just re-test

> **Tip:** Minor fixes that only touch test files or configuration can skip the full re-review and go directly back to testing. Substantive code changes require a full re-review from step 2.

## Reviewing Local Changes

### Uncommitted Changes

Review everything that's changed since your last commit:

```
/review-local
```

This runs `git diff HEAD` to collect your changes and sends them to all three reviewers.

### Changes Against a Branch

Compare your current branch against another branch:

```
/review-local main
```

```
/review-local develop
```

This runs `git diff <branch>...HEAD` to compute the diff.

### What You Get Back

Findings are presented grouped by severity:

```text
## Critical issues (must fix)
[CRITICAL] src/auth.py:42 — SQL injection via unsanitized user input
  Risk: Attacker can execute arbitrary SQL queries
  Suggestion: Use parameterized queries

## Warnings (should fix)
[WARNING] src/utils.py:15 — Empty catch block swallows errors silently
  Suggestion: Log the exception at minimum

## Suggestions (nice to have)
[SUGGESTION] src/config.py:8 — Unused import 'os'
  Suggestion: Remove unused import
```

## Implement-and-Review in One Command

To implement a change and automatically run the review loop:

```
/implement-and-review Add rate limiting to the /api/login endpoint
```

This chains three steps together:

1. A `worker` agent implements the task
2. All 3 reviewers run in parallel on the result
3. A `worker` agent fixes all issues found by the reviewers

## Reviewing a GitHub PR

To review a pull request and post inline comments on GitHub:

```
/pr-review
/pr-review 123
/pr-review https://github.com/owner/repo/pull/123
```

This fetches the PR diff, sends it to all three reviewers in parallel, lets you select which findings to post, and submits them as GitHub review comments. See [Using Slash Commands and Prompt Templates](slash-commands.html) for the full list of review-related commands.

## How Reviewers Run in the Background

All three code reviewers are enforced as **async-only agents**. When the orchestrator dispatches them, they automatically run as background agents — the session stays interactive while reviews happen.

When reviews finish, results surface automatically in your conversation with a notification:

```text
## Async Agent Result: code-reviewer-quality ✅ completed

Task: Review the changes for code quality
Duration: 45s

No quality issues found. Code approved.
```

You can check the status of running reviewers at any time:

```
/async-status
```

This shows all background agents with their elapsed time and task description. Select one to view its live output as it runs.

> **Tip:** If you need to cancel a running review, use `/async-kill` and select the agent to stop, or `/async-kill all` to stop everything.

## How Findings Are Deduplicated

When findings come back from all three reviewers, they're merged using these rules:

| Scenario | Action |
|----------|--------|
| Same file/line range + same issue type or root cause | Keep the most actionable version |
| Conflicting suggestions | Priority order: security > correctness > performance > style |
| Complementary findings on the same code (different issue types) | Keep both |
| Still ambiguous after priority ordering | Escalate to the user |

## Handling Review Feedback from External Reviewers

When your PR receives reviews from external tools (CodeRabbit, Qodo) or human reviewers on GitHub, use the review handler:

```
/review-handler
```

This fetches all review comments from the current PR — human, CodeRabbit, and Qodo — and walks you through addressing each one.

### Automated Review Loops

For fully automated handling of external reviewer comments:

```
/review-handler --autorabbit
/review-handler --autoqodo
/review-handler --autorabbit --autoqodo
```

In auto mode, the handler enters a polling loop: it fixes comments, pushes changes, waits for the reviewer to re-evaluate, and repeats until the reviewer approves. The session stays interactive while the loop runs.

See [Common Workflow Recipes](workflow-recipes.html) for copy-paste patterns covering autorabbit and autoqodo workflows.

## Advanced Usage

### Baseline Test Comparison

When the review loop reaches the testing phase, it compares test results against the baseline (the state before your changes). Only **new** test failures block the review — pre-existing failures are noted but don't block.

The baseline comparison works by:

1. Saving your changes as a patch
2. Resetting to a clean state and running tests
3. Restoring your changes and running tests again
4. Comparing the two results — only new failures count

> **Note:** If the baseline comparison fails (patch can't be applied), it's skipped with a note. Tests still run, but all failures are reported without filtering.

### Staged Review Mode

For automated workflows (`--autorabbit`, `--autoqodo`), reviews use a **two-stage order** instead of running all three reviewers in parallel:

| Stage | Focus | Purpose |
|-------|-------|---------|
| **Stage 1** | Spec compliance | Does the code meet requirements? All deliverables implemented? No scope creep? |
| **Stage 2** | Code quality | Quality, security, guidelines (runs only after Stage 1 passes) |

The staged approach avoids polishing code that doesn't meet spec — saving review cycles.

### Each Reviewer's Output Format

All three reviewers use a consistent severity-tagged format:

```text
[SEVERITY] file:line — Description
  Suggestion: What to change and why
```

- `[CRITICAL]` — Must fix before merging
- `[WARNING]` — Should fix, potential issue
- `[SUGGESTION]` — Nice to have, minor improvement

When a reviewer finds no issues, it explicitly states approval:

```text
No quality issues found. Code approved.
```

The loop only completes when all three reviewers return an approval message.

### Guidelines Reviewer and Documentation Checks

The `code-reviewer-guidelines` agent reads your project's `AGENTS.md` file first, then reviews changes against those rules. It also checks whether documentation needs updating:

- If code was added, changed, or removed, it verifies that `AGENTS.md` and `README.md` are updated accordingly
- Missing documentation updates are flagged as `[CRITICAL]`

### Multi-PR Reviews with Worktrees

When reviewing multiple PRs simultaneously, never switch branches in the main worktree. Use git worktrees:

```bash
git worktree add .worktrees/pr-42 origin/fix/issue-42
git worktree add .worktrees/pr-43 origin/feat/issue-43
```

Each worktree gets its own directory, so agents working on different PRs don't interfere with each other. Clean up when done:

```bash
git worktree remove .worktrees/pr-42
git worktree remove .worktrees/pr-43
```

### Extending the Review System

#### Adding a Custom Reviewer

To add a project-specific reviewer (e.g., for domain-specific rules), create an agent file in your project's `.pi/agents/` directory. See [Customization and Extension Recipes](customization-recipes.html) for the step-by-step process.

#### Async-Only Enforcement

All three code reviewers are in the async-only enforcement list. If the orchestrator accidentally tries to dispatch them synchronously, the system automatically promotes the call to async. This prevents the session from blocking while reviews run.

> **Warning:** If you create a custom reviewer agent and want it enforced as async-only, it must be added to the enforcement list in the extension configuration. Without this, sync calls will block your session for the duration of the review.

## Troubleshooting

**Reviews seem to take a long time**
Reviewer agents run as full pi sessions with their own context. Complex diffs take longer. Use `/async-status` to monitor progress and view live output.

**A reviewer keeps finding the same issue after I fix it**
Make sure your fix is saved to disk. Reviewers read files directly — unsaved editor buffers won't be seen. Also ensure you're not accidentally reverting changes between review cycles.

**"No async agents running" but I just started a review**
Agents take a moment to spawn. Wait a few seconds and check `/async-status` again. If the agent failed to start, the orchestrator will report an error in the conversation.

**Tests fail but the failures existed before my changes**
The baseline comparison should filter pre-existing failures. If it reports "baseline comparison unavailable," the patch couldn't be cleanly applied to the base. In that case, manually verify whether failures are new.

**Review comments conflict with each other**
When reviewers disagree, the priority order is: security > correctness > performance > style. If the conflict is still ambiguous, you'll be asked to decide.

## Related Pages

- [Understanding Agent Routing and Delegation](agent-routing.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
- [Specialist Agents Reference](agents-reference.html)
- [Common Workflow Recipes](workflow-recipes.html)
- [Your First Coding Workflow](first-workflow.html)
