---
description: Handle CodeRabbit rate limits - waits and re-triggers review automatically
---

## Raw Arguments

```text
$ARGUMENTS
```

# CodeRabbit Rate Limit Handler

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug
> while executing this command — DO NOT work around it silently. Ask the user:
> "Should I create a GitHub issue for this?" Route to:
> `myk-org/pi-config` for plugin/command spec or `myk-pi-tools` CLI issues.
> Do not silently skip steps or apply manual fixes that hide the root cause.

Automatically handles CodeRabbit rate limits by waiting for the cooldown period and re-triggering the review.

## Prerequisites Check (MANDATORY)

### Step 0: Check uv

```bash
uv --version
```

If not found, install from <https://docs.astral.sh/uv/getting-started/installation/>

### Step 1: Check myk-pi-tools

```bash
myk-pi-tools --version
```

If not found, prompt to install: `uv tool install myk-pi-tools`

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
myk-pi-tools coderabbit check <owner/repo> <pr_number>
```

This outputs JSON to stdout. Parse the result:

- If `rate_limited` is `false` — notify user "Not rate limited" and exit
- If `rate_limited` is `true` — read `wait_seconds` and proceed to Phase 3

### Phase 3: Wait and Trigger Review

Add a 30-second buffer to the wait time and run the trigger command in background:

```bash
myk-pi-tools coderabbit trigger <owner/repo> <pr_number> --wait <wait_seconds + 30>
```

This command will:

1. Sleep for the specified wait duration
2. Post `@coderabbitai review` to re-trigger the review
3. Poll every 60s (max 10 min) until the review starts

### Phase 4: Notify User

Based on the exit code of the trigger command:

- **Exit 0** — Report success to user ("CodeRabbit review started on PR #N")
- **Exit 1** — Report the error message from stderr to the user
