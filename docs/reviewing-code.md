# Reviewing Code with Parallel Agents

Catch bugs, security issues, and guideline violations before they reach production by running three specialized review agents simultaneously. Whether you're reviewing a GitHub pull request or checking local changes before pushing, parallel reviews give you comprehensive coverage in a single pass.

## Prerequisites

- **uv** installed ([installation guide](https://docs.astral.sh/uv/getting-started/installation/))
- **myk-pi-tools** installed: `uv tool install myk-pi-tools`
- **gh** CLI authenticated (for PR reviews): `gh auth login`

## Quick Example

Review your uncommitted changes with three parallel agents:

```
/review-local
```

That's it. Three reviewers analyze your code simultaneously and return merged, deduplicated findings grouped by severity.

## How Parallel Review Works

Every review triggers three specialized agents that run concurrently:

| Agent | Focus Area |
|-------|------------|
| **Quality reviewer** | Readability, abstractions, DRY violations, error handling, dead code, observability |
| **Guidelines reviewer** | Project conventions, naming, file structure, documentation completeness |
| **Security reviewer** | Logic errors, injection vulnerabilities, race conditions, resource leaks, edge cases |

The overlapping scope is intentional — multiple reviewers examining similar areas reduces the chance of missed issues. Findings are automatically deduplicated before you see them.

When findings conflict, they follow a priority order: **security > correctness > performance > style**.

## Reviewing Local Changes

Use `/review-local` to review changes before committing or pushing.

### Review uncommitted changes

```
/review-local
```

Reviews all staged and unstaged changes against `HEAD`.

### Compare against a branch

```
/review-local main
```

Reviews all changes on your current branch compared to `main`. Use any branch name:

```
/review-local develop
/review-local feature/auth-rewrite
```

### Reading the results

Findings are grouped into three severity levels:

- **Critical** — Must fix. Security vulnerabilities, data loss risks, logic errors.
- **Warning** — Should fix. Missing error handling, code smells, poor observability.
- **Suggestion** — Nice to have. Style improvements, minor refactors.

## Reviewing GitHub Pull Requests

Use `/pr-review` to fetch a PR diff from GitHub, run parallel reviews, and post inline comments directly on the PR.

### Review the current branch's PR

```
/pr-review
```

Auto-detects the PR associated with your current branch.

### Review by PR number

```
/pr-review 123
```

### Review by URL

```
/pr-review https://github.com/owner/repo/pull/123
```

### What happens during a PR review

1. The PR diff and project guidelines are fetched from GitHub
2. All three review agents analyze the diff in parallel
3. Findings are merged, deduplicated, and presented by severity
4. You choose which findings to post: `all`, `none`, or specific numbers (e.g., `1,3,5`)
5. Selected findings are posted as inline comments on the PR

> **Tip:** You can review any PR you have read access to, including PRs from forks.

## Implementing with Built-in Review

Use `/implement-and-review` to write code and review it in a single workflow:

```
/implement-and-review Add retry logic to the API client
```

This runs a three-step chain:

1. A worker agent implements your task
2. All three review agents analyze the changes in parallel
3. The worker agent fixes every issue the reviewers found

The result is reviewed, corrected code — ready to commit.

## Advanced Usage

### Handling incoming review comments

Use `/review-handler` to process review comments that others have left on your PR:

```
/review-handler
```

This fetches all unresolved review threads (from humans, Qodo, and CodeRabbit), presents them in a table sorted by priority, and lets you decide which to address. For each approved comment, a specialist agent implements the fix. After all fixes pass tests, replies are posted and threads are resolved.

You can target a specific review:

```
/review-handler https://github.com/owner/repo/pull/123#pullrequestreview-456
```

### Autorabbit mode

For PRs with CodeRabbit reviews, autorabbit mode creates a fully automated fix-and-poll loop:

```
/review-handler --autorabbit
```

In this mode:

- All CodeRabbit comments are auto-approved and fixed without prompting
- Human and Qodo comments still require your decision
- After fixes are pushed, it polls for new CodeRabbit comments automatically
- The loop continues until CodeRabbit approves or you type `stop`

> **Note:** The polling loop runs silently in the background. You can continue working in the same session while it watches for new comments.

### Handling multiple PRs

When processing reviews for multiple PRs, the system uses git worktrees to avoid branch-switching conflicts:

```
/review-handler https://github.com/owner/repo/pull/42
/review-handler https://github.com/owner/repo/pull/43
```

Each PR gets its own isolated worktree. This prevents parallel agents from seeing the wrong branch.

### Refining your own review comments

Use `/refine-review` to polish pending review comments you've drafted on GitHub before submitting:

```
/refine-review https://github.com/owner/repo/pull/123
```

This fetches your pending (unsubmitted) review, shows original vs. refined versions side-by-side, and lets you accept, reject, or customize each refinement. You then choose the review action (comment, approve, or request changes) and submit.

### Checking async agent status

When reviews are running in the background, check their progress:

```
/async-status
```

## The Review Loop

When agents implement code changes (not just review), pi-config enforces a mandatory review loop:

1. Agent writes or modifies code
2. All three review agents run in parallel
3. Findings are merged and deduplicated
4. If any reviewer has comments — fix and go back to step 2
5. Run the test suite
6. If tests fail — fix and re-review if the fix is substantive
7. Done only when all reviewers approve **and** tests pass

This loop runs automatically during `/implement-and-review` and when fixing review comments via `/review-handler`. You don't need to trigger it manually.

## Troubleshooting

**"myk-pi-tools not found"**
Install with `uv tool install myk-pi-tools`. The commands check for this automatically and prompt you to install if missing.

**PR not detected from current branch**
Make sure your branch has an open PR on GitHub. Run `gh pr view` to verify. You can always pass a PR number or URL explicitly.

**Reviews seem to hang**
Long reviews run asynchronously. Use `/async-status` to check progress. Background agents have no timeout — large diffs may take several minutes.

**Duplicate findings across reviewers**
This is expected and handled automatically. Findings on the same file and line with the same root cause are deduplicated, keeping the most actionable version.

**Autorabbit loop won't stop**
Type `stop`, `exit`, `done`, or `quit` to end the polling loop. The loop only exits automatically when CodeRabbit posts an approval.
