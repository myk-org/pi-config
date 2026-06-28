---
description: Review a GitHub PR and post inline comments on selected findings
argument-hint: "[PR number or URL]"
---

## Raw Arguments

```text
$ARGUMENTS
```

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

## Task Plan

Before starting any work, create ALL tasks upfront using `TaskCreate`, then set their dependencies
using `TaskUpdate` with `addBlockedBy`. The task system enforces execution order — blocked tasks cannot start.

### Task List

| Task | Title | blockedBy |
|------|-------|-----------|
| 1 | PR Detection | — |
| 2 | Clone & checkout PR | 1 |
| 3 | (auto-complete — reviewers read from clone) | 1 |
| 4 | Check past review comments | 1, 2 |
| 5 | Review — Code Quality | 2 |
| 6 | Review — Guidelines | 2 |
| 7 | Review — Security | 2 |
| 8 | Merge & deduplicate findings | 4, 5, 6, 7 |
| 9 | User selection | 8 |
| 10 | Post comments | 9 |
| 11 | Store comments | 10 |
| 12 | Summary | 11 |

### Dependency Graph

```text
Task 1 (PR Detection)
 ├── Task 2 (Clone & checkout PR) ────┐
 │    Task 3 auto-completes instantly  │
 │    Task 2 unblocks:                │
 │    ├── Task 5 (Review: Quality)    │
 │    ├── Task 6 (Review: Guidelines) │
 │    └── Task 7 (Review: Security)   │
 └── Task 4 (Past comments) ──────────┤  (also needs Task 2)
                                       ▼
                            Task 8 (Merge findings)
                                       │
                            Task 9 (User selection)
                                       │
                            Task 10 (Post comments)
                                       │
                            Task 11 (Store comments)
                                       │
                            Task 12 (Summary)
```

Create all 12 tasks using `TaskCreate` NOW, before starting any work.
Then IMMEDIATELY set dependencies using `TaskUpdate` with `addBlockedBy` for each task per the table above.

`TaskCreate` does NOT accept `addBlockedBy` — dependencies MUST be set via `TaskUpdate` after creation.

Example two-step flow:

```text
# Step 1: Create all tasks
TaskCreate(subject="PR Detection", ...)          → Task 1
TaskCreate(subject="Fetch PR diff", ...)          → Task 2
TaskCreate(subject="Fetch AGENTS.md", ...)        → Task 3
...all 12 tasks...

# Step 2: Set dependencies
TaskUpdate(taskId="2", addBlockedBy=["1"])
TaskUpdate(taskId="3", addBlockedBy=["1"])
TaskUpdate(taskId="4", addBlockedBy=["1", "2"])
TaskUpdate(taskId="5", addBlockedBy=["2"])
TaskUpdate(taskId="6", addBlockedBy=["2"])
TaskUpdate(taskId="7", addBlockedBy=["2"])
TaskUpdate(taskId="8", addBlockedBy=["4", "5", "6", "7"])
TaskUpdate(taskId="9", addBlockedBy=["8"])
TaskUpdate(taskId="10", addBlockedBy=["9"])
TaskUpdate(taskId="11", addBlockedBy=["10"])
TaskUpdate(taskId="12", addBlockedBy=["11"])
```

> 🚨 **HARD RULE: NEVER start a task while its `blockedBy` tasks are incomplete.**
> The task system enforces this via `addBlockedBy` — but even if you could bypass it, **DON'T**.
> Posting comments from partial reviewer results is a **CRITICAL violation**.
> ALL 3 reviewers (Tasks 5, 6, 7) MUST complete before merging findings (Task 8).

## Workflow

**PROJECT_TMP_DIR** is the project-scoped temp directory from `getProjectTmpDir(cwd)`.
All temp files for this workflow go there —

### Phase 0: PR Detection — Task 1

Mark Task 1 as `in_progress`.

If the raw arguments are empty:

1. If the raw arguments do NOT contain a PR number or URL, detect from current branch:

   ```bash
   myk-pi-tools pr info $(gh pr view --json number --jq '.number')
   ```

2. Fetch PR metadata using the CLI:

   ```bash
   myk-pi-tools pr info <cleaned_arguments>
   ```

   This returns JSON with all needed fields: `owner`, `repo`, `pr_number`, `author`,
   `head_sha`, `base_ref`, `title`, `state`, `labels`, `assignees`, `is_fork`, `head_repo`, `body`.

3. Extract and store all fields from the JSON output — these are used by Phase 1c and Phase 5.

If the raw arguments contain a PR number or URL:

1. Fetch PR metadata using the CLI:

   ```bash
   myk-pi-tools pr info <cleaned_arguments>
   ```

   This returns JSON with all needed fields: `owner`, `repo`, `pr_number`, `author`,
   `head_sha`, `base_ref`, `title`, `state`, `labels`, `assignees`, `is_fork`, `head_repo`, `body`.

2. Extract and store all fields from the JSON output — these are used by Phase 1c and Phase 5.

Mark Task 1 as `completed`.

Tasks 2 and 3 are independent — execute them in parallel.
Task 4 depends on Task 2 (needs the diff data) and will start after Task 2 completes.

### Phase 1a: Clone & Checkout PR — Task 2

Mark Task 2 as `in_progress`.

Clone the target repo and checkout the PR branch. This gives reviewers full repo access
instead of passing a truncated diff in the prompt.

**Delegate to `git-expert`** with this task:

> Clone `https://github.com/{owner}/{repo}.git` (depth 50) to `{PROJECT_TMP_DIR}/pr-review-{owner}-{repo}-{pr_number}`.
> Then run: gh pr checkout {pr_number}
> Then get the base branch: gh pr view {pr_number} --json baseRefName --jq '.baseRefName'
> Then fetch the base: git fetch origin {base_branch} --depth 50
> Report REVIEW_DIR and BASE_BRANCH.

Store:

- `REVIEW_DIR` — the clone path (used as `cwd` for reviewers)
- `BASE_BRANCH` — the PR's target branch (used for `git diff`)

If cloning or checkout fails, fall back to `myk-pi-tools pr diff` (original behavior).

Mark Task 2 as `completed`.

### Phase 1b: (Removed — reviewers read AGENTS.md from clone)

Task 3 is no longer needed — reviewers have full repo access via the clone
and read AGENTS.md independently per their agent instructions.
Mark Task 3 as `completed` immediately.

### Phase 1c: Check Past Review Comments — Task 4

Mark Task 4 as `in_progress`.

Fetch ALL human review threads (resolved + unresolved) from the PR:

Use the `owner`, `repo`, and `pr_number` from Phase 0 to construct the PR URL:

```bash
myk-pi-tools reviews fetch --output-dir ${PROJECT_TMP_DIR} --user {current_github_user} --include-resolved https://github.com/{owner}/{repo}/pull/{pr_number}
```

Where `{current_github_user}` is obtained from:

```bash
gh api user --jq '.login'
```

Also fetch ALL unresolved review threads from all authors (for dedup in Phase 2):

```bash
myk-pi-tools reviews fetch --output-dir ${PROJECT_TMP_DIR}/all-unresolved https://github.com/{owner}/{repo}/pull/{pr_number}
```

This second call omits `--user` and `--include-resolved`, so it returns only currently-unresolved
threads from every author (humans, Qodo, CodeRabbit, etc.). The output is passed to
reviewers in Phase 2 so they can avoid raising duplicate findings.

Parse the JSON output from the `--user` fetch (`${PROJECT_TMP_DIR}`). This file is used
for resolved/unresolved categorization below. The all-unresolved fetch (`${PROJECT_TMP_DIR}/all-unresolved`)
is used separately in Phase 2 for dedup context — do NOT use it here.

For the `human` list, categorize each thread:

**Unresolved threads:**

- These are still open — the PR author hasn't addressed them yet.
- Include them in the findings presented to the user in Phase 4.
- Mark as "⚠️ UNRESOLVED from previous review"

**Resolved threads:**

- Read the full thread including ALL replies from the PR author.
- Check the diff from Phase 1a — did the code at `path:line` change?
  - **Code changed:** Review the changed code to verify the fix is correct. Don't trust blindly.
    - Fix looks correct → mark as "✅ Resolved — fix verified"
    - Fix looks wrong/incomplete → include in findings as "❌ Resolved but fix is incorrect"
  - **Code NOT changed:** Read the PR author's response/reply.
    - Valid response (by design, wrong assumption, clarification) → mark as "✅ Resolved — response accepted"
    - Invalid/missing response → include in findings as "❌ Resolved without code change or valid response"

**All past comment statuses are included in the combined findings in Phase 4 —
not presented as a separate summary.**

Mark Task 4 as `completed`.

### Phase 2: Code Analysis — Tasks 5, 6, 7

Mark Tasks 5, 6, 7 as `in_progress`, then spawn ALL 3 review agents as async subagents
with `taskId` linking each to its task:

Use the actual task IDs returned by `TaskCreate` — do NOT hardcode IDs.

Before spawning reviewers, read the all-unresolved JSON from `${PROJECT_TMP_DIR}/all-unresolved/`
(the output of the second `reviews fetch` call — NOT the `--user` fetch used in Phase 1c)
and format the existing comments as a block of context. Build an `EXISTING_COMMENTS` string
listing each unresolved thread with its file path, line number, author, and body.

> **Note:** Some comment types (e.g., Qodo sticky findings without code refs) may have an empty
> `path` or `null` line number. Use `"(no file)"` as fallback when path is missing and
> `"(no line)"` when line is missing or null.

Also build a `PR_DESCRIPTION_VERIFICATION` block to include in each reviewer's task. Use this
exact text:

> MANDATORY: Verify the PR description matches the actual diff.
>
> 1. Run: `gh pr view {pr_number} --repo {owner}/{repo} --json body,title --jq '{title: .title, body: .body}'`
>    to read the PR description.
> 2. Compare every claim in the description (files changed, classes added,
>    methods implemented, tests written) against the actual git diff.
>    Report [CRITICAL] for any file, class, method, or test mentioned in
>    the description that does NOT exist in the diff.
> 3. If the PR references an issue (Closes #N, Fixes #N), run:
>    `gh issue view N --repo {owner}/{repo} --json body --jq .body`
>    and verify the issue deliverables are implemented in the diff.
>    Report [CRITICAL] for unimplemented deliverables.
> 4. Do NOT report [CRITICAL] for vague/aspirational description text —
>    only flag specific concrete claims (file names, class names, function
>    names, test names, feature descriptions) that are verifiably absent
>    from the diff.

Then include both `EXISTING_COMMENTS` and `PR_DESCRIPTION_VERIFICATION` in every reviewer's task prompt:

```text
subagent(tasks=[
  {agent: "code-reviewer-quality", task: "Review this PR for code quality. Run: git diff origin/<BASE_BRANCH>...HEAD to see changes. Read any files needed for context.\n\n<existing-unresolved-comments>\nThe following unresolved review comments already exist on this PR from other reviewers. Do NOT raise findings that duplicate these — skip them. If you find the same issue but with additional context or a different angle, note that it references the existing comment.\n\n<EXISTING_COMMENTS>\n</existing-unresolved-comments>\n\n<pr-description-verification>\n<PR_DESCRIPTION_VERIFICATION>\n</pr-description-verification>", cwd: "<REVIEW_DIR>", name: "Review Quality", taskId: "<task 5 ID>"},
  {agent: "code-reviewer-guidelines", task: "Review this PR for guideline adherence. Run: git diff origin/<BASE_BRANCH>...HEAD to see changes. Read AGENTS.md and check compliance.\n\n<existing-unresolved-comments>\nThe following unresolved review comments already exist on this PR from other reviewers. Do NOT raise findings that duplicate these — skip them. If you find the same issue but with additional context or a different angle, note that it references the existing comment.\n\n<EXISTING_COMMENTS>\n</existing-unresolved-comments>\n\n<pr-description-verification>\n<PR_DESCRIPTION_VERIFICATION>\n</pr-description-verification>", cwd: "<REVIEW_DIR>", name: "Review Guidelines", taskId: "<task 6 ID>"},
  {agent: "code-reviewer-security", task: "Review this PR for bugs and security. Run: git diff origin/<BASE_BRANCH>...HEAD to see changes. Trace data flow through changed code.\n\n<existing-unresolved-comments>\nThe following unresolved review comments already exist on this PR from other reviewers. Do NOT raise findings that duplicate these — skip them. If you find the same issue but with additional context or a different angle, note that it references the existing comment.\n\n<EXISTING_COMMENTS>\n</existing-unresolved-comments>\n\n<pr-description-verification>\n<PR_DESCRIPTION_VERIFICATION>\n</pr-description-verification>", cwd: "<REVIEW_DIR>", name: "Review Security", taskId: "<task 7 ID>"},
])
```

Where `<EXISTING_COMMENTS>` is replaced with the formatted unresolved comments from
`${PROJECT_TMP_DIR}/all-unresolved/`. If no unresolved comments exist, replace with
"No existing unresolved comments found."

Each reviewer runs in the cloned repo directory (`REVIEW_DIR`) and has full access to:

- All source files via `read` tool
- The PR diff via `git diff origin/<BASE_BRANCH>...HEAD`
- Project guidelines (AGENTS.md/CLAUDE.md) — read independently per agent instructions
- File history, imports, tests — anything in the repo

Each agent should analyze for security, bugs, error handling, and performance issues
and return their findings as prose.

**After spawning, verify the response confirms all 3 agents were spawned.**
If any spawn fails, STOP and report the error — do NOT continue waiting.

**After spawning, your turn is DONE.** Do NOT poll, sleep, call TaskOutput,
or check status. Results arrive automatically as follow-up messages.
When each reviewer finishes, its task is auto-completed via `taskId`.
Task 8 (Merge findings) auto-unblocks when all 3 reviewer tasks complete.

### Phase 3: Merge & Deduplicate Findings — Task 8

Mark Task 8 as `in_progress`.

Merge and deduplicate the findings from all 3 reviewers AND the past review comment analysis from Task 4 into a single combined findings list.

Reviewers were already instructed in Phase 2 to skip findings that duplicate existing
unresolved PR comments. However, verify that no duplicates slipped through by comparing
the merged findings against the all-unresolved list from `${PROJECT_TMP_DIR}/all-unresolved/`.
Drop any **`[NEW]`** finding (from Phase 2 reviewers) that raises the same issue as an
existing unresolved comment.

> **IMPORTANT:** `[PREV-UNRESOLVED]`, `[PREV-BAD-FIX]`, and `[PREV-NO-FIX]` items from
> Task 4 are NEVER dropped by dedup. These represent the current user's own prior review
> comments that naturally appear in the all-unresolved list — removing them would lose
> tracking of unresolved prior findings. Dedup applies ONLY to `[NEW]` findings.

Mark Task 8 as `completed`.

### Phase 4: User Selection — Task 9

Mark Task 9 as `in_progress`.

Present ALL findings to user in one combined list, grouped by severity (CRITICAL, WARNING, SUGGESTION).
This includes:

1. **Past review findings** from Phase 1c (unresolved, incorrectly resolved, or bad fixes)
2. **New code review findings** from Phase 2

Each finding shows its source:

- `[PREV-UNRESOLVED]` — unresolved from previous review cycle
- `[PREV-BAD-FIX]` — resolved but fix is incorrect
- `[PREV-NO-FIX]` — resolved without code change or valid response
- `[NEW]` — new finding from current code analysis

**Auto-post previous findings:** `[PREV-UNRESOLVED]`, `[PREV-BAD-FIX]`, and `[PREV-NO-FIX]`
findings are **automatically included** in the post list — they are the user's own prior
comments that remain unaddressed and MUST be re-raised. Do NOT ask the user to select these.
Show them in the list marked as "(auto-post)" so the user knows they'll be re-raised.

**User selects from `[NEW]` findings only:**

- 'all' = Post all new findings
- 'none' = Skip posting new findings (previous findings are still auto-posted)
- Specific numbers = Post only those new findings

If there are ZERO `[NEW]` findings, skip user selection entirely — just auto-post the
previous findings and proceed to Phase 5

Mark Task 9 as `completed`.

### Phase 5: Post Comments — Task 10

Mark Task 10 as `in_progress`.

If user selected findings, write JSON to temp file:

Use the `owner`, `repo`, `pr_number`, and `head_sha` from Phase 0 or Phase 1a metadata:

```bash
myk-pi-tools pr post-comment {owner}/{repo} {pr_number} {head_sha} ${PROJECT_TMP_DIR}/pr-review-comments.json
```

Mark Task 10 as `completed`.

### Phase 5b: Store Posted Comments — Task 11

Mark Task 11 as `in_progress`.

After posting comments, store them in the PR review database for future cycle tracking:

1. Write a JSON file with the posted comments:

```bash
cat > ${PROJECT_TMP_DIR}/pr-review-store.json << 'EOF'
{
  "metadata": {"owner": "{owner}", "repo": "{repo}", "pr_number": {pr_number}, "head_sha": "{head_sha}"},
  "comments": [
    {
      "thread_id": null,
      "comment_id": null,
      "path": "file.py",
      "line": 42,
      "body": "Comment body as posted",
      "severity": "WARNING",
      "posted_at": "<ISO timestamp>"
    }
  ]
}
EOF
```

1. Store to database:

```bash
myk-pi-tools pr store-pr-review ${PROJECT_TMP_DIR}/pr-review-store.json
```

**This step is MANDATORY — never skip it.** The database is used by future `/pr-review`
runs to track which comments were posted and verify they were addressed.

Mark Task 11 as `completed`.

### Phase 6: Summary — Task 12

Mark Task 12 as `in_progress`.

Display final summary with counts and links.

Mark Task 12 as `completed`.

### Cleanup

After the review is complete (all phases done):

1. Delete all tasks: `TaskUpdate(taskId="N", status="deleted")` for every task created in this workflow
2. Delegate to `git-expert`: remove the clone directory `REVIEW_DIR`
