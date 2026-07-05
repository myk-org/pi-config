# Code Review Loop (MANDATORY)

After ANY code change, follow this loop:

```text
1. Specialist writes/fixes code
2. Send to ALL 4 review agents IN PARALLEL (async)
3. Merge & deduplicate findings
4. Has comments? ──YES──→ Fix code → go to 2
                    NO ↓
5. Run test-automator
6. Tests pass? ──NO──→ Minor fix? re-run tests (go to 5)
                        Substantive change? full re-review (go to 2)
               YES ↓
✅ DONE
```

## Review Agents

Four agents review code in parallel for comprehensive coverage:

| Agent | Focus |
|---|---|
| `code-reviewer-quality` | General code quality and maintainability |
| `code-reviewer-guidelines` | Project guidelines and style adherence (AGENTS.md) |
| `code-reviewer-security` | Bugs, logic errors, and security vulnerabilities |
| `code-reviewer-docs` | Documentation quality, completeness, and accuracy |

**All 4 MUST be invoked as async subagents (`async: true`) in the same assistant turn.
Do NOT block waiting for reviews — continue working while they run.**

Overlapping scope is intentional for comprehensive coverage; step 3's deduplication handles duplicates.

## Deduplication Criteria

Same file/line + same issue or root cause = duplicate — keep the most actionable version.
Conflicts follow priority: security > correctness > performance > style; complementary findings on the same code are kept.

## Key Rules

Never skip code review — loop until all reviewers approve AND tests pass.
If there are comments, fix and re-review from step 2; once approved, run tests.
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
Parallel mode (all 4 reviewers at once) remains default for manual reviews.
