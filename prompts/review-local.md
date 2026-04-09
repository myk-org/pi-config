---
description: "Review uncommitted changes with 3 parallel reviewers — /review-local [BRANCH]"
---

Execute this workflow step by step.

## Step 1: Get the diff

**If `{{args}}` is provided (not empty):**

Compare current branch against the specified branch:

```bash
git diff "{{args}}"...HEAD
```

**If no argument provided:**

Get all uncommitted changes (staged + unstaged):

```bash
git diff HEAD
```

If the diff is empty, report "No changes to review" and stop.

## Step 2: Route to review agents (MANDATORY)

Use the subagent tool to run ALL 3 review agents IN PARALLEL (using the `tasks` array):

1. **code-reviewer-quality** — General code quality and maintainability
2. **code-reviewer-guidelines** — Project guidelines and style adherence
3. **code-reviewer-security** — Bugs, logic errors, and security vulnerabilities

Pass each agent the full diff and ask them to analyze for:

1. Code quality and best practices
2. Potential bugs or logic errors
3. Security vulnerabilities
4. Performance issues
5. Naming conventions and readability
6. Missing error handling
7. Code duplication
8. Suggestions for improvement

## Step 3: Present the review

Merge and deduplicate findings from all 3 reviewers:

- Same file/line + same issue = duplicate → keep most actionable
- Conflicting suggestions → priority: security > correctness > performance > style
- Complementary findings → keep both

Display grouped by:
- **Critical issues** (must fix)
- **Warnings** (should fix)
- **Suggestions** (nice to have)
