## Prerequisites

- A working pi session with the orchestrator loaded (see [Installing and Starting Your First Session](quickstart.html))
- Familiarity with basic pi interactions (see [Your First Coding Workflow](first-workflow.html))

## Quick Example

Just tell pi what you need — the orchestrator routes it to the right agent automatically:

```
Fix the bug in src/auth/login.py where expired tokens aren't rejected
```

The orchestrator reads your request, identifies it involves Python code, and delegates to `python-expert`. You don't need to name the agent — routing happens based on the task's intent.

## How Routing Works

The orchestrator follows a routing table that maps task domains to specialist agents. When you make a request, it analyzes the **intent** of your task — not just the tools or file types involved — and picks the best agent.

### The Routing Table

| Domain | Agent | When It's Used |
|--------|-------|----------------|
| Python (.py) | `python-expert` | Writing, modifying, refactoring, or debugging Python code |
| Go (.go) | `go-expert` | Go development tasks |
| JS/TS/React/Vue/Angular | `ts-expert` | Frontend and TypeScript/JavaScript work |
| Java (.java) | `java-expert` | Java development tasks |
| Shell scripts (.sh) | `bash-expert` | Creating or editing shell scripts |
| Markdown (.md) | `technical-documentation-writer` | Writing documentation |
| Docker | `docker-expert` | Dockerfiles, container orchestration, image builds |
| Kubernetes/OpenShift | `kubernetes-expert` | Cluster configs, deployments, pods |
| Jenkins/CI/Groovy | `jenkins-expert` | CI pipeline configuration |
| Git (local) | `git-expert` | Commits, branching, rebasing, stash |
| GitHub (platform) | `github-expert` | PRs, issues, releases, workflows |
| Tests | `test-automator` | Creating test suites and CI pipelines |
| Debugging | `debugger` | Root cause analysis of errors and failures |
| API documentation | `api-documenter` | Generating API docs |
| External docs | `docs-fetcher` | Fetching library/framework documentation |
| Security audits | `security-auditor` | Auditing external code before adoption |
| No specialist match | `worker` | General-purpose fallback for anything else |

### Intent-Based Routing

The orchestrator routes by what you're **trying to accomplish**, not just the tools being used:

| Your Request | Routed To | Why |
|---|---|---|
| "Run the Python tests" | `python-expert` | The intent is testing Python code |
| "Edit `auth.py` using sed" | `python-expert` | The target is a Python file, regardless of the tool |
| "Create a PR for this branch" | `github-expert` | PR creation is a GitHub platform operation |
| "Commit these changes" | `git-expert` | Committing is a local git operation |
| "How do I use React hooks?" | `docs-fetcher` | Fetching external documentation |
| "Write a deploy script" | `bash-expert` | Creating a shell script |

> **Tip:** If the orchestrator ever routes to the wrong agent, just tell it: "Use python-expert for this" — it'll correct course immediately.

## Delegation Modes

The orchestrator can delegate work in three modes depending on your task's structure.

### Single Agent

One agent handles one task. This is the most common mode:

```
Refactor the database connection pool in src/db/pool.py
```

The orchestrator sends this to `python-expert`, waits for the result, and presents it to you.

### Parallel Agents

Multiple independent tasks run simultaneously:

```
Review these changes for quality, guidelines compliance, and security issues
```

The orchestrator spawns all three review agents (`code-reviewer-quality`, `code-reviewer-guidelines`, `code-reviewer-security`) at the same time and merges their findings. See [Running the Automated Code Review Loop](code-review-loop.html) for details.

### Chain Mode

Sequential agents where each step feeds into the next. The `/implement` slash command uses this pattern:

```
/implement Add rate limiting to the API endpoints
```

This runs a three-step chain:

1. **`scout`** — Explores the codebase to find relevant files and dependencies
2. **`planner`** — Creates a detailed implementation plan from the scout's findings
3. **`worker`** — Implements the plan, making all code changes

Each step receives the previous step's output via the `{previous}` placeholder. The `/scout-and-plan` command works the same way but stops after step 2 (no implementation).

## Sync vs Async Delegation

Agents run in one of two modes depending on how long the task takes and whether the orchestrator needs the result immediately.

### Sync Agents (Default)

The orchestrator waits for the result before continuing. Used when the next step depends on this agent's output. Sync agents must complete in under 30 seconds.

### Async Agents (Background)

The agent runs in the background while you keep working. Results surface automatically when complete. Use `/async-status` to check progress.

> **Note:** Three agents are **always** forced to run async, even if requested as sync: `code-reviewer-quality`, `code-reviewer-guidelines`, and `code-reviewer-security`. This prevents long code reviews from blocking your session.

See [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) for the full async workflow.

## Agent Discovery and Scope

Agents are loaded from three locations, with later sources overriding earlier ones by name:

| Priority | Source | Location |
|----------|--------|----------|
| 1 (base) | Package agents | Bundled with pi-config (24 built-in agents) |
| 2 | User agents | `~/.pi/agent/agents/` |
| 3 (highest) | Project agents | `.pi/agents/` in your project directory |

This means you can override any built-in agent by placing a file with the same `name` in your user or project agents directory.

### Agent Scope Control

When the orchestrator delegates, it can control which agent directories are searched:

| Scope | Package | User | Project |
|-------|---------|------|---------|
| `user` (default) | ✅ | ✅ | ❌ |
| `project` | ✅ | ❌ | ✅ |
| `both` | ✅ | ✅ | ✅ |

> **Note:** When project agents are used (`project` or `both` scope), pi prompts for confirmation before running them. This protects against unexpected code in project-local agent definitions.

## Advanced Usage

### Creating Project-Local Agents

You can define agents specific to your project by placing markdown files in `.pi/agents/`:

```markdown
---
name: my-api-agent
description: Handles API endpoint creation following our internal conventions.
tools: read, write, edit, bash
---

You are an API specialist for this project. Follow these conventions:

- Use FastAPI with Pydantic v2 models
- All endpoints go in src/api/routes/
- Every endpoint needs OpenAPI documentation
- Use dependency injection for database sessions
```

Each agent file needs YAML frontmatter with at least `name` and `description`. The optional `tools` field controls which tools the agent can use (comma-separated). You can also set `model` and `provider` to override the default LLM.

> **Tip:** Project agents are great for encoding project-specific conventions that don't apply globally. See [Customization and Extension Recipes](customization-recipes.html) for step-by-step instructions.

### Overriding a Built-In Agent

To customize a built-in agent's behavior for your project, create a file in `.pi/agents/` with the same `name` frontmatter value:

```markdown
---
name: python-expert
description: Python expert with project-specific conventions.
tools: read, write, edit, bash
---

You are a Python Expert. In addition to standard Python best practices:

- Always use SQLAlchemy 2.0 style (not legacy)
- Use pydantic-settings for all configuration
- Run `make lint` after every change
```

This project-level `python-expert` completely replaces the built-in one when working in this project.

### Overriding Routing with Model Pinning

Individual agents can be pinned to specific models using the `model` and `provider` fields in the frontmatter:

```markdown
---
name: scout
description: Fast codebase reconnaissance.
tools: read, bash
model: claude-haiku-4-5
---
```

The `scout` agent uses a faster, cheaper model by default because its job is quick reconnaissance, not deep analysis. You can apply this pattern to any agent — use a powerful model for complex tasks and a lightweight one for simple ones.

### The Fallback Agent

When no specialist matches your request, the orchestrator delegates to `worker` — a general-purpose agent with full capabilities (read, write, edit, bash). The worker handles any task that doesn't fit a specialist's domain.

If the worker identifies during execution that a task would be better handled by a specialist, it reports back and the orchestrator re-routes.

### Documentation Routing

When you ask about external libraries or frameworks, the orchestrator **must** delegate to `docs-fetcher` rather than fetching documentation directly. The `docs-fetcher` agent:

1. Checks for `llms.txt` first (documentation optimized for LLMs)
2. Falls back to web parsing if no `llms.txt` is available
3. Extracts only the relevant sections, saving tokens

```
How do I configure Oh My Posh themes?
```

This goes to `docs-fetcher`, which fetches the official docs efficiently. The orchestrator never uses `fetch_content` for external documentation directly.

**Skip `docs-fetcher` when:**

- You're working with standard library features only
- You explicitly say "skip docs" or "I know the API"
- The pattern is simple and obvious

### The Code Review Pipeline

After any code change, the orchestrator automatically triggers the review loop with three parallel async reviewers. This is a mandatory part of the workflow — you can't skip it.

The three reviewers have intentionally overlapping scopes to ensure nothing is missed:

| Reviewer | Focus |
|----------|-------|
| `code-reviewer-quality` | Clean code, abstractions, readability |
| `code-reviewer-guidelines` | Project conventions and AGENTS.md compliance |
| `code-reviewer-security` | Bugs, logic errors, security vulnerabilities |

Findings from all three are merged and deduplicated before being presented to you. See [Running the Automated Code Review Loop](code-review-loop.html) for the complete flow.

### The Scout → Plan → Implement Chain

For complex tasks, the `/implement` command chains three agents:

1. **`scout`** (pinned to `claude-haiku-4-5`) — Fast reconnaissance to map the relevant codebase
2. **`planner`** — Detailed implementation plan with files to change, steps, and edge cases
3. **`worker`** — Executes the plan, making all code changes

Use `/scout-and-plan` to get just the plan without implementation — useful when you want to review the approach before committing to it. See [Using Slash Commands and Prompt Templates](slash-commands.html) for all available commands.

## Troubleshooting

**The orchestrator picked the wrong agent**
Tell it directly: "Use `bash-expert` for this" or "Route this to `docker-expert`". The orchestrator corrects immediately.

**A project agent isn't being picked up**
Check that your file is in `.pi/agents/`, has valid YAML frontmatter with `name` and `description`, and ends in `.md`. The orchestrator searches upward from your working directory, so the `.pi/agents/` directory must be at or above your current location.

**An agent seems to be using the wrong model**
Agents inherit the session's model unless they have a `model` field in their frontmatter. Check the agent definition to see if a model override is set. User-level agents (`~/.pi/agent/agents/`) override package agents, and project-level agents (`.pi/agents/`) override both.

**Sync agent call was rejected as too slow**
Sync agents must complete in under 30 seconds. If the orchestrator estimates a task will take longer, it either auto-promotes to async or rejects the call. This is by design — long tasks should run in the background so they don't block your session. See [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html).

## Related Pages

- [Specialist Agents Reference](agents-reference.html)
- [Your First Coding Workflow](first-workflow.html)
- [Running the Automated Code Review Loop](code-review-loop.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
- [Customization and Extension Recipes](customization-recipes.html)
