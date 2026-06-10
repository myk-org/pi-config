---
description: Process ALL review sources (human, Qodo, CodeRabbit) from current PR
argument-hint: "[--autorabbit] [--autoqodo]"
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
> Documented retry loops (e.g., auto polling) are not bugs — only report reproducible failures.

Unified handler that processes ALL review sources from the current branch's GitHub PR.

## Multi-PR Handling (MANDATORY)

When asked to handle reviews for **multiple PRs**, NEVER switch branches in the main worktree.
Use `git worktree` to create isolated directories for each PR:

```bash
# Create a worktree per PR (inside the repo)
git worktree add .worktrees/pr-42 origin/fix/issue-42
git worktree add .worktrees/pr-43 origin/feat/issue-43

# Run review-handler in each worktree directory
# When done, clean up all worktrees at once
git worktree remove .worktrees/pr-42
git worktree remove .worktrees/pr-43
```

All worktrees live under `.worktrees/` in the repo.
`.worktrees/` is in the global gitignore (added by entrypoint.sh).
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
- `/review-handler --autoqodo` - Auto-fix Qodo comments in a loop
- `/review-handler --autorabbit --autoqodo` - Auto-fix both CodeRabbit and Qodo comments

## Workflow

> **CRITICAL — BEFORE ANY CLI COMMAND:**
> `--autorabbit` and `--autoqodo` are **command-level flags**, NOT CLI arguments.
> **NEVER** pass `--autorabbit` or `--autoqodo` to `myk-pi-tools`. The CLI will reject it.
> You MUST strip them from the raw arguments first. See Phase 0 below.

### Phase 0: Parse Arguments (MANDATORY — DO NOT SKIP)

Read the **Raw Arguments** section above. Parse as follows:

1. Check if `--autorabbit` appears in the raw arguments
   - If YES: set autorabbit mode = ON, remove `--autorabbit` from the text
   - If NO: autorabbit mode = OFF
2. Check if `--autoqodo` appears in the (remaining) raw arguments
   - If YES: set autoqodo mode = ON, remove `--autoqodo` from the text
   - If NO: autoqodo mode = OFF
3. The remaining text is the cleaned arguments — pass these through to the CLI
4. `--autorabbit` and `--autoqodo` are **command-level flags** — NEVER pass them to the CLI
5. Both flags can be active simultaneously

**Example:** Raw arguments = `--autorabbit --autoqodo`

- autorabbit mode = ON, autoqodo mode = ON
- cleaned arguments = (empty)
- CLI call = `myk-pi-tools reviews fetch` (NO flags)

### Auto Mode Fast Path (MANDATORY)

**If autorabbit mode OR autoqodo mode is ON (set in Phase 0), skip Phases 1-8 entirely
and jump directly to Phase 9 (Auto Polling Loop).** The polling
loop handles fetching, processing, and posting internally. There is no
initial fetch/review cycle — the first fetch happens inside the poll.

### Phase 1: Fetch Reviews

**Skip this phase if autorabbit mode OR autoqodo mode is ON — see Auto Mode Fast Path above.**

The `reviews fetch` command auto-detects the PR from the current branch.

**Use the cleaned arguments from Phase 0 — NEVER pass `--autorabbit` or `--autoqodo` to the CLI.**

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

> **CRITICAL — AUTO MODE CHECK (do this FIRST, before anything else):**
>
> If autorabbit mode is ON:
>
> 1. **CodeRabbit comments → ALL auto-approved.** Set every CodeRabbit item to "yes" automatically.
>
> If autoqodo mode is ON:
>
> **Qodo sticky findings are NEVER auto-skipped.** Unlike CodeRabbit, Qodo sticky
> findings persist intentionally until resolved. Even if a finding was previously
> addressed or dismissed, it must be re-evaluated and fixed again. The `is_auto_skipped`
> flag does not apply to Qodo sources.
>
> 1. **Qodo comments → auto-approved based on finding type:**
>    - `qodo_bug` → **MUST address.** Fix the code. No skip allowed.
>    - `qodo_rule_violation` → **MUST address.** Fix the code. No skip allowed.
>    - `qodo_requirement_gap` → **MUST address.** Either fix the code OR update the issue requirements to document the design decision. No skip allowed.
>    - `qodo_ux_issue` → **MUST address.** Either fix the UX concern OR update the issue requirements to document the design decision. No skip allowed.
>    - `qodo_cross_repo` → **MUST address.** Fix the code to avoid cross-repo breakage. No skip allowed.
>    - `qodo_finding` (other) → **MUST address.** Either fix the code OR update the issue requirements. No skip allowed.
>
>    **No finding type is optional. Every finding gets a code fix or an issue update.**
>    **"Not a realistic issue", "by design", or "not applicable" are NOT valid skip reasons.**
>
>    🚨 **STRICT ENFORCEMENT — EVERY QODO FINDING MUST RESULT IN ONE OF:**
>    1. **Code fix** — change the code to address the finding. Commit and push.
>    2. **Issue spec update** — if the finding is about a spec mismatch (code does X, spec says Y),
>       update the GitHub issue to match the actual design. Use `gh issue edit` to fix the spec.
>       Then reply to Qodo referencing the updated spec.
>
>    **Bare assertions without proof are FORBIDDEN:**
>    - ❌ "Already addressed" (without citing commit SHA or diff link)
>    - ❌ "By design" (without citing updated issue spec)
>    - ❌ "Not applicable" (without explaining why AND updating spec if needed)
>  
>    **WITH proof, these are allowed:**
>    - ✅ "Already addressed in commit abc123 — see diff" (links to specific change)
>    - ✅ "By design per updated issue #N spec" (issue was actually updated)
>  
>    **Posting the same reply multiple times without a NEW code fix or spec update is a HARD VIOLATION.**
>
>    **If a Qodo sticky comment keeps re-appearing after your reply:**
>    - The spec does not match the code — FIX THE SPEC (gh issue edit)
>    - OR the code does not match the spec — FIX THE CODE
>    - NEVER post the same reply again. That means you haven't actually addressed it.
>
> Combined behavior:
>
> 1. **Human comments** → ALWAYS follow the normal decision flow (never auto-approved).
> 1. **If ALL comments are from auto-approved sources** (e.g., only CodeRabbit when autorabbit is on,
>    or only Qodo when autoqodo is on, or both when both flags are on) →
>    skip this entire phase and go directly to Phase 3.
>
> **Auto-approved sources are NEVER presented to the user for decision.**

**Normal mode (no `--autorabbit` / `--autoqodo`):** Follow the full decision flow below.

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

### Phase 3b: Finding Verification (MANDATORY — DO NOT SKIP)

**After ALL fixes are applied, verify EVERY finding from ALL sources (human, Qodo, CodeRabbit):**

1. **Read each finding's FULL description** — not just the title. Two findings with similar titles can reference completely different code.
2. **Read the code block** in the finding — the specific file, line range, and code snippet the reviewer referenced.
3. **Check the ACTUAL file** at that location — does the problematic code still exist?
   - If YES → the finding is NOT addressed. Fix it.
   - If NO → the finding is addressed.
4. **Never group findings by title.** Each finding is independent.
   "Inconsistent task counts" about `readTaskSummary` is a DIFFERENT finding than
   "Inconsistent task counts" about `renderTasksPart`.
5. **Never mark a finding as "pre-existing" or "by design" without reading the actual
   code reference.** The code block tells you exactly what the reviewer found —
   check if it's still there.

🚨 **HARD RULE: Every finding that includes a code block MUST be verified against
the actual file before being marked as addressed. No exceptions. No shortcuts.
No "this looks similar to the one I already fixed."**

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
- User said **yes** but fix attempt failed (code change didn't work) → `not_addressed`
- User said **no** → `skipped` (include the user's skip reason in `reply`)
- User said **all** → same as **yes** for each remaining comment
- User said **skip \<source\>** → `skipped` for all remaining from that source
  (include the user's skip reason in `reply`)
- User said **skip ai** → `skipped` for all remaining AI sources
  (include the user's skip reason in `reply`)

**Autoqodo status rules (MANDATORY):**

- Code was changed to fix the finding → `addressed`
- No code changed, finding is by design / won't fix / not applicable → `skipped` (with reason)
- No code changed, deferred to follow-up → `skipped` (with reason)
- Issue spec was updated (no code change) → `skipped` (with reason referencing the spec update)

🚨 **`addressed` means code was changed. If no code was changed, the status MUST be `skipped`.**
`not_addressed` means "we wanted to fix it but couldn't" — do NOT use it for "by design" findings.

### Phase 6: Testing

Run tests with coverage.

**ALL tests must pass before proceeding. No exceptions.**

- Do NOT skip or ignore failures, even if they appear "pre-existing" or "unrelated to our changes"
- Do NOT rationalize failures as acceptable
- If a test fails, fix it — regardless of whether this PR introduced the failure
- Only proceed to Phase 7 when the test suite is fully green (zero failures)

### Phase 7: Commit & Push

**NEVER amend commits — always create NEW commits.** Amending + force-push prevents
automated reviewers (Qodo, CodeRabbit) from detecting changes and re-evaluating findings.
Each fix cycle MUST be a separate commit so reviewers can see what changed.

**If ALL comments are from auto-approved sources (see Phase 2 auto mode rules):**
Skip asking the user — commit and push automatically.

**Otherwise:** Ask user if they want to commit and push changes.

Code must be pushed before posting replies so that reviewers can see the fixes
when threads are resolved.

### Phase 8: Post Replies

Post all replies to GitHub and store results in the database.

**Body comments (outside-diff, major, minor, nitpick, duplicate, qodo sticky):**

Comments that don't have GitHub review threads (e.g., CodeRabbit outside-diff,
major, minor, nitpick, and duplicate comments) are replied to via a single
consolidated PR comment per reviewer. The comment mentions the reviewer (e.g., `@coderabbitai`)
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

### Phase 9: Auto Polling Loop (--autorabbit / --autoqodo mode)

**Skip this phase if NEITHER `--autorabbit` NOR `--autoqodo` was passed.**

🚨 **ABSOLUTE RULE: NO USER INTERACTION DURING THE POLLING LOOP.**

**NEVER call AskUserQuestion during Phase 9. NEVER present options,
dialogs, choices, or questions to the user. The polling loop is FULLY
AUTOMATIC. If something is stuck, stale, or unclear — keep polling
silently. Do NOT invent questions like "PRs are stuck, what do you
want to do?" or "Should I keep polling?" or any variation. The loop
runs silently until an exit condition is met. Period.**

After the review flow completes (Phases 1-8), enter a polling loop
to watch for new comments from auto-approved sources (CodeRabbit if autorabbit,
Qodo if autoqodo, both if both flags active).

#### 9a+9b: Wait and Fetch (combined async)

**Always pass `--source` explicitly. No defaults.**

**If autorabbit is ON (only):** Spawn ONE async worker:

- Agent: `worker`
- Task: `Run: myk-pi-tools reviews poll --source coderabbit [same arguments as Phase 1].`
  `Return the EXACT raw stdout output — do NOT summarize, interpret, or rephrase it.`
- async: true
- **No timeout** — the poll can take 30+ minutes (rate limit waits). NEVER set a timeout.

**If autoqodo is ON (only):** Spawn ONE async worker:

- Agent: `worker`
- Task: `Run: myk-pi-tools reviews poll --source qodo [same arguments as Phase 1].`
  `Return the EXACT raw stdout output — do NOT summarize, interpret, or rephrase it.`
- async: true
- **No timeout** — the poll loops internally until new Qodo comments appear. NEVER set a timeout.

**If BOTH are ON:** Spawn TWO async workers in parallel:

1. `Run: myk-pi-tools reviews poll --source coderabbit [same arguments as Phase 1].`
   `Return the EXACT raw stdout output — do NOT summarize, interpret, or rephrase it.`
1. `Run: myk-pi-tools reviews poll --source qodo [same arguments as Phase 1].`
   `Return the EXACT raw stdout output — do NOT summarize, interpret, or rephrase it.`

When EITHER returns with new comments, process them (Phases 2-8). Then re-spawn that agent.
The other agent keeps running independently.

**While waiting for the async result**, the session remains interactive — the user
can continue working. When the result surfaces, process it:

Check the poll RAW output (not the worker's summary — look for the exact JSON string):

- If output contains the EXACT string `"approved": true`: **EXIT the loop**. Notify the user:
  "🎉 All auto-approved reviewers approved this PR — no actionable comments. Auto loop complete."
  **CRITICAL:** Only exit on the literal JSON `{"approved": true}` from the CLI output.
  Do NOT exit because the worker says "approved" or "0 comments" in its summary.
- If **new comments found from auto-approved sources**: Run Phases 2-8 again with
  auto-approve behavior for the relevant sources.
  After completing, spawn another async worker (go to 9a+9b again).

#### 9c: Exit Conditions (MANDATORY)

**The loop MUST run until one of these conditions is met:**

1. **All auto-approved reviewers approved** — `reviews poll` returns `{"approved": true}`. Exit and notify the user.
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
[auto] Cycle {N} complete — {addressed} addressed, {skipped} skipped. Re-spawning poll...
[auto] Checking for new comments from auto-approved sources...
[auto] Found {N} new comments — processing...
[auto] No new comments. Next check in 5 minutes...
[auto] CodeRabbit rate-limited. Handling automatically via reviews poll --source coderabbit...
[auto] 🎉 All auto-approved reviewers approved! No actionable comments. Loop complete.
```
