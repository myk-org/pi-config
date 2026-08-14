# Code Review Loop (MANDATORY)

After ANY code change, send to ALL 6 agents (5 reviewers + test-automator) IN PARALLEL. **Never skip the first review.**

## Commit enforcement

{{IF:review_loop_enforcement}}
When `review_loop_enforcement` is enabled, the enforcement rule in `enforcement.ts` blocks `git commit` unless:

- Review status is `clean` (all reviewers returned 0 findings)
- `tests_passed: true` (test-automator or test command succeeded)

**You MUST run the review loop BEFORE attempting `git commit`.** The enforcement rule will reject the commit otherwise.
Do NOT try to work around it — run the actual review agents to reach `clean` status.

🚫 **NEVER manipulate review state directly.** Do not import `pi-config-review-state.ts`,
call `addReviewerPending`/`recordReviewerResult` from bash, write to the JSON file,
or use any method to fake a clean state. The enforcement system detects and blocks this.
The ONLY way to reach `clean` status is to run the actual review agents.

Resolution is handled automatically via project settings injection.

- MUST loop until clean or the max cycle cap is reached — see "Cycle Definition & Max Cycles" below.
{{/IF}}

{{IFNOT:review_loop_enforcement}}
Single review pass is sufficient — no commit blocking from the review loop.
Step 5a (fix/explain every finding) is optional: fix what you agree with, skip what you don't.
{{/IFNOT}}

**All 6 agents are always called.** `review_loop_enforcement` controls whether the loop repeats.

{{IF:review_loop_enforcement}}
When enabled, `review_loop_max_cycles` caps **total** cycles including the first (see Cycle Definition below).

### Cycle Definition & Max Cycles

One **cycle** = call all 6 reviewers (in parallel) → fix/explain findings → end of cycle.

**The cycle count IS the `cycle` field in `pi-config-review-state.jsonl`** — the same counter shown by
`/review-status` and the review UI status card. It increments each time reviewers are (re-)dispatched
for a fresh pass. Step 5's branches below MUST compare against that same counter — do not track cycles
mentally or separately.

The review loop repeats for at most `review_loop_max_cycles` cycles (default `3`, range `1`-`10` only;
current value: `{{REVIEW_LOOP_MAX_CYCLES}}`), including the first cycle. Invalid values fall through to the
next resolution layer / default `3` — see `dev-docs/project-settings.md` for the full resolution order.
Disable the review loop via `review_loop_enforcement: false` — not via max_cycles.

Cap check is after 5a; it only blocks `go to 2` (re-dispatch of step 2 / all 6 agents,
including test-automator), not completing the current cycle's fix/explain.

**After 5a completes on the max cycle, two outcomes** (report them; commit may still be
allowed via the max-cycle path — see step 6):

- **Not fixed** (explained why not) → outstanding — report them.
- **Fixed** (verification blocked by the cap) → cannot re-dispatch to confirm clean — report that
  verification is blocked by the cap, NOT "leftovers from skipping 5a".

**Example (`max_cycles=3`):**

```text
cycle1: dispatch → findings → 5a (fix|explain) → re-dispatch (cycle < max)
cycle2: dispatch → findings → 5a (fix|explain) → re-dispatch (cycle < max)
cycle3: dispatch → findings → 5a (fix|explain) → cycle >= max → stop (no cycle4)
```

```text
1. Specialist writes/fixes code
2. Send ALL 6 agents IN PARALLEL (async): 5 reviewers + test-automator
   **On cycle 2+: MANDATORY — include prior cycle findings + responses in each reviewer's prompt (see Step 5a format).**
   Reviewers without this context will blindly repeat the same findings. This is not optional.
3. Wait for all 6 to complete
4. Merge & deduplicate review findings
5. Has findings OR tests failed?
   ── Neither? ↓ status: clean, tests_passed: true
   ── Findings and/or tests failed? → ALWAYS run 5a first: fix code OR explain why not, for EACH finding;
      fix code for failing tests. Then check state.cycle (from `pi-config-review-state.jsonl`):
        · cycle < {{REVIEW_LOOP_MAX_CYCLES}}? → go to 2 (re-run all 6 with prior findings + responses)
        · cycle >= {{REVIEW_LOOP_MAX_CYCLES}}? → **STOP** (terminal): report the two-outcome result
          (see "Cycle Definition & Max Cycles" above). Do NOT proceed to step 6.
6. NOW you can commit — the pre-commit hook will pass when:
   - status is `clean` AND `tests_passed: true`, OR
   - max cycles exhausted (`has_findings` or `clean`, no pending reviewers, `cycle >= review_loop_max_cycles` — no `tests_passed` check)
✅ DONE — commit/push allowed
```

🚨 **Step 6 applies when clean OR max cycles exhausted.** Do NOT attempt `git commit` before that.
The enforcement rule blocks commits until this is satisfied — if it blocks you, run the reviewers.
**After a cap stop:** report the two-outcome result (**Not fixed** → outstanding, **Fixed** → verification
blocked); commit is allowed when status is `has_findings` or `clean`, no reviewers pending, and
`cycle >= review_loop_max_cycles` (no `tests_passed` requirement); do **not**
return to step 2 (re-dispatch of all 6 agents, including test-automator).
{{/IF}}

## Review Agents

Six agents run in parallel for comprehensive coverage:

| Agent | Focus |
|---|---|
| `code-reviewer-quality` | General code quality and maintainability |
| `code-reviewer-guidelines` | Project guidelines and style adherence (AGENTS.md) |
| `code-reviewer-security` | Bugs, logic errors, and security vulnerabilities |
| `code-reviewer-docs` | Documentation quality, completeness, and accuracy |
| `code-reviewer-spec` | Code/PR/issue spec alignment and compliance |
| `test-automator` | Run project tests (pytest, node tests, pre-commit) |

**All 6 MUST be invoked as async subagents (`async: true`) in the same assistant turn.
Do NOT block waiting for results — continue working while they run.**

Send reviewers "Review the code changes" — never mention `git diff HEAD` in the task prompt.
Reviewers get `$PI_REVIEW_BASE_BRANCH` env var and use `git diff origin/$PI_REVIEW_BASE_BRANCH` themselves (includes uncommitted changes).

Reviewers return structured JSON: `{"findings": [{"severity": "...", "file": "...", "line": N, "description": "...", "suggestion": "..."}]}`.
The async runner validates the output is valid JSON and retries if not (up to 3 times).

Overlapping scope is intentional for comprehensive coverage; step 4's deduplication handles duplicates.

## Deduplication Criteria

Same file/line + same issue or root cause = duplicate — keep the most actionable version.
Conflicts follow priority: security > correctness > performance > style; complementary findings on the same code are kept.

**Spec findings are never deduplicated against non-spec findings.** Findings from `code-reviewer-spec`
(missing deliverables, scope creep, spec misalignment) are never suppressed by findings from other
reviewers, even on the same file/line. A quality finding about *how* code is written does not
address *whether* the code matches the spec. Always keep both. Spec findings CAN still be
deduplicated against other spec findings when they are truly the same issue.

{{IF:review_loop_enforcement}}

## Step 5a: Respond to Findings

For each finding from step 4, do ONE of:

1. **Fix it** — change the code to address the finding
2. **Explain why not** — provide a specific technical reason (e.g., "pre-existing pattern,
   changing it would break X", "intentional for performance", "out of scope for this PR")

**Every finding MUST get a response. No silent ignoring.**

When re-running reviewers (step 2, cycle N+1), pass the prior cycle's findings and
responses in each reviewer's task prompt using this format:

```text
<prior-review-cycle>
The following findings were raised in review cycle {N}. Each has been either fixed or
explained. Do NOT re-raise findings that were adequately addressed. Only re-raise if:
- The code fix is incorrect or incomplete
- The explanation is invalid or factually wrong
- You disagree with the reasoning (state why in the finding description field)

Findings with valid explanations that you accept → do not re-raise.
Findings that were fixed in code → verify the fix, do not re-raise if correct.

{numbered list of findings with their fix/explanation}
</prior-review-cycle>
```

**Reviewers MUST respect valid responses:**

- If a finding was fixed → verify the fix is correct, don't re-raise
- If a finding was explained with a valid technical reason → accept it, don't re-raise
- If the explanation is wrong or the fix is incomplete → re-raise with specific pushback
{{/IF}}

## Key Rules

Never skip code review — all 6 agents always run (5 reviewers + test-automator).
Exception: on `chore/bump-version` branches (release version bumps), review dirty-tracking and commit blocking are skipped.
{{IF:review_loop_enforcement}}
When `review_loop_enforcement` is enabled: loop, respond to each finding (fix or explain), and re-run all 6 from step 2
until clean or the cycle cap is reached — see "Cycle Definition & Max Cycles" above for the exact stop conditions.
{{/IF}}
{{IFNOT:review_loop_enforcement}}
When `review_loop_enforcement` is disabled: single pass is sufficient; no mandatory re-loop or explanations.
{{/IFNOT}}
Minor test/config-only fixes skip re-review (go to step 5); substantive code changes require full re-review.

## Test Tracking

Test results are tracked in `pi-config-review-state.jsonl` via the `tests_passed` field.

{{IF:review_loop_enforcement}}
This is **code-enforced** — commit/push is blocked unless `tests_passed: true`.
{{/IF}}
{{IFNOT:review_loop_enforcement}}
Tests still run and `tests_passed` is still recorded; commit is not blocked by review state when enforcement is off.
{{/IFNOT}}

**How `tests_passed` gets set:**

- **Bash hook detection:** When any agent runs a test command (`pytest`, `npm test`, `npx tsx --test`, `tox`, `go test`, `vitest`, `jest`, `mocha`),
  the enforcement hook detects it and auto-marks `tests_passed` based on exit code.
- **Agent completion:** When `test-automator` or `test-runner` agents complete, their result auto-marks `tests_passed`.
- **Reset on edit:** Any file edit triggers `markNeedsReview()` (except on `chore/bump-version` branches), which resets `tests_passed: false` —
  preventing stale results.

**Duplicate test run avoidance:** If a specialist already ran tests before the review loop, `tests_passed` may already be `true`.
Any file edit resets it, so test-automator in the parallel batch always validates the latest code.

## Baseline Test Comparison (Step 5)

Compare against baseline before declaring test failures as blockers:

```bash
BASELINE_DIR="${PROJECT_TMP_DIR}"
mkdir -p "$BASELINE_DIR"

# 1. Save ALL changes (staged + unstaged + untracked)
git diff HEAD > "$BASELINE_DIR/baseline.patch"
git ls-files --others --exclude-standard > "$BASELINE_DIR/untracked.list"

# 2. Reset to clean state
git reset --hard HEAD
xargs -r -d '\n' rm -f < "$BASELINE_DIR/untracked.list" 2>/dev/null || true

# 3. Run tests → record baseline failure count

# 4. Restore changes
git apply "$BASELINE_DIR/baseline.patch" \
  || git apply --3way "$BASELINE_DIR/baseline.patch"

# 5. Clean up
rm -f "$BASELINE_DIR/baseline.patch" "$BASELINE_DIR/untracked.list"

# 6. Run tests → record current failure count
```

Only **new failures** (current minus baseline) block the review; pre-existing failures are noted but don't block.
If both `git apply` methods fail, skip baseline comparison and note "baseline comparison unavailable" — do NOT block on all failures.

## Staged Review Mode (Automated Workflows)

For automated review flows (autorabbit, autoqodo), use **two-stage order** instead of parallel:

1. **Stage 1 — Spec Compliance:** Does code meet requirements? All deliverables implemented? No scope creep?
{{IF:review_loop_enforcement}}
   Loop Stage 1 until passed OR the shared cycle cap is reached.
{{/IF}}
2. **Stage 2 — Code Quality:** Quality, security, guidelines adherence.
{{IF:review_loop_enforcement}}
   Loop Stage 2 until passed OR the shared cycle cap is reached.
{{/IF}}

{{IF:review_loop_enforcement}}
**Staged cycle definition:** one **cycle** = one pass of the *current* stage's reviewers (in parallel)
→ fix/explain that stage's findings → end of cycle. This mirrors the parallel-mode cycle definition
(see "Cycle Definition & Max Cycles" above), scoped to one stage's reviewers instead of all 6.

**The `review_loop_max_cycles` cap is shared across both stages — one total budget, not one per stage.**
Stage 1 and Stage 2 both draw from and increment the same `cycle` counter in
`pi-config-review-state.jsonl`. Cap check, 5a-before-cap, and two-outcome reporting follow
"Cycle Definition & Max Cycles" above. Stage-specific stops: if Stage 1 is **not clean** when the cap is hit, stop entirely — do not proceed
to Stage 2 (covers both **Not fixed** and **Fixed** (verification blocked)). If hit during Stage 2,
stop looping Stage 2.
{{/IF}}

Don't polish code that doesn't meet spec — it wastes work.
Parallel mode (all 6 agents at once) remains default for manual reviews.
