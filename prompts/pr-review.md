---
description: "Review a GitHub PR and post inline comments — /pr-review [PR_NUMBER|PR_URL]"
---

Execute this workflow step by step. Run bash commands directly — do NOT delegate to subagents for CLI commands.

## Prerequisites Check (MANDATORY)

### Step 0: Check uv

```bash
uv --version
```

If not found, stop and tell the user to install from https://docs.astral.sh/uv/getting-started/installation/

### Step 1: Check myk-pi-tools

```bash
myk-pi-tools --version
```

If not found, ask the user: "myk-pi-tools is required. Install with: `uv tool install myk-pi-tools`. Install now?"
- Yes: Run `uv tool install myk-pi-tools`
- No: Abort

## Phase 0: PR Detection

If `{{args}}` is empty — auto-detect from current branch:

```bash
gh pr view --json number,headRefOid -q '.'
```

Extract `pr_number` and `head_sha` (headRefOid).

Then get the base repository:

```bash
gh repo view --json owner,name -q '.'
```

Extract `owner` (owner.login) and `repo` (name).

If `{{args}}` contains a URL — extract owner/repo/number from it. Get head SHA:

```bash
gh pr view <number> --repo <owner>/<repo> --json headRefOid -q '.headRefOid'
```

If `{{args}}` is a number — use it as pr_number, detect repo with `gh repo view`, get head SHA.

## Phase 1a: Fetch Diff

```bash
myk-pi-tools pr diff <pr_number_or_url>
```

Store the JSON output containing metadata, diff, and files.

## Phase 1b: Fetch CLAUDE.md / AGENTS.md

```bash
myk-pi-tools pr claude-md <pr_number_or_url>
```

Store the output as project guidelines context.

## Phase 2: Code Analysis

Use the subagent tool to run ALL 3 review agents IN PARALLEL (using the `tasks` array):

1. **code-reviewer-quality** — General code quality and maintainability
2. **code-reviewer-guidelines** — Project guidelines and style adherence (pass the CLAUDE.md/AGENTS.md content)
3. **code-reviewer-security** — Bugs, logic errors, and security vulnerabilities

Pass each agent the full diff content from Phase 1a and the guidelines from Phase 1b.

After all 3 finish, merge and deduplicate findings:
- Same file/line range + same issue type = duplicate → keep most actionable
- Conflicting suggestions → priority: security > correctness > performance > style
- Complementary findings (different issue types) → keep both

## Phase 3: User Selection

Present findings grouped by severity (CRITICAL, WARNING, SUGGESTION), numbered.

Ask the user which to post:
- `all` = Post all findings
- `none` = Skip posting
- Specific numbers (e.g., `1,3,5`) = Post only those

## Phase 4: Post Comments

If user selected findings, create the JSON comment file:

```bash
mkdir -p /tmp/pi-work
```

Write a JSON array to `/tmp/pi-work/pr-review-comments.json` with format:
```json
[{"path": "file.py", "line": 42, "body": "Comment text"}]
```

Post using the owner, repo, pr_number, and head_sha from Phase 0/1a:

```bash
myk-pi-tools pr post-comment <owner>/<repo> <pr_number> <head_sha> /tmp/pi-work/pr-review-comments.json
```

## Phase 5: Summary

Display final summary:
- Number of findings by severity
- Number of comments posted
- PR URL for reference
