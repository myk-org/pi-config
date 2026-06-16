# Running the Automated Code Review Loop

Get your code changes reviewed by three parallel reviewers — quality, guidelines, and security — and iterate on findings until all reviewers approve and tests pass.

## Prerequisites

- A working pi session with the orchestrator (see [Installing and Starting Your First Session](quickstart.html))
- Code changes on a working branch (uncommitted or committed)
- Familiarity with basic agent delegation (see [Understanding Agent Routing and Delegation](agent-routing.html))

## Quick Example

Make a code change and ask pi to review it:

```text
I've updated the authentication module. Please review my changes.
```

The orchestrator automatically triggers the code review loop — it spawns all three reviewers in parallel, collects their findings, and presents a merged summary. If there are issues, fix them and the loop runs again.

For an even faster workflow, use the built-in slash command:

```text
/review-local
```

This reviews all uncommitted changes (staged + unstaged) against `HEAD`. To review changes compared to a specific branch:

```text
/review-local main
```

## How the Review Loop Works

The code review loop runs automatically after any code change. Here's the flow:

1. **Specialist writes or fixes code** — a language expert (e.g., `python-expert`, `ts-expert`) makes the changes
2. **Three reviewers run in parallel** — all launched simultaneously as background agents
3. **Findings are merged** — duplicates across reviewers are removed
4. **Findings require fixes?** — if yes, the code is fixed and reviewers run again (step 2)
5. **All reviewers approve** — the `test-automator` agent runs tests
6. **Tests pass?** — if yes, the loop is complete. If not, the code is fixed and either re-reviewed (for substantive changes) or re-tested (for test/config-only fixes)

> **Note:** You don't need to manage this loop manually. The orchestrator handles the full cycle — spawning reviewers, collecting results, requesting fixes, and re-running reviews. You only interact when asked to make a decision.

## The Three Reviewers

Each reviewer focuses on a different aspect of your code:

| Reviewer | Focus Area | Example Findings |
|----------|-----------|------------------|
| `code-reviewer-quality` | Code quality and maintainability | DRY violations, poor naming, missing error logging, dead code |
| `code-reviewer-guidelines` | Project guidelines compliance | AGENTS.md violations, missing documentation updates, import ordering |
| `code-reviewer-security` | Bugs, logic errors, and security | SQL injection, race conditions, null references, resource leaks |

The overlapping scope is intentional — multiple reviewers examining similar areas reduces the chance of missed issues.

### Finding Severity Levels

Reviewers categorize their findings into three severity levels:

- **`[CRITICAL]`** — Must fix before merging. Security vulnerabilities, data loss risks, logic errors.
- **`[WARNING]`** — Should fix. Quality issues, missing error handling, guideline violations.
- **`[SUGGESTION]`** — Nice to have. Style improvements, minor readability enhancements.

### How Findings Are Deduplicated

When reviewers flag the same issue, the orchestrator merges findings using these rules:

- **Same file/line range + same root cause** → kept as one finding (the most actionable version)
- **Conflicting suggestions** → priority order: security > correctness > performance > style
- **Different issue types on the same code** → both findings are kept

## Reviewing Uncommitted Changes

The `/review-local` command runs a full three-reviewer analysis on your local changes without creating a PR.

```text
/review-local
```

This reviews all uncommitted changes (staged + unstaged) against `HEAD`.

To compare against a specific branch:

```text
/review-local main
/review-local develop
```

The workflow creates a structured task plan:

1. Get the diff
2. Launch all three reviewers in parallel (async)
3. Merge and deduplicate findings
4. Present findings grouped by severity

> **Tip:** Use `/review-local` before pushing to catch issues early. It's faster than a full PR review since it works on local changes.

## Implementing with Automatic Review

To implement a feature and run the review loop in one step:

```text
/implement-and-review Add rate limiting to the API endpoints
```

This chains three stages:

1. A `worker` agent implements the task
2. All three reviewers run in parallel on the changes
3. A `worker` agent fixes all issues found by the reviewers

## Reviewing a GitHub PR

The `/pr-review` command runs the three-reviewer system against a GitHub PR and posts inline comments:

```text
/pr-review
/pr-review 123
/pr-review https://github.com/owner/repo/pull/123
```

The PR review workflow:

1. **Detects the PR** — from the current branch or from the argument you provide
2. **Clones the repo** — checks out the PR branch so reviewers have full repo access
3. **Checks past review comments** — fetches previous review threads to track unresolved issues
4. **Runs all three reviewers in parallel** — each reviewer examines the diff and full source
5. **Presents merged findings** — you choose which to post as inline PR comments
6. **Posts comments and stores them** — comments are tracked in a local database for future review cycles

> **Note:** Past review comments are categorized during the review. Unresolved threads appear as `[PREV-UNRESOLVED]`, while threads marked resolved but with incorrect fixes show as `[PREV-BAD-FIX]`. This prevents issues from slipping through across review cycles.

See [Using Slash Commands and Prompt Templates](slash-commands.html) for the full list of available commands.

## Understanding Async Reviewers

All three review agents are enforced to run asynchronously — they always run as background agents. This means:

- The orchestrator spawns all three reviewers in a single action
- Your session remains interactive while reviewers work
- Results surface automatically when each reviewer finishes
- You can continue other work while waiting

Check reviewer status at any time:

```text
/async-status
```

See [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) for more on async agents.

## Baseline Test Comparison

When the review loop runs tests (step 5), it compares test results against a baseline to avoid blocking on pre-existing failures:

- The orchestrator saves your changes, resets to a clean state, and runs tests to establish a baseline failure count
- Then it restores your changes and runs tests again
- **Only new failures** (current minus baseline) block the review
- Pre-existing failures are noted but don't prevent approval

This prevents the review loop from blocking on test failures that existed before your changes.

## Advanced Usage

### Handling Review Comments from External Reviewers

The `/review-handler` command processes review comments from multiple sources — human reviewers, CodeRabbit, and Qodo — on a GitHub PR:

```text
/review-handler
```

For each comment, you choose whether to address it, skip it, or address all at once. The agent then delegates fixes to the appropriate specialist.

To automatically fix comments from CodeRabbit or Qodo in a polling loop:

```text
/review-handler --autorabbit
/review-handler --autoqodo
/review-handler --autorabbit --autoqodo
```

In auto mode, the handler processes comments, pushes fixes, and polls for new comments until the reviewer approves the PR.

See [Common Workflow Recipes](workflow-recipes.html) for more patterns.

### Refining Your Own Review Comments

Before submitting a pending GitHub review, polish your comments with AI:

```text
/refine-review https://github.com/owner/repo/pull/123
```

This fetches your pending review comments, suggests refinements for clarity and actionability, and lets you accept, reject, or customize each suggestion before submitting.

### Staged Review Mode for Automated Workflows

When using automated review flows (`--autorabbit`, `--autoqodo`), the system uses a two-stage review order instead of launching all three reviewers in parallel:

- **Stage 1 — Spec Compliance:** Does the code meet requirements? Are all deliverables implemented? No scope creep?
- **Stage 2 — Code Quality:** Quality, security, and guidelines checks (the normal three reviewers)

Stage 1 must pass before Stage 2 begins. This avoids polishing code that doesn't meet the specification — saving time and review cycles.

### Multi-PR Review Handling

When handling reviews for multiple PRs simultaneously, the system uses git worktrees to isolate each PR:

```text
/review-handler
```

> **Warning:** Never switch branches manually when multiple review agents are running. The orchestrator uses worktrees automatically to prevent branch switching from corrupting parallel agent work.

### The Implement → Review → Fix Cycle

For a complete implementation workflow that includes scouting, planning, implementation, and review:

```text
/implement Add caching layer to the database queries
```

This chains three agents:

1. `scout` — explores the codebase to find relevant code
2. `planner` — creates a detailed implementation plan
3. `worker` — implements the plan

After implementation, the orchestrator automatically triggers the code review loop. Any findings lead to fixes and re-review until all three reviewers approve.

## Troubleshooting

**Reviewers seem stuck or unresponsive:**
Check `/async-status` to see if reviewers are still running. If a reviewer fails, the orchestrator reports the error and can retry.

**Too many false positives from reviewers:**
The overlapping reviewer scope is intentional, but if findings are consistently unhelpful, check that your project has an `AGENTS.md` or `CLAUDE.md` file. Reviewers read these files to understand project-specific conventions and reduce noise.

**Tests fail on pre-existing issues:**
The baseline comparison should handle this automatically. If baseline comparison is unavailable (e.g., `git apply` fails), the review notes "baseline comparison unavailable" and does not block on all failures.

**Review loop keeps cycling:**
The loop exits when all three reviewers approve AND tests pass. If fixes introduce new issues, the loop continues. For complex changes, consider breaking the work into smaller commits.

## Related Pages

- [Understanding Agent Routing and Delegation](agent-routing.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
- [Specialist Agents Reference](agents-reference.html)
- [Using Slash Commands and Prompt Templates](slash-commands.html)
- [Common Workflow Recipes](workflow-recipes.html)
