---
description: "Process ALL review sources (human, Qodo, CodeRabbit) from current PR — /review-handler [--autorabbit] [REVIEW_URL]"
---

Execute this workflow step by step. Run bash commands directly for CLI operations.
Delegate code fixes to the appropriate specialist subagent.

If `--autorabbit` mode: [PUSH_APPROVED]

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

## Phase 0: Parse Arguments (MANDATORY — DO NOT SKIP)

Before calling ANY `myk-pi-tools` command, parse `{{args}}`:

1. Check if `--autorabbit` is present in `{{args}}`
2. If YES: **Remove** `--autorabbit` from the arguments and set autorabbit mode = ON
3. Store the cleaned arguments (without `--autorabbit`) for all subsequent CLI calls
4. If NO: proceed normally

**Example:** If `{{args}}` = `--autorabbit`, then:
- autorabbit mode = ON
- cleaned arguments = (empty)
- CLI call = `myk-pi-tools reviews fetch` (NO `--autorabbit` flag)

**CRITICAL: `--autorabbit` is a command-level flag, NOT a CLI argument. NEVER pass it to `myk-pi-tools`.**

## Phase 1: Fetch Reviews

Use the cleaned arguments from Phase 0.

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

## Phase 2: User Decision Collection

### AUTORABBIT MODE CHECK (do this FIRST):

If autorabbit mode is ON:
1. CodeRabbit comments → ALL auto-approved. Do NOT ask the user. Set every CodeRabbit item to "yes" automatically. Display the table for visibility only.
2. Human/Qodo comments → follow the normal decision flow below.
3. If there are ONLY CodeRabbit comments (no human, no Qodo) → skip this entire phase and go directly to Phase 3.

**In autorabbit mode, the user is NEVER asked about CodeRabbit items.**

### Normal mode:

Present ALL fetched items to the user for decision. Never silently hide or omit items — including auto-skipped ones.

**Presentation format (MANDATORY):**

Present one table per source (human, qodo, coderabbit). Skip sources with zero items. Within each table, sort by priority (HIGH → MEDIUM → LOW). Use a global counter for the `#` column across all tables.

```text
## Review Items: {source} ({total} total, {auto_skipped} auto-skipped)

| # | Priority | File | Line | Summary | Status |
|---|----------|------|------|---------|--------|
| 1 | HIGH | src/storage.py | 231 | Backfill destroys historical chronology | Pending |
| 2 | MEDIUM | src/html_report.py | 1141 | Add/delete leaves badges stale | Pending |
| 3 | LOW | src/utils.py | 42 | Unused import | Auto-skipped (skipped): "style only" |
```

**After presenting all tables, show response options:**

```text
Respond with:
- 'yes' / 'no' (per item number — if 'no', ask for a reason)
- 'all' — address all remaining pending items
- 'skip human/qodo/coderabbit' — skip remaining from that source (ask for a reason)
- 'skip ai' — skip all AI sources (qodo + coderabbit) (ask for a reason)
```

## Phase 3: Execute Approved Tasks

For each approved comment, delegate to the appropriate specialist subagent using the subagent tool.

When delegating, pass the FULL original review thread — including the complete comment body, all replies, every code suggestion/diff, and all referenced locations. Do NOT summarize or compress the thread.

**When fixing review comments (MANDATORY):**

- If the reviewer provides a specific code suggestion or diff, implement it exactly — not your own interpretation
- Do NOT simplify, minimize, or "half-fix" the suggestion
- After fixing, verify your code matches what the reviewer asked for
- **NO SKIP WITHOUT USER APPROVAL:** If you disagree with a suggestion, ASK THE USER before skipping
- **Read the ENTIRE review thread before acting.** Comments often contain multiple parts: a main issue description, code suggestions, AND additional references like "Also applies to: 663-668" or mentions of other files/lines. You MUST address ALL parts.
- **Multi-location fixes are MANDATORY.** When a comment says "Also applies to: X-Y" or references other lines/files, apply the same fix to each location.
- **Post-fix verification checklist.** After fixing a comment, re-read the ORIGINAL review thread in full and verify:
  1. Every code suggestion or diff was implemented
  2. Every referenced file and line range was addressed
  3. Every "Also applies to" location was fixed
  4. No secondary instructions or reply clarifications were skipped

## Phase 4: Review Unimplemented

If any approved tasks weren't implemented, review with user.

## Phase 5: Persist Decisions

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
- User said **skip <source>** → `skipped` for all remaining from that source
- User said **skip ai** → `skipped` for all remaining AI sources

## Phase 6: Testing

Run tests with coverage. **ALL tests must pass before proceeding. No exceptions.**

- Do NOT skip or ignore failures, even if they appear "pre-existing" or "unrelated"
- If a test fails, fix it — regardless of whether this PR introduced the failure
- Only proceed when the test suite is fully green (zero failures)

## Phase 7: Commit & Push

Ask user if they want to commit and push changes.

Code must be pushed before posting replies so that reviewers can see the fixes when threads are resolved.

## Phase 8: Post Replies

Post replies to GitHub:

```bash
myk-pi-tools reviews post {json_path}
```

If non-zero exit code, re-run — only unposted entries are retried. Repeat until all succeed.

**Output verification (MANDATORY):**

- `Processed N threads` — N should equal entries with status addressed/not_addressed/skipped/failed
- `Resolved: N` — should be non-zero if any entries have status `addressed`
- If `Processed 0 threads`, the status values are wrong — fix and re-run
- If output shows `Warning: Unknown status`, fix those entries

Store to database:

```bash
myk-pi-tools reviews store {json_path}
```

## Phase 9: Autorabbit Polling Loop (--autorabbit mode only)

**Skip this phase if `--autorabbit` was NOT passed.**

### 9a: Wait

Wait 5 minutes before checking for new comments. After waiting, ALWAYS proceed to 9b. NEVER exit the loop.

### 9b: Fetch New Reviews

```bash
myk-pi-tools reviews poll [same arguments as Phase 1]
```

This command atomically handles rate limit checking, triggering, and fetching.

Check if there are new CodeRabbit comments (without `posted_at` timestamps, not auto-skipped).

- If **new CodeRabbit comments found**: Run Phases 2-8 again with autorabbit behavior. After completing, MUST return to Step 9a.
- If **no new CodeRabbit comments**: Display "No new CodeRabbit comments. Checking again in 5 minutes..." and MUST return to Step 9a.

### 9c: NEVER EXIT (MANDATORY)

**THE LOOP MUST NEVER STOP UNLESS THE USER EXPLICITLY REQUESTS IT.**

There is NO automatic exit condition. The loop runs forever until the user intervenes (Ctrl+C or explicit "stop"/"exit"/"done"/"quit").

Even after 100 consecutive cycles with zero new comments, the loop continues.

If any command fails, log the error, wait 5 minutes, and retry from 9a.

Each cycle displays status:

```text
[autorabbit] Cycle {N} complete. Next check in 5 minutes...
[autorabbit] Checking for new CodeRabbit comments...
[autorabbit] Found {N} new comments — processing...
[autorabbit] No new comments. Next check in 5 minutes...
```
