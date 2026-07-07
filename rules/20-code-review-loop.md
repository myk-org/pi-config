# Code Review Loop (MANDATORY)

After ANY code change, send to ALL 5 review agents. **Never skip the first review.**

If `review_loop_enforcement` is enabled (default: disabled).
Resolution: project `.pi/pi-config-settings.json` → global `~/.pi/pi-config-settings.json` → `PI_REVIEW_LOOP_ENFORCEMENT` env var → `false`.

- MUST loop until all reviewers return 0 findings
- Commit will be blocked until clean

If disabled:

- Single review pass is sufficient
- No commit blocking

**In both cases, all 5 reviewers are always called. The setting only controls whether the loop repeats.**

```text
1. Specialist writes/fixes code
2. Send to ALL 5 review agents IN PARALLEL (async)
3. Merge & deduplicate findings
4. Has comments? ──YES──→ For EACH finding: fix code OR explain why not (step 4a)
                    │     → go to 2 with prior findings + responses (if review_loop_enforcement enabled)
                    NO ↓
5. Run test-automator
6. Tests pass? ──NO──→ Minor fix? re-run tests (go to 5)
                        Substantive change? full re-review (go to 2)
               YES ↓
✅ DONE
```

## Review Agents

Five agents review code in parallel for comprehensive coverage:

| Agent | Focus |
|---|---|
| `code-reviewer-quality` | General code quality and maintainability |
| `code-reviewer-guidelines` | Project guidelines and style adherence (AGENTS.md) |
| `code-reviewer-security` | Bugs, logic errors, and security vulnerabilities |
| `code-reviewer-docs` | Documentation quality, completeness, and accuracy |
| `code-reviewer-spec` | Code/PR/issue spec alignment and compliance |

**All 5 MUST be invoked as async subagents (`async: true`) in the same assistant turn.
Do NOT block waiting for reviews — continue working while they run.**

Overlapping scope is intentional for comprehensive coverage; step 3's deduplication handles duplicates.

## Deduplication Criteria

Same file/line + same issue or root cause = duplicate — keep the most actionable version.
Conflicts follow priority: security > correctness > performance > style; complementary findings on the same code are kept.

## Step 4a: Respond to Findings (when `review_loop_enforcement` is enabled)

For each finding from step 3, do ONE of:

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
- You disagree with the reasoning (explain why)

Findings with valid explanations that you accept → do not re-raise.
Findings that were fixed in code → verify the fix, do not re-raise if correct.

{numbered list of findings with their fix/explanation}
</prior-review-cycle>
```

**Reviewers MUST respect valid responses:**

- If a finding was fixed → verify the fix is correct, don't re-raise
- If a finding was explained with a valid technical reason → accept it, don't re-raise
- If the explanation is wrong or the fix is incomplete → re-raise with specific pushback

**When `review_loop_enforcement` is disabled:** Step 4a is optional. Single review pass
is sufficient — fix what you agree with, skip what you don't. No need to explain skips.

## Key Rules

Never skip code review — loop until all reviewers approve AND tests pass.
If there are comments, respond to each (fix or explain) and re-review from step 2; once approved, run tests.
Minor test/config-only fixes skip re-review (go to step 5); substantive code changes require full re-review.

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
   Loop Stage 1 until passed.
2. **Stage 2 — Code Quality:** Quality, security, guidelines adherence.
   Loop Stage 2 until passed.

Don't polish code that doesn't meet spec — it wastes work.
Parallel mode (all 5 reviewers at once) remains default for manual reviews.
