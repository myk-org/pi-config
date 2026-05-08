# Orchestrator Architecture

When you ask pi-config to fix a bug, write a feature, or review code, your request doesn't go straight to a code-editing agent. Instead, it flows through an **orchestrator** — a coordination layer that decides *who* should do the work, *how* the work should be done safely, and *what rules* apply. Understanding this architecture helps you predict how pi-config behaves, why certain commands are blocked, and how to get the most out of the multi-agent system.

The orchestrator coordinates three subsystems working together: **rule injection** loads governance into the session, the **enforcement layer** blocks dangerous commands in real time, and **subagent delegation** routes tasks to the right specialist. This page explains how these three systems interact.

## The Big Picture

When you start a pi session with the orchestrator extension loaded, the following happens:

1. **Session starts** — the extension registers all subsystems (rules, enforcement, subagent tool, async infrastructure, commands)
2. **Rule injection** fires (`before_agent_start` hook) — orchestrator rules and project memories are loaded into the system prompt
3. **You send a message** — the orchestrator reads your request and decides which specialist agent should handle it
4. **Enforcement checks** run on every tool call — blocking forbidden commands before they execute
5. **Subagent delegation** spawns a specialist (e.g., `python-expert`) as an isolated child process
6. **Results surface** — sync results return inline; async results appear automatically when the agent finishes

| Subsystem | When it runs | What it does | User-visible effect |
|---|---|---|---|
| Rule injection | Session start | Loads rules and memories into the system prompt | Orchestrator knows its role and project history |
| Enforcement | Every tool call | Blocks forbidden or dangerous commands | Dangerous commands are rejected with explanations |
| Subagent delegation | When the orchestrator routes work | Spawns specialist agents in isolated processes | Work is done by the right expert for the job |

## Rule Injection

Rule injection is the mechanism that turns a generic AI session into a governed orchestrator. At session start, the `before_agent_start` hook loads two types of content into the system prompt:

### What Gets Injected

**Project memories** are loaded first, from `.pi/memory/memory.md` in your project directory. These are lessons learned from previous sessions — things like "always use `uv run`, never `python` directly" or "never merge PRs without asking first." Memories appear before everything else in the prompt so the orchestrator treats them as high priority.

**Orchestrator rules** are loaded next, from the `rules/` directory in the pi-config package. These are Markdown files that define what the orchestrator can and cannot do. They load in alphabetical order by filename:

| Rule file | Purpose |
|---|---|
| `00-orchestrator-core.md` | Defines forbidden and allowed actions for the orchestrator |
| `05-issue-first-workflow.md` | Pre-implementation checklist (issue creation, branch naming) |
| `10-agent-routing.md` | Maps domains and languages to specialist agents |
| `15-mcp-launchpad.md` | MCP server integration rules |
| `20-code-review-loop.md` | Mandatory code review workflow with three parallel reviewers |
| `25-documentation-updates.md` | When to trigger documentation generation |
| `30-prompt-templates.md` | How slash commands should be executed |
| `35-memory.md` | Memory system rules (writing, dreaming, quality) |
| `40-critical-rules.md` | Parallelism, async agents, time estimates, safety |
| `45-file-preview.md` | HTML file serving for browser preview |
| `50-agent-bug-reporting.md` | Workflow when agent logic bugs are discovered |

### How Injection Differs for Subagents

Specialist subagents do **not** receive orchestrator rules. When a child process starts with the `PI_SUBAGENT_CHILD=1` environment variable, rule injection is skipped entirely. Subagents receive only their own agent-specific system prompt and, optionally, a read-only view of project memories.

This separation is deliberate: the orchestrator needs governance rules about routing and delegation, while specialists just need to do their job (write Python, commit code, run tests).

> **Tip:** If your project has specific memories that should influence all agents, add them to `.pi/memory/memory.md`. Memories are the one piece of injected context that both the orchestrator and subagents can see.

## The Enforcement Layer

While rule injection tells the orchestrator what it *should* do, the enforcement layer ensures certain things *cannot* happen. It's a `tool_call` hook that inspects every bash command before execution and blocks those that violate safety policies.

### What Gets Enforced

| Category | Blocked | Required instead |
|---|---|---|
| **Python/pip** | `python script.py`, `pip install pkg` | `uv run script.py`, `uv add pkg` |
| **Pre-commit** | `pre-commit run` | `prek run --all-files` |
| **Git staging** | `git add .`, `git add -A` | `git add <specific-files>` |
| **Hook bypass** | `git commit --no-verify`, `core.hooksPath=/dev/null` | Run hooks normally |
| **Protected branches** | Commits or pushes to `main`/`master` | Create a feature branch |
| **Merged branches** | Commits to already-merged branches | Create a new branch |
| **Remote execution** | `curl ... \| bash`, `eval $(curl ...)` | Download, audit with `security-auditor`, then run |
| **Polling loops** | `while ... sleep 60 ...` | Use an async subagent instead |
| **Long sleeps** | `sleep` longer than 30 seconds | Use an async subagent instead |
| **Memory writes (subagents)** | Specialist agents writing memories | Only the orchestrator writes memories |
| **Docker/Podman (in container)** | Direct `docker`/`podman` commands | Use the `docker-safe` read-only wrapper |
| **Gitignored files** | Staging files matched by `.gitignore` | Don't stage ignored files |
| **Temp files** | `mktemp` outside `/tmp/pi-work/` | Use `/tmp/pi-work/<project>/` prefix |

### How Enforcement Differs From Rules

Rules are *advisory* — they tell the orchestrator what to do, but the orchestrator could theoretically ignore them. Enforcement is *mandatory* — it intercepts tool calls at the system level and blocks them before execution. The orchestrator cannot bypass enforcement.

> **Note:** Dangerous commands like `rm -rf` and `sudo` are not outright blocked. Instead, enforcement prompts you for confirmation before allowing them to run. If there's no UI available (e.g., in a headless session), dangerous commands are blocked entirely.

### Enforcement and Subagents

Enforcement applies to **all** agents, not just the orchestrator. When a specialist agent tries to run `git add .` or `python script.py`, the enforcement layer blocks it with the same error message. This means safety guarantees hold regardless of which agent is doing the work.

The one enforcement rule specific to subagents is **memory write restriction**: specialist agents cannot add or delete memories. This prevents race conditions when multiple agents run in parallel.

## Subagent Delegation

The subagent tool is how the orchestrator gets work done. Instead of editing files or running commands directly, the orchestrator delegates to specialist agents that run as isolated child processes.

### How Agents Are Discovered

Agents come from three sources, loaded in priority order (later sources override earlier ones by name):

| Priority | Source | Location |
|---|---|---|
| 1 (base) | Package agents | Bundled in pi-config (`agents/` directory) |
| 2 | User agents | `~/.pi/agent/agents/` |
| 3 (highest) | Project agents | `.pi/agents/` in your repo |

Each agent is a Markdown file with YAML frontmatter defining its name, description, available tools, and optional model override. The body of the file becomes the agent's system prompt.

pi-config ships with 24 specialist agents covering languages (Python, Go, Java, frontend), infrastructure (Docker, Kubernetes, Jenkins), development workflows (git, GitHub, testing, debugging), and specialized roles (security auditing, documentation, code review).

### Delegation Modes

The subagent tool supports four execution modes:

**Single mode** — one agent, one task, blocks until complete. Use when the next step depends on the result.

**Parallel mode** — up to 8 agents run simultaneously (4 concurrent), all must complete before returning. Use for tasks like sending code to three reviewers at once.

**Chain mode** — agents run sequentially, with each step able to reference the previous step's output via a `{previous}` placeholder. Use for multi-step workflows like scout-then-plan.

**Async mode** — the agent runs in the background as a detached process. The orchestrator continues immediately, and results surface automatically as a follow-up message when the agent finishes. Use for independent tasks like code reviews, research, or monitoring.

| Mode | Blocks session? | `estimatedSeconds` required? | Max time |
|---|---|---|---|
| Single | Yes | Yes | Under 60 seconds |
| Parallel | Yes | Yes (per task) | Longest task under 60 seconds |
| Chain | Yes | Yes (per step) | Sum of all steps under 60 seconds |
| Async | No | No | No limit |

> **Warning:** If a sync task's estimated time is 60 seconds or more, the tool rejects the call and requires `async: true` instead. This prevents the session from blocking on long-running work.

### Agent Isolation

When a subagent is spawned, it runs as a separate child process with specific isolation properties:

- **Environment**: `PI_SUBAGENT_CHILD=1` is set, which skips orchestrator rule injection and prevents memory writes
- **Session**: agents run with `--no-session` (no persistent session file)
- **Tools**: each agent only has access to the tools listed in its definition (e.g., `read, write, edit, bash`)
- **System prompt**: the agent's own prompt is appended via a temporary file, which is cleaned up after execution

Subagents **cannot** spawn their own subagents — the `PI_SUBAGENT_CHILD=1` check prevents the subagent tool from registering in child processes, avoiding infinite recursion.

## How the Three Systems Work Together

The three subsystems form a layered architecture:

1. **Rule injection** provides the orchestrator's "knowledge" — what agents exist, how to route tasks, what workflows to follow, and what the project has learned from previous sessions
2. **The orchestrator** uses that knowledge to make decisions — choosing the right agent, structuring parallel workflows, following the code review loop
3. **Enforcement** acts as a safety net beneath both the orchestrator and its subagents — catching mistakes that rules alone can't prevent

Here is what a typical workflow looks like when all three systems are active:

1. You ask: "Fix the type error in `models.py`"
2. The orchestrator (guided by **routing rules**) selects `python-expert`
3. The orchestrator delegates via the `subagent` tool with `estimatedSeconds: 30`
4. `python-expert` spawns as a child process (no orchestrator rules, has project memories)
5. The expert reads the file, edits it, and runs `uv run pytest` (**enforcement** allows `uv run`, would block `python`)
6. The expert tries `git add .` — **enforcement** blocks it, requiring specific file staging
7. The expert stages the specific file and returns
8. The orchestrator receives the result and (guided by **code review rules**) spawns three async review agents in parallel
9. Review results surface automatically when complete
10. If reviewers find issues, the orchestrator sends fixes back through the loop

### Async Agent Lifecycle

For background tasks (code reviews, memory dreaming, monitoring), the async agent infrastructure manages the full lifecycle:

1. **Spawn** — a detached child process starts, tracked in an in-memory job map
2. **Monitor** — a 3-second poller checks status files and a file watcher detects results
3. **Surface** — when the agent completes, its output is injected into the conversation as a follow-up message (unless `fireAndForget` is set)
4. **Notify** — a terminal notification fires so you know work finished
5. **Cleanup** — completed jobs are removed after 30 seconds

Async jobs survive session restarts. When you resume a session, the system restores jobs that belong to it using a session file hash, so background agents aren't lost.

> **Tip:** Use `/async-status` to see what's running in the background. Use `/async-kill` to stop agents you no longer need — don't let unneeded agents waste resources.

## How This Affects You

Understanding the orchestrator architecture explains several behaviors you'll encounter:

- **The orchestrator never edits files directly.** It always delegates to a specialist. If you want a quick edit, the orchestrator still routes it through an agent — this is by design, not a limitation.
- **Certain commands are always blocked.** If you see a message like "Direct python/pip forbidden," that's the enforcement layer. Use the suggested alternative (e.g., `uv run`).
- **Code reviews happen automatically.** After any code change, three review agents run in parallel. This is a mandatory workflow defined in the rules, not optional behavior.
- **Background tasks surface on their own.** When you see a "Async Agent Result" message appear, that's a background agent reporting back. You didn't need to wait for it.
- **Project memories carry forward.** Lessons learned in one session (mistakes, preferences, decisions) are loaded into every future session via rule injection. Over time, the orchestrator gets smarter about your project.
- **You can customize agent behavior** by adding agents to `.pi/agents/` in your repo (project-scoped) or `~/.pi/agent/agents/` (user-scoped). Project agents override package agents with the same name.

## Related Pages

- See Agent Routing for the full domain-to-agent mapping and how to control which specialist handles your task
- See Code Review Loop for details on the mandatory three-reviewer workflow
- See Memory System for how project memories are stored, written, and consolidated through dreaming
- See Async Agents for managing background tasks, monitoring status, and understanding the async lifecycle
- See Enforcement Rules for the complete list of blocked commands and their required alternatives
- See Subagent Tool Reference for the full parameter schema and usage examples of all delegation modes
- See Agent Definitions for how to write custom agents with frontmatter configuration
- See [Slash Commands](slash-commands.html) for the prompt templates that orchestrate multi-step workflows like `/implement` and `/pr-review`
