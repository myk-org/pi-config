# Code Review Loop (MANDATORY)

After ANY code change, follow this loop:

```text
┌───────────────────────────────────────────────────────────────────┐
│  1. Specialist writes/fixes code                                 │
│              ↓                                                   │
│  2. Send to ALL 3 review agents IN PARALLEL:                     │
│     - `code-reviewer-quality`                                    │
│     - `code-reviewer-guidelines`                                 │
│     - `code-reviewer-security`                                   │
│              ↓                                                   │
│  3. Merge findings from all 3 reviewers                          │
│              ↓                                                   │
│  4. Has comments from ANY reviewer? ──YES──→ Fix code (go to 2)  │
│              │                                                   │
│             NO                                                   │
│              ↓                                                   │
│  5. Run `test-automator`                                         │
│              ↓                                                   │
│  6. Tests pass? ──NO──→ Fix code                                 │
│              │              ↓                                    │
│              │         Minor fix (test/config only)?             │
│              │           YES → re-run tests (go to 5)           │
│              │           NO  → full re-review (go to 2)         │
│             YES                                                  │
│              ↓                                                   │
│  ✅ DONE                                                         │
└───────────────────────────────────────────────────────────────────┘
```

## Review Agents

Three agents review code in parallel for comprehensive coverage:

| Agent | Focus |
|---|---|
| `code-reviewer-quality` | General code quality and maintainability |
| `code-reviewer-guidelines` | Project guidelines and style adherence (AGENTS.md) |
| `code-reviewer-security` | Bugs, logic errors, and security vulnerabilities |

**All 3 MUST be invoked as async subagents (`async: true`) in the same assistant turn.
Do NOT block waiting for reviews — continue working while they run.
Results surface automatically when complete.**

**Note:** The overlapping scope between reviewers is intentional. Multiple reviewers examining similar areas
ensures comprehensive coverage and reduces the chance of missed issues.
Step 3's deduplication (see below) handles any duplicate findings.

## Deduplication Criteria

When merging findings from all 3 reviewers (step 3), apply these rules:

- **Same file/line range + same issue type or root cause** = duplicate. Keep the most actionable version.
- **Conflicting suggestions** = follow priority order: security > correctness > performance > style. If still ambiguous, escalate to the user.
- **Complementary findings on the same code** (different issue types) = keep both.

## Key Rules

**Never skip code review. Loop until all reviewers approve.**

The process is iterative:

1. Code is written or modified by a specialist
2. All 3 review agents run in parallel
3. Merge and deduplicate findings from all reviewers (see "Deduplication Criteria" above)
4. If there are comments, fix the code and repeat from step 2
5. Once approved, run tests
6. If tests fail, fix the code. Minor test/config-only fixes can skip re-review and go to step 5. Substantive code changes require full re-review from step 2
7. Only complete when all reviewers approve AND tests pass

## Baseline Test Comparison (Step 5)

Before declaring test failures as blockers, compare against the baseline:

```bash
BASELINE_DIR="/tmp/pi-work/$(basename "$PWD")"
mkdir -p "$BASELINE_DIR"

# 1. Save ALL changes (staged + unstaged + untracked)
git diff HEAD > "$BASELINE_DIR/baseline.patch"
git ls-files --others --exclude-standard > "$BASELINE_DIR/untracked.list"

# 2. Reset to clean state
git reset --hard HEAD
# Remove untracked files listed (if any)
xargs -r rm -f < "$BASELINE_DIR/untracked.list" 2>/dev/null || true

# 3. Run tests → record baseline failure count
# <run tests here>

# 4. Restore changes
git apply "$BASELINE_DIR/baseline.patch" \
  || git apply --3way "$BASELINE_DIR/baseline.patch"

# 5. Clean up
rm -f "$BASELINE_DIR/baseline.patch" "$BASELINE_DIR/untracked.list"

# 6. Run tests → record current failure count
# <run tests here>
```

- **Only NEW failures** (current minus baseline) block the review
- Pre-existing failures are noted in the review but do not block
- If both `git apply` and `git apply --3way` fail, skip baseline comparison
  and note "baseline comparison unavailable" — do NOT block on all failures
- Untracked files are saved/restored separately since `git diff` doesn't capture them

This prevents blocking on test failures that existed before the PR.

## Staged Review Mode (Automated Workflows)

For automated review flows (autorabbit, autoqodo), use **two-stage review order**
instead of parallel review:

```text
┌─────────────────────────────────────────────────────────────────┐
│  Stage 1: Spec Compliance                                       │
│  - Does the code meet the requirements/spec?                    │
│  - Are all deliverables implemented?                            │
│  - No scope creep?                                              │
│              ↓                                                  │
│  Stage 1 passed?  ──NO──→ Fix spec issues first (loop Stage 1)  │
│              │                                                  │
│             YES                                                 │
│              ↓                                                  │
│  Stage 2: Code Quality                                          │
│  - Code quality and maintainability                             │
│  - Security and bugs                                            │
│  - Project guidelines adherence                                 │
│              ↓                                                  │
│  Stage 2 passed?  ──NO──→ Fix quality issues (loop Stage 2)     │
│              │                                                  │
│             YES                                                 │
│              ↓                                                  │
│  ✅ DONE                                                         │
└─────────────────────────────────────────────────────────────────┘
```

**Why staged?** Don't polish code that doesn't meet spec — it wastes work.
The parallel mode (all 3 reviewers at once) remains the default for manual reviews.
