# Installing and Starting Your First Session

Get pi-config installed and running so you can start delegating coding tasks to an orchestrator backed by 24 specialist agents. Choose between Docker (sandboxed, all dependencies included) or native installation on your own machine.

## Prerequisites

- **Node.js 22+** — required by pi itself ([download](https://nodejs.org) or `nvm install 22`)
- **Git** — version control (`apt install git` / `brew install git`)
- **pi** — the coding agent that pi-config extends (`npm install -g @earendil-works/pi-coding-agent`)
- **An LLM provider** — pi needs an API key for at least one provider (Anthropic, Google Vertex AI, etc.). See [Configuration and Environment Variables Reference](configuration-reference.html) for all supported providers.

## Quick Start (Docker)

```bash
docker pull ghcr.io/myk-org/pi-config:latest

docker run --rm -it \
  --name "pi-session" \
  --network host \
  -e ANTHROPIC_API_KEY="sk-ant-..." \
  -v "$PWD":"$PWD":rw \
  -v "$HOME/.pi":"$HOME/.pi":rw \
  -v "$HOME/.gitconfig":"$HOME/.gitconfig":ro \
  -v "$HOME/.ssh":"$HOME/.ssh":ro \
  -v "$HOME/.config/gh":"$HOME/.config/gh":ro \
  -w "$PWD" \
  ghcr.io/myk-org/pi-config:latest
```

That's it. The container installs pi, pulls pi-config, and drops you into an interactive session. Type a task and the orchestrator takes over.

## Installation Methods

### Option A: Docker Container (Recommended)

The Docker image ships with every tool pre-installed — GitHub CLI, Python (uv), Go, kubectl, browser automation, and more. Your host filesystem is protected; the agent can only access mounted directories.

**1. Pull the image:**

```bash
docker pull ghcr.io/myk-org/pi-config:latest
```

**2. Create an environment file** at `~/.pi/.env`:

```env
# Timezone
TZ=America/New_York

# Host username — maps container home to /home/<user> so host paths resolve
PI_HOST_USER=your-username

# LLM provider (at least one required)
# Option A: Anthropic direct
ANTHROPIC_API_KEY=sk-ant-xxx

# Option B: Google Cloud / Vertex AI
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION=us-east5
GOOGLE_APPLICATION_CREDENTIALS=/home/your-username/.config/gcloud/application_default_credentials.json

# GitHub (required for PR/issue workflows)
GITHUB_TOKEN=ghp_xxx
GH_CONFIG_DIR=/home/your-username/.config/gh
```

> **Note:** Use your actual home path in the env file — the `PI_HOST_USER` setting creates a symlink inside the container so these paths resolve correctly.

**3. Run the container:**

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
  -v /tmp/pi-work:/tmp/pi-work:rw \
  -w "$PWD" \
  ghcr.io/myk-org/pi-config:latest
```

On first start, the entrypoint automatically:

1. Installs/updates pi to the latest version
2. Installs pi-config (orchestrator, agents, prompts)
3. Installs companion packages (pi-web-access, pi-tasks)
4. Installs the myk-pi-tools CLI
5. Configures the global gitignore for memory and worktree directories
6. Starts an interactive pi session

> **Tip:** A `WARNING` on stderr about packages already being cached is normal. If pi doesn't start, check your network connectivity.

For a permanent shell alias, see [Running Pi in a Docker Container](docker-deployment.html).

### Option B: Native Installation

For running pi directly on your machine without Docker.

**1. Install prerequisites:**

```bash
# Node.js 22+
nvm install 22

# pi coding agent
npm install -g @earendil-works/pi-coding-agent

# uv (Python package manager — required for Python tools)
curl -LsSf https://astral.sh/uv/install.sh | sh
```

**2. Run the interactive installer:**

```bash
uv run https://raw.githubusercontent.com/myk-org/pi-config/main/scripts/install.py
```

The installer walks you through five steps with multi-select checkboxes:

| Step | What it installs |
|------|-----------------|
| Pi Packages | pi-config, pi-vertex-claude, pi-web-access, pi-tasks, myk-pi-tools, bun |
| Python Tools | mcp-launchpad (mcpl), prek |
| npm Packages | acpx, agent-browser |
| Browser Automation | Playwright + Chromium |
| Environment Setup | Adds `.pi/memory/`, `.worktrees/`, `.pi/tasks/` to global gitignore |

Select only what you need — each tool shows whether it's already installed.

> **Tip:** For non-interactive CI environments, run `uv run scripts/install.py --all` to install everything without prompts.

**3. Start a session:**

```bash
cd your-project
pi
```

## Configuring Prerequisites

### GitHub CLI (gh)

The GitHub CLI is required for PR reviews, issue creation, and release workflows. It's pre-installed in the Docker image.

**Native installation:**

```bash
# macOS
brew install gh

# Linux (Debian/Ubuntu)
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | sudo gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt update && sudo apt install gh
```

**Authenticate:**

```bash
gh auth login
```

For Docker, mount your gh config directory: `-v "$HOME/.config/gh":"$HOME/.config/gh":ro`

### API Keys

Pi needs credentials for at least one LLM provider. Pass them as environment variables:

| Provider | Environment Variable |
|----------|---------------------|
| Anthropic (direct) | `ANTHROPIC_API_KEY` |
| Google Vertex AI | `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS` |
| Gemini (image generation) | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| GitHub (for PR/issue workflows) | `GITHUB_TOKEN` |

For Docker, put these in your `~/.pi/.env` file and pass with `--env-file`. For native, export them in your shell profile.

See [Configuration and Environment Variables Reference](configuration-reference.html) for the full list of supported variables.

### MCP Launchpad (Optional)

MCP Launchpad (`mcpl`) lets pi access external tools from MCP servers (Sentry, Vercel, Jenkins, etc.). It's pre-installed in the Docker image.

**Native installation:**

```bash
uv tool install mcp-launchpad --from "mcp-launchpad @ git+https://github.com/kenneth-liao/mcp-launchpad.git"
```

**Docker mount** for your MCP config:

```bash
-v "$HOME/.config/mcpl/mcp.json":"$HOME/.config/mcpl/mcp.json":ro
```

## Running Your First Session

**1. Navigate to your project and start pi:**

```bash
cd ~/my-project
pi     # or use the Docker command/alias
```

**2. On startup, pi validates your environment.** You'll see notifications about any missing tools — critical ones (like `uv`) get a warning, optional ones (like `gh`, `mcpl`) are informational.

**3. Try a simple task:**

```
Add a docstring to every public function in src/utils.py
```

The orchestrator reads the request, identifies it as Python work, and delegates to the `python-expert` agent. You'll see the delegation happen in real time.

**4. Try a workflow command:**

```
/implement add retry logic to the HTTP client
```

This runs the full scout → planner → worker pipeline: a scout agent explores the codebase, a planner creates a step-by-step plan, and a worker implements it.

**5. Check session status anytime:**

```
/status
```

This shows async agents, cron tasks, git branch, and session info at a glance.

> **Tip:** The orchestrator never edits files directly — it always delegates to the right specialist agent. See [Understanding Agent Routing and Delegation](agent-routing.html) for how routing decisions work.

## Project-Level Configuration

Create `.pi/pi-config-settings.json` in any project to customize behavior:

```json
{
  "co_author": true,
  "use_worktrees": false,
  "dream_interval_hours": 3
}
```

| Setting | What it does | Default |
|---------|-------------|---------|
| `co_author` | Add co-author trailer to git commits | `false` |
| `use_worktrees` | Force git worktree workflow for branches | `false` |
| `dream_interval_hours` | How often memory consolidation runs | `3` |

Settings resolve in order: project file → environment variable → default. See [Configuration and Environment Variables Reference](configuration-reference.html) for details.

## Updating

### Docker

```bash
docker pull ghcr.io/myk-org/pi-config:latest
```

The container runs `pi update` automatically on every start, so you always get the latest pi-config and agents.

### Native

```bash
pi update                       # Updates pi-config and all pi packages
uv tool upgrade myk-pi-tools    # Updates the CLI tool
```

After updating, run `/reload` inside a running pi session or restart pi to pick up changes.

## Advanced Usage

### Building the Docker Image from Source

If you want to customize the image or run on a different architecture:

```bash
git clone https://github.com/myk-org/pi-config.git
cd pi-config
docker build -t ghcr.io/myk-org/pi-config:latest .
```

> **Note:** The image is built for **linux/amd64** only. On ARM hosts, build with `--platform linux/amd64`.

### Docker Socket Access

To let pi inspect containers (via the restricted `docker-safe` wrapper), mount the Docker socket:

```bash
-v /var/run/docker.sock:/var/run/docker.sock:ro \
--group-add $(stat -c '%g' /var/run/docker.sock)
```

The `docker-safe` wrapper only allows read-only operations: `ps`, `logs`, `inspect`, `top`, `stats`.

### Additional Docker Mounts

| Mount | Purpose |
|-------|---------|
| `-v "$HOME/.config/gcloud/application_default_credentials.json":"$HOME/.config/gcloud/application_default_credentials.json":ro` | Google Cloud ADC for Vertex AI |
| `-v "$HOME/.config/cursor/auth.json":"$HOME/.config/cursor/auth.json":ro` | Cursor CLI auth for ACPX models |
| `-v "$HOME/.config/glab-cli":"$HOME/.config/glab-cli":ro` | GitLab CLI config |
| `-v "$HOME/.coderabbit":"$HOME/.coderabbit":rw` | CodeRabbit CLI auth and review data |
| `-v "$HOME/.agents":"$HOME/.agents":rw` | User-level skills for agent-browser |
| `-v "$HOME/screenshots":"$HOME/screenshots":ro` | Share screenshots/images with the agent |

### ACPX Provider (External Agent Models)

Access models from external agents (Cursor, Claude, Gemini, Copilot) as native pi models by setting `ACPX_AGENTS`:

```env
ACPX_AGENTS=cursor
```

This registers all models available through the Cursor agent as selectable pi models.

### Disabling Bundled Features

| Feature | Environment Variable | Default |
|---------|---------------------|---------|
| Pidash web dashboard | `PI_PIDASH_ENABLE=false` | enabled |
| Pidiff diff viewer | `PI_PIDIFF_ENABLE=false` | enabled |
| Pidash custom port | `PI_PIDASH_PORT=9999` | `19190` |
| Pidiff custom port | `PI_PIDIFF_PORT=9999` | `19290` |

### Native Gitignore Setup

The Docker container automatically configures the global gitignore. For native installations, the installer handles this too, but you can verify manually:

```bash
echo '.pi/memory/' >> ~/.gitignore-global
echo '.worktrees/' >> ~/.gitignore-global
echo '.pi/tasks/' >> ~/.gitignore-global
git config --global core.excludesFile ~/.gitignore-global
```

## Troubleshooting

**Pi won't start in Docker — "permission denied" errors:**
The container runs as user `node` (UID 1000). If your project files are owned by a different UID, set `PI_HOST_USER=your-username` in the env file so the container maps home directories correctly.

**"uv not found" warning on session start:**
`uv` is required for Python execution. In Docker it's pre-installed. For native, install with `curl -LsSf https://astral.sh/uv/install.sh | sh`.

**"gh not found" notification:**
GitHub CLI is optional but needed for PR/issue workflows. Install it or mount your existing config into the container.

**Container exits immediately:**
Ensure you're passing `-it` (interactive + TTY). Without it, pi has no terminal to attach to.

**Slow first start:**
The first run downloads pi-config, companion packages, and npm dependencies. Subsequent starts use cached packages and are much faster. Mount `/tmp/pi-work:/tmp/pi-work:rw` to persist temp files across container restarts.

## Related Pages

- [Your First Coding Workflow](first-workflow.html)
- [Running Pi in a Docker Container](docker-deployment.html)
- [Configuration and Environment Variables Reference](configuration-reference.html)
- [Using Slash Commands and Prompt Templates](slash-commands.html)
- [Understanding Agent Routing and Delegation](agent-routing.html)
