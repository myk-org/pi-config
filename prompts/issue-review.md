---
description: "Review a GitHub issue spec and fix it — /issue-review [issue number or URL]"
argument-hint: "[issue number or URL]"
---

# GitHub Issue Review Command

## Raw Arguments

```text
$ARGUMENTS
```

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug
> while executing this command — DO NOT work around it silently. Ask the user:
> "Should I create a GitHub issue for this?" Route to:
> `myk-org/pi-config` for plugin/command spec or `myk-pi-tools` CLI issues.
> Do not silently skip steps or apply manual fixes that hide the root cause.

Reviews a GitHub issue for spec quality, feasibility, and scope — then edits the issue body to fix problems.

## Usage

- `/issue-review` — review issue linked to current branch (auto-detect)
- `/issue-review 42` — review issue #42
- `/issue-review https://github.com/owner/repo/issues/42` — review from URL

## Task Plan

Before starting any work, create ALL tasks upfront using `TaskCreate`, then set dependencies.

### Task List

| Task | Title | blockedBy |
|------|-------|-----------|
| 1 | Issue detection | — |
| 2 | Context gathering | 1 |
| 3 | Duplicate scan | 1 |
| 4 | Review — Spec | 2 |
| 5 | Review — Feasibility | 2 |
| 6 | Review — Scope | 2, 3 |
| 7 | Merge findings | 4, 5, 6 |
| 8 | User selection | 7 |
| 9 | Apply fixes to issue body | 8 |
| 10 | Summary | 9 |

Create all 10 tasks, then set dependencies via `TaskUpdate` with `addBlockedBy`.

## Workflow

**PROJECT_TMP_DIR** is the project-scoped temp directory from `getProjectTmpDir(cwd)`.

### Phase 0: Issue Detection — Task 1

Mark Task 1 as `in_progress`.

If the raw arguments are empty:

1. Detect issue from current branch name (extract issue number from branch like `feat/issue-42-...`
   or `fix/issue-42-...`).
2. If no issue number in branch, try: `gh issue list --assignee @me --state open --limit 1 --json number --jq '.[0].number'`
3. If still nothing, ask the user for an issue number.

If the raw arguments contain an issue number or URL:

1. Parse the number (e.g., `42`) or extract from URL (e.g., `https://github.com/owner/repo/issues/42`)

Fetch issue metadata:

```bash
gh issue view <number> --json number,title,body,labels,assignees,state,comments,milestone,author --jq '.'
```

Store:

- `ISSUE_NUMBER` — the issue number
- `ISSUE_TITLE` — the issue title
- `ISSUE_BODY` — the full issue body (markdown)
- `ISSUE_LABELS` — labels array
- `ISSUE_ASSIGNEES` — assignees array
- `ISSUE_COMMENTS` — comments array
- `ISSUE_AUTHOR` — issue author login

Also get repo info:

```bash
gh repo view --json owner,name --jq '.owner.login + "/" + .name'
```

Store as `OWNER_REPO`.

Mark Task 1 as `completed`.

### Phase 1: Context Gathering — Task 2

Mark Task 2 as `in_progress`.

Extract all file/function/class references from the issue body and comments:

1. Scan the issue body for patterns like:
   - File paths: `src/foo.ts`, `extensions/bar/baz.py`, backtick-wrapped paths
   - Function/method references: `functionName()`, `Class.method()`
   - Code blocks referencing specific files

2. For each reference, verify it exists in the codebase:

   ```bash
   test -f <path> && echo "EXISTS" || echo "MISSING"
   ```

   For function references:

   ```bash
   rg "function <name>|def <name>|<name>\s*=" <likely_files> --count
   ```

3. Store results as `CODEBASE_REFS` — a list of `{ref, exists, location}` objects.

Write the issue body to a temp file for reviewer access using the `write` tool:

```text
Use the write tool to create ${PROJECT_TMP_DIR}/issue-body.md with the ISSUE_BODY content
```

Mark Task 2 as `completed`.

### Phase 2: Duplicate Scan — Task 3

Task 3 can run in parallel with Task 2.

Mark Task 3 as `in_progress`.

Search for potential duplicate or overlapping issues:

```bash
gh issue list --state open --limit 50 --json number,title,body,labels
```

Compare the current issue against all open issues:

- Title keyword similarity
- Body content overlap
- Same labels + similar description

Store results as `DUPLICATES` — a list of `{number, title, similarity_reason}`.
Only include issues with meaningful overlap, not just shared labels.

Mark Task 3 as `completed`.

### Phase 3: Review — Tasks 4, 5, 6

Spawn ALL 3 review agents as async subagents. Each reviewer gets the issue body
and relevant context.

**Important:** Pass `cwd` as the current project directory so reviewers can access the codebase.

```text
subagent(tasks=[
  {agent: "issue-reviewer-spec", task: "Review this GitHub issue for spec completeness.\n\nIssue #<ISSUE_NUMBER>: <ISSUE_TITLE>\n\n<issue-body>\n<ISSUE_BODY>\n</issue-body>\n\nLabels: <ISSUE_LABELS>\nAssignees: <ISSUE_ASSIGNEES>\n\nReturn findings as JSON.", cwd: "<project_dir>", name: "Issue Spec", taskId: "<task 4 ID>"},
  {agent: "issue-reviewer-feasibility", task: "Review this GitHub issue for codebase feasibility.\n\nIssue #<ISSUE_NUMBER>: <ISSUE_TITLE>\n\n<issue-body>\n<ISSUE_BODY>\n</issue-body>\n\n<codebase-refs>\n<CODEBASE_REFS>\n</codebase-refs>\n\nVerify all file/function references and assess approach viability. Return findings as JSON.", cwd: "<project_dir>", name: "Issue Feasibility", taskId: "<task 5 ID>"},
  {agent: "issue-reviewer-scope", task: "Review this GitHub issue for scope hygiene.\n\nIssue #<ISSUE_NUMBER>: <ISSUE_TITLE>\n\n<issue-body>\n<ISSUE_BODY>\n</issue-body>\n\n<duplicate-candidates>\n<DUPLICATES>\n</duplicate-candidates>\n\nCheck for single concern, scope creep, and duplicates. Return findings as JSON.", cwd: "<project_dir>", name: "Issue Scope", taskId: "<task 6 ID>"},
])
```

After spawning, end your turn. Results arrive automatically.

### Phase 4: Merge Findings — Task 7

Mark Task 7 as `in_progress`.

Merge and deduplicate findings from all 3 reviewers:

1. Parse JSON findings from each reviewer
2. Remove duplicates (same description targeting same issue section)
3. Sort by severity: CRITICAL → WARNING → SUGGESTION
4. For each finding, determine the fix action:
   - **Add section** — missing `## Done`, missing reproduction steps, etc.
   - **Rewrite section** — vague problem statement, unclear deliverables
   - **Add metadata** — missing labels, assignee
   - **Flag only** — scope concerns, duplicates (can't be auto-fixed in body)

Mark Task 7 as `completed`.

### Phase 5: User Selection — Task 8

Mark Task 8 as `in_progress`.

Present ALL findings to the user in a table:

```text
## Issue Review Findings

| # | Severity | Category | Finding | Fix |
|---|----------|----------|---------|-----|
| 1 | CRITICAL | spec | Missing ## Done checklist | Add section |
| 2 | WARNING | feasibility | references src/auth.py which doesn't exist | Correct reference |
| 3 | WARNING | scope | Overlaps with #38 (similar auth refactor) | Flag only |
| 4 | SUGGESTION | spec | Bug report missing environment info | Add section |
```

For each finding that has a fix (not "flag only"), show the proposed change
(what will be added/modified in the issue body).

Then ask the user:

```text
Which fixes to apply? (e.g., 'all', 'none', '1,2,4', or specific numbers)
```

Use `ask_user` for the selection.

Mark Task 8 as `completed`.

### Phase 6: Apply Fixes — Task 9

Mark Task 9 as `in_progress`.

For each approved fix:

1. Build the updated issue body by applying all selected changes to `ISSUE_BODY`
2. Show the user the diff (original vs updated body) as a preview
3. Ask for confirmation: "Apply these changes to issue #N?"
4. If confirmed, update the issue:

```bash
gh issue edit <ISSUE_NUMBER> --body-file <temp_file_with_new_body>
```

Write the new body to a temp file first to handle special characters:

```bash
write ${PROJECT_TMP_DIR}/updated-issue-body.md with the new body content
gh issue edit <ISSUE_NUMBER> --body-file ${PROJECT_TMP_DIR}/updated-issue-body.md
```

If the user also approved label/assignee changes, apply those:

```bash
gh issue edit <ISSUE_NUMBER> --add-label "bug" --add-assignee "@me"
```

Mark Task 9 as `completed`.

### Phase 7: Summary — Task 10

Mark Task 10 as `in_progress`.

Display:

```text
## Issue Review Complete

Issue: #<NUMBER> — <TITLE>
URL: https://github.com/<OWNER_REPO>/issues/<NUMBER>

Applied: <N> fixes
Skipped: <N> findings
Flagged: <N> (manual action needed)

Changes:
- ✅ Added ## Done checklist (4 items)
- ✅ Corrected file reference (src/auth.py → src/auth/validate.ts)
- ⚠️ Flagged: overlaps with #38 — consider linking
```

Mark Task 10 as `completed`.

### Cleanup

Delete all tasks created in this workflow:

```text
For each task ID created in Phase 0, call TaskUpdate(taskId="<ID>", status="deleted").
```
