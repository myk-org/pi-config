---
description: Process ALL review sources (human, Qodo, CodeRabbit) from current PR
argument-hint: "[--autorabbit]"
---

## Raw Arguments

```text
$ARGUMENTS
```

# GitHub Review Handler

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug
> while executing this command — DO NOT work around it silently. Ask the user:
> "Should I create a GitHub issue for this?" Route to:
> `myk-org/pi-config` for plugin/command spec or `myk-pi-tools` CLI issues.
> Do not silently skip steps or apply manual fixes that hide the root cause.
> Documented retry loops (e.g., autorabbit polling) are not bugs — only report reproducible failures.

Unified handler that processes ALL review sources from the current branch's GitHub PR.

## Multi-PR Handling (MANDATORY)

When asked to handle reviews for **multiple PRs**, NEVER switch branches in the main worktree.
Use `git worktree` to create isolated directories for each PR:

```bash
# Create a worktree per PR (under /tmp/pi-work/<repo-name>/)
git worktree add /tmp/pi-work/<repo-name>/pr-42 origin/fix/issue-42
git worktree add /tmp/pi-work/<repo-name>/pr-43 origin/feat/issue-43

# Run review-handler in each worktree directory
# When done, clean up
git worktree remove /tmp/pi-work/<repo-name>/pr-42
```

Branch switching corrupts parallel agent work — other agents running in the
main worktree will see the wrong branch.

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

- `/review-handler` - Process reviews from current PR
- `/review-handler https://github.com/owner/repo/pull/123#pullrequestreview-456` - With specific review URL
- `/review-handler --autorabbit` - Auto-fix CodeRabbit comments in a loop

## Workflow

> **CRITICAL — BEFORE ANY CLI COMMAND:**
> `--autorabbit` is a **command-level flag**, NOT a CLI argument.
> **NEVER** pass `--autorabbit` to `myk-pi-tools`. The CLI will reject it.
> You MUST strip it from the raw arguments first. See Phase 0 below.

### Phase 0: Parse Arguments (MANDATORY — DO NOT SKIP)

Read the **Raw Arguments** section above. Parse as follows:

1. Check if the text `--autorabbit` appears in the raw arguments
2. If YES: set autorabbit mode = ON, and remove `--autorabbit` from the text. The remaining text (if any) is the cleaned arguments.
3. If NO: autorabbit mode = OFF, the entire raw arguments text is the cleaned arguments.
4. Use ONLY the cleaned arguments for all subsequent CLI calls.

**Example:** Raw arguments = `--autorabbit`

- autorabbit mode = ON
- cleaned arguments = (empty)
- CLI call = `myk-pi-tools reviews fetch` (NO `--autorabbit` flag)

**Example:** Raw arguments = `--autorabbit https://github.com/org/repo/pull/123#pullrequestreview-456`

- autorabbit mode = ON
- cleaned arguments = `https://github.com/org/repo/pull/123#pullrequestreview-456`
- CLI call = `myk-pi-tools reviews fetch https://github.com/...`

### Autorabbit Fast Path (MANDATORY)

**If autorabbit mode is ON (set in Phase 0), skip Phases 1-8 entirely
and jump directly to Phase 9 (Autorabbit Polling Loop).** The polling
loop handles fetching, processing, and posting internally. There is no
initial fetch/review cycle — the first fetch happens inside the poll.

### Phase 1: Fetch Reviews

**Skip this phase if autorabbit mode is ON — see Autorabbit Fast Path above.**

The `reviews fetch` command auto-detects the PR from the current branch.

**Use the cleaned arguments from Phase 0 — NEVER pass `--autorabbit` to the CLI.**

If a specific review URL is in the cleaned arguments:

```bash
myk-pi-tools reviews fetch <cleaned_arguments>
```

Otherwise (auto-detect from current branch):

```bash
myk-pi-tools reviews fetch
```

Returns JSON with:

- `metadata`: owner, repo, pr_number, json_path
- `human`: Human review threads
- `qodo`: Qodo AI review threads
- `coderabbit`: CodeRabbit AI review threads

### Phase 2: User Decision Collection

> **CRITICAL — AUTORABBIT MODE CHECK (do this FIRST, before anything else):**
>
> If autorabbit mode is ON (set in Phase 0):
>
> 1. **CodeRabbit comments → ALL auto-approved.** Do NOT use AskUserQuestion
>    for CodeRabbit. Do NOT ask the user. Set every CodeRabbit item to "yes"
>    automatically. Display the table for visibility only.
> 2. **Human/Qodo comments** → follow the normal decision flow below.
> 3. **If there are ONLY CodeRabbit comments** (no human, no Qodo) →
>    skip this entire phase and go directly to Phase 3.
>
> **In autorabbit mode, the user is NEVER asked about CodeRabbit items.**

**Normal mode (no `--autorabbit`):** Follow the full decision flow below.

**MANDATORY: Present ALL fetched items to the user for decision.
Never silently hide or omit items — including auto-skipped ones.**

Even if an item appears to be a repeat from a previous round, was already addressed,
or seems trivial — present it to the user. The user decides what to address or skip,
not the AI.

**Presentation format (MANDATORY — always use this exact structure):**

**HARD RULE: The table MUST include ALL items — pending AND auto-skipped.
No exceptions. Never present a partial table. If you omit auto-skipped items,
the output is INVALID and must be redone.**

Present one table per source (human, qodo, coderabbit). Skip sources with zero items.
Within each table, sort by priority (HIGH → MEDIUM → LOW).
Use a **global counter** for the `#` column across all tables (not per-table).

```text
## Review Items: {source} ({total} total, {auto_skipped} auto-skipped)

| # | Priority | File | Line | Summary | Status |
|---|----------|------|------|---------|--------|
| 1 | HIGH | src/storage.py | 231 | Backfill destroys historical chronology | Pending |
| 2 | MEDIUM | src/html_report.py | 1141 | Add/delete leaves badges stale | Pending |
| 3 | LOW | src/utils.py | 42 | Unused import | Auto-skipped (skipped): "style only" |
| 4 | LOW | src/config.py | 15 | Missing validation | Auto-skipped (addressed): "added in prev PR" |

(Numbering continues across tables — e.g., if this table ends at 4, the next table starts at 5.)
```

**Table rules:**

- **Always a table** — never use bullets, prose, or any other format
- **Summary column:** 1-2 lines summarizing the comment.
  Include "Also applies to" references if present
- **Status column values:**
  - `Pending` — awaiting user decision
  - `Auto-skipped ({original_status}): "{reason}"` — showing the original status (addressed/skipped/not_addressed) and the stored reason
- **Every item gets a row** — including auto-skipped items so the user can override

**After presenting all tables, show the response options:**

```text
Respond with:
- 'yes' / 'no' (per item number — if 'no', ask for a reason)
- 'all' — address all remaining pending items
- 'skip human/qodo/coderabbit' — skip remaining from that source (ask for a reason)
- 'skip ai' — skip all AI sources (qodo + coderabbit) (ask for a reason)
```

**User input method (MANDATORY):**

Always use the `AskUserQuestion` tool to collect user decisions — never rely on
free-text conversation. Present the tables first as regular output, then call
`AskUserQuestion` with a concise prompt summarizing the available options.

Example `AskUserQuestion` prompt:

```text
Enter your decisions (e.g., '1 yes, 2 no: already addressed, 3 yes, skip coderabbit: duplicates human review'):
```

The handler collects ALL decisions in a single `AskUserQuestion` call.
If the user says 'no' or 'skip' without a reason, follow up with another
`AskUserQuestion` asking for the reason before proceeding.

### Phase 3: Execute Approved Tasks

For each approved comment, delegate to appropriate specialist agent.
When delegating, pass the FULL original review thread to the agent — including the complete comment body,
all replies, every code suggestion/diff, and all referenced locations. Do NOT summarize or compress the thread.

**When fixing review comments (MANDATORY):**

- If the reviewer provides a specific code suggestion or diff, implement IT exactly — not your own interpretation
- Do NOT simplify, minimize, or "half-fix" the suggestion
- After fixing, verify your code matches what the reviewer asked for, not just "addresses the concern"
- **NO SKIP WITHOUT USER APPROVAL:** If you disagree with the suggestion, ASK THE USER before skipping, partially fixing, or applying a minimum-viable fix
- **Read the ENTIRE review thread before acting.** Review threads contain a top-level comment plus replies.
  Comments often contain multiple parts: a main issue description, code suggestions, AND additional references
  like "Also applies to: 663-668" or mentions of other files/lines. Replies may contain clarifications,
  additional locations, or refined suggestions. You MUST address ALL parts from the comment AND replies,
  not just the first paragraph.
- **Multi-location fixes are MANDATORY.** When a comment says "Also applies to: X-Y" or references other lines/files,
  apply the same logical fix, adapted as needed to each location. These are not optional — they are part of the
  comment's requirements.
- **Post-fix verification checklist.** After fixing a comment, re-read the ORIGINAL review thread in full and verify:
  1. Every code suggestion or diff was implemented
  2. Every referenced file and line range was addressed
  3. Every "Also applies to" location was fixed
  4. No secondary instructions or reply clarifications were skipped
  If any part was missed, fix it before moving to the next comment.

### Phase 4: Review Unimplemented

If any approved tasks weren't implemented, review with user.

### Phase 5: Persist Decisions

Update each JSON entry with `status` and `reply` fields before posting.

**Valid status values:**

| Status | Behavior |
|--------|----------|
| `addressed` | Post reply, resolve thread |
| `not_addressed` | Post reply (human: leave unresolved; AI: resolve) |
| `skipped` | Post reply with skip reason (human: leave unresolved; AI: resolve) |
| `pending` | Skip (not processed yet) |
| `failed` | Retry posting |

**Mapping from user decisions (Phase 2):**

- User said **yes** and code was changed → `addressed`
- User said **yes** but change was not implemented → `not_addressed`
- User said **no** → `skipped` (include the user's skip reason in `reply`)
- User said **all** → same as **yes** for each remaining comment
- User said **skip \<source\>** → `skipped` for all remaining from that source
  (include the user's skip reason in `reply`)
- User said **skip ai** → `skipped` for all remaining AI sources
  (include the user's skip reason in `reply`)

### Phase 6: Testing

Run tests with coverage.

**ALL tests must pass before proceeding. No exceptions.**

- Do NOT skip or ignore failures, even if they appear "pre-existing" or "unrelated to our changes"
- Do NOT rationalize failures as acceptable
- If a test fails, fix it — regardless of whether this PR introduced the failure
- Only proceed to Phase 7 when the test suite is fully green (zero failures)

### Phase 7: Commit & Push

**If autorabbit mode is ON and there are ONLY CodeRabbit comments (no human, no qodo):**
Skip asking the user — commit and push automatically.

**Otherwise:** Ask user if they want to commit and push changes.

Code must be pushed before posting replies so that reviewers can see the fixes
when threads are resolved.

### Phase 8: Post Replies

Post all replies to GitHub and store results in the database.

**Body comments (outside-diff, nitpick, duplicate):**

Comments that don't have GitHub review threads (e.g., CodeRabbit outside-diff,
nitpick, and duplicate comments) are replied to via a single consolidated PR
comment per reviewer. The comment mentions the reviewer (e.g., `@coderabbitai`)
and includes sections for each comment with the decision made. This ensures
automated reviewers know their comments were reviewed and won't re-raise them.

Post replies to GitHub:

```bash
myk-pi-tools reviews post {json_path}
```

If the command exits with a non-zero code, some threads failed to post.
The command prints an ACTION REQUIRED message with the exact retry command.
Re-run it to retry — only unposted entries are retried. Repeat until all succeed.

**Output verification (MANDATORY):**

After `reviews post` completes successfully, check the output:

- `Processed N threads` — N should equal the number of entries with status `addressed`, `not_addressed`, `skipped`, or `failed` (everything except `pending`)
- `Resolved: N` — should be non-zero if any entries have status `addressed` or if AI-source entries have status `skipped`/`not_addressed`
- If `Processed 0 threads`, the status values in the JSON are wrong — fix them to use valid values from the table above and re-run before proceeding
- If output shows `Warning: Unknown status`, fix those entries — e.g., `"done"` or `"completed"` are not valid, use `"addressed"` instead

Do NOT proceed to `reviews store` until `reviews post` shows the expected thread count.

Store to database:

```bash
myk-pi-tools reviews store {json_path}
```

### Phase 9: Autorabbit Polling Loop (--autorabbit mode only)

**Skip this phase if `--autorabbit` was NOT passed.**

🚨 **ABSOLUTE RULE: NO USER INTERACTION DURING THE POLLING LOOP.**

**NEVER call AskUserQuestion during Phase 9. NEVER present options,
dialogs, choices, or questions to the user. The polling loop is FULLY
AUTOMATIC. If something is stuck, stale, or unclear — keep polling
silently. Do NOT invent questions like "PRs are stuck, what do you
want to do?" or "Should I keep polling?" or any variation. The loop
runs silently until an exit condition is met. Period.**

After the review flow completes (Phases 1-8), enter a polling loop
to watch for new CodeRabbit comments.

#### 9a+9b: Wait and Fetch (combined async)

`reviews poll` loops internally until something actionable happens. Spawn ONE
async worker and wait for the result.

**Spawn the poll as one async subagent:**

- Agent: `worker`
- Task: `Run: myk-pi-tools reviews poll [same arguments as Phase 1]. Return the EXACT raw stdout output — do NOT summarize, interpret, or rephrase it.`
- async: true
- **No timeout** — the poll can take 30+ minutes (rate limit waits). NEVER set a timeout.

**While waiting for the async result**, the session remains interactive — the user
can continue working. When the result surfaces, process it:

Check the poll RAW output (not the worker's summary — look for the exact JSON string):

- If output contains the EXACT string `"approved": true`: **EXIT the loop**. Notify the user:
  "🎉 CodeRabbit approved this PR — no actionable comments. Autorabbit loop complete."
  **CRITICAL:** Only exit on the literal JSON `{"approved": true}` from the CLI output.
  Do NOT exit because the worker says "approved" or "0 comments" in its summary.
- If **new CodeRabbit comments found**: Run Phases 2-8 again with
  autorabbit behavior (auto-approve CodeRabbit, ask user for others).
  After completing, spawn another `reviews poll` async worker (go to 9a+9b again).

#### 9c: Exit Conditions (MANDATORY)

**The loop MUST run until one of these conditions is met:**

1. **CodeRabbit approved** — `reviews poll` returns `{"approved": true}`. Exit and notify the user.
2. **User explicitly stops** — user presses `Ctrl+C` or sends "stop", "exit", "done", or "quit".

**No other reason is valid to exit the loop.**

```text
VIOLATION — The following rationalizations are FORBIDDEN reasons to exit the loop:

  - "All comments have been addressed"
  - "No new comments found for N cycles"
  - "The loop seems complete"
  - "Nothing left to process"
  - "The review is done"
  - "CodeRabbit has not posted anything new"
  - "It appears the review cycle is finished"
  - "The fetch command failed"
  - "An error occurred during polling"
  - "The API returned an error"
  - "An error prevents continuing"
  - Any variation of the AI deciding there is no more work to do
```

```text
VIOLATION — The following user interactions are FORBIDDEN during Phase 9:

  - Calling AskUserQuestion for ANY reason
  - Presenting options like "keep polling / stop / skip"
  - Asking "should I continue?"
  - Asking "PRs are stuck, what do you want to do?"
  - Asking for user input about stale comments
  - Asking for user decisions about polling strategy
  - ANY dialog, question, or prompt to the user
  - Any variation of the AI asking the user what to do

The ONLY way the user interacts with the loop is by explicitly
sending "stop", "exit", "done", or "quit" — unprompted by the AI.
```

If any command in the loop fails, log the error, wait 5 minutes, and retry from 9a.
Errors are recoverable — NEVER treat a command failure as a reason to exit.

**Breaking the loop without a valid exit condition is a HARD VIOLATION of this spec.**

Each cycle displays a status update so the user knows the loop is active:

```text
[autorabbit] Cycle {N} complete. Next check in 5 minutes...
[autorabbit] Checking for new CodeRabbit comments...
[autorabbit] Found {N} new comments — processing...
[autorabbit] No new comments. Next check in 5 minutes...
[autorabbit] CodeRabbit rate-limited. Handling automatically via reviews poll...
[autorabbit] 🎉 CodeRabbit approved! No actionable comments. Loop complete.
```
