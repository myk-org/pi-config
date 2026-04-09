---
description: "Handle CodeRabbit rate limits — wait and re-trigger automatically — /coderabbit-rate-limit [PR_NUMBER|PR_URL]"
---

Execute this workflow step by step. Run bash commands directly.

## Prerequisites Check (MANDATORY)

### Step 0: Check uv

```bash
uv --version
```

If not found, stop — install from https://docs.astral.sh/uv/getting-started/installation/

### Step 1: Check myk-pi-tools

```bash
myk-pi-tools --version
```

If not found, ask user to install: `uv tool install myk-pi-tools`

## Phase 1: Detect PR

If `{{args}}` contains a URL, extract owner/repo and PR number from it.

If `{{args}}` contains a number, detect the repository:

```bash
gh repo view --json nameWithOwner -q .nameWithOwner
```

If `{{args}}` is empty, detect PR from current branch:

```bash
gh pr view --json number,url -q '.number'
gh repo view --json nameWithOwner -q .nameWithOwner
```

## Phase 2: Check Rate Limit

```bash
myk-pi-tools coderabbit check <owner/repo> <pr_number>
```

Parse the JSON result:
- If `rate_limited` is `false` — notify user "Not rate limited" and exit
- If `rate_limited` is `true` — read `wait_seconds` and proceed to Phase 3

## Phase 3: Wait and Trigger Review

Add a 30-second buffer to the wait time and run the trigger command:

```bash
myk-pi-tools coderabbit trigger <owner/repo> <pr_number> --wait <wait_seconds + 30>
```

This command will:
1. Sleep for the specified wait duration
2. Post `@coderabbitai review` to re-trigger the review
3. Poll every 60s (max 10 min) until the review starts

## Phase 4: Notify User

Based on the exit code of the trigger command:
- **Exit 0** — Report success: "CodeRabbit review started on PR #N"
- **Exit 1** — Report the error message from stderr
