---
description: Review a GitHub PR and post inline comments on selected findings
---

# GitHub PR Review Command

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug
> while executing this command — DO NOT work around it silently. Ask the user:
> "Should I create a GitHub issue for this?" Route to:
> `myk-org/pi-config` for plugin/command spec or `myk-pi-tools` CLI issues.
> Do not silently skip steps or apply manual fixes that hide the root cause.

Reviews a GitHub PR and posts inline review comments on selected findings.

## Prerequisites Check (MANDATORY)

Before starting, verify the tools are available:

### Step 0: Check uv

```bash
uv --version
```

If not found, install from <https://docs.astral.sh/uv/getting-started/installation/>

### Step 1: Check myk-pi-tools

```bash
myk-pi-tools --version
```

If not found, prompt user: "myk-pi-tools is required. Install with: `uv tool install myk-pi-tools`. Install now?"

- Yes: Run `uv tool install myk-pi-tools`
- No: Abort with instructions

### Step 2: Continue with workflow

## Usage

- `/pr-review` - Review PR from current branch (auto-detect)
- `/pr-review 123` - Review PR #123 in current repo
- `/pr-review https://github.com/owner/repo/pull/123` - Review from URL

## Workflow

### Phase 0: PR Detection (when no arguments provided)

If `$ARGUMENTS` is empty:

1. Detect PR from current branch:

   ```bash
   gh pr view --json number,headRefOid
   ```

2. Get base repository context (where PR targets):

   The base repository (where the PR is opened) is determined by the current working directory context.
   When you run `gh pr view` from a cloned repository, it operates in that repository's context.

   To get `owner` and `repo`:

   ```bash
   gh repo view --json owner,name
   ```

   This returns the base repository information regardless of whether the PR comes from a fork.

   **Note:** `baseRepository` is NOT available in `gh pr view --json`. For fork PRs, `headRepository` would incorrectly point to the fork, not the target repository.

3. Extract and store:

   - `pr_number` from the PR JSON response
   - `owner` from `gh repo view` → `owner.login`
   - `repo` from `gh repo view` → `name`
   - `head_sha` from `headRefOid`

4. Use `{pr_number}` for subsequent CLI commands

If `$ARGUMENTS` contains a PR number or URL, use it directly.

### Phase 1a: Data Fetching

Run the diff command to get PR data:

If PR was auto-detected (no arguments):

```bash
myk-pi-tools pr diff {pr_number}
```

Otherwise:

```bash
myk-pi-tools pr diff $ARGUMENTS
```

Store the JSON output containing metadata, diff, and files.

### Phase 1b: Fetch AGENTS.md

Run the claude-md command to get project rules:

If PR was auto-detected (no arguments):

```bash
myk-pi-tools pr claude-md {pr_number}
```

Otherwise:

```bash
myk-pi-tools pr claude-md $ARGUMENTS
```

Store the output as `claude_md_content`.

### Phase 2: Code Analysis

Delegate to ALL 3 review agents IN PARALLEL (single message with 3 Task tool calls):

- `superpowers:code-reviewer` - General code quality and maintainability
- `pr-review-toolkit:code-reviewer` - Project guidelines and style adherence
- `feature-dev:code-reviewer` - Bugs, logic errors, and security vulnerabilities

Provide each agent with:

- The diff content from Phase 1a
- The AGENTS.md content from Phase 1b (or "No AGENTS.md found" if empty)

Each agent should analyze for security, bugs, error handling, and performance issues and return their findings as prose.
Merge and deduplicate the findings from all 3 reviewers before proceeding.

### Phase 3: User Selection

Present findings to user grouped by severity (CRITICAL, WARNING, SUGGESTION). Ask which to post:

- 'all' = Post all
- 'none' = Skip posting
- Specific numbers = Post only those

### Phase 4: Post Comments

If user selected findings, create temp directory and write JSON to temp file:

```bash
mkdir -p /tmp/pi-work
```

Use the `owner`, `repo`, `pr_number`, and `head_sha` from Phase 0 or Phase 1a metadata:

```bash
myk-pi-tools pr post-comment {owner}/{repo} {pr_number} {head_sha} /tmp/pi-work/pr-review-comments.json
```

### Phase 5: Summary

Display final summary with counts and links.
