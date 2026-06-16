# Installing and Starting Your First Session

Get pi-config installed and launch your first orchestrator session so you can start delegating tasks to specialist agents. You can install via a pre-built Docker container (recommended for isolation and consistency) or natively on your machine.

## Prerequisites

- **Node.js 22+** — required for pi itself ([nodejs.org](https://nodejs.org))
- **Git** — version control ([git-scm.com](https://git-scm.com))
- **A GitHub account** with a personal access token — needed for PR and issue workflows
- **An LLM provider** — pi needs a model to run (e.g., Claude via Vertex AI, or another supported provider)

## Quick Start (Docker)

```bash
docker pull ghcr.io/myk-org/pi-config:latest

docker run --rm -it \
  --name "pi-session" \
  --network host \
  -v "$PWD":"$PWD":rw \
  -v "$HOME/.pi":"$HOME/.pi":rw \
  -v "$HOME/.gitconfig":"$HOME/.gitconfig":ro \
  -v "$HOME/.ssh":"$HOME/.ssh":ro \
  -v "$HOME/.config/gh":"$HOME/.config/gh":ro \
  -w "$PWD" \
  ghcr.io/myk-org/pi-config:latest
```

That's it — pi starts automatically with the orchestrator, all 24 specialist agents, and every tool pre-installed. Navigate to a project directory first, then run the command.

## Quick Start (Native)

```bash
npm install -g @earendil-works/pi-coding-agent
curl -LsSf https://astral.sh/uv/install.sh | sh
uv run https://raw.githubusercontent.com/myk-org/pi-config/main/scripts/install.py
```

After the installer finishes, start a session:

```bash
pi
```

## Step-by-Step: Docker Installation

### 1. Pull the image

```bash
docker pull ghcr.io/myk-org/pi-config:latest
```

The image includes everything pre-installed: `gh`, `uv`, `go`, `kubectl`, `bun`, Playwright + Chromium, CodeRabbit CLI, Cursor CLI, Claude Code, and more.

### 2. Create an environment file

Create a file at `~/.pi/.env` with your credentials and settings:

```env
# Timezone (match your host for correct timestamps)
TZ=America/New_York

# Host username (maps container paths to match your host home directory)
PI_HOST_USER=yourusername

# GitHub token (required for PR/issue workflows)
GITHUB_TOKEN=ghp_xxx
GH_CONFIG_DIR=/home/yourusername/.config/gh

# Google Cloud / Vertex AI (if using Claude via Vertex)
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION=us-east5
GOOGLE_APPLICATION_CREDENTIALS=/home/yourusername/.config/gcloud/application_default_credentials.json
```

> **Note:** Replace `yourusername` with your actual system username. The `PI_HOST_USER` variable creates a symlink inside the container so that host-mounted paths resolve correctly.

### 3. Run pi in a container

Navigate to your project directory and start a session:

```bash
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
  -w "$PWD" \
  ghcr.io/myk-org/pi-config:latest
```

On each start, the container automatically installs the latest version of pi and updates all packages.

> **Tip:** A startup `WARNING` about already-cached packages is normal and can be ignored.

### 4. Create a shell alias

Add this to your `~/.bashrc` or `~/.zshrc` so you can launch pi with a single command:

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
  -w "$PWD" \
  ghcr.io/myk-org/pi-config:latest'
```

Then from any project directory:

```bash
pi-docker
```

## Step-by-Step: Native Installation

### 1. Install prerequisites

Install pi, uv, and the GitHub CLI:

```bash
# Pi coding agent
npm install -g @earendil-works/pi-coding-agent

# uv (Python package manager — enforced by pi-config instead of pip)
curl -LsSf https://astral.sh/uv/install.sh | sh

# GitHub CLI (for PR and issue workflows)
# macOS:
brew install gh
# Debian/Ubuntu:
# See https://cli.github.com/ for installation instructions
```

### 2. Run the interactive installer

The installer walks you through each component with multi-select checkboxes:

```bash
uv run https://raw.githubusercontent.com/myk-org/pi-config/main/scripts/install.py
```

It installs in 5 steps:

1. **Pi Packages** — pi-config, pi-vertex-claude, pi-web-access, pi-tasks, myk-pi-tools, bun
2. **Python Tools** — mcp-launchpad (mcpl), prek
3. **npm Packages** — acpx, agent-browser
4. **Browser Automation** — Playwright + Chromium
5. **Environment Setup** — adds `.pi/` and `.worktrees/` to your global gitignore

Deselect anything you don't need. The installer shows which items are already installed.

### 3. Authenticate GitHub CLI

```bash
gh auth login
```

Follow the prompts to authenticate. This enables PR creation, issue management, and release workflows.

### 4. Start a session

Navigate to a project directory and launch pi:

```bash
cd ~/my-project
pi
```

The orchestrator loads automatically and validates your environment. You'll see notifications about any missing optional tools.

## Verifying Your Installation

When pi starts, it runs environment checks and notifies you about missing tools. A healthy session shows:

- **No critical warnings** — `uv` is detected
- **Git status** in the status line — shows your current branch and working tree status
- **Container indicator** (Docker only) — a container icon confirms you're running inside the sandbox

Try a simple delegation to confirm the orchestrator is working:

```text
What files are in this project?
```

The orchestrator should route this to a specialist agent (typically `worker`) that reads and reports the directory contents.

## What the Container Protects

When running via Docker, pi-config enforces filesystem isolation:

| Access | Scope |
|--------|-------|
| ✅ Read/write | Your mounted project directory |
| ✅ Read/write | `~/.pi` (sessions, memory, settings) |
| ✅ Read-only | Git, SSH, and GitHub CLI config |
| ❌ Blocked | Everything else on your host |

> **Warning:** The `--network host` flag shares your host network stack. This is required for local MCP servers, the web dashboard, and file preview. If you only use cloud-based LLM providers and don't need these features, you can omit it.

## Updating

### Docker

```bash
docker pull ghcr.io/myk-org/pi-config:latest
```

The container runs `pi update` automatically on each start, so packages stay current.

### Native

```bash
pi update
uv tool upgrade myk-pi-tools
```

After updating, run `/reload` inside an active session or restart pi to pick up changes. Pi-config shows a changelog notification on the first session after an upgrade.

## Advanced Usage

### Non-Interactive Installation (CI)

Skip all prompts and install everything:

```bash
uv run https://raw.githubusercontent.com/myk-org/pi-config/main/scripts/install.py --all
```

### Building the Docker Image from Source

> **Note:** The image is built for **linux/amd64** only. On ARM hosts, build with `--platform linux/amd64`.

```bash
git clone https://github.com/myk-org/pi-config.git
cd pi-config
docker build -t ghcr.io/myk-org/pi-config:latest .
```

### Additional Docker Volume Mounts

These optional mounts unlock extra capabilities:

| Mount | Purpose |
|-------|---------|
| `-v "$HOME/.config/gcloud/application_default_credentials.json":"$HOME/.config/gcloud/application_default_credentials.json":ro` | Google Cloud credentials (Claude via Vertex AI) |
| `-v "$HOME/.config/mcpl/mcp.json":"$HOME/.config/mcpl/mcp.json":ro` | MCP server configuration |
| `-v "$HOME/.agents":"$HOME/.agents":rw` | User-level skills |
| `-v "$HOME/.config/cursor/auth.json":"$HOME/.config/cursor/auth.json":ro` | Cursor CLI auth (for ACPX models) |
| `-v "$HOME/.config/glab-cli":"$HOME/.config/glab-cli":ro` | GitLab CLI config |
| `-v "$HOME/.coderabbit":"$HOME/.coderabbit":rw` | CodeRabbit CLI auth and data |
| `-v "$HOME/screenshots":"$HOME/screenshots":ro` | Share images with the agent |
| `-v /var/run/docker.sock:/var/run/docker.sock:ro` | Docker container inspection |

When mounting the Docker socket, also add `--group-add $(stat -c '%g' /var/run/docker.sock)` for proper permissions.

### Environment Variables for Additional Features

Add these to your `.env` file as needed:

| Variable | Purpose |
|----------|---------|
| `GEMINI_API_KEY` | Gemini API access (image generation, external AI) |
| `PI_IMAGE_MODEL` | Gemini model for image generation (e.g., `gemini-3-pro-image`) |
| `ACPX_AGENTS` | Comma-separated list of ACPX agents to register as providers (e.g., `cursor`) |
| `MCPL_CONFIG_FILES` | Path to MCP Launchpad config inside the container |
| `VERTEX_PROJECT_ID` | Google Cloud project for Vertex AI |
| `VERTEX_REGION` | Google Cloud region for Vertex AI |
| `PI_PIDASH_PORT` | Custom port for the web dashboard (default: `19190`) |
| `PI_PIDIFF_PORT` | Custom port for the diff viewer (default: `19290`) |

See [Configuration and Environment Variables Reference](configuration-reference.html) for the complete list.

### Project-Level Settings

Create `.pi/pi-config-settings.json` in any project to override global defaults:

```json
{
  "co_author": true,
  "use_worktrees": false,
  "dream_interval_hours": 3
}
```

See [Customization and Extension Recipes](customization-recipes.html) for details on project settings and custom agents.

## Troubleshooting

**"Cannot find pi" after native install**
Make sure `~/.npm-global/bin` (or your npm prefix) is in your `PATH`. Run `npm config get prefix` to check.

**Container exits immediately**
Ensure you're running with `-it` (interactive + TTY). Without these flags, the container has no terminal to attach to.

**"uv: command not found" warning on session start**
Install uv: `curl -LsSf https://astral.sh/uv/install.sh | sh`. Pi-config enforces `uv` instead of `pip` for all Python operations.

**GitHub CLI not authenticated**
Run `gh auth login` on the host (native) or ensure `~/.config/gh` is mounted (Docker). Without it, PR and issue workflows won't work.

**Host file paths don't resolve inside the container**
Set `PI_HOST_USER=yourusername` in your `.env` file. This creates a symlink from `/home/yourusername` inside the container to the container's home directory, so mounted paths match.

**Startup is slow**
The container runs `npm install -g` and `pi update` on every start to stay current. This takes a few seconds with a warm cache. Subsequent starts in the same network environment are faster.

## Related Pages

- [Your First Coding Workflow](first-workflow.html)
- [Running Pi in a Docker Container](docker-deployment.html)
- [Configuration and Environment Variables Reference](configuration-reference.html)
- [Customization and Extension Recipes](customization-recipes.html)
- [Using Slash Commands and Prompt Templates](slash-commands.html)
