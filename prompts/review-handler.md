---
description: Process ALL review sources (human, Qodo, CodeRabbit) from current PR
argument-hint: "[--autorabbit] [--autoqodo]"
---

## Raw Arguments

```text
$ARGUMENTS
```

# GitHub Review Handler

Unified handler that processes ALL review sources from the current branch's GitHub PR.

- **Multi-PR work:** NEVER switch branches in the main worktree — create an isolated worktree per PR under `.worktrees/` (`git worktree add .worktrees/pr-42
  origin/fix/issue-42`; `git worktree remove` when done).
- **Check `uv`:** `uv --version` (install from <https://docs.astral.sh/uv/getting-started/installation/> if missing).
- **Usage:** `/review-handler` | `/review-handler <review-url>` | `--autorabbit` | `--autoqodo` | `--autorabbit --autoqodo`

## Workflow

**`PROJECT_TMP_DIR`** is `getProjectTmpDir(cwd)` — all temp files go there.

> 🚨 **`--autorabbit` and `--autoqodo` are command-level flags, NEVER CLI args.** Strip them from raw arguments first — `myk-pi-tools` rejects them.

### Phase 0: Parse Arguments (MANDATORY)

1. Check raw arguments for `--autorabbit` (set `autorabbit = ON/OFF`, strip flag) and `--autoqodo` (set `autoqodo = ON/OFF`, strip flag). Both can be ON.
2. Remaining text = `<cleaned_arguments>`.
3. **Auto Mode Fast Path (MANDATORY):** If `autorabbit` OR `autoqodo` is ON, **skip Phases 1–8 and jump directly to Phase 9** (the polling loop handles fetching,
   processing, and posting internally).

### Phase 1: Fetch Reviews

Skip if `autorabbit` or `autoqodo` is ON.

```bash
uvx myk-pi-tools@latest reviews fetch --output-dir ${PROJECT_TMP_DIR} [<cleaned_arguments>]
```

Returns JSON with `metadata` (`owner`, `repo`, `pr_number`, `json_path`), `human`, `qodo`, and `coderabbit`.

### Phase 2: User Decision Collection

**Auto mode check (run FIRST):**

- **`autorabbit` ON:** all CodeRabbit items are auto-approved (`yes`).
- **`autoqodo` ON:**
  1. **Auto-skipped stickies:** `is_auto_skipped=true` (`already_replied=true` and no `qodo_response`) means implicit acceptance — do NOT re-process.
  2. **Read ALL 6 Qodo fields before acting** (`code_diff`, `evidence`, `evidence_refs`, `agent_prompt`, `qodo_response`, `previous_reply`) — **NEVER match/dismiss by
     title alone**.
  3. **Handle `qodo_response` FIRST when present:** if Qodo accepted ("looks good", "addressed", "thanks"), reply referencing acceptance; if Qodo pushed back ("still
     present", "not fixed", "disagree", "issue remains"), your prior fix failed — make a **NEW, DIFFERENT fix** (repeating the same reply/approach is a HARD VIOLATION).
  4. **Every actionable Qodo finding (`qodo_bug`, `qodo_rule_violation`, `qodo_requirement_gap`, `qodo_ux_issue`, `qodo_cross_repo`, `qodo_finding`) is mandatory** — "not
     realistic", "by design", or "not applicable" are NOT valid skip reasons. Each MUST produce:
     - **Code fix** (commit & push), OR
     - **Issue spec update** (`gh issue edit` to match design, then reply citing updated issue `#N` spec — only for spec mismatches).
  5. **No bare assertions without proof:** ❌ "Already addressed" / "By design" / "Not applicable" without citing a commit SHA/diff link or updated issue `#N` spec. If a
     sticky re-appears after your reply, fix the code or fix the spec — NEVER repeat the same reply.
- **Combined behavior:** `human` comments ALWAYS use the interactive flow below; if ALL items are from auto-approved sources, skip the rest of Phase 2 and go straight to
  Phase 3 (auto-approved items are NEVER presented for user decision).

**Normal mode (interactive):**

🚨 **HARD RULE: Present ALL fetched items (pending AND auto-skipped) — never hide repeats or auto-skipped items.**

Print one table per non-empty source (`human`, `qodo`, `coderabbit`), sorted `HIGH → MEDIUM → LOW`, with a global `#` counter across tables:

```text
## Review Items: {source} ({total} total, {auto_skipped} auto-skipped)

| # | Priority | File | Line | Summary | Status |
|---|----------|------|------|---------|--------|
| 1 | HIGH | src/storage.py | 231 | Backfill destroys historical chronology | Pending |
| 2 | LOW | src/utils.py | 42 | Unused import | Auto-skipped (skipped): "style only" |
```

- Always use a table (never bullets/prose); Summary = 1–2 lines (+ `"Also applies to"` refs); Status = `Pending` or `Auto-skipped ({original_status}): "{reason}"`.
- After the tables, show options (`yes`/`no` per number + reason on `no`, `all`, `skip human/qodo/coderabbit` + reason, `skip ai` + reason), then collect ALL decisions in
  a single `AskUserQuestion` call (e.g., `'1 yes, 2 no: already addressed, skip coderabbit: duplicates human'`). Follow up with `AskUserQuestion` if any `no`/`skip` lacks
  a reason.

### Phase 3: Execute Approved Tasks

Delegate each approved comment to the appropriate specialist, passing the **FULL original review thread** (body, all replies, code suggestions/diffs, referenced locations
— never summarize/compress):

- **Qodo findings:** read `code_diff`, `evidence`, `evidence_refs`, `agent_prompt`, `qodo_response` (read FIRST), `previous_reply`. If `code_diff` is empty, locate code
  via every `evidence_refs` entry, `path`/`line`/`end_line`, or snippet from `evidence`.
- Implement provided code suggestions/diffs **exactly** (do not simplify or half-fix). **NO SKIP WITHOUT USER APPROVAL** (if you disagree, ask user first).
- Read the ENTIRE thread (top-level + replies) and fix ALL parts, secondary instructions, and `"Also applies to: X-Y"` multi-location references.
- **Post-fix check:** re-read original thread in full and verify every diff, file/line range, `"Also applies to"`, and reply clarification was addressed.

### Phase 3b: Finding Verification (MANDATORY)

After all fixes, verify EVERY finding against the actual files:

1. Read full description + code block (`code_diff` first; if empty, check `evidence_refs` like `file[28-52]`/`file[R28-52]`, `path`/`line`/`end_line`, and body — never
   skip due to empty `code_diff` or group by title).
2. Inspect the actual file at that location — if the problematic code still exists, fix it. Never mark `"pre-existing"` or `"by design"` without reading the referenced
   code.

### Phase 4: Review Unimplemented

If any approved tasks weren't implemented, review with user.

### Phase 5: Prepare Reply Mappings

🚨 **NEVER hand-edit `status`/`reply` in a reviews JSON** (bypasses posting and DB). Prepare one mapping file per target status (`reviews address` applies, posts, and
stores in Phase 8 after push):

```text
src/a.py:10|Fixed in abc1234                      # one finding (any line in [line, end_line] span)
src/a.py:10~backoff|Fixed the backoff in abc1234  # discriminator when spans overlap at line 10
src/a.py:*|Same reply for every finding in this file
*|All findings fixed in def5678                   # every pending finding
```

- **Span semantics (#945):** specific `<path>:<line>` matches `[line, end_line]`. When one span contains another in the same file, the outer finding matches only its own
  reported `line` (inner lines hit the inner finding); equal spans match only their own reported `line`. Never target sticky duplicates separately (paired automatically
  via cluster).
- **Atomic validation:** a rule matching 2+ distinct findings fails atomically (never run twice to split them). Disambiguate with `~<fragment>`, `<path>:*`/`*`, or (the
  ONE sanctioned JSON edit) narrow `line`/`end_line` in the JSON.
- **Statuses (`--set`):** `addressed` (post + resolve), `not_addressed` (post; human stays open, AI resolves), `skipped` (post skip reason; human stays open, AI
  resolves), `pending`, `failed`.
- **Decision mapping:** `yes` + code fixed → `addressed`; `yes` + fix failed → `not_addressed`; `no`/`skip` → `skipped` (with reason).
- **Autoqodo status rules (MANDATORY):** `addressed` means **code was changed**. If no code changed (by design, spec updated, deferred), status MUST be `skipped` (with
  reason referencing spec update if applicable) — never use `not_addressed` for "by design". 🚨 **NEVER skip/defer for "too much work"** (schema migration, refactoring,
  etc.) — fix it now.

### Phase 6: Testing

Run tests with coverage. **ALL tests must pass** before Phase 7 — fix any failure (even "pre-existing" or "unrelated").

### Phase 7: Commit & Push

**NEVER amend commits — always create NEW commits** (amending/force-pushing breaks Qodo/CodeRabbit re-evaluation). Auto mode: commit and push automatically. Interactive
mode: ask user first. Push before Phase 8.

### Phase 8: Post Replies (via `reviews address`)

Run one call per status group (omit `--json` to pick newest `pr-*-reviews.json` in `.pi/tmp`):

```bash
uvx myk-pi-tools@latest reviews address --json {json_path} --replies {mapping_file} --set addressed
uvx myk-pi-tools@latest reviews address --json {json_path} --replies {mapping_file} --set skipped
```

- **Multi-group retention:** while pending findings remain, a successful run posts its group and keeps the JSON on disk; the final group stores to DB and consumes the
  JSON. Body comments (CodeRabbit outside-diff/major/minor/nitpick/duplicate, Qodo sticky) get consolidated PR comments mentioning the reviewer.
- **Exit 0:** matched findings posted (`addressed` and AI `skipped`/`not_addressed` resolved; human `skipped`/`not_addressed` stay open).
- **Non-zero exit:** JSON is retained for safe re-run (already-posted entries are skipped; failed resolves retry). Fix `no findings matched` in mapping file or re-run
  failed posts/resolves — **NEVER delete or hand-edit a retained JSON**.

### Phase 9: Auto Polling Loop (`--autorabbit` / `--autoqodo`)

Skip if NEITHER flag was passed.

🚨 **ABSOLUTE RULE: NO USER INTERACTION DURING PHASE 9.** Never call `AskUserQuestion` or present options/questions — run silently until an exit condition holds. **Sole
exception:** if a `qodo_requirement_gap` requires an issue spec update (not a code fix), ask via `ask_user` first.

#### 9a+9b: Wait and Fetch (combined async)

Leave `fireAndForget` unset (poll output is required; see `40-critical-rules.md`) and pass `taskId` (`-1` if unlinked; see `60-task-tracking.md`). After spawning, **end
your turn** — never poll, sleep, or re-spawn; do not report "still waiting".

**Always pass `--source` explicitly.** Spawn one async `worker` per active flag (in parallel when both are on), with **NO timeout** on the bash call (sleeps 300s/cycle,
can run 30+ min):

- Task template (`<source>` = `coderabbit` or `qodo`):
  `Run: uvx myk-pi-tools@latest reviews poll --output-dir ${PROJECT_TMP_DIR} --source <source> [same arguments as Phase 1]. Return the EXACT raw stdout output — do NOT
summarize, interpret, or rephrase it. IMPORTANT: Do NOT set a timeout on the bash call — this command sleeps 300s between cycles and can run for 30+ minutes.`

When a worker returns new comments, run Phases 2–8, then re-spawn that worker (the other keeps running). Check `"approved"` in the returned JSON:

- **`"approved": true` → EXIT loop.**
  - Check `qodo_cli_state` vs top-level aggregate `approved`: ONLY when `qodo_cli_state.approved` is `true` AND `qodo_cli_state.review_complete` is `false` AND
    `qodo_cli_state.status` != `completed` (e.g. `skipped`), state plainly that Qodo approved on a clean findings catalog at head while its review run was
    skipped/incomplete (`status: completed` is never skipped). If `qodo_cli_state.approved` is `false` or Qodo is still reviewing, another reviewer approved — do NOT
    claim/imply Qodo approved.
  - Display **only** the two summary tables below on exit (from approval JSON / `metadata.json_path` / DB — no per-cycle summaries):
    1. `## Tradeoffs ({count})` (`# | Type | File | Finding | Resolution`): every finding across ALL cycles replied without a code change (`All findings fixed with code
       changes.` if 0).
    2. `## Remaining Findings ({count})` (`# | Type | File | Finding | Why remaining`): only `not_addressed`/`failed` items, NOT `skipped` (`All findings resolved.` if
       0).

- **`"approved": false` → Process ALL actionable items in the same cycle** (never cherry-pick):
  1. Review thread comments (`thread_id` present) → Phases 2–8.
  2. Sticky findings (no `thread_id`, type starts with `qodo_`) → Phases 2–8.
  3. `qodo_cleanup_response` (if non-empty) → address every item ("fixed"/"addressed" → no code change; "still open/relevant/actionable" → fix code, commit, push; unclear
     → `uvx myk-pi-tools@latest reviews ask-qodo "<question>"`).
  Commit, push, and re-spawn the poll.

#### 9c: Exit Conditions (MANDATORY)

Exit ONLY when: (1) `reviews poll` returns `"approved": true`, OR (2) user explicitly sends `"stop"`, `"exit"`, `"done"`, or `"quit"` (or `Ctrl+C`).
**FORBIDDEN:** calling `AskUserQuestion`/asking to continue, exiting on "no new comments"/"loop seems complete"/command or API errors (log error, wait 5 min, retry 9a).
Emit concise `[auto]` progress lines (`Cycle {N} complete...`, `Checking...`, `Found {N} new comments...`, `No new comments...`, `CodeRabbit rate-limited...`, `🎉 {source}
approved...`).

## Qodo Review-Session Loops (Storage — MANDATORY)

`pr-review-session` loops bypass GitHub review comments until convergence, so every completed round MUST follow this exact order — store AFTER `mark-implemented` on a
**fresh** fetch (never store poll-time snapshots; re-storing refreshes attribution idempotently per UUID and keeps the JSON):

```bash
# 1. Poll
qodo read pr-review-session findings --pr-url <pr-url> --json 2>/dev/null | head -1 > ${PROJECT_TMP_DIR}/qodo-<pr>-<sha>.json
# 2. Fix and resolve
qodo pr-review-session mark-implemented --finding-ids <ids> --explanation "..." --json
# 3. Fresh fetch + idempotent DB store (repeat once more at clean convergence)
qodo read pr-review-session findings --pr-url <pr-url> --json 2>/dev/null | head -1 > ${PROJECT_TMP_DIR}/qodo-<pr>-<sha>.json
uvx myk-pi-tools@latest reviews store-session ${PROJECT_TMP_DIR}/qodo-<pr>-<sha>.json
```
