# Test Plan: feat/issue-634-test-results-in-review-state

> Note: `review-state.json` was renamed to `pi-config-review-state.json` in a later PR.

## Feature

Integrate `tests_passed` into `pi-config-review-state.json`. Commit/push blocked unless both
`status: clean` AND `tests_passed: true`. 6 agents run in parallel (5 reviewers + test-automator).

## Prerequisites

- `review_loop_enforcement` enabled in `.pi/pi-config-settings.json`
- Branch: `feat/issue-634-test-results-in-review-state`
- Extensions, rules, agents deployed locally

---

## Tests

| # | Test | How | Expected | Pass? |
|---|------|-----|----------|-------|
| 1 | Commit blocked (no review, no tests) | Delegate commit to git-expert | Blocked — `needs_review` + `tests_passed: false` | ✅ |
| 2 | 6 agents in parallel | Spawn 5 reviewers + test-automator all at once | All 6 run in parallel | ✅ |
| 3 | Happy path | Wait for all 6 to complete (0 findings + tests pass) | `status: clean`, `tests_passed: true` | ✅ |
| 4 | Commit allowed | Delegate commit to git-expert | Should succeed (not blocked) | ✅ |
| 5 | Edit resets both | Edit a file after test 4 | `status: needs_review`, `tests_passed: false` | ✅ |
| 6 | Commit blocked after edit | Delegate commit to git-expert | Blocked — mentions review + tests | ✅ |
| 7 | Reviewers pass, tests not run | Run only 5 reviewers (no test-automator) → all clean | `status: clean`, `tests_passed: false`, git-expert blocked with "Tests have not passed" | ✅ |
| 8 | Bash hook detection | Run `uv run --group tests pytest` manually | `tests_passed` flips to `true`, git-expert now succeeds | ✅ |
| 9 | Tests pass outside loop, then edit | After test 8 succeeds, edit a file | `tests_passed` resets to `false`, git-expert blocked again | ✅ |
| 10 | Tests pass outside loop, no edit | Run pytest ad-hoc (no edit after) → check review_status | `tests_passed: true` sticks, but `status` still `needs_review` → git-expert still blocked (needs both) | ✅ |

## Result

**10/10 PASS** — All tests verified on 2026-07-09.
