---
description: "Implement → 3 parallel reviewers → fix — /implement-and-review <task>"
---

## Raw Arguments

```text
$ARGUMENTS
```

Use the subagent tool with a chain of agents:

1. **worker** — Implement the task from the raw arguments above.
   Make all necessary code changes following project conventions.

2. Run 3 review subagents **in parallel**:
   - **code-reviewer-quality** — Review {previous} for code quality
   - **code-reviewer-guidelines** — Review {previous} for guideline adherence
   - **code-reviewer-security** — Review {previous} for bugs and security

3. **worker** — Based on the review feedback from {previous}, fix all issues found.
   Then report what was fixed.
