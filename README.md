# Pi Orchestrator Config

A [pi package](https://github.com/badlogic/pi-mono) that implements an **orchestrator pattern** — the main agent delegates all work to specialist subagents.

## What's Included

### Extension: `orchestrator`

Single extension that provides:

| Feature | Description |
|---------|-------------|
| **Subagent tool** | Delegate tasks to specialist agents (single, parallel, chain modes) |
| **Python/pip enforcement** | Blocks `python`/`pip` — requires `uv`/`uvx` |
| **Git protection** | Blocks commits/pushes to main/master, merged branches, `--no-verify`, `git add .` |
| **Dangerous command gate** | Confirms `rm -rf`, `sudo`, `mkfs`, etc. |
| **Rule injection** | Injects orchestrator routing rules into system prompt |
| **Status line** | Shows current git branch |
| **Notifications** | Desktop notification on task completion |
| **Slash commands** | `/pr-review`, `/release`, `/review-local`, `/query-db` |

### Agents (23)

| Category | Agents |
|----------|--------|
| Languages | python-expert, go-expert, frontend-expert, java-expert, bash-expert |
| Infrastructure | docker-expert, kubernetes-expert, jenkins-expert |
| Dev workflow | git-expert, github-expert, test-runner, test-automator, debugger |
| Documentation | technical-documentation-writer, api-documenter, docs-fetcher |
| Code review | code-reviewer-quality, code-reviewer-guidelines, code-reviewer-security |
| Workflow | scout, planner, worker, reviewer |

### Prompt Templates

| Prompt | Flow |
|--------|------|
| `/implement <task>` | scout → planner → worker |
| `/scout-and-plan <task>` | scout → planner |
| `/implement-and-review <task>` | worker → 3 reviewers → worker |

## Installation

### Pi package (extension + agents + prompts)

```bash
pi install git:github.com/myk-org/pi-config
```

### CLI tool (myk-pi-tools)

```bash
uv tool install git+https://github.com/myk-org/pi-config
```

The pi package installs globally to `~/.pi/agent/git/`. Agents are bundled with the extension and discovered automatically.

## Updating

### Pi package

```bash
pi update
```

### CLI tool

```bash
uv tool upgrade myk-pi-tools
```

After updating, run `/reload` in pi or restart pi to pick up changes.

## Usage

### Automatic delegation

Just describe your task — the orchestrator routes to the right specialist:

```
Add retry logic to the HTTP client in src/api.py
```

### Workflow prompts

```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

### Slash commands

```
/pr-review 42
/release --dry-run
/review-local main
/query-db stats
```

### Direct subagent usage

```
Use python-expert to fix the type errors in src/models.py
Run scout and planner in a chain to analyze the auth module
```

## Code Review Loop

After any code change, the orchestrator runs 3 review agents **in parallel**:

1. **code-reviewer-quality** — Code quality & maintainability
2. **code-reviewer-guidelines** — Project guidelines adherence  
3. **code-reviewer-security** — Bugs, logic errors, security

Loops until all approve, then runs tests.

## Customization

### Override agents

Place a `.md` file with the same `name` frontmatter in `~/.pi/agent/agents/` (user) or `.pi/agents/` (project) to override a bundled agent.

Priority: project > user > package (bundled).

### Add project agents

Create `.pi/agents/my-agent.md` in your project with frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, write, edit, bash
---

Agent system prompt here.
```

Use `agentScope: "both"` in the subagent tool to include project agents.

## Prerequisites

- [pi](https://github.com/badlogic/pi-mono)
- `gh` CLI (for GitHub operations)
- `uv` (for Python execution)
- `myk-pi-tools` (optional, for `/pr-review` and `/release`)

## License

MIT
