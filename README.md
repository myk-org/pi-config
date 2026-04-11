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

```text
Add retry logic to the HTTP client in src/api.py
```

### Workflow prompts

```text
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

### Slash commands

```text
/pr-review 42
/release --dry-run
/review-local main
/query-db stats
```

### Direct subagent usage

```text
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

## Docker (Sandboxed Execution)

Run pi inside a disposable container for **filesystem isolation** — the agent can only access your mounted project directory and pi settings. Everything else on the host is protected.

### Why?

- **Safety** — Prevents accidental `rm -rf`, modifications outside the project, or unintended system changes
- **Filesystem isolation** — pi can only read/write the mounted project directory
- **Consistent tooling** — All required tools pre-installed in a single image
- **Disposable** — Container is destroyed after each session (`--rm`)

### Pre-built image

```bash
docker pull ghcr.io/myk-org/pi-config:latest
```

### Build from source (optional)

> **Note:** The image is built for **linux/amd64** only.
> On ARM hosts, build with `--platform linux/amd64`.

```bash
git clone https://github.com/myk-org/pi-config.git
cd pi-config
docker build -t ghcr.io/myk-org/pi-config:latest .
```

### Run

```bash
docker run --rm -it \
  --network host \
  --env-file /path/to/.env \
  -v "$PWD":"$PWD":rw \
  -v "$HOME/.pi":/home/node/.pi:rw \
  -v "$HOME/.gitconfig":/home/node/.gitconfig:ro \
  -v "$HOME/.ssh":/home/node/.ssh:ro \
  -v "$HOME/.config/gh":/home/node/.gh-config:ro \
  -e GH_CONFIG_DIR=/home/node/.gh-config \
  -w "$PWD" \
  ghcr.io/myk-org/pi-config:latest
```

### Environment file

Create a `.env` file with container-specific variables:

```env
# Google Cloud / Vertex AI
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION=us-east5
GOOGLE_APPLICATION_CREDENTIALS=/home/node/.gcloud-adc.json
VERTEX_PROJECT_ID=your-project-id
VERTEX_REGION=us-east5

# GitHub
GITHUB_TOKEN=ghp_xxx
GITHUB_API_TOKEN=ghp_xxx

# Gemini (optional)
GEMINI_API_KEY=xxx

# acpx agents (optional)
# ACPX_AGENTS=cursor
```

Pass via `--env-file /path/to/.env` in the docker run command.

### Optional mounts

| Mount | Purpose |
|---|---|
| `-v "$HOME/.claude/mcp.json":/home/node/.claude/mcp.json:ro` | MCP server config for `mcpl` |
| `-v "$HOME/.agents":/home/node/.agents:ro` | User-level skills (if not in the project) |
| `-v "$HOME/.config/gcloud/application_default_credentials.json":/home/node/.gcloud-adc.json:ro` | Google Cloud ADC (for Claude via Vertex AI) |
| `-v "$HOME/.config/cursor/auth.json":/home/node/.cursor/auth.json:ro` | Cursor CLI auth (for acpx cursor models) |

### What's in the image

| Tool | Purpose |
|---|---|
| `pi` | Coding agent |
| `git` | Version control |
| `gh` | GitHub CLI (PRs, issues) |
| `uv` / `uvx` | Python execution (enforced by orchestrator) |
| `go` | Go development and code review |
| `mcpl` | MCP server access (search, Jenkins, etc.) |
| `myk-pi-tools` | PR review, release, and other CLI utilities |
| `prek` | Pre-commit hook runner |
| `acpx` | Agent proxy for remote models |
| `kubectl` / `oc` | Kubernetes and OpenShift CLI |
| `agent-browser` | Browser automation CLI (navigate, click, screenshot, forms) |
| `gcloud` | Google Cloud CLI (Vertex AI authentication) |
| `jq` | JSON processing |
| `curl` | HTTP requests |

### What's protected

**Filesystem isolation** — the container cannot access anything outside the mounted volumes:

- ✅ `$PWD` (your project) — read/write
- ✅ `~/.pi` (pi settings/sessions) — read/write
- ✅ Git, GitHub, SSH config — read-only
- ❌ Other directories on your host — not accessible
- ❌ Other git repos — not accessible
- ❌ System files — not accessible

**Network** — `--network host` shares the host network stack,
so the container can reach any service your host can (LAN, localhost).
This is required for local MCP servers, LiteLLM proxy, etc.
If your LLM provider is cloud-based and you don't use local MCPs,
you can omit `--network host` for full network isolation.

### Shell alias

Add to your `~/.bashrc` or `~/.zshrc`:

```bash
alias pi-docker='docker pull ghcr.io/myk-org/pi-config:latest && \
  docker run --rm -it \
  --network host \
  --env-file "$HOME/.pi/.env" \
  -v "$PWD":"$PWD":rw \
  -v "$HOME/.pi":/home/node/.pi:rw \
  -v "$HOME/.gitconfig":/home/node/.gitconfig:ro \
  -v "$HOME/.ssh":/home/node/.ssh:ro \
  -v "$HOME/.config/gh":/home/node/.gh-config:ro \
  -e GH_CONFIG_DIR=/home/node/.gh-config \
  -v "$HOME/.claude/mcp.json":/home/node/.claude/mcp.json:ro \
  -v "$HOME/.config/gcloud/application_default_credentials.json":/home/node/.gcloud-adc.json:ro \
  -v "$HOME/.config/cursor/auth.json":/home/node/.cursor/auth.json:ro \
  -w "$PWD" \
  ghcr.io/myk-org/pi-config:latest'
```

Then just run `pi-docker` from any project directory.

> **Startup note:** The container runs as non-root user `node` (UID 1000).
> `pi install` runs on each start.
> A `WARNING` on stderr is normal when the package is already cached in `~/.pi`.
> If pi misbehaves or the warning persists, verify network connectivity
> and run `pi install git:github.com/myk-org/pi-config` manually.

## Prerequisites

- [pi](https://github.com/badlogic/pi-mono)
- `gh` CLI (for GitHub operations)
- `uv` (for Python execution)
- `myk-pi-tools` (optional, for `/pr-review` and `/release`)

## License

MIT
