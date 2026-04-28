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
