# Running Pi in a Docker Container

Run pi-config inside a sandboxed Docker container to get filesystem isolation, consistent tooling, and all dependencies pre-installed — without modifying your host system.

## Prerequisites

- **Docker** (or a compatible runtime like Podman) installed on your host
- An **LLM provider** configured (e.g., Google Cloud / Vertex AI credentials, or an API key)
- **Git**, **SSH keys**, and **GitHub CLI** (`gh`) configured on your host
- An environment file (`.env`) with your API keys and settings (see [Setting up the environment file](#setting-up-the-environment-file) below)

## Quick Start

Pull the pre-built image and launch a session from any project directory:

```bash
docker pull ghcr.io/myk-org/pi-config:latest

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

On first run, the container installs the latest `pi` and `pi-config` package, then drops you into an interactive pi session. Subsequent starts reuse cached packages and only pull updates.

## Setting Up the Environment File

Create a `.env` file at `~/.pi/.env` (or any path you prefer) with your credentials and configuration:

```env
# Timezone (match your host for correct timestamps)
TZ=America/New_York

# Host username — maps /home/<user> paths between host and container
PI_HOST_USER=yourname

# Google Cloud / Vertex AI
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION=us-east5
GOOGLE_APPLICATION_CREDENTIALS=/home/yourname/.config/gcloud/application_default_credentials.json
VERTEX_PROJECT_ID=your-project-id
VERTEX_REGION=us-east5

# GitHub
GITHUB_TOKEN=ghp_xxx
GITHUB_API_TOKEN=ghp_xxx
GH_CONFIG_DIR=/home/yourname/.config/gh

# Gemini (optional — for image generation)
GEMINI_API_KEY=xxx
PI_IMAGE_MODEL=gemini-3-pro-image

# MCP Launchpad config path (must match mount target inside container)
MCPL_CONFIG_FILES=/home/yourname/.config/mcpl/mcp.json
```

> **Note:** Paths in the `.env` file should use your **host home directory path** (e.g., `/home/yourname/...`). The `PI_HOST_USER` setting creates symlinks inside the container so these paths resolve correctly.

## Understanding Volume Mounts

Every file the container can access must be explicitly mounted. This is the core of Docker's filesystem isolation.

### Required Mounts

| Mount | Mode | Purpose |
|-------|------|---------|
| `-v "$PWD":"$PWD"` | `rw` | Your project directory — the agent reads and writes code here |
| `-v "$HOME/.pi":"$HOME/.pi"` | `rw` | Pi settings, sessions, memory, and cached packages |
| `-v "$HOME/.gitconfig":"$HOME/.gitconfig"` | `ro` | Git configuration (name, email, aliases) |
| `-v "$HOME/.gitignore-global":"$HOME/.gitignore-global"` | `ro` | Global gitignore rules |
| `-v "$HOME/.ssh":"$HOME/.ssh"` | `ro` | SSH keys for git push/pull over SSH |
| `-v "$HOME/.config/gh":"$HOME/.config/gh"` | `ro` | GitHub CLI authentication |

### Optional Mounts

Add these for specific features:

| Mount | Mode | Purpose |
|-------|------|---------|
| `-v "$HOME/.config/gcloud/application_default_credentials.json":"$HOME/.config/gcloud/application_default_credentials.json"` | `ro` | Google Cloud ADC (for Claude via Vertex AI) |
| `-v "$HOME/.config/mcpl/mcp.json":"$HOME/.config/mcpl/mcp.json"` | `ro` | MCP server config for `mcpl` |
| `-v "$HOME/.config/cursor/auth.json":"$HOME/.config/cursor/auth.json"` | `ro` | Cursor CLI auth (for ACPX cursor models) |
| `-v "$HOME/.config/glab-cli":"$HOME/.config/glab-cli"` | `ro` | GitLab CLI config (auth tokens, host settings) |
| `-v "$HOME/.agents":"$HOME/.agents"` | `rw` | User-level skills (install/uninstall from container) |
| `-v "$HOME/.coderabbit":"$HOME/.coderabbit"` | `rw` | CodeRabbit CLI auth and review data |
| `-v "$HOME/screenshots":"$HOME/screenshots"` | `ro` | Share screenshots/images with the agent |

## Host User Mapping with `PI_HOST_USER`

The container runs as the `node` user (UID 1000) internally. When you mount host directories like `$HOME/.ssh` or `$HOME/.config/gh`, the paths inside the container don't match because the container's home is `/home/node`.

Set `PI_HOST_USER` in your `.env` file to your host username:

```env
PI_HOST_USER=yourname
```

The init entrypoint will:

1. Create `/home/yourname` inside the container and symlink it to the container's internal directories
2. Set `HOME=/home/yourname` so all your host paths (SSH keys, Git config, GCloud credentials) resolve correctly
3. Reverse-symlink mounted content back to `/home/node` so container tools find everything regardless of which home they check

> **Tip:** If your host UID is also 1000, you can skip `PI_HOST_USER` — paths under `/home/node` will match permission-wise. But if your username differs from `node`, you still need it for path resolution.

## Docker Socket Access

To let pi inspect running containers (via the read-only `docker-safe` wrapper), mount the Docker socket:

```bash
-v /var/run/docker.sock:/var/run/docker.sock:ro
```

The container's init entrypoint automatically detects the mounted socket and grants the `node` user access using ACLs or group membership — no manual `--group-add` is needed.

For Podman, mount the Podman socket instead:

```bash
-v /var/run/podman/podman.sock:/var/run/podman/podman.sock:ro
```

The `docker-safe` wrapper only allows **read-only inspection commands**: `ps`, `logs`, `inspect`, `top`, `stats`, `port`, `diff`, `images`, `version`, and `info`. All state-modifying commands (`run`, `exec`, `rm`, `build`, etc.) are blocked. See [Command Safety Guards and Enforcement](command-enforcement.html) for details.

## Networking

The `--network host` flag shares your host's network stack with the container. This is needed for:

- **Local MCP servers** — pi connects to MCP servers running on your host
- **File preview** — agents serve generated HTML files via HTTP for browser access
- **Pidash dashboard** — the web dashboard listens on port `19190` (accessible at `http://localhost:19190`)
- **Pidiff viewer** — the diff viewer listens on port `19290`

> **Tip:** If your LLM provider is cloud-based, you don't use local MCP servers, and you don't need the web dashboard or file preview, you can omit `--network host` and use the default bridge network instead.

## Creating a Shell Alias

Add this to your `~/.bashrc` or `~/.zshrc` to launch pi with a single command from any project directory:

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
  -v "$HOME/.config/gcloud/application_default_credentials.json":"$HOME/.config/gcloud/application_default_credentials.json":ro \
  -v "$HOME/.config/cursor/auth.json":"$HOME/.config/cursor/auth.json":ro \
  -v "$HOME/.config/glab-cli":"$HOME/.config/glab-cli":ro \
  -v "$HOME/.config/mcpl/mcp.json":"$HOME/.config/mcpl/mcp.json":ro \
  -v "$HOME/.agents":"$HOME/.agents":rw \
  -v "$HOME/screenshots":"$HOME/screenshots":ro \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -w "$PWD" \
  ghcr.io/myk-org/pi-config:latest'
```

Then run `pi-docker` from any project directory. Remove any `-v` lines for mounts you don't need.

## What's Included in the Image

The container ships with all tools pre-installed:

| Tool | Purpose |
|------|---------|
| `pi` | Coding agent (installed/updated on each start) |
| `git`, `gh`, `glab` | Version control, GitHub CLI, GitLab CLI |
| `uv` / `uvx` | Python execution (enforced by the orchestrator) |
| `go` | Go development |
| `bun` | JavaScript/TypeScript runtime |
| `kubectl` / `oc` | Kubernetes and OpenShift CLI |
| `mcpl` | MCP server access |
| `myk-pi-tools` | PR review, release, and CLI utilities |
| `acpx` | Agent proxy for remote models |
| `agent-browser` | Browser automation (Chromium via Playwright) |
| `docker` / `podman` | Container CLIs (via `docker-safe` read-only wrapper) |
| `cr` | CodeRabbit CLI for local AI code reviews |
| `prek` | Pre-commit hook runner |
| `jq`, `curl` | JSON processing, HTTP requests |
| `procps` | Process utilities (`ps`, `top`, `pgrep`, `pkill`) |

## What's Protected

The container cannot access anything outside your mounted volumes:

- ✅ `$PWD` (your project) — read/write
- ✅ `~/.pi` (pi settings, sessions, memory) — read/write
- ✅ Git, GitHub, SSH config — read-only
- ❌ Other directories on your host — not accessible
- ❌ Other git repos — not accessible
- ❌ System files — not accessible

## Advanced Usage

### Building the Image from Source

> **Note:** The image is built for **linux/amd64** only. On ARM hosts (e.g., Apple Silicon), build with `--platform linux/amd64`.

```bash
git clone https://github.com/myk-org/pi-config.git
cd pi-config
docker build -t ghcr.io/myk-org/pi-config:latest .
```

### Updating the Image

```bash
docker pull ghcr.io/myk-org/pi-config:latest
```

The container also runs `pi update` automatically on each start, so you always get the latest pi-config package even without pulling a new image.

### Custom Dashboard and Diff Viewer Ports

Override the default ports via environment variables:

```env
PI_PIDASH_PORT=9999
PI_PIDIFF_PORT=9998
```

Or disable them entirely:

```env
PI_PIDASH_ENABLE=false
PI_PIDIFF_ENABLE=false
```

See [Using the Web Dashboard and Diff Viewer](dashboards-and-diffs.html) for more on pidash and pidiff.

### Using ACPX Agent Providers

To route LLM requests through external agents (Cursor, Claude CLI, Gemini CLI), set `ACPX_AGENTS` in your `.env` and mount the appropriate auth files:

```env
ACPX_AGENTS=cursor
```

```bash
-v "$HOME/.config/cursor/auth.json":"$HOME/.config/cursor/auth.json":ro
```

See [Using ACPX Provider for External Agent Models](acpx-provider.html) for setup details.

### Discord Bot in the Container

The Discord bot runs inside the pidash daemon. To enable it, create a Discord config file on your host:

```bash
cat > ~/.pi/discord.env << 'EOF'
DISCORD_BOT_TOKEN=your-token-here
DISCORD_ALLOWED_USERS=your-discord-user-id
EOF
```

Since `~/.pi` is already mounted read/write, the pidash daemon inside the container picks up this file automatically. Run `/pidash restart` in your pi session to activate it. See [Controlling Pi Sessions from Discord](discord-bot.html) for full setup.

### Project-Level Settings

Create `.pi/pi-config-settings.json` in your project directory to override defaults per-project:

```json
{
  "co_author": true,
  "use_worktrees": false,
  "dream_interval_hours": 6
}
```

See [Configuration and Environment Variables Reference](configuration-reference.html) for all available settings.

## Troubleshooting

### Container exits immediately on start

Check that your `.env` file path is correct in `--env-file`. A missing file causes Docker to fail silently. Verify with:

```bash
docker run --rm -it --env-file "$HOME/.pi/.env" ghcr.io/myk-org/pi-config:latest echo "env loaded"
```

### Permission denied on mounted volumes

The container runs as user `node` (UID 1000). If your host UID differs, mounted files may not be readable. Ensure your SSH keys and config files are world-readable or owned by UID 1000:

```bash
chmod 644 ~/.gitconfig
chmod 700 ~/.ssh
chmod 600 ~/.ssh/id_*
```

### `WARNING` about packages on startup

A warning about already-cached packages during startup is normal. The entrypoint runs `pi install` / `pi update` on every start. If the warning persists or you see errors, check your network connection — the container needs internet access to fetch packages.

### Git push/pull fails with SSH errors

Verify your SSH agent is running on the host and keys are loaded. The container mounts `~/.ssh` read-only but cannot access the host's SSH agent socket by default. Add the agent socket mount:

```bash
-v "$SSH_AUTH_SOCK":"$SSH_AUTH_SOCK":ro \
-e SSH_AUTH_SOCK="$SSH_AUTH_SOCK"
```

### Host paths don't resolve inside the container

Make sure `PI_HOST_USER` in your `.env` matches your host username exactly. The container creates a `/home/<PI_HOST_USER>` directory with symlinks so that paths like `/home/yourname/.config/gh` work inside the container.

## Related Pages

- [Installing and Starting Your First Session](quickstart.html)
- [Configuration and Environment Variables Reference](configuration-reference.html)
- [Command Safety Guards and Enforcement](command-enforcement.html)
- [Using the Web Dashboard and Diff Viewer](dashboards-and-diffs.html)
- [Controlling Pi Sessions from Discord](discord-bot.html)
