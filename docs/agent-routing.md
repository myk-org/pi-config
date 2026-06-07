# Understanding Agent Routing and Delegation

Route your tasks to the right specialist agent automatically, or take control of routing when the defaults don't fit. This page explains how the orchestrator decides which agent handles your work and how to customize that behavior.

## Prerequisites

- Pi is installed and running — see [Installing and Starting Your First Session](quickstart.html)
- You've seen the orchestrator delegate at least once — see [Your First Coding Workflow](first-workflow.html)

## Quick Example

Ask pi to fix a bug in a Python file:

```
Fix the off-by-one error in the pagination logic in utils.py
```

The orchestrator automatically:
1. Identifies this as Python work (`.py` file)
2. Delegates to `python-expert`
3. Returns the result to you

You never need to name the agent — routing happens based on what you ask for.

## How Routing Works

The orchestrator does not write code, run git commands, or modify files directly. Instead, it reads your request, matches it against a routing table, and delegates to the appropriate specialist agent via the `subagent` tool.

### The Routing Table

| Domain | Agent | When to use |
|--------|-------|-------------|
| **Python** (`.py`) | `python-expert` | Writing, modifying, or debugging Python code |
| **Go** (`.go`) | `go-expert` | Go code, modules, goroutines |
| **TypeScript/JavaScript** (`.ts`, `.js`, React, Vue) | `ts-expert` | Frontend and Node.js development |
| **Java** (`.java`) | `java-expert` | Spring Boot, Maven, Gradle, enterprise Java |
| **Shell scripts** (`.sh`) | `bash-expert` | Bash/shell script creation and modification |
| **Markdown** (`.md`) | `technical-documentation-writer` | Writing technical documentation |
| **Docker** | `docker-expert` | Dockerfiles, container workflows, image optimization |
| **Kubernetes/OpenShift** | `kubernetes-expert` | K8s manifests, Helm charts, cluster management |
| **Jenkins/CI** | `jenkins-expert` | Jenkinsfiles, Groovy, CI/CD pipelines |
| **Git** (local) | `git-expert` | Commits, branches, merges, rebases, stash |
| **GitHub** (platform) | `github-expert` | PRs, issues, releases, GitHub workflows |
| **Tests** | `test-automator` | Creating test suites, test infrastructure |
| **Debugging** | `debugger` | Root cause analysis of errors and failures |
| **API docs** | `api-documenter` | OpenAPI specs, SDK docs, API references |
| **External docs** | `docs-fetcher` | Fetching React, FastAPI, Django docs, etc. |
| **Security audit** | `security-auditor` | Auditing external repos before adoption |
| **Everything else** | `worker` | General-purpose fallback agent |

### Intent-Based Routing, Not Tool-Based

The orchestrator routes based on **what you're trying to accomplish**, not which tool happens to be involved:

| Task | Routed to | Why |
|------|-----------|-----|
| Run Python tests | `python-expert` | Testing *Python code*, not running a shell command |
| Edit a Python file with sed | `python-expert` | Modifying *Python code*, regardless of the tool |
| Create a PR | `github-expert` | GitHub platform operation, not local git |
| Commit changes | `git-expert` | Local git operation |
| Write a shell script | `bash-expert` | Creating a *shell script* |
| Look up React hooks docs | `docs-fetcher` | External library documentation |

> **Tip:** If you're unsure which agent will handle your request, just describe what you want. The orchestrator almost always picks the right one.

## Execution Modes

The orchestrator delegates work in three modes depending on the task structure.

### Single Agent

One agent, one task. The most common mode:

```
Add type hints to the User class in models.py
```

The orchestrator sends this to `python-expert` and waits for the result.

### Parallel Agents

Independent tasks that can run simultaneously:

```
Refactor the auth module in auth.py and update the API docs in docs/api.md
```

The orchestrator dispatches `python-expert` and `technical-documentation-writer` at the same time, up to 4 concurrent agents and 8 total tasks.

### Chain Mode

Sequential tasks where each step depends on the previous one:

```
Scout the codebase for all database queries, then create an optimization plan
```

The orchestrator runs `scout` first, then feeds its output to `planner` via a `{previous}` placeholder.

## Sync vs Async Agents

By default, the orchestrator runs agents synchronously — it waits for the result before responding. But for long-running or independent tasks, it uses async mode.

### When Async Is Used

- **Code reviews** — always async (the three review agents are enforced as async-only)
- **Independent research or analysis** — no need to block the session
- **Any task estimated at 30+ seconds** — the orchestrator must use async mode

### Async-Only Agents

Three agents are **always** dispatched asynchronously, even if the orchestrator tries to run them synchronously:

- `code-reviewer-quality`
- `code-reviewer-guidelines`
- `code-reviewer-security`

This prevents the session from blocking while waiting for code reviews. Results appear automatically when the reviews complete.

> **Note:** For details on monitoring async agents and managing background tasks, see [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html).

## Special-Purpose Agents

Some agents serve specific roles beyond language routing.

| Agent | Purpose | Key difference |
|-------|---------|---------------|
| `scout` | Fast codebase reconnaissance | Uses a lighter model (`claude-haiku-4-5`) for speed. Read-only — finds files and maps dependencies. |
| `planner` | Creates implementation plans | Read-only — never writes code. Produces structured plans for other agents. |
| `debugger` | Root cause analysis | Diagnoses issues but does not fix them. Returns analysis for the orchestrator to act on. |
| `test-runner` | Execute tests and report | Runs tests and analyzes failures without making fixes. |
| `reviewer` | General code review | Lightweight single-reviewer alternative to the 3-reviewer loop. |
| `docs-fetcher` | External documentation | Tries `llms.txt` first (AI-optimized), falls back to web parsing. The orchestrator never fetches docs directly. |

## The Code Review Loop

After any code change, the orchestrator triggers a mandatory 3-reviewer parallel code review. This is a core part of the routing system — you don't need to request it.

1. Specialist writes or fixes code
2. All 3 review agents run **in parallel** (always async)
3. Findings are merged and deduplicated
4. If any reviewer has comments → fix and re-review
5. Once approved → run `test-automator`
6. Tests pass → done

> **Note:** For the full review workflow, see [Running the Automated Code Review Loop](code-review-loop.html).

## Advanced Usage

### Agent Discovery and Override Layers

Agents are loaded from three directories in priority order (later overrides earlier by name):

1. **Package agents** — the 24 built-in agents shipped with pi-config (always loaded)
2. **User agents** — your personal agents at `~/.pi/agent/agents/`
3. **Project agents** — project-specific agents at `.pi/agents/` in your repo

To override a built-in agent, create a file with the same `name:` in your user or project agents directory. For example, to customize `python-expert` for your project:

```markdown
---
name: python-expert
description: Python expert with our team's conventions.
tools: read, write, edit, bash
---

You are a Python expert for the Acme project.
Always use our internal `acme.utils` library.
Follow PEP 8 and use type hints on all functions.
```

Save this as `.pi/agents/python-expert.md` in your repository root.

> **Warning:** When project-level agents are used, pi prompts for confirmation before running them. This is a security measure — project agents execute with the same tools as built-in agents.

### Controlling Agent Scope

The `subagent` tool accepts an `agentScope` parameter that controls which agent directories are searched:

| Scope | Loads from |
|-------|------------|
| `"user"` (default) | Package + user agents |
| `"project"` | Package + project agents |
| `"both"` | Package + user + project agents |

The orchestrator uses `"user"` scope by default. Switch to `"project"` or `"both"` when you have project-specific agents defined.

### Creating Custom Agents

Create a `.md` file in `~/.pi/agent/agents/` (for personal agents) or `.pi/agents/` in your repo (for project agents). Every agent file needs YAML frontmatter:

```markdown
---
name: my-custom-agent
description: One-sentence description of what this agent does.
tools: read, write, edit, bash
---

Agent instructions go here. Be specific about what the agent should
and should not do.
```

The required frontmatter fields:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Agent identifier — used in routing and delegation |
| `description` | Yes | One-sentence summary — helps the orchestrator choose the right agent |
| `tools` | No | Comma-separated list of tools the agent can use (`read`, `write`, `edit`, `bash`) |
| `model` | No | Override the default model (e.g., `claude-haiku-4-5` for faster, cheaper agents) |

The body after the frontmatter becomes the agent's system prompt.

> **Tip:** For a full walkthrough of creating and registering a custom agent, see [Customization and Extension Recipes](customization-recipes.html).

### Model Overrides

Any agent can specify a `model:` in its frontmatter to use a different model than the session default. The built-in `scout` agent uses this to run on `claude-haiku-4-5` for faster, cheaper codebase reconnaissance.

If no `model:` is specified, the agent inherits the parent session's model.

### Time Estimation and Enforcement

Sync agents require a time estimate (`estimatedSeconds`). If the estimated duration is **30 seconds or more**, the orchestrator must use async mode instead. This prevents long-running agents from blocking your session.

- **Single sync agent**: estimate must be under 30s
- **Parallel sync agents**: the longest task must be under 30s
- **Chain sync agents**: the sum of all steps must be under 30s
- **Async agents**: no estimate required

### Forcing a Specific Agent

If the orchestrator routes to the wrong agent, you can explicitly request one:

```
Use the bash-expert to write a systemd service file
```

```
Have the go-expert review this migration script
```

The orchestrator respects explicit agent requests in your message.

## Troubleshooting

**The orchestrator picked the wrong agent**
- Be more specific about the task intent. "Fix the Python test" is better than "fix the test."
- Explicitly name the agent: "Use `python-expert` to fix the test in `test_auth.py`."

**"Unknown agent" error**
- Check the agent name matches exactly (including hyphens). Run a session and ask pi to list available agents.
- If using project agents, make sure the file is in `.pi/agents/` and has valid frontmatter with `name:` and `description:`.

**Agent seems to lack the right tools**
- Check the `tools:` field in the agent's frontmatter. An agent without `write` and `edit` can't modify files. An agent without `bash` can't run shell commands.

**Code review never finishes**
- The three review agents are async-only. Their results appear automatically. Use `/async-status` to check progress. See [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) for details.

**Project agents aren't being picked up**
- Ensure the agents directory is at `.pi/agents/` relative to your project root (not `agents/`).
- The `agentScope` must be set to `"project"` or `"both"` — the default `"user"` scope does not load project agents.

## Related Pages

- [Specialist Agents Reference](agents-reference.html)
- [Your First Coding Workflow](first-workflow.html)
- [Running the Automated Code Review Loop](code-review-loop.html)
- [Customization and Extension Recipes](customization-recipes.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
