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
| 8 | Review — Docs | 2 |
| 9 | Review — Spec | 2 |
| 10 | Merge & deduplicate findings | 4, 5, 6, 7, 8, 9 |
| 11 | User selection | 10 |
| 12 | Post comments | 11 |
| 13 | Store comments | 12 |
| 14 | Summary | 13 |

### Dependency Graph

```text
Task 1 (PR Detection)
 ├── Task 2 (Clone & checkout PR) ────┐
 │    Task 3 auto-completes instantly  │
 │    Task 2 unblocks:                │
 │    ├── Task 5 (Review: Quality)    │
 │    ├── Task 6 (Review: Guidelines) │
 │    ├── Task 7 (Review: Security)   │
 │    ├── Task 8 (Review: Docs)       │
 │    └── Task 9 (Review: Spec)       │
 └── Task 4 (Past comments) ──────────┤  (also needs Task 2)
                                       ▼
                            Task 10 (Merge findings)
                                       │
                            Task 11 (User selection)
                                       │
                            Task 12 (Post comments)
                                       │
                            Task 13 (Store comments)
                                       │
                            Task 14 (Summary)
```

Create all 14 tasks using `TaskCreate` NOW, before starting any work.
Then IMMEDIATELY set dependencies using `TaskUpdate` with `addBlockedBy` for each task per the table above.

`TaskCreate` does NOT accept `addBlockedBy` — dependencies MUST be set via `TaskUpdate` after creation.

Example two-step flow:

```text
# Step 1: Create all tasks
TaskCreate(subject="PR Detection", ...)          → Task 1
TaskCreate(subject="Fetch PR diff", ...)          → Task 2
TaskCreate(subject="Fetch AGENTS.md", ...)        → Task 3
TaskCreate(subject="Review — Docs", ...)         → Task 8
TaskCreate(subject="Review — Spec", ...)         → Task 9
...all 14 tasks...

# Step 2: Set dependencies
TaskUpdate(taskId="2", addBlockedBy=["1"])
TaskUpdate(taskId="3", addBlockedBy=["1"])
TaskUpdate(taskId="4", addBlockedBy=["1", "2"])
TaskUpdate(taskId="5", addBlockedBy=["2"])
TaskUpdate(taskId="6", addBlockedBy=["2"])
TaskUpdate(taskId="7", addBlockedBy=["2"])
TaskUpdate(taskId="8", addBlockedBy=["2"])
TaskUpdate(taskId="9", addBlockedBy=["2"])
TaskUpdate(taskId="10", addBlockedBy=["4", "5", "6", "7", "8", "9"])
TaskUpdate(taskId="11", addBlockedBy=["10"])
TaskUpdate(taskId="12", addBlockedBy=["11"])
TaskUpdate(taskId="13", addBlockedBy=["12"])
TaskUpdate(taskId="14", addBlockedBy=["13"])
```

> 🚨 **HARD RULE: NEVER start a task while its `blockedBy` tasks are incomplete.**
> The task system enforces this via `addBlockedBy` — but even if you could bypass it, **DON'T**.
> Posting comments from partial reviewer results is a **CRITICAL violation**.
> ALL 5 reviewers (Tasks 5, 6, 7, 8, 9) MUST complete before merging findings (Task 10).

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
is used separately in Phase 2 for dedup context — do NOT use it for the resolved/unresolved
categorization above. However, it IS used later in this same phase for `[AUTHOR-QUESTION]`
detection (see "Detect questions directed at us" section below).

For the `human` list, categorize each thread:

**Unresolved threads:**

- These are still open on GitHub — but the PR author may have fixed the code without resolving the thread.
- Check the diff from Phase 1a — did the code at `path:line` change?
  - **Code changed:** Review the changed code to verify the fix is correct.
    - Fix looks correct → resolve the thread on GitHub by setting its status to `addressed`
      with reply "Verified fix in code — resolving." in the JSON, then mark as
      "✅ Fixed but not resolved by author — resolved by us". Store verdict to DB as `resolved_fixed`.
    - Fix looks wrong/incomplete → include in findings as "❌ Code changed but fix is incorrect".
      Store verdict to DB as `resolved_bad_fix`.
  - **Code NOT changed:** The finding is genuinely unaddressed.
    - Include in the findings presented to the user in Phase 4.
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

**Store resolution verdicts to DB (MANDATORY):**

After evaluating each resolved thread, persist YOUR verdict to the PR review database.
For each resolved thread that was previously posted by us (matched in the `--user` fetch),
call:

To store the verdict, write the author's response to a temp file first (to avoid shell quoting issues),
then run the CLI:

1. Write `{author_response}` text to `${PROJECT_TMP_DIR}/resolution-response.txt` using the `write` tool
2. Run: `myk-pi-tools pr update-resolution {owner} {repo} {pr_number} --path {path} --line {line} --status {resolution_status} --response-file ${PROJECT_TMP_DIR}/resolution-response.txt`

Where:

- `{resolution_status}` is one of:
  - `resolved_fixed` (code changed, fix verified)
  - `resolved_accepted` (response accepted, no code change needed)
  - `resolved_bad_fix` (code changed but fix is incorrect)
  - `resolved_no_fix` (resolved without code change or valid response)
- `{author_response}` is the PR author's reply text (why they resolved/dismissed)

This persists resolution decisions to the DB so future review cycles can query them.
Resolution decisions are OURS (from this LLM evaluation), not the PR author's click.

**All past comment statuses are included in the combined findings in Phase 4 —
not presented as a separate summary.**

**Detect questions directed at us (MANDATORY):**

After processing our own threads above, scan for questions/comments from others that need
our attention. This covers two sources:

**Source 1 — Review thread questions:**

Scan the all-unresolved JSON from `${PROJECT_TMP_DIR}/all-unresolved/`. For each thread:

- Skip threads authored by us (already handled above)
- Skip threads from bots (Qodo, CodeRabbit, GitHub Actions, dependabot, etc.)
- Check if ANY comment in the thread **explicitly @mentions** the current user (`@{current_github_user}`)

For each matching @mention comment, include it as an `[AUTHOR-QUESTION]` finding **only if**
there is no subsequent comment authored by `{current_github_user}` after that mention.
Compare using the `created_at` field on reply objects (ISO timestamp) — a reply from us
with a `created_at` later than the @mention comment's `created_at` means we already
responded. Do NOT rely on array position alone — always compare `created_at` timestamps.

**Do NOT use loose heuristics** (e.g., "thread is on a file we changed") or thread-level
"no reply anywhere" checks. Only explicit @mentions with no subsequent reply from us qualify —
this prevents false positives from unrelated reviewer conversations and correctly handles
late @mentions in threads where we participated earlier.

**Source 2 — General PR issue comments:**

Fetch PR issue comments (standalone PR comments, not tied to code lines):

```bash
gh api /repos/{owner}/{repo}/issues/{pr_number}/comments --paginate
```

For each comment:

- Skip comments authored by us
- Skip bot comments (Qodo, CodeRabbit, GitHub Actions, dependabot, etc.)
- Check if the comment **explicitly @mentions** the current user (`@{current_github_user}`)
- Check we haven't responded — no comment from us with a later timestamp (`created_at`)
  than the @mention comment. This is the same rule as Source 1: any comment from us
  posted after the @mention counts as a response.

If matched, include it as an `[AUTHOR-QUESTION]` finding.

**Only explicit @mentions qualify.** Do NOT match comments just because they contain a
question mark — this would produce false positives from conversations between other
collaborators. Store the original `comment_id` and `comment_url` (from the API's
`html_url` field) for use in Phase 5 reply formatting.

**For each `[AUTHOR-QUESTION]`, generate a suggested answer:**

Read the relevant code, diff, and surrounding context referenced by the question. Analyze
what the commenter is asking and draft a concise, technically accurate suggested answer.
Store the suggested answer alongside the finding for presentation in Phase 4.

The suggested answer should:

- Reference specific code/lines when applicable
- Be ready to post as-is (the user can approve it directly)
- Be concise — answer the question, don't lecture
- If the answer requires a code change, note that explicitly

Mark Task 4 as `completed`.

### Phase 2: Code Analysis — Tasks 5, 6, 7, 8, 9

Mark Tasks 5, 6, 7, 8, 9 as `in_progress`, then spawn ALL 5 review agents as async subagents
with `taskId` linking each to its task:

Use the actual task IDs returned by `TaskCreate` — do NOT hardcode IDs.

Before spawning reviewers, read the all-unresolved JSON from `${PROJECT_TMP_DIR}/all-unresolved/`
(the output of the second `reviews fetch` call — NOT the `--user` fetch used in Phase 1c)
and format the existing comments as a block of context. Build an `EXISTING_COMMENTS` string
listing each unresolved thread with its file path, line number, author, and body.

> **Note:** Some comment types (e.g., Qodo sticky findings without code refs) may have an empty
> `path` or `null` line number. Use `"(no file)"` as fallback when path is missing and
> `"(no line)"` when line is missing or null.

Also build a `CODE_SUGGESTIONS` instruction block to include in each reviewer's task:

> When a finding has a concrete code fix, include a GitHub suggestion block showing the
> corrected code. Use the exact syntax so the PR author can apply it with one click:
>
> ````text
> ```suggestion
> fixed code here
> ```
> ````
>
> Only include suggestions for specific code replacements — not for architectural concerns,
> missing tests, new files, or design questions where the fix isn't a simple line replacement.
> The suggestion must replace the exact lines referenced by the finding.

Then include `EXISTING_COMMENTS` and `CODE_SUGGESTIONS` in every reviewer's task prompt:

```text
subagent(tasks=[
  {agent: "code-reviewer-quality", task: "Review this PR for code quality. Run: git diff origin/<BASE_BRANCH>...HEAD to see changes. Read any files needed for context.\n\n<review-history>\nMANDATORY — before reviewing any code, run:\nmyk-pi-tools pr get-review-history {owner} {repo} {pr_number}\nReview the output. Do NOT re-raise any finding marked as resolved_accepted, resolved_fixed, or skipped. These have been evaluated and decided in prior review cycles. Only flag a previously resolved finding if the code at that location has materially changed since the resolution.\n</review-history>\n\n<existing-unresolved-comments>\nThe following unresolved review comments already exist on this PR from other reviewers. Do NOT raise findings that duplicate these — skip them. If you find the same issue but with additional context or a different angle, note that it references the existing comment.\n\n<EXISTING_COMMENTS>\n</existing-unresolved-comments>\n\n<code-suggestions>\n<CODE_SUGGESTIONS>\n</code-suggestions>", cwd: "<REVIEW_DIR>", name: "Review Quality", taskId: "<task 5 ID>"},
  {agent: "code-reviewer-guidelines", task: "Review this PR for guideline adherence. Run: git diff origin/<BASE_BRANCH>...HEAD to see changes. Read AGENTS.md and check compliance.\n\n<review-history>\nMANDATORY — before reviewing any code, run:\nmyk-pi-tools pr get-review-history {owner} {repo} {pr_number}\nReview the output. Do NOT re-raise any finding marked as resolved_accepted, resolved_fixed, or skipped. These have been evaluated and decided in prior review cycles. Only flag a previously resolved finding if the code at that location has materially changed since the resolution.\n</review-history>\n\n<existing-unresolved-comments>\nThe following unresolved review comments already exist on this PR from other reviewers. Do NOT raise findings that duplicate these — skip them. If you find the same issue but with additional context or a different angle, note that it references the existing comment.\n\n<EXISTING_COMMENTS>\n</existing-unresolved-comments>\n\n<code-suggestions>\n<CODE_SUGGESTIONS>\n</code-suggestions>", cwd: "<REVIEW_DIR>", name: "Review Guidelines", taskId: "<task 6 ID>"},
  {agent: "code-reviewer-security", task: "Review this PR for bugs and security. Run: git diff origin/<BASE_BRANCH>...HEAD to see changes. Trace data flow through changed code.\n\n<review-history>\nMANDATORY — before reviewing any code, run:\nmyk-pi-tools pr get-review-history {owner} {repo} {pr_number}\nReview the output. Do NOT re-raise any finding marked as resolved_accepted, resolved_fixed, or skipped. These have been evaluated and decided in prior review cycles. Only flag a previously resolved finding if the code at that location has materially changed since the resolution.\n</review-history>\n\n<existing-unresolved-comments>\nThe following unresolved review comments already exist on this PR from other reviewers. Do NOT raise findings that duplicate these — skip them. If you find the same issue but with additional context or a different angle, note that it references the existing comment.\n\n<EXISTING_COMMENTS>\n</existing-unresolved-comments>\n\n<code-suggestions>\n<CODE_SUGGESTIONS>\n</code-suggestions>", cwd: "<REVIEW_DIR>", name: "Review Security", taskId: "<task 7 ID>"},
  {agent: "code-reviewer-docs", task: "Review this PR for documentation quality. Run: git diff origin/<BASE_BRANCH>...HEAD to see changes. Check all docs for completeness and accuracy.\n\n<review-history>\nMANDATORY — before reviewing any code, run:\nmyk-pi-tools pr get-review-history {owner} {repo} {pr_number}\nReview the output. Do NOT re-raise any finding marked as resolved_accepted, resolved_fixed, or skipped. These have been evaluated and decided in prior review cycles. Only flag a previously resolved finding if the code at that location has materially changed since the resolution.\n</review-history>\n\n<existing-unresolved-comments>\nThe following unresolved review comments already exist on this PR from other reviewers. Do NOT raise findings that duplicate these — skip them. If you find the same issue but with additional context or a different angle, note that it references the existing comment.\n\n<EXISTING_COMMENTS>\n</existing-unresolved-comments>\n\n<code-suggestions>\n<CODE_SUGGESTIONS>\n</code-suggestions>", cwd: "<REVIEW_DIR>", name: "Review Docs", taskId: "<task 8 ID>"},
  {agent: "code-reviewer-spec", task: "Review this PR for spec compliance. Run: git diff origin/<BASE_BRANCH>...HEAD to see changes. Check PR description claims vs diff, issue deliverables vs diff, and scope creep.\n\n<review-history>\nMANDATORY — before reviewing any code, run:\nmyk-pi-tools pr get-review-history {owner} {repo} {pr_number}\nReview the output. Do NOT re-raise any finding marked as resolved_accepted, resolved_fixed, or skipped. These have been evaluated and decided in prior review cycles. Only flag a previously resolved finding if the code at that location has materially changed since the resolution.\n</review-history>\n\n<existing-unresolved-comments>\nThe following unresolved review comments already exist on this PR from other reviewers. Do NOT raise findings that duplicate these — skip them. If you find the same issue but with additional context or a different angle, note that it references the existing comment.\n\n<EXISTING_COMMENTS>\n</existing-unresolved-comments>\n\n<code-suggestions>\n<CODE_SUGGESTIONS>\n</code-suggestions>", cwd: "<REVIEW_DIR>", name: "Review Spec", taskId: "<task 9 ID>"},
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

**After spawning, verify the response confirms all 5 agents were spawned.**
If any spawn fails, STOP and report the error — do NOT continue waiting.

**After spawning, your turn is DONE.** Do NOT poll, sleep, call TaskOutput,
or check status. Results arrive automatically as follow-up messages.
When each reviewer finishes, its task is auto-completed via `taskId`.
Task 10 (Merge findings) auto-unblocks when all 5 reviewer tasks complete.

### Phase 3: Merge & Deduplicate Findings — Task 10

Mark Task 10 as `in_progress`.

Merge and deduplicate the findings from all 5 reviewers AND the past review comment analysis from Task 4 into a single combined findings list.

Reviewers were already instructed in Phase 2 to skip findings that duplicate existing
unresolved PR comments. However, verify that no duplicates slipped through by comparing
the merged findings against the all-unresolved list from `${PROJECT_TMP_DIR}/all-unresolved/`.
Drop any **`[NEW]`** finding (from Phase 2 reviewers) that raises the same issue as an
existing unresolved comment.

> **IMPORTANT:** `[PREV-UNRESOLVED]`, `[PREV-BAD-FIX]`, and `[PREV-NO-FIX]` items from
> Task 4 are NEVER dropped by dedup. These represent the current user's own prior review
> comments that naturally appear in the all-unresolved list — removing them would lose
> tracking of unresolved prior findings. Dedup applies ONLY to `[NEW]` findings.

**Previously skipped findings dedup:** Also check the PR review database for findings
the user previously skipped on this same PR. Run:

```bash
myk-pi-tools pr get-skipped-comments {owner} {repo} {pr_number}
```

This returns a JSON array of previously skipped comments with `path`, `line`, `body`,
`severity`, `skip_reason`, and `head_sha`.

For each `[NEW]` finding, compare against the skipped list using path + body similarity
(same file and similar description = match). Matched findings are auto-skipped with
`"Auto-skipped (previously dismissed): <skip_reason>"`. The user still sees them in the
Phase 4 table and can override by selecting them explicitly.

Mark Task 10 as `completed`.

### Phase 4: User Selection — Task 11

Mark Task 11 as `in_progress`.

Present ALL findings to user in one combined list, grouped by severity (CRITICAL, WARNING, SUGGESTION).
This includes:

1. **Past review findings** from Phase 1c (unresolved, incorrectly resolved, or bad fixes)
2. **New code review findings** from Phase 2

Each finding shows its source:

- `[PREV-UNRESOLVED]` — unresolved from previous review cycle
- `[PREV-BAD-FIX]` — resolved but fix is incorrect
- `[PREV-NO-FIX]` — resolved without code change or valid response
- `[AUTHOR-QUESTION]` — question/comment from someone on the PR directed at us
- `[NEW]` — new finding from current code analysis

**Auto-post previous findings:** `[PREV-UNRESOLVED]`, `[PREV-BAD-FIX]`, and `[PREV-NO-FIX]`
findings are **automatically included** in the post list — they are the user's own prior
comments that remain unaddressed and MUST be re-raised. Do NOT ask the user to select these.
Show them in the list marked as "(auto-post)" so the user knows they'll be re-raised.

**Author questions require user approval:** `[AUTHOR-QUESTION]` findings are NOT auto-posted.
They require user review because the AI-generated answer may need editing or the user may
choose not to respond. Author questions are presented with approve/edit/skip options (see below).

**Author question presentation:**

For each `[AUTHOR-QUESTION]` finding, display:

1. The original question/comment (who asked, where, full text)
2. The AI-generated **suggested answer** from Phase 1c
3. An action prompt for the user:
   - **approve** — post the suggested answer as-is
   - **edit** — user provides a revised answer (print prompt as regular text, NOT `ask_user`)
   - **skip** — don't reply to this question

Collect user decisions for all author questions before proceeding. Approved/edited answers
are included in the Phase 5 post step. Skipped questions are excluded from posting.

**Numbering:** Display three separate numbered sections:

1. Previous findings (P1, P2, ...) marked "(auto-post)"
2. Author questions (Q1, Q2, ...) with suggested answers and action prompts
3. New findings (1, 2, ...) for user selection

This avoids ambiguity — user selections for new findings always refer to the `[NEW]` numbering.

**User selects from `[NEW]` findings only:**

- 'all' = Post all new findings (previous findings are always auto-posted regardless)
- 'none' = Skip posting new findings (previous findings are still auto-posted)
- Specific numbers = Post only those new findings (numbers refer to the `[NEW]` list)

If there are ZERO `[NEW]` findings AND zero `[AUTHOR-QUESTION]` findings, skip user
selection entirely — auto-post the previous findings and proceed directly to Phase 5
(the auto-post path still generates the comments JSON and posts them — see Phase 5).

If there are ZERO `[NEW]` findings but `[AUTHOR-QUESTION]` findings exist, skip new
finding selection but still present author questions with suggested answers for
user approval/edit/skip.

🚨 **Skip reason collection (MANDATORY — NEVER SKIP THIS STEP):**

**HARD RULE: If the user skipped ANY finding (said 'no', selected specific numbers
that exclude some findings, or said 'none'), you MUST ask for skip reasons
BEFORE proceeding to Phase 5. Do NOT continue the workflow without collecting
skip reasons. Skipping this step is a HARD VIOLATION.**

After the user selects which findings to post, compute the skipped set (total `[NEW]`
findings minus user-selected findings). If the skipped set is non-empty:

1. Ask the user for skip reasons as a **normal chat message** (do NOT use `ask_user` — skip
   reasons are often multiline and `ask_user` only supports single-line input).
   Print this prompt as regular text:

   ```text
   You skipped findings 2, 4, 5. Why?
   Give one reason for all, or per-finding (e.g., "2: not relevant, 4 and 5: style only")
   ```

   **STOP your turn after printing this prompt.** Do NOT continue the workflow.
   The user will respond with their skip reasons in their next message.
   Resume the workflow (step 2 below) only after receiving the user's response.

2. AI refines each reason — make it concise, technical, and useful for future reference:
   - User: "don't care" → "Style-only finding — no functional impact"
   - User: "we do it this way" → "Intentional pattern — project convention"
   - User: "already covered" → "Already validated by existing test coverage"

3. AI classifies each refined reason (no user interaction):
   - **Finding-specific** — references specific code, line, variable, or one-off context.
     Store in DB only (same-PR dedup).
   - **Generalizable** — references a project-wide pattern, convention, or category of
     findings (e.g., "don't flag snake_case", "print() is intentional in CLI modules").
     Store in DB AND append to `.pi/data/review-guidelines.md`.

4. For generalizable reasons, append one line per finding to `.pi/data/review-guidelines.md`
   (create the file if it doesn't exist). Format:

   ```markdown
   - Do not flag <finding type> — <refined reason>
   ```

   This file is read by all 5 reviewer agents before reviewing, so the same class of
   finding won't be raised again on future PRs in this repo.

Mark Task 11 as `completed`.

### Phase 5: Post Comments — Task 12

Mark Task 12 as `in_progress`.

**Step 1: Post `[NEW]` and `[PREV-*]` findings as new review comments:**

Write JSON to temp file for all `[NEW]` (user-selected) and `[PREV-*]` (auto-posted)
findings. If only `[PREV-*]` findings exist (zero `[NEW]` findings, selection was skipped),
still generate the JSON for the auto-posted items:

Use the `owner`, `repo`, `pr_number`, and `head_sha` from Phase 0 or Phase 1a metadata:

```bash
myk-pi-tools pr post-comment {owner}/{repo} {pr_number} {head_sha} ${PROJECT_TMP_DIR}/pr-review-comments.json
```

**Step 2: Reply to `[AUTHOR-QUESTION]` findings (approved/edited only):**

For each approved or edited author question, reply using the appropriate method based on
the question's source:

**Review thread questions** (have a `thread_id`):

Write a JSON file with the reply and use `reviews post` which correctly replies in the
existing thread via GraphQL `addPullRequestReviewThreadReply`:

```bash
myk-pi-tools reviews post ${PROJECT_TMP_DIR}/author-question-replies.json
```

The JSON file MUST use the `reviews post` format with the `"human"` category key:

```json
{
  "metadata": {"owner": "{owner}", "repo": "{repo}", "pr_number": "{pr_number}"},
  "human": [
    {"thread_id": "{thread_id}", "status": "not_addressed", "reply": "{approved_answer}"}
  ]
}
```

**IMPORTANT:** Use `status: "not_addressed"` (NOT `"addressed"`). These are threads owned
by someone else — `"addressed"` would auto-resolve their thread, which is inappropriate.
`"not_addressed"` posts the reply but leaves the thread open for the original author to resolve.

**General PR issue comments** (no `thread_id`, have `comment_id`):

Write the reply body to a temp file to avoid shell injection, then post via the GitHub API
with a quoted reference to the original question:

Write the raw markdown reply to a plain text file first, then use `jq` to safely
encode it as valid JSON (handles quotes, backslashes, newlines):

```bash
# 1. Build the reply body as raw markdown (not JSON)
cat > ${PROJECT_TMP_DIR}/author-reply-body.md << 'REPLY_EOF'
> @{commenter} [asked]({comment_url}):
> {original_question_first_line}

{approved_answer}
REPLY_EOF

# 2. Encode as valid JSON using jq (handles all special characters safely)
jq -Rs '{body: .}' < ${PROJECT_TMP_DIR}/author-reply-body.md > ${PROJECT_TMP_DIR}/author-reply-body.json

# 3. Post via gh api
gh api /repos/{owner}/{repo}/issues/{pr_number}/comments --input ${PROJECT_TMP_DIR}/author-reply-body.json
```

NEVER build JSON by string interpolation — always write the reply body as raw text
and use `jq -Rs '{body: .}'` to produce valid JSON. This prevents both shell injection
and JSON encoding errors from quotes, backslashes, or newlines in the answer.

Mark Task 12 as `completed`.

### Phase 5b: Store Posted Comments — Task 13

Mark Task 13 as `in_progress`.

After posting comments, store ALL findings (posted AND skipped) in the PR review database
for future cycle tracking and same-PR dedup of skipped findings.

1. Write a JSON file with ALL findings:

```bash
cat > ${PROJECT_TMP_DIR}/pr-review-store.json << 'EOF'
{
  "metadata": {"owner": "{owner}", "repo": "{repo}", "pr_number": {pr_number}, "head_sha": "{head_sha}", "author": "{author}"},
  "comments": [
    {
      "thread_id": null,
      "comment_id": null,
      "path": "file.py",
      "line": 42,
      "body": "Comment body as posted",
      "severity": "WARNING",
      "posted_at": "<ISO timestamp>",
      "status": "posted"
    },
    {
      "thread_id": null,
      "comment_id": null,
      "path": "file.py",
      "line": 99,
      "body": "Finding description that was skipped",
      "severity": "SUGGESTION",
      "posted_at": null,
      "status": "skipped",
      "skip_reason": "Refined skip reason from Phase 4"
    },
    {
      "thread_id": "thread_abc123",
      "comment_id": 456,
      "path": "utils.py",
      "line": 10,
      "body": "Author question: should this use sleep=0?",
      "severity": "QUESTION",
      "posted_at": "<ISO timestamp>",
      "status": "posted",
      "source": "author-question"
    },
    {
      "thread_id": null,
      "comment_id": 789,
      "path": null,
      "line": null,
      "body": "General PR question that was skipped",
      "severity": "QUESTION",
      "posted_at": null,
      "status": "skipped",
      "skip_reason": "User chose not to respond",
      "source": "author-question"
    }
  ]
}
EOF
```

Include `[AUTHOR-QUESTION]` findings with `status: "posted"` (approved/edited and posted)
or `status: "skipped"` (user chose to skip). Use `"posted"` (not `"answered"`) because
the `myk-pi-tools pr store-pr-review` CLI only accepts `posted` or `skipped` as valid
statuses.

**Note on `source` field:** The `source: "author-question"` field in the JSON example is
for LLM context only — the CLI's DB schema does not have a `source` column and will
ignore it. Future review cycles detect already-answered questions by matching
`path`/`line`/`body` similarity against stored comments, same as other finding types.

Use `{author}` from Phase 0 (`myk-pi-tools pr info` returns `author` field).

1. Store to database:

```bash
myk-pi-tools pr store-pr-review ${PROJECT_TMP_DIR}/pr-review-store.json
```

**This step is MANDATORY — never skip it.** The database is used by future `/pr-review`
runs to track which comments were posted, verify they were addressed, and auto-skip
previously dismissed findings.

Mark Task 13 as `completed`.

### Phase 6: Summary — Task 14

Mark Task 14 as `in_progress`.

Display final summary with counts and links. Include:

- New findings posted / skipped counts
- Previous findings re-raised count
- Author questions answered / skipped counts
- Total comments posted
- PR link

Mark Task 14 as `completed`.

### Cleanup

After the review is complete (all phases done):

1. Delete all tasks: `TaskUpdate(taskId="N", status="deleted")` for every task created in this workflow
2. Delegate to `git-expert`: remove the clone directory `REVIEW_DIR`
