# Delegating Tasks to Specialist Agents

Route your work to the right specialist agent so each task is handled by an expert with the right tools and knowledge. Delegation keeps the orchestrator focused on planning and coordination while agents handle implementation, review, testing, and debugging in parallel.

## Prerequisites

- pi is installed and configured
- The orchestrator extension is active (enabled by default)

## Quick Example

Delegate a single task to a Python specialist:

```
subagent(
  agent: "python-expert",
  task: "Add type hints to all public functions in src/models.py",
  cwd: "/path/to/repo",
  estimatedSeconds: 30
)
```

The orchestrator sends the task, waits for the result, and returns the agent's output.

## Choosing the Right Agent

The orchestrator routes by **intent**, not by tool. Pick the agent that matches what you're trying to accomplish.

| Domain | Agent | Use When |
|--------|-------|----------|
| Python (.py) | `python-expert` | Writing, fixing, or refactoring Python code — including running Python tests |
| Go (.go) | `go-expert` | Go code changes |
| Frontend (JS/TS/React/Vue) | `frontend-expert` | JavaScript, TypeScript, or frontend framework code |
| Java (.java) | `java-expert` | Java code changes |
| Shell scripts (.sh) | `bash-expert` | Writing or editing shell scripts |
| Docker | `docker-expert` | Dockerfiles and container configuration |
| Kubernetes/OpenShift | `kubernetes-expert` | Cluster manifests and deployments |
| Jenkins/CI | `jenkins-expert` | CI pipeline and Groovy scripts |
| Git (local) | `git-expert` | Commits, branches, merges — local git operations |
| GitHub | `github-expert` | PRs, issues, releases, GitHub workflows |
| Tests | `test-automator` | Writing and running tests |
| Debugging | `debugger` | Investigating failures and tracing bugs |
| Docs (project) | `technical-documentation-writer` | Project markdown documentation |
| Docs (API) | `api-documenter` | API reference documentation |
| Docs (external) | `docs-fetcher` | Fetching external library/framework docs (React, FastAPI, etc.) |
| Security | `security-auditor` | Security audits of external repos |
| Code review | `code-reviewer-quality` | Code quality and maintainability review |
| Code review | `code-reviewer-guidelines` | Project guideline adherence review |
| Code review | `code-reviewer-security` | Bug, logic error, and security review |
| Exploration | `scout` | Fast codebase reconnaissance |
| Planning | `planner` | Detailed implementation plans |
| General | `worker` | Anything that doesn't match a specialist |

> **Tip:** Route by what you want done, not the file type. Running Python tests? Use `python-expert`, not `bash-expert`. Creating a PR? Use `github-expert`, not `git-expert`.

## Delegation Modes

pi supports four delegation modes. Pick the one that matches your task structure.

| Mode | When to Use | Time Limit |
|------|-------------|------------|
| **Single** | One agent, one task | < 60 seconds |
| **Parallel** | Multiple independent tasks at once | < 60 seconds per task |
| **Chain** | Sequential steps where each depends on the previous | Sum of all steps < 60 seconds |
| **Async** | Long-running or fire-and-forget tasks | No limit |

### Single Delegation

Send one task to one agent. The orchestrator waits for the result before continuing.

```
subagent(
  agent: "go-expert",
  task: "Fix the nil pointer dereference in handler.go",
  cwd: "/path/to/repo",
  estimatedSeconds: 25
)
```

Required parameters:
- `agent` — the specialist to use
- `task` — what to do
- `cwd` — the working directory
- `estimatedSeconds` — how long you expect it to take (must be under 60)

### Parallel Delegation

Run multiple independent tasks at the same time. Up to 8 tasks can be submitted, with 4 running concurrently.

```
subagent(
  tasks: [
    {
      agent: "code-reviewer-quality",
      task: "Review the changes in src/ for code quality",
      cwd: "/path/to/repo",
      estimatedSeconds: 20,
      name: "Quality Review"
    },
    {
      agent: "code-reviewer-security",
      task: "Review the changes in src/ for security issues",
      cwd: "/path/to/repo",
      estimatedSeconds: 25,
      name: "Security Review"
    },
    {
      agent: "code-reviewer-guidelines",
      task: "Review the changes in src/ for guideline adherence",
      cwd: "/path/to/repo",
      estimatedSeconds: 20,
      name: "Guidelines Review"
    }
  ]
)
```

The time estimate uses the **longest single task** (not the sum), since tasks run concurrently.

> **Note:** Each parallel task still needs its own `cwd` and `estimatedSeconds`. The maximum of all `estimatedSeconds` values must be under 60.

### Chain Delegation

Run tasks sequentially, passing each result to the next step with the `{previous}` placeholder.

```
subagent(
  chain: [
    {
      agent: "scout",
      task: "Find all authentication-related code in this repo",
      cwd: "/path/to/repo",
      estimatedSeconds: 15
    },
    {
      agent: "planner",
      task: "Create an implementation plan for OAuth support based on: {previous}",
      cwd: "/path/to/repo",
      estimatedSeconds: 20
    },
    {
      agent: "worker",
      task: "Implement the OAuth changes described in: {previous}",
      cwd: "/path/to/repo",
      estimatedSeconds: 20
    }
  ]
)
```

Key details:
- `{previous}` is replaced with the output from the prior step
- Time estimates are **summed** across all steps (15 + 20 + 20 = 55 seconds total)
- The total sum must be under 60 seconds — use async for longer chains
- If any step fails, the entire chain stops

### Async Delegation

For tasks that take longer than 60 seconds, or when you don't need to wait for the result, use async mode. The agent runs in the background and results surface automatically when complete.

**Single async task:**

```
subagent(
  agent: "security-auditor",
  task: "Perform a full security audit of this repository",
  cwd: "/path/to/repo",
  async: true,
  name: "Security Audit"
)
```

**Multiple async tasks in parallel:**

```
subagent(
  tasks: [
    {
      agent: "code-reviewer-quality",
      task: "Review all changes on this branch",
      cwd: "/path/to/repo",
      name: "Quality Review"
    },
    {
      agent: "code-reviewer-security",
      task: "Review all changes on this branch",
      cwd: "/path/to/repo",
      name: "Security Review"
    }
  ],
  async: true
)
```

Required for async:
- `async: true`
- `name` — a display label for the status line (e.g., `"Security Audit"`, `"PR #42"`)
- No `estimatedSeconds` needed

> **Note:** Async mode does not support chains. Use single or parallel tasks only.

Use `/async-status` to check progress on running background agents.

#### Fire-and-Forget Tasks

For maintenance tasks where you don't need the result delivered back (like memory consolidation), add `fireAndForget: true`:

```
subagent(
  agent: "worker",
  task: "Consolidate and clean up memory files",
  cwd: "/path/to/repo",
  async: true,
  fireAndForget: true,
  name: "Memory Cleanup"
)
```

The agent runs silently in the background. You get a terminal notification on completion, but no result is injected into the conversation.

#### Killing Async Agents

Stop a running background agent by name, ID prefix, or all at once:

```
subagent(asyncKill: "Security Audit")
subagent(asyncKill: "all")
```

## Built-in Workflows

pi includes slash commands that combine delegation modes into common workflows. These are ready to use out of the box.

### `/implement` — Scout, Plan, Build

A three-step chain: `scout` explores the codebase, `planner` creates a plan, `worker` implements it.

```
/implement Add rate limiting to the /api/upload endpoint
```

### `/implement-and-review` — Build, Review, Fix

Implements a task, runs three code reviewers in parallel, then fixes any issues found.

```
/implement-and-review Refactor the user auth module to use JWT tokens
```

### `/scout-and-plan` — Explore and Plan (No Implementation)

A two-step chain: `scout` explores the codebase, `planner` creates a detailed plan — without making any changes.

```
/scout-and-plan Migrate the database layer from SQLAlchemy to asyncpg
```

## The Code Review Loop

After any code change, the orchestrator runs a mandatory review cycle using three reviewers in parallel:

1. A specialist writes or fixes code
2. Three reviewers run **in parallel** (as async subagents):
   - `code-reviewer-quality` — code quality and maintainability
   - `code-reviewer-guidelines` — project guideline adherence
   - `code-reviewer-security` — bugs, logic errors, and security
3. Findings are merged and deduplicated
4. If any reviewer has comments, the code is fixed and reviewers run again (back to step 2)
5. Once all reviewers approve, `test-automator` runs tests
6. If tests pass, the task is done. If they fail, the code is fixed and the loop continues

When reviewers produce conflicting suggestions, priority order is: **security > correctness > performance > style**.

> **Warning:** Never skip the review loop. It runs until all three reviewers approve AND tests pass.

## Advanced Usage

### Agent Scopes

By default, agents are loaded from the bundled package and your user directory (`~/.pi/agent/agents/`). You can change the scope to include project-local agents:

| Scope | Sources |
|-------|---------|
| `"user"` (default) | Bundled + user agents |
| `"project"` | Bundled + project agents (from `.pi/agents/` in the repo) |
| `"both"` | Bundled + user + project agents |

```
subagent(
  agent: "my-custom-agent",
  task: "Run the custom linter",
  cwd: "/path/to/repo",
  estimatedSeconds: 15,
  agentScope: "project"
)
```

When project agents are used, the orchestrator prompts for confirmation before running them. Disable this with `confirmProjectAgents: false`.

> **Note:** If a user agent and a project agent share the same name, the project agent takes priority (when in scope).

### Creating Custom Agents

Define a custom agent as a Markdown file with YAML frontmatter:

```markdown
---
name: my-linter
description: Runs project-specific linting rules
tools: read, bash
model: claude-haiku-4-5
---

You are a linting specialist. Run the project linter and report findings.

Always use the project's configured lint command from package.json.
```

Place the file in:
- `~/.pi/agent/agents/` for personal agents (available in all projects)
- `.pi/agents/` in your repository root for project-specific agents

The `tools` field controls which tools the agent can use (`read`, `write`, `edit`, `bash`). The `model` field optionally overrides the default model.

### Sync vs. Async Decision Guide

| Scenario | Mode | Why |
|----------|------|-----|
| Fix a single bug | Single (sync) | Quick, need result immediately |
| Three code reviewers | Parallel (async) | Independent, don't block on results |
| Scout → plan → implement | Chain (sync) | Each step needs the previous result |
| Full security audit | Single (async) | Takes too long for sync |
| Open a GitHub issue | Single (sync) | Fast, need confirmation it was created |
| Memory consolidation | Single (async, fire-and-forget) | Background maintenance, no result needed |

> **Tip:** Default to `async: true` for independent tasks. Only use sync when the very next step depends on this agent's output.

## Troubleshooting

**"Estimated time exceeds 60s sync limit"**
Your `estimatedSeconds` is 60 or more. Add `async: true` to run the task in the background, or break it into smaller steps.

**"Unknown agent" error**
The agent name doesn't match any available agent. Check the agent scope — project agents need `agentScope: "project"` or `"both"`.

**"Missing required parameter: cwd"**
Every delegation call needs a `cwd`. Always specify the working directory for the target repo.

**"Async agents require a name"**
All async tasks must include a `name` field for the status line. Add a short descriptive label like `"Code Review"` or `"PR #42"`.

**Chain stops at an intermediate step**
If any chain step fails (non-zero exit or error), the entire chain halts. Check the error output for that step. The `{previous}` placeholder only works if the prior step succeeded.

**Too many parallel tasks**
The maximum is 8 tasks per parallel call, with 4 running concurrently. Split larger batches into multiple calls.
