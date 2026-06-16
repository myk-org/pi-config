# Pi Orchestrator Config

A [pi package](https://github.com/badlogic/pi-mono) that implements an **orchestrator pattern** — the main agent delegates all work to specialist subagents.

📚 **[Full Documentation](https://myk-org.github.io/pi-config/)**

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
| **Git status** | Live git status in status line with colored icons — updates after every tool call. Last-activity clock `⏱ HH:MM (Xm/Xh ago)` shows time since last response |
| **Desktop notifications** | Notifies via `notify-send` on task completion, waiting for input, and action required |
| **File preview** | Serves generated HTML/frontend files via HTTP for browser preview from container |
| **Pidash dashboard** | Live web dashboard — multi-session monitoring, browser messaging, model switching |
| **Pidiff viewer** | Standalone diff viewer with review comments — branch diffs, file tree, inline comments |
| **Dreaming** | Background memory consolidation — extracts memories from sessions, deduplicates, maintains topic-based memory |
| **Upgrade changelog** | Shows release notes on session start after pi-config version upgrade |
| **Task tracking** | Structured task lists for multi-step workflows — live widget, progress tracking, reminder nudges ([@tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks)) |
| **Neovim integration** | Send changed files and review findings to nvim's quickfix list — only active when running inside nvim |
| **Inter-agent communication** | P2P (`/coms`) and networked (`/coms-net`) agent communication — on-demand activation via slash commands |
| **Slash commands** | `/pr-review`, `/release`, `/review-local`, `/query-db`, `/btw`, `/async-status`, `/status`, `/dream`, `/remember`, `/coms`, `/coms-net` — with autocomplete argument hints |
| **GitHub autocomplete** | Type `#` in the editor to get issue/PR suggestions from the current repo — lazy-loaded, 5min cache |
| **Command arg completions** | Tab-complete arguments for slash commands — providers and models for `/external-ai`, branches for `/review-local`, PR numbers for `/pr-review`, and more |
| **Discord bot** | Control pi sessions from your phone via Discord DMs — send prompts, answer ask_user dialogs, switch sessions |

### Agents (24)

| Category | Agents |
|----------|--------|
| Languages | python-expert, go-expert, ts-expert, java-expert, bash-expert |
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
| `/pr-review [number\|url]` | Fetch PR diff, check past review comments, review with guidelines, post and track comments |
| `/release [flags]` | Create GitHub release with changelog and version bumping |
| `/review-local [branch]` | Review local uncommitted or branch changes |
| `/review-handler [url] [--autorabbit] [--autoqodo]` | Process PR review comments, fix approved items |
| `/refine-review <url>` | Refine and improve existing PR review comments |
| `/coderabbit-rate-limit [number\|url]` | Handle CodeRabbit rate limiting on PRs |
| `/create-coms-feature-manager` | Generate a coms feature-manager prompt customized for the current project (source template: `templates/coms-feature-manager-prompt.md`) |
| `/query-db <command>` | Query the review comments database |
| `/external-ai <agent> [--model <model>] [--session-id <id>] [--fix\|--peer\|--resume] <prompt>` | Run prompts via AI CLIs directly (cursor, claude, gemini) — full model access |
| `/external-ai-models-refresh` | Refresh cached AI CLI models for autocomplete |
| `/dream` | Run memory consolidation — extract, deduplicate, maintain topic-based memory |
| `/remember <what>` | Save a memory for future sessions |
| `/dream-auto` | Toggle automatic memory dreaming (every 3h + session end) |
| `/cron add\|list\|remove` | Schedule recurring tasks within the pi session (e.g., `/cron add every 2h check for new issues`, `/cron add at 12:00 /review-handler`). Tasks run while pi is active, survive `/reload`, and stop on exit |
| `/status` | Unified session snapshot — async agents, cron tasks, git branch, context usage |
| `/nvim-changed-files` | Send git changed files to nvim's quickfix list (only inside nvim) |
| `/pidiff start\|stop\|restart\|status` | Manage the pidiff diff viewer daemon |
| `/coms start\|stop\|status` | P2P local agent communication (Unix socket) |
| `/coms-net start\|connect\|disconnect\|stop\|status` | Networked agent communication (HTTP/SSE hub) |

### Inter-Agent Communication (coms & coms-net)

Two systems for Pi agents to communicate with each other, activated on-demand via slash commands:

**P2P Local (`/coms`)** — Direct Unix socket communication between agents on the same machine. No server needed.

```text
/coms start --name planner --purpose "Plans the work"
/coms stop
/coms status
```

**Networked (`/coms-net`)** — HTTP/SSE hub for communication across machines. Server auto-starts on localhost.

```text
/coms-net start --name dev --purpose "Development agent"
/coms-net connect
/coms-net disconnect
/coms-net stop
/coms-net status
```

For LAN/remote access, set `PI_COMS_NET_AUTH_TOKEN` and `PI_COMS_NET_HOST=0.0.0.0` in your environment.

**Tools available once activated:**

| Tool | Description |
|------|-------------|
| `*_list` | List peer agents with names, models, context usage |
| `*_send` | Send a prompt to a peer agent |
| `*_get` | Non-blocking poll for a response |
| `*_await` | Block until response arrives |

Forked from [disler/pi-vs-claude-code](https://github.com/disler/pi-vs-claude-code) coms extensions. We own these files — FIFO message queue, structured task delegation via coms protocol.

## Installation

### Docker (Recommended)

The recommended way to run pi-config is via the pre-built container image. It provides filesystem isolation, consistent tooling, and all dependencies pre-installed.

```bash
docker pull ghcr.io/myk-org/pi-config:latest
```

See the [Docker section](#docker-sandboxed-execution) below for the full run command and shell alias.

### Native (without Docker)

Run the interactive installer — it walks you through each component with multi-select checkboxes:

```bash
uv run https://raw.githubusercontent.com/myk-org/pi-config/main/scripts/install.py
```

Or if you already have the repo cloned:

```bash
uv run scripts/install.py
```

The installer covers:

- **Pi Packages** — pi-config, pi-vertex-claude, pi-web-access, myk-pi-tools, bun
- **Python Tools** — mcp-launchpad (mcpl), prek
- **npm Packages** — acpx, agent-browser
- **Browser Automation** — playwright + chromium
- **Environment Setup** — gitignore configuration

For non-interactive (CI) usage:

```bash
uv run scripts/install.py --all
```

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

### Project Settings

Create `.pi/pi-config-settings.json` in your project to override global defaults:

```json
{
  "commit_trailer": true,
  "allow_push_to_protected_branches": false,
  "use_worktrees": true,
  "dream_interval_hours": 6
}
```

Resolution order: project file → env var → default.

Global env vars: `PI_COMMIT_TRAILER`, `PI_ALLOW_PUSH_TO_PROTECTED_BRANCHES`, `PI_USE_WORKTREES`, `PI_DREAM_INTERVAL_HOURS`

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

### Image Generation

The `generate_image` tool creates images from structured descriptions via Gemini API.

**Required environment variables:**

| Variable | Description |
|----------|-------------|
| `PI_IMAGE_MODEL` | Gemini model name (e.g., `gemini-3-pro-image`). No default. |
| `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Gemini API key |

**Usage:** Ask naturally — "generate an image of a sunset" — or use structured params: `subject`, `action`, `scene`, `composition`, `lighting`, `style`, `text`, `aspect_ratio`.

In containers, images are auto-served via HTTP for browser preview.

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
  -v "$HOME/.pi":"$HOME/.pi":rw \
  -v "$HOME/.gitconfig":"$HOME/.gitconfig":ro \
  -v "$HOME/.gitignore-global":"$HOME/.gitignore-global":ro \
  -v "$HOME/.ssh":"$HOME/.ssh":ro \
  -v "$HOME/.config/gh":"$HOME/.config/gh":ro \
  -w "$PWD" \
  ghcr.io/myk-org/pi-config:latest
```

### Environment file

Create a `.env` file with container-specific variables:

```env
# Timezone (host timezone for correct timestamps)
TZ=Asia/Jerusalem

# Host username (creates /home/<user> -> container home symlink so host paths resolve)
PI_HOST_USER=myakove

# Google Cloud / Vertex AI
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION=us-east5
GOOGLE_APPLICATION_CREDENTIALS=/home/myakove/.config/gcloud/application_default_credentials.json
VERTEX_PROJECT_ID=your-project-id
VERTEX_REGION=us-east5
VERTEX_CLAUDE_1M=true

# GitHub
GITHUB_TOKEN=ghp_xxx
GITHUB_API_TOKEN=ghp_xxx
GH_CONFIG_DIR=/home/myakove/.config/gh

# Gemini (optional — required for image generation)
GEMINI_API_KEY=xxx

# Image generation model (required for generate_image tool)
PI_IMAGE_MODEL=gemini-3-pro-image

# acpx agents (optional)
# ACPX_AGENTS=cursor

# mcpl (MCP Launchpad) config path inside the container (must match mount target)
# Use your actual home path — it resolves inside the container via the PI_HOST_USER symlink
MCPL_CONFIG_FILES=/home/myakove/.config/mcpl/mcp.json
```

Pass via `--env-file /path/to/.env` in the docker run command.

### Project memory

The memory system stores per-repo lessons and patterns in `.pi/memory/topics/` as markdown
files organized by category (lessons, preferences, patterns, decisions, completions, mistakes).

- **Pinned** — user-requested memories (via `/remember`), never auto-removed
- **Learned** — auto-extracted by dreaming, can be reorganized/removed

The `.pi/memory/` directory is auto-added to the global gitignore in the container.

For **native** (non-container) usage, add it to your global gitignore:

```bash
echo '.pi/memory/' >> ~/.gitignore-global
git config --global core.excludesFile ~/.gitignore-global
```

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
- Info bar: model, tokens, context %, git status, diff viewer toggle
- Standalone diff viewer (pidiff) — opens in browser via link in info bar, powered by `@pierre/diffs` + `@pierre/trees`, with review comments
- Collapsible thinking and tool blocks with copy buttons
- ask_user tool bridging (answer from browser or TUI)
- Mobile responsive
- Event buffering for message replay on refresh
- Browser push notifications for background events (configurable per event type)
- Async agent live streaming (real-time tool calls and output inline in chat)
- Sidebar session working indicator (pulsing green dot when AI is active)
- `[HH:MM]` timestamps on all messages

**Access:**

```bash
# Automatically starts with pi — open in browser:
http://localhost:19190

# From other devices on your network:
http://<your-ip>:19190

# Custom port:
PI_PIDASH_PORT=9999 pi

# Disable pidash entirely:
PI_PIDASH_ENABLE=false pi
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
cd extensions/pidash/pidash-ui
npm install && npm run build
```

> **Note:** Session switching (`/resume`) and new sessions (`/new`) from the browser are not yet supported due to a pi API limitation. Use the TUI for these operations.

### Pidiff — standalone diff viewer

Pidiff is a standalone diff viewer that opens in your browser, providing rich branch diffs with inline review comments.

**How it works:**

- A daemon (`pidiff-server.ts`) runs on port `19290` and aggregates diff sessions from all pi instances
- Each pi session's extension (`pidiff.ts`) connects to the daemon and registers its repo
- The React UI uses `@pierre/diffs` and `@pierre/trees` for a full-featured diff experience

**Features:**

- Branch diff and commit comparison
- File tree with search and filtering
- Inline review comments on specific lines
- Publish review comments back to the pi session
- Multi-session support — each repo gets its own diff view
- Accessible via link in pidash info bar

**Access:**

```bash
# Open in browser:
http://localhost:19290

# Custom port:
PI_PIDIFF_PORT=9999 pi

# Disable pidiff entirely:
PI_PIDIFF_ENABLE=false pi
```

**Management:**

```bash
/pidiff status    # Check server status
/pidiff stop      # Stop the daemon
/pidiff start     # Start the daemon
/pidiff restart   # Restart the daemon
```

### Optional mounts

| Mount | Purpose |
|---|---|
| `-v "<PATH_TO_MCPL_CONFIG>":"$HOME/.config/mcpl/mcp.json":ro` | MCP server config for `mcpl` |
| `-v "$HOME/.agents":"$HOME/.agents":rw` | User-level skills (install/uninstall from container) |
| `-v "$HOME/.config/gcloud/application_default_credentials.json":"$HOME/.config/gcloud/application_default_credentials.json":ro` | Google Cloud ADC (for Claude via Vertex AI) |
| `-v "$HOME/.config/cursor/auth.json":"$HOME/.config/cursor/auth.json":ro` | Cursor CLI auth (for acpx cursor models) |
| `-v "$HOME/.config/glab-cli":"$HOME/.config/glab-cli":ro` | GitLab CLI config (auth tokens, host settings) |
| `-v "$HOME/.coderabbit":"$HOME/.coderabbit":rw` | CodeRabbit CLI auth and review data |
| `-v "$HOME/screenshots":"$HOME/screenshots"` | Share screenshots/images with the agent |
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
| `docker` / `podman` | Container CLIs (used via `docker-safe` read-only wrapper) |
| `docker-safe` | Restricted Docker/Podman wrapper — container only (ps, logs, inspect, top, stats) |
| `jq` | JSON processing |
| `cr` | CodeRabbit CLI — local AI code reviews |
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
  -v "$HOME/.pi":"$HOME/.pi":rw \
  -v "$HOME/.gitconfig":"$HOME/.gitconfig":ro \
  -v "$HOME/.gitignore-global":"$HOME/.gitignore-global":ro \
  -v "$HOME/.ssh":"$HOME/.ssh":ro \
  -v "$HOME/.config/gh":"$HOME/.config/gh":ro \
  -v "$HOME/.config/mcpl/mcp.json":"$HOME/.config/mcpl/mcp.json":ro \ # adjust host path to your mcpl config location
  -v "$HOME/.agents":"$HOME/.agents":rw \
  -v "$HOME/.config/gcloud/application_default_credentials.json":"$HOME/.config/gcloud/application_default_credentials.json":ro \
  -v "$HOME/.config/cursor/auth.json":"$HOME/.config/cursor/auth.json":ro \
  -v "$HOME/.config/glab-cli":"$HOME/.config/glab-cli":ro \
  -v "$HOME/screenshots":"$HOME/screenshots":ro \
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
