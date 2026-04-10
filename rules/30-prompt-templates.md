# Prompt Template Execution - Strict Rules

🚨 **CRITICAL: Prompt templates (`/command`) have SPECIAL execution rules**

## When a Prompt Template is Invoked

1. **EXECUTE IT DIRECTLY YOURSELF** - NEVER delegate to any agent
2. **ALL internal operations run DIRECTLY** - scripts, bash commands, everything
3. **Prompt template takes FULL CONTROL** - its instructions override general AGENTS.md rules
4. **General delegation rules are SUSPENDED** for the duration of the prompt template

## Execution Mode Comparison

| Scenario            | Normal Mode                | During Prompt Template |
|---------------------|----------------------------|------------------------|
| Run bash script     | Delegate to bash-expert    | Run directly           |
| Execute git command | Delegate to git-expert     | Run directly           |
| Any shell command   | Delegate to specialist     | Run directly           |

## Why These Rules Exist

- Prompt templates define their OWN workflow and agent routing
- The prompt template specifies exactly when/how to use agents
- Delegating the prompt template itself breaks its internal logic
- The orchestrator must maintain control to follow the prompt template's phases

## Enforcement

❌ **VIOLATION**: `/mycommand` → delegate to agent → agent runs the prompt
✅ **CORRECT**: `/mycommand` → orchestrator executes prompt directly → follows its internal rules

**If a prompt template's internal instructions say to use an agent, THEN use an agent. Otherwise, do it directly.**
