# Agent Bug Reporting

## Scope

> **If you are a SPECIALIST AGENT:**
> IGNORE this rule. This is for the ORCHESTRATOR only.

When the orchestrator discovers a logic flaw or bug in an agent's configuration or instructions, follow this workflow.

## Agents Covered by This Rule

This rule applies ONLY to agents defined in this repository (`agents/` directory):

- api-documenter
- bash-expert
- code-reviewer-quality
- code-reviewer-guidelines
- code-reviewer-security
- debugger
- docs-fetcher
- docker-expert
- ts-expert
- git-expert
- github-expert
- go-expert
- java-expert
- jenkins-expert
- kubernetes-expert
- planner
- python-expert
- reviewer
- scout
- security-auditor
- technical-documentation-writer
- test-automator
- test-runner
- worker

**NOT covered:** Built-in pi agents or agents from other sources.

## When to Trigger

**Trigger** when you find flawed logic, incorrect results, contradictory behavior, or systematic errors in an agent's instructions (in `agents/` directory — see scope list above).
**Do NOT trigger** for runtime/external failures, user code bugs, expected behavior the user disagrees with, or bugs in built-in pi agents.

## Workflow

1. **Ask user:** "I found a logic bug in [agent]. Do you want me to create a GitHub issue for this?"
2. **If yes:** Delegate to `github-expert` to create the issue in `myk-org/pi-config`.
3. **Continue** with the original task (fix bug or apply workaround) regardless of the answer.

## Issue Creation Format

**Title:** `bug(agents): [agent-name] - brief description`

**Body template:**

```markdown
## Agent
[Agent name from agents/ directory]

## Bug Description
[Clear description of the logic flaw]

## Expected Behavior
[What the agent should do]

## Actual Behavior
[What the agent actually does]

## Suggested Fix
[Proposed change, if known]

## Impact
[How this affects users/workflows]
```

## Key Rules

Always ask user before creating an issue — never auto-create.
Delegate issue creation to `github-expert` (don't use `gh` commands directly).
Be specific about which agent and which logic is flawed, and suggest a fix if you know one.
