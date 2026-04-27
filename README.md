# Pi Orchestrator Config

A [pi package](https://github.com/badlogic/pi-mono) that implements an **orchestrator pattern** — the main agent delegates all work to specialist subagents.

## What's Included

### Extension: `orchestrator`

Single extension that provides:

| Feature | Description |
|---------|-------------|
| **Subagent tool** | Delegate tasks to specialist agents (single, parallel, chain, async modes) |
| **Async background agents** | Spawn agents in background with `async: true` — results surface automatically when complete |
| **`/btw` command** | Quick side questions without polluting conversation history — ephemeral overlay |
| **`/async-status` command** | Show status of background agents — select one for live output streaming |
| **`ask_user` tool** | Structured user input with options and free-text — used by workflows |
| **Python/pip enforcement** | Blocks `python`/`pip` — requires `uv`/`uvx` |
| **Git protection** | Blocks commits/pushes to main/master, merged branches, `--no-verify`, `git add .` |
| **Dangerous command gate** | Confirms `rm -rf`, `sudo`, `mkfs`, etc. |
| **Rule injection** | Injects orchestrator routing rules into system prompt |
| **Git status** | Live git status in status line with colored icons — updates after every tool call |
| **Desktop notifications** | Notifies via `notify-send` on task completion, waiting for input, and action required |
| **File preview** | Serves generated HTML/frontend files via HTTP for browser preview from container |
| **Pidash dashboard** | Live web dashboard — multi-session monitoring, browser messaging, model switching |
| **Dreaming** | Background memory consolidation — extracts memories from sessions, deduplicates, maintains memory.md |
| **Slash commands** | `/pr-review`, `/release`, `/review-local`, `/query-db`, `/btw`, `/async-status`, `/dream`, `/remember` — with autocomplete argument hints |
| **GitHub autocomplete** | Type `#` in the editor to get issue/PR suggestions from the current repo — lazy-loaded, 5min cache |
| **Command arg completions** | Tab-complete arguments for slash commands — agent names for `/acpx-prompt`, branches for `/review-local`, PR numbers for `/pr-review`, and more |
| **Discord bot** | Control pi sessions from your phone via Discord DMs — send prompts, answer ask_user dialogs, switch sessions |

### Agents (24)

| Category | Agents |
|----------|--------|
| Languages | python-expert, go-expert, frontend-expert, java-expert, bash-expert |
| Infrastructure | docker-expert, kubernetes-expert, jenkins-expert |
| Dev workflow | git-expert, github-expert, test-runner, test-automator, debugger |
| Documentation | technical-documentation-writer, api-documenter, docs-fetcher |
| Code review | code-reviewer-quality, code-reviewer-guidelines, code-reviewer-security |
| Security | security-auditor |
| Workflow | scout, planner, worker, reviewer |

### Prompt Templates

| Prompt | Description |
|--------|-------------|
| `/implement <task>` | scout → planner → worker |
| `/scout-and-plan <task>` | scout → planner |
| `/implement-and-review <task>` | worker → 3 reviewers → worker |
| `/pr-review [number\|url]` | Fetch PR diff, review with guidelines, post comments |
| `/release [flags]` | Create GitHub release with changelog and version bumping |
| `/review-local [branch]` | Review local uncommitted or branch changes |
| `/review-handler [url] [--autorabbit]` | Process PR review comments, fix approved items |
| `/refine-review <url>` | Refine and improve existing PR review comments |
| `/coderabbit-rate-limit [number\|url]` | Handle CodeRabbit rate limiting on PRs |
| `/query-db <command>` | Query the review comments database |
| `/acpx-prompt <agent> [--fix\|--peer] <prompt>` | Run prompts via external AI agents (cursor, codex, gemini, etc.) |
| `/dream` | Run memory consolidation — extract, deduplicate, maintain memory.md |
| `/remember <what>` | Save a memory for future sessions |
| `/dream-auto` | Toggle automatic memory dreaming (every 3h + session end) |
| `/cron add\|list\|remove` | Schedule recurring tasks within the pi session (e.g., `/cron add every 2h check for new issues`, `/cron add at 12:00 /review-handler`). Tasks run while pi is active, survive `/reload`, and stop on exit |

## Installation

### Docker (Recommended)

The recommended way to run pi-config is via the pre-built container image. It provides filesystem isolation, consistent tooling, and all dependencies pre-installed.

```bash
docker pull ghcr.io/myk-org/pi-config:latest
```

See the [Docker section](#docker-sandboxed-execution) below for the full run command and shell alias.

### Native (without Docker)

If you prefer running pi directly on your host:

#### Pi package (extension + agents + prompts)

```bash
pi install git:github.com/myk-org/pi-config
```

#### CLI tool (myk-pi-tools)

```bash
uv tool install git+https://github.com/myk-org/pi-config
```

#### Recommended tools

```bash
npm install -g difit          # Git diff viewer in browser (auto-starts with pi)
npm install -g acpx           # External AI agent proxy (cursor, codex, gemini)
npm install -g pi-web-access  # Web search/fetch skills (librarian)
uvx install mcp-launchpad     # MCP server CLI (mcpl)
```

#### Optional: Vertex AI (Claude via Google Cloud)

If using Claude models through Google Cloud Vertex AI:

```bash
pi install git:github.com/myk-org/pi-vertex-claude@feat/1m-context-window-support
```

#### Optional: Browser automation

For browser automation (screenshots, form filling, web testing), install [agent-browser](https://github.com/nicobailon/agent-browser):

```bash
npm install -g agent-browser
npx playwright install --with-deps chromium
```

The pi package installs globally to `~/.pi/agent/git/`. Agents are bundled with the extension and discovered automatically.

## Updating

### Docker

```bash
docker pull ghcr.io/myk-org/pi-config:latest
```

The container runs `pi update` automatically on each start.

### Native

```bash
pi update                          # Pi package
uv tool upgrade myk-pi-tools      # CLI tool
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
  --name "pi-config-$(basename $PWD)-$(date +%s)" \
  --network host \
  --env-file /path/to/.env \
  -v "$PWD":"$PWD":rw \
  -v "$HOME/.pi":/home/node/.pi:rw \
  -v "$HOME/.gitconfig":/home/node/.gitconfig:ro \
  -v "$HOME/.gitignore-global":/home/node/.gitignore-global:ro \
  -v "$HOME/.ssh":/home/node/.ssh:ro \
  -v "$HOME/.config/gh":/home/node/.gh-config:ro \
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
VERTEX_CLAUDE_1M=true

# GitHub
GITHUB_TOKEN=ghp_xxx
GITHUB_API_TOKEN=ghp_xxx
GH_CONFIG_DIR=/home/node/.gh-config

# Gemini (optional)
GEMINI_API_KEY=xxx

# acpx agents (optional)
# ACPX_AGENTS=cursor
```

Pass via `--env-file /path/to/.env` in the docker run command.

### Project memory

The memory system stores per-repo lessons and patterns in `.pi/memory/memory.md` — a plain markdown file with two sections:

- **Pinned** — user-requested memories (via `/remember`), never auto-removed
- **Learned** — auto-extracted by dreaming, can be reorganized/removed

The file is auto-added to the global gitignore in the container.

For **native** (non-container) usage, add it to your global gitignore:

```bash
echo '.pi/memory/' >> ~/.gitignore-global
git config --global core.excludesFile ~/.gitignore-global
```

**Migration:** If you have an existing `memories.db`, it's automatically migrated to `memory.md` on the next session start.

### Pidash — live web dashboard

Pidash is a web-based dashboard that runs alongside the TUI, accessible from any browser including mobile phones.

**How it works:**

- A daemon (`pidash-server.ts`) runs on port `19190` and aggregates all pi sessions
- Each pi session's extension (`pidash.ts`) connects to the daemon and forwards events
- The React web UI shows live conversations, tool calls, and session status

**Features:**

- Multi-session dashboard with sidebar grouped by project
- Live conversation streaming (user, assistant, tool, thinking)
- Send messages from browser to pi
- Model and thinking level switching from browser
- Extension commands (`/release`, `/dream`, `/remember`, etc.) work from browser
- Info bar: model, tokens, context %, git status, diff viewer link
- Collapsible thinking and tool blocks with copy buttons
- ask_user tool bridging (answer from browser or TUI)
- Mobile responsive
- Event buffering for message replay on refresh
- Browser push notifications for background events (configurable per event type)
- Async agent live streaming (real-time tool calls and output inline in chat)
- Sidebar session working indicator (pulsing green dot when AI is active)

**Access:**

```bash
# Automatically starts with pi — open in browser:
http://localhost:19190

# From other devices on your network:
http://<your-ip>:19190

# Custom port:
PI_PIDASH_PORT=9999 pi
```

**Management:**

```bash
/pidash status    # Check server status
/pidash stop      # Stop the daemon
/pidash start     # Start the daemon
/pidash restart   # Restart the daemon
```

**Building the UI (first run only — auto-built):**

```bash
cd extensions/orchestrator/pidash-ui
npm install && npm run build
```

> **Note:** Session switching (`/resume`) and new sessions (`/new`) from the browser are not yet supported due to a pi API limitation. Use the TUI for these operations.

### Optional mounts

| Mount | Purpose |
|---|---|
| `-v "$HOME/.claude/mcp.json":/home/node/.claude/mcp.json:ro` | MCP server config for `mcpl` |
| `-v "$HOME/.agents":/home/node/.agents:rw` | User-level skills (install/uninstall from container) |
| `-v "$HOME/.config/gcloud/application_default_credentials.json":/home/node/.gcloud-adc.json:ro` | Google Cloud ADC (for Claude via Vertex AI) |
| `-v "$HOME/.config/cursor/auth.json":/home/node/.cursor/auth.json:ro` | Cursor CLI auth (for acpx cursor models) |
| `-v "$HOME/.config/glab-cli":/home/node/.config/glab-cli:ro` | GitLab CLI config (auth tokens, host settings) |
| `-v "$HOME/screenshots":/home/node/screenshots` | Share screenshots/images with the agent |
| `-v /var/run/docker.sock:/var/run/docker.sock:ro` + `--group-add $(stat -c '%g' /var/run/docker.sock)` | Docker container inspection via `docker-safe` |
| `-v /var/run/podman/podman.sock:/var/run/podman/podman.sock:ro` | Podman container inspection via `docker-safe` |

### What's in the image

| Tool | Purpose |
|---|---|
| `pi` | Coding agent |
| `git` | Version control |
| `gh` | GitHub CLI (PRs, issues) |
| `glab` | GitLab CLI (MRs, issues, pipelines) — install [gitlab-cli-skills](https://github.com/vince-winkintel/gitlab-cli-skills) for full agent support |
| `uv` / `uvx` | Python execution (enforced by orchestrator) |
| `go` | Go development and code review |
| `mcpl` | MCP server access (search, Jenkins, etc.) |
| `myk-pi-tools` | PR review, release, and other CLI utilities |
| `prek` | Pre-commit hook runner |
| `acpx` | Agent proxy for remote models |
| `kubectl` / `oc` | Kubernetes and OpenShift CLI |
| `agent-browser` | Browser automation CLI (navigate, click, screenshot, forms) |
| `procps` | Process utilities (ps, top, pgrep, pkill) |
| `difit` | Git diff viewer in the browser with ref switching (auto-starts) |
| `docker` / `podman` | Container CLIs (used via `docker-safe` read-only wrapper) |
| `docker-safe` | Restricted Docker/Podman wrapper — container only (ps, logs, inspect, top, stats) |
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
so the container can reach any service your host can (LAN, localhost),
and the host can reach services started inside the container.
This is required for local MCP servers, LiteLLM proxy, and file preview
(agents serve generated HTML/frontend files via HTTP for browser access).
If your LLM provider is cloud-based, you don't use local MCPs,
and you don't need file preview, you can omit `--network host`.

### Shell alias

Add to your `~/.bashrc` or `~/.zshrc`:

```bash
alias pi-docker='docker pull ghcr.io/myk-org/pi-config:latest && \
  docker run --rm -it \
  --name "pi-config-$(basename $PWD)-$(date +%s)" \
  --network host \
  --env-file "$HOME/.pi/.env" \
  -v "$PWD":"$PWD":rw \
  -v "$HOME/.pi":/home/node/.pi:rw \
  -v "$HOME/.gitconfig":/home/node/.gitconfig:ro \
  -v "$HOME/.gitignore-global":/home/node/.gitignore-global:ro \
  -v "$HOME/.ssh":/home/node/.ssh:ro \
  -v "$HOME/.config/gh":/home/node/.gh-config:ro \
  -v "$HOME/.claude/mcp.json":/home/node/.claude/mcp.json:ro \
  -v "$HOME/.agents":/home/node/.agents:rw \
  -v "$HOME/.config/gcloud/application_default_credentials.json":/home/node/.gcloud-adc.json:ro \
  -v "$HOME/.config/cursor/auth.json":/home/node/.cursor/auth.json:ro \
  -v "$HOME/.config/glab-cli":/home/node/.config/glab-cli:ro \
  -v "$HOME/screenshots":/home/node/screenshots \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  --group-add $(stat -c '%g' /var/run/docker.sock) \
  -w "$PWD" \
  ghcr.io/myk-org/pi-config:latest'
```

Then just run `pi-docker` from any project directory.

> **Startup note:** The container runs as non-root user `node` (UID 1000).
> `pi install` runs on each start.
> A `WARNING` on stderr is normal when the package is already cached in `~/.pi`.
> If pi misbehaves or the warning persists, verify network connectivity
> and run `pi install git:github.com/myk-org/pi-config` manually.

## Discord Bot

Control your pi sessions from your phone via Discord DMs.

### Setup

1. **Create a Discord bot:**
   - Go to [Discord Developer Portal](https://discord.com/developers/applications)
   - Click "New Application" → name it (e.g., "pi-agent")
   - Go to "Bot" section → click "Reset Token" → copy the token
   - Enable "Message Content Intent" under "Privileged Gateway Intents"
   - Go to "OAuth2 > URL Generator" → select scope `bot` → select permissions:
     `Send Messages`, `Read Message History`, `Add Reactions`, `View Channels`
   - Open the generated URL → add bot to your server

2. **Configure:**

   ```bash
   # Create config file
   cat > ~/.pi/discord.env << EOF
   DISCORD_BOT_TOKEN=your-token-here
   DISCORD_ALLOWED_USERS=your-discord-user-id
   EOF
   ```

   Find your Discord user ID: Settings > Advanced > Developer Mode ON, then right-click yourself > Copy User ID.

3. **Restart pidash:**
   The Discord bot runs inside the pidash server daemon. Restart it to pick up the config:

   ```text
   /pidash restart
   ```

### Discord Commands

| Command | Description |
|---------|-------------|
| `!sessions` | List active pi sessions |
| `!watch N` | Watch/switch to session N |
| `!status` | Show current session info |
| `!abort` | Abort current operation |
| `!help` | Show commands |
| Any text | Send as prompt to watched session |
| `/command` | Forward slash command to pi session |

### How It Works

The Discord bot runs inside the pidash server daemon (no separate process):

```text
Discord app (phone) ↔ Discord cloud ↔ pidash server (localhost) ↔ pi sessions
```

No ports to open — the bot connects outbound to Discord’s API.
The bot starts automatically with pidash when `DISCORD_BOT_TOKEN` is configured.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for tips on testing extensions locally, running tests, and managing Python dependencies.

## Prerequisites

- [pi](https://github.com/badlogic/pi-mono)
- `gh` CLI (for GitHub operations)
- `uv` (for Python execution)
- `myk-pi-tools` (optional, for `/pr-review` and `/release`)

## License

MIT
