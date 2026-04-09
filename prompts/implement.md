---
description: "Scout → plan → implement a task — /implement <task>"
---
Use the subagent tool with a chain of 3 agents:

1. **scout** — Explore the codebase to find all relevant code for: {{task}}
   Return a compressed summary of file locations, key functions, and dependencies.

2. **planner** — Based on {previous}, create a detailed implementation plan:
   - Files to modify/create
   - Step-by-step changes
   - Edge cases to handle
   - Testing approach

3. **worker** — Based on {previous}, implement the plan:
   - Make all code changes
   - Follow project conventions
   - Handle edge cases identified in the plan

Task: {{task}}
