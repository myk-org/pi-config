---
description: Handle CodeRabbit rate limits - waits and re-triggers review automatically
argument-hint: "[PR number]"
---

## Raw Arguments

```text
$ARGUMENTS
```

# CodeRabbit Rate Limit Handler

Automatically handles CodeRabbit rate limits by waiting for the cooldown period and re-triggering the review.

## Prerequisites Check (MANDATORY)

### Step 0: Check uv

```bash
uv --version
```

If not found, install from <https://docs.astral.sh/uv/getting-started/installation/>

## Usage

- `/coderabbit-rate-limit` - Handle rate limit on current branch's PR
- `/coderabbit-rate-limit 123` - Handle rate limit on PR #123
- `/coderabbit-rate-limit https://github.com/owner/repo/pull/123` - Handle rate limit via URL

## Workflow

### Phase 1: Detect PR

If the raw arguments contain a URL, extract owner/repo and PR number from it.

If the raw arguments contain a number, detect the repository:

```bash
gh repo view --json nameWithOwner -q .nameWithOwner
```

If the raw arguments are empty, detect PR from current branch:

```bash
gh pr view --json number,url -q '.number'
gh repo view --json nameWithOwner -q .nameWithOwner
```

### Phase 2: Check Rate Limit

```bash
uvx myk-pi-tools@latest coderabbit check <owner/repo> <pr_number>
```

`coderabbit check` inspects the latest `CodeRabbit` check run on the PR's head SHA
rather than the summary comment. A run counts as rate limited when `conclusion` is
`"neutral"` and `output.title` or `output.summary` contains `"rate limit"`. The
command reads `wait_seconds` from the check run output or a matching CodeRabbit
reply comment.

It prints JSON to stdout:

- `rate_limited: false`: either no `CodeRabbit` check run exists yet
  (`{"rate_limited": false}`), or the latest run is not rate limited (also includes
  `check_run_id`, `head_sha`, `conclusion`, `title`). Notify the user
  "Not rate limited" and exit.
- `rate_limited: true`: includes `wait_seconds` (the **remaining** seconds to wait,
  already subtracting elapsed time since the reply comment or check run timestamp),
  `check_run_id`, `head_sha`, `conclusion`, `title`, `updated_at` (the check run's
  ISO `completed_at` timestamp), and optionally `fallback: true`. Read
  `wait_seconds` and proceed to Phase 3.
  - If `fallback` is `true`, the remaining wait time is **estimated** from the
    check run's `completed_at` timestamp (1-hour window), not parsed from the reply
    comment or check run output. Warn the user that timing is approximate.

### Phase 3: Wait and Trigger Review

Add a 30-second buffer to the wait time and run the trigger command in background:

```bash
uvx myk-pi-tools@latest coderabbit trigger <owner/repo> <pr_number> --wait <wait_seconds + 30>
```

This command will:

1. Sleep for the specified wait duration
2. Post `@coderabbitai review` to re-trigger the review
3. Poll every 60s (max 10 min) until the review starts

### Phase 4: Notify User

Based on the exit code of the trigger command:

- **Exit 0** — Report success to user ("CodeRabbit review started on PR #N")
- **Exit 1** — Report the error message from stderr to the user
