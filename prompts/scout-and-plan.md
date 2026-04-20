---
description: "Scout → plan without implementing — /scout-and-plan <task>"
argument-hint: "<task>"
---

## Raw Arguments

```text
$ARGUMENTS
```

Use the subagent tool with a chain of 2 agents:

1. **scout** — Explore the codebase to find all relevant code for the task from the raw arguments above.
   Return a compressed summary of file locations, key functions, and dependencies.

2. **planner** — Based on {previous}, create a detailed implementation plan:
   - Files to modify/create
   - Step-by-step changes
   - Edge cases to handle
   - Testing approach
