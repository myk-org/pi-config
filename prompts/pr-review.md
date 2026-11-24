---
description: Review a GitHub PR and post inline comments on selected findings
argument-hint: "[PR number or URL]"
---

## Raw Arguments

```text
$ARGUMENTS
```

# GitHub PR Review Command

Reviews a GitHub PR and posts inline review comments on selected findings.

## Prerequisites & Usage

- **Check `uv`:** `uv --version` (if missing, install from <https://docs.astral.sh/uv/getting-started/installation/>).
- `/pr-review` — current branch PR | `/pr-review 123` — PR #123 | `/pr-review <PR URL>`
- Phase 4 offers `Post all`, `Skip all`, or `Decide one by one` (~1 turn per finding, +1 on skip reason/early stop — avoid one-by-one on large finding lists).

## Task Plan

Create all 14 tasks upfront via `TaskCreate`, then immediately wire `addBlockedBy` via `TaskUpdate` per the table below (`TaskCreate` does not accept `addBlockedBy`):

| Task | Title | blockedBy |
| --- | --- | --- |
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

> 🚨 **HARD RULE: NEVER start a task while its `blockedBy` tasks are incomplete.** ALL 5 reviewers (Tasks 5–9) MUST complete before merging findings (Task 10).

## Workflow

**`PROJECT_TMP_DIR`** is `getProjectTmpDir(cwd)` — all temp files go there.

### Phase 0: PR Detection — Task 1

Let `<TARGET>` be `$(gh pr view --json number --jq '.number')` when raw arguments are empty, otherwise `<cleaned_arguments>`:

1. Fetch PR metadata:

   ```bash
   uvx myk-pi-tools@latest pr info <TARGET>
   ```

   Store all returned fields: `owner`, `repo`, `pr_number`, `author`, `head_sha`, `base_ref`, `title`, `state`, `labels`, `assignees`, `is_fork`, `head_repo`, `body`.

2. Fetch latest commit timestamp (always query `{owner}/{repo}` — resolves fork PRs via `refs/pull/*/head`):

   ```bash
   gh api /repos/{owner}/{repo}/commits/{head_sha} --jq '.commit.committer.date'
   ```

   Store as `LATEST_COMMIT_DATE` (ISO 8601).

3. Run Tasks 2 and 3 in parallel; Task 4 starts after Task 2 completes.

### Phase 1a: Clone & Checkout PR — Task 2

Delegate to `git-expert`:

> Clone `https://github.com/{owner}/{repo}.git` (depth 50) to `{PROJECT_TMP_DIR}/pr-review-{owner}-{repo}-{pr_number}`.
> Run `gh pr checkout {pr_number}`, get base branch via `gh pr view {pr_number} --json baseRefName --jq '.baseRefName'`, run `git fetch origin {base_branch} --depth 50`,
> and report `REVIEW_DIR` and `BASE_BRANCH`.

If clone/checkout fails, fall back to `uvx myk-pi-tools@latest pr diff`.

### Phase 1b: Task 3

Auto-complete Task 3 immediately — reviewers read `AGENTS.md` directly from `REVIEW_DIR`.

### Phase 1c: Check Past Review Comments — Task 4

1. Get `{current_github_user}` via `gh api user --jq '.login'`, then run 3 fetches:

   ```bash
   # 1) Our own threads (resolved + unresolved) — used for resolved/unresolved categorization below
   uvx myk-pi-tools@latest reviews fetch --output-dir ${PROJECT_TMP_DIR} --user {current_github_user} --include-resolved https://github.com/{owner}/{repo}/pull/{pr_number}
   # 2) All unresolved threads (all authors) — Phase 2 dedup & [AUTHOR-QUESTION] detection
   uvx myk-pi-tools@latest reviews fetch --output-dir ${PROJECT_TMP_DIR}/all-unresolved https://github.com/{owner}/{repo}/pull/{pr_number}
   # 3) All threads (resolved + unresolved, all authors) — Phase 2 RESOLVED_COMMENTS & Phase 3 third-party dedup ONLY
   uvx myk-pi-tools@latest reviews fetch --output-dir ${PROJECT_TMP_DIR}/all-resolved --include-resolved https://github.com/{owner}/{repo}/pull/{pr_number}
   ```

2. **Check `RESOLVED_EXTERNAL` (from fetch #3 where `is_resolved: true` AND `author != {current_github_user}`):**
   Never inspect paths with `git log ... -- {path}` in bash (untrusted GitHub filenames). Write `${PROJECT_TMP_DIR}/resolved-external-check.json`:

   ```json
   {"threads": [{"thread_id": "{thread_id}", "path": "{path}", "created_at": "{thread created_at}", "replies": [{"created_at": "{reply created_at}"}]}]}
   ```

   Run:

   ```bash
   uvx myk-pi-tools@latest pr check-resolved-threads {REVIEW_DIR} ${PROJECT_TMP_DIR}/resolved-external-check.json
   ```

   - **Fail-open on older CLI:** if non-zero due to unknown/unsupported `check-resolved-threads`, treat all as `suppressed: false`, print one line noting suppression was
     skipped, and CONTINUE.
   - Otherwise read `suppressed` per `thread_id` from output (fails open `false` on unsafe paths, missing timestamps, shallow-clone boundary, or deleted/renamed paths):
     - `suppressed: true` → unchanged since resolution: include in `RESOLVED_COMMENTS` (Phase 2), drop matching `[NEW]` findings (Phase 3), and persist via
       `store-pr-review` below.
     - `suppressed: false` → changed/unproven: include in `RESOLVED_COMMENTS`, do NOT drop matching `[NEW]` findings, do NOT persist suppressing verdict. Never emit
       `[PREV-BAD-FIX]`/`[PREV-NO-FIX]` for third-party threads.

3. **Categorize our own `human` threads (from fetch #1 `--user` only):**
   - **Unresolved:** check diff at `path:line`:
     - Code changed & fix correct → set status `addressed` with reply `"Verified fix in code — resolving."` in JSON, mark `"✅ Fixed but not resolved by author — resolved
       by us"`, store `resolved_fixed`.
     - Code changed & fix wrong/incomplete → include as `"❌ Code changed but fix is incorrect"` (`[PREV-BAD-FIX]`), store `resolved_bad_fix`.
     - Code NOT changed & `LATEST_COMMIT_DATE` > comment `created_at` → include as `"⚠️ UNRESOLVED from previous review"` (`[PREV-UNRESOLVED]`).
     - Code NOT changed & `LATEST_COMMIT_DATE` ≤ comment `created_at` → silently skip.
   - **Resolved:** read full thread + all replies; check diff at `path:line`:
     - Code changed & fix correct → `"✅ Resolved — fix verified"` (`resolved_fixed`).
     - Code changed & fix wrong/incomplete → include as `"❌ Resolved but fix is incorrect"` (`[PREV-BAD-FIX]`, `resolved_bad_fix`).
     - Code NOT changed & valid author reply → `"✅ Resolved — response accepted"` (`resolved_accepted`).
     - Code NOT changed & invalid/missing reply → include as `"❌ Resolved without code change or valid response"` (`[PREV-NO-FIX]`, `resolved_no_fix`).

4. **Store our resolution verdicts to DB (MANDATORY):**
   For each resolved thread posted by us (`--user` fetch): write `{author_response}` to `${PROJECT_TMP_DIR}/resolution-response.txt`, then run:

   ```bash
   uvx myk-pi-tools@latest pr update-resolution {owner} {repo} {pr_number} --path {path} --line {line} --status {resolution_status} --response-file ${PROJECT_TMP_DIR}/resolution-response.txt
   ```

   `{resolution_status}` ∈ `resolved_fixed`, `resolved_accepted`, `resolved_bad_fix`, `resolved_no_fix`.

5. **Persist `suppressed: true` third-party resolutions (skip if none):**
   Write `${PROJECT_TMP_DIR}/resolved-external.json` (all `suppressed: true` `RESOLVED_EXTERNAL` threads) and run `uvx myk-pi-tools@latest pr store-pr-review
${PROJECT_TMP_DIR}/resolved-external.json` (upserted by `thread_id`):

   ```json
   {
     "metadata": {"owner": "{owner}", "repo": "{repo}", "pr_number": {pr_number}, "head_sha": "{LATEST_COMMIT_SHA}"},
     "comments": [{"thread_id": "{thread_id}", "comment_id": {comment_id}, "path": "{path}", "line": {line}, "body": "{body}", "author": "{author}", "posted_at": "{resolved_at}", "status": "resolved_external", "resolution_status": "resolved_accepted", "author_response": "{author's resolving reply, or 'Resolved by author on GitHub'}"}]
   }
   ```

   Past comment statuses fold into Phase 4's combined findings (not a separate summary).

6. **Detect `[AUTHOR-QUESTION]` items (MANDATORY):**
   Scan both (a) `${PROJECT_TMP_DIR}/all-unresolved/` review threads and (b) `gh api /repos/{owner}/{repo}/issues/{pr_number}/comments --paginate` issue comments:
   - Skip our own comments and bots (Qodo, CodeRabbit, GitHub Actions, dependabot, etc.).
   - Match ONLY explicit `@{current_github_user}` mentions (never `?` or loose heuristics) with NO subsequent reply from `{current_github_user}` (`reply.created_at >
     mention.created_at` — use `created_at` only, never `updated_at`).
   - Store `comment_id` and `comment_url` (`html_url`). Read the referenced code/diff and draft a concise, ready-to-post suggested answer (referencing specific
     code/lines; note if a code change is required).

### Phase 2: Code Analysis — Tasks 5, 6, 7, 8, 9

Build three context strings first:

- `EXISTING_COMMENTS`: formatted threads from `${PROJECT_TMP_DIR}/all-unresolved/` (path, line, author, body; use `"(no file)"` / `"(no line)"` if missing/null; or `"No
  existing unresolved comments found."`).
- `RESOLVED_COMMENTS`: formatted `RESOLVED_EXTERNAL` threads from `${PROJECT_TMP_DIR}/all-resolved/` with `resolved_at`, `resolved_at_source`, and `(suppressed: true)` /
  `(suppressed: false)` from `check-resolved-threads` (or `"No resolved third-party comments found."`).
- `CODE_SUGGESTIONS`: instruct reviewers to attach GitHub ```` ```suggestion ```` blocks only for exact line-replacement fixes (not architectural concerns, missing tests,
  new files, or design questions). The suggestion must replace the exact lines referenced by the finding.

Define `SHARED_CONTEXT` once, replacing `<EXISTING_COMMENTS>`, `<RESOLVED_COMMENTS>`, `<CODE_SUGGESTIONS>`, `{owner}`, `{repo}`, and `{pr_number}` with the built
strings/values before appending it to all 5 reviewer tasks:

```text
SHARED_CONTEXT = """
<review-history>
MANDATORY — before reviewing any code, run:
uvx myk-pi-tools@latest pr get-review-history {owner} {repo} {pr_number}
Review the output. Do NOT re-raise any finding marked as resolved_accepted, resolved_fixed, or skipped. Only flag a previously resolved finding if the code at that location materially changed since the resolution.
</review-history>

<existing-unresolved-comments>
The following unresolved review comments already exist on this PR from other reviewers. Do NOT raise duplicate findings — skip them (or note a reference if adding new context/angle).

<EXISTING_COMMENTS>
</existing-unresolved-comments>

<resolved-comments>
The following review comments from OTHER reviewers were resolved. Do NOT re-raise a matching finding unless the code at that path materially changed after the listed resolution timestamp.

<RESOLVED_COMMENTS>
</resolved-comments>

<code-suggestions>
<CODE_SUGGESTIONS>
</code-suggestions>
"""
```

Spawn ALL 5 reviewers as async subagents using the actual task IDs from `TaskCreate` (never hardcode IDs):

```text
subagent(tasks=[
  {agent: "code-reviewer-quality", task: "Review this PR for code quality. Run: git diff origin/<BASE_BRANCH>...HEAD to see changes. Read any files needed for context.\n\n" + SHARED_CONTEXT, cwd: "<REVIEW_DIR>", name: "Review Quality", taskId: "<task 5 ID>"},
  {agent: "code-reviewer-guidelines", task: "Review this PR for guideline adherence. Run: git diff origin/<BASE_BRANCH>...HEAD to see changes. Read AGENTS.md and check compliance.\n\n" + SHARED_CONTEXT, cwd: "<REVIEW_DIR>", name: "Review Guidelines", taskId: "<task 6 ID>"},
  {agent: "code-reviewer-security", task: "Review this PR for bugs and security. Run: git diff origin/<BASE_BRANCH>...HEAD to see changes. Trace data flow through changed code.\n\n" + SHARED_CONTEXT, cwd: "<REVIEW_DIR>", name: "Review Security", taskId: "<task 7 ID>"},
  {agent: "code-reviewer-docs", task: "Review this PR for documentation quality. Run: git diff origin/<BASE_BRANCH>...HEAD to see changes. Check all docs for completeness and accuracy.\n\n" + SHARED_CONTEXT, cwd: "<REVIEW_DIR>", name: "Review Docs", taskId: "<task 8 ID>"},
  {agent: "code-reviewer-spec", task: "Review this PR for spec compliance. Run: git diff origin/<BASE_BRANCH>...HEAD to see changes. Check PR description claims vs diff, issue deliverables vs diff, and scope creep.\n\n" + SHARED_CONTEXT, cwd: "<REVIEW_DIR>", name: "Review Spec", taskId: "<task 9 ID>"}
])
```

Confirm all 5 spawned (STOP and report on error), then **end your turn** — do not poll or sleep. Task 10 auto-unblocks when Tasks 5–9 complete.

### Phase 3: Merge & Deduplicate Findings — Task 10

Merge Task 4 items with Phase 2 findings, then deduplicate `[NEW]` findings against three sources (**NEVER drop `[PREV-UNRESOLVED]`, `[PREV-BAD-FIX]`, or
`[PREV-NO-FIX]`**):

1. **Existing unresolved (`${PROJECT_TMP_DIR}/all-unresolved/`):** drop `[NEW]` findings raising the same issue.
2. **Resolved third-party (`RESOLVED_EXTERNAL`):** match by path + body similarity (ignore line numbers — outdated/rebased lines are unreliable):
   - `suppressed: true` AND verdict is not `resolved_bad_fix`/`resolved_no_fix` → drop and record `"Auto-skipped (previously raised by <author> and resolved)"`.
   - `suppressed: false` → keep (optionally note it re-raises a previously resolved thread).
3. **Previously skipped (`uvx myk-pi-tools@latest pr get-skipped-comments {owner} {repo} {pr_number}`):** match path + body similarity → mark `"Auto-skipped (previously
   dismissed): <skip_reason>"` (still display in Phase 4 so user can override).

### Phase 4: User Selection — Task 11

Present ALL findings grouped by severity (`CRITICAL`, `WARNING`, `SUGGESTION`) in three numbered sections:

1. **Previous findings (`P1, P2, ...`)** marked `(auto-post)` (`[PREV-UNRESOLVED]`, `[PREV-BAD-FIX]`, `[PREV-NO-FIX]` — never ask user to select these; silently-skipped
   items from Phase 1c do not appear).
2. **Author questions (`Q1, Q2, ...`)** (`[AUTHOR-QUESTION]` — show original question, suggested answer, and require Approve/Edit/Skip).
3. **New findings (`1, 2, ...`)** (`[NEW]`).

- **Zero `[NEW]` and zero `[AUTHOR-QUESTION]`:** skip selection and go straight to Phase 5 (auto-post `[PREV-*]`).
- **Otherwise:** print the tables, then call `ask_user` once: `{N} findings — how do you want to decide?` with options `Post all`, `Skip all`, `Decide one by one` (typed
  `all`, `none`, `3,7,12` also work).

**Bulk mode (`Post all` / `Skip all` / numbers):**

- If `[AUTHOR-QUESTION]` items exist, collect Approve / Edit (plain-text prompt, not `ask_user`) / Skip per question.
- 🚨 **Skip reason collection (MANDATORY if any `[NEW]` finding is skipped):** print as normal chat text (not `ask_user`) and **STOP your turn**:

  ```text
  You skipped findings 2, 4, 5. Why?
  Give one reason for all, or per-finding (e.g., "2: not relevant, 4 and 5: style only")
  ```

  If user gives no reason, store `Skipped — no reason given` (Phase 5b rejects empty `skip_reason`).

**Per-finding loop (`Decide one by one`):**

1. Print once: `N prior finding(s) will be re-raised (auto-post).`
2. For each `[AUTHOR-QUESTION]` (`Q1..`): print original comment + suggested answer, then `ask_user` (`Question i/N — <one-line summary>`, options `Approve`, `Edit`,
   `Skip`). `Edit` prints `Answer for Q{i}:` in plain chat and STOPs the turn; `Skip` stores `skip_reason` `Author question — user chose not to respond`.
3. For each `[NEW]` finding (`1..N`): print `Finding i/N — <severity> — <file>:<line>`, source tag, description, suggestion block, and reviewers; call `ask_user`
   (`Finding i/N — <one-line summary>`, options `Post`, `Skip`, `Skip + reason`, `Show more context`, `Stop here`):
   - `Post` → select.
   - `Skip` → skip with `Skipped — no reason given` (no prompt).
   - `Skip + reason` → `ask_user` (`Reason for finding i/N:`, no options; or plain chat + STOP if multi-line requested).
   - `Show more context` → print diff hunk + call sites, re-ask same finding.
   - `Stop here` → skip remaining; ask once for blanket reason (`ask_user` no options, or plain chat + STOP; default `Skipped — no reason given`).

**Refine & classify all skip reasons (both modes):**

1. Refine each reason into concise technical phrasing.
2. Classify each refined reason:
   - **Finding-specific** → store in DB only.
   - **Generalizable** (project-wide pattern/convention) → store in DB AND append `- Do not flag <finding type> — <refined reason>` to `.pi/data/review-guidelines.md`
     (create if absent).

### Phase 5: Post Comments — Task 12

1. **Post `[NEW]` (selected) + `[PREV-*]` (auto-posted):** write `${PROJECT_TMP_DIR}/pr-review-comments.json` and run:

   ```bash
   uvx myk-pi-tools@latest pr post-comment {owner}/{repo} {pr_number} {head_sha} ${PROJECT_TMP_DIR}/pr-review-comments.json
   ```

2. **Reply to approved/edited `[AUTHOR-QUESTION]` items:**
   - **Review thread (`thread_id` present):** write `${PROJECT_TMP_DIR}/author-question-replies.json` using `"human"` with **`status: "not_addressed"`** (NEVER
     `"addressed"` — don't auto-resolve someone else's thread), then run:

     ```bash
     uvx myk-pi-tools@latest reviews post ${PROJECT_TMP_DIR}/author-question-replies.json
     ```

     ```json
     {"metadata": {"owner": "{owner}", "repo": "{repo}", "pr_number": "{pr_number}"}, "human": [{"thread_id": "{thread_id}", "status": "not_addressed", "reply": "{approved_answer}"}]}
     ```

   - **General PR issue comment (no `thread_id`, has `comment_id`):** write raw markdown to `${PROJECT_TMP_DIR}/author-reply-body.md`, encode safely with `jq -Rs '{body:
     .}'` (never string-interpolate JSON), and post:

     ```bash
     cat > ${PROJECT_TMP_DIR}/author-reply-body.md << 'REPLY_EOF'
     > @{commenter} [asked]({comment_url}):
     > {original_question_first_line}

     {approved_answer}
     REPLY_EOF
     jq -Rs '{body: .}' < ${PROJECT_TMP_DIR}/author-reply-body.md > ${PROJECT_TMP_DIR}/author-reply-body.json
     gh api /repos/{owner}/{repo}/issues/{pr_number}/comments --input ${PROJECT_TMP_DIR}/author-reply-body.json
     ```

### Phase 5b: Store Posted Comments — Task 13 (MANDATORY)

Write `${PROJECT_TMP_DIR}/pr-review-store.json` with ALL findings (posted AND skipped; `[AUTHOR-QUESTION]` uses `status: "posted"` or `"skipped"` — never `"answered"` —
and optional `"source": "author-question"`):

```json
{
  "metadata": {"owner": "{owner}", "repo": "{repo}", "pr_number": {pr_number}, "head_sha": "{head_sha}", "author": "{author}"},
  "comments": [
    {"thread_id": null, "comment_id": null, "path": "file.py", "line": 42, "body": "Comment body as posted", "severity": "WARNING", "posted_at": "<ISO timestamp>", "status": "posted"},
    {"thread_id": null, "comment_id": null, "path": "file.py", "line": 99, "body": "Finding description that was skipped", "severity": "SUGGESTION", "posted_at": null, "status": "skipped", "skip_reason": "Refined skip reason from Phase 4"},
    {"thread_id": "thread_abc123", "comment_id": 456, "path": "utils.py", "line": 10, "body": "Author question: should this use sleep=0?", "severity": "QUESTION", "posted_at": "<ISO timestamp>", "status": "posted", "source": "author-question"}
  ]
}
```

Run:

```bash
uvx myk-pi-tools@latest pr store-pr-review ${PROJECT_TMP_DIR}/pr-review-store.json
```

### Phase 6: Summary & Cleanup — Task 14

Display counts (new posted/skipped, previous re-raised, author questions answered/skipped, total posted) and PR link. Then delete all workflow tasks
(`TaskUpdate(taskId="N", status="deleted")`) and delegate to `git-expert` to remove `REVIEW_DIR`.
