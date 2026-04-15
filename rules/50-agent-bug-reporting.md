# Agent Bug Reporting

## Scope

> **If you are a SPECIALIST AGENT:**
> IGNORE this rule. This is for the ORCHESTRATOR only.

---

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
- frontend-expert
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

---

## When to Trigger

**Trigger this process when you discover:**

- Flawed logic in an agent's instructions (in `agents/` directory - see scope list above)
- An agent producing incorrect results due to its configuration
- An agent's behavior contradicting its intended purpose
- Agent instructions that cause systematic errors

**DO NOT trigger for:**

- Runtime errors (network failures, missing files, etc.)
- External tool failures
- User code bugs (those are normal review feedback)
- Expected behavior that user disagrees with
- Bugs in built-in pi agents (not in this repository)

---

## Workflow

```text
┌─────────────────────────────────────────────────┐
│  Orchestrator discovers agent logic bug         │
│                    ↓                            │
│  ASK USER: "I found a logic bug in [agent].     │
│             Do you want me to create a          │
│             GitHub issue for this?"             │
│                    ↓                            │
│          User responds YES/NO                   │
│                    │                            │
│           ┌────────┴────────┐                   │
│          YES              NO                    │
│           │                 │                   │
│           ↓                 ↓                   │
│  Delegate to github-expert  │                   │
│  to create issue            │                   │
│           │                 │                   │
│           └────────┬────────┘                   │
│                    ↓                            │
│  Continue with original task                    │
│  (fix bug or apply workaround)                  │
└─────────────────────────────────────────────────┘
```

---

## Issue Creation Format

**Repository:** `myk-org/pi-config`

**Title format:** `bug(agents): [agent-name] - brief description`

**Body template:**

```markdown
## Agent
[Agent name from agents/ directory]

## Bug Description
[Clear description of the logic flaw in the agent's instructions]

## Expected Behavior
[What the agent should do according to its purpose]

## Actual Behavior
[What the agent actually does due to the flawed logic]

## Impact
[How this affects users/workflows]

## Suggested Fix
[Proposed change to agent instructions, if known]

## Context
[Any additional context about when/how the bug was discovered]
```

---

## Example Interaction

```text
Orchestrator: "I found a logic bug in git-expert. The merged branch
check incorrectly flags fresh branches as 'already merged' when the
branch HEAD equals main HEAD, even though the branch has never been
merged.

Do you want me to create a GitHub issue for this?"

User: "yes"

Orchestrator: [Delegates to github-expert with issue details]
Orchestrator: "Issue #42 created: bug(agents): git-expert - false
positive on merged branch detection. Now let me fix the bug with a
workaround..."
```

---

## Key Rules

1. **Always ask first** - Never auto-create issues without user confirmation
2. **Use github-expert** - Delegate issue creation to github-expert agent (don't use gh commands directly)
3. **Continue working** - After issue creation (or skip), continue with the original task
4. **Be specific** - Clearly identify which agent and which part of its logic is flawed
5. **Suggest fixes** - If you know how to fix the agent's instructions, include it in the issue
