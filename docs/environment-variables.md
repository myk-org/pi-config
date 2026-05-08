# Environment Variables

All environment variables used by pi-config. Pass them via `--env-file` in Docker or export them in your shell for native usage. See Docker Setup for container configuration details.

> **Tip:** None of these variables are strictly required. pi-config runs with sensible defaults; configure only what you need.

## GitHub Authentication

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `GITHUB_TOKEN` | string | — | GitHub personal access token for API operations (PRs, issues, reviews) |
| `GITHUB_API_TOKEN` | string | — | Alternative GitHub token variable (same purpose as `GITHUB_TOKEN`) |
| `GH_CONFIG_DIR` | string | `~/.config/gh` | Path to GitHub CLI configuration directory |

```env
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GITHUB_API_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GH_CONFIG_DIR=/home/myuser/.config/gh
```

> **Note:** `GITHUB_TOKEN` and `GITHUB_API_TOKEN` serve the same purpose. Set whichever your tooling expects. The `gh` CLI uses its own auth from `GH_CONFIG_DIR`.

## Google Cloud / Vertex AI

Variables for running Claude via Vertex AI and accessing Google Cloud services.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `GOOGLE_CLOUD_PROJECT` | string | — | Google Cloud project ID |
| `GOOGLE_CLOUD_LOCATION` | string | — | Google Cloud region (e.g., `us-east5`) |
| `GOOGLE_APPLICATION_CREDENTIALS` | string | — | Path to Google Cloud ADC credentials JSON file |
| `VERTEX_PROJECT_ID` | string | — | Vertex AI project ID (can differ from `GOOGLE_CLOUD_PROJECT`) |
| `VERTEX_REGION` | string | — | Vertex AI region |
| `VERTEX_CLAUDE_1M` | string | — | Set to `true` to enable Claude 1M context window via Vertex AI |

```env
GOOGLE_CLOUD_PROJECT=my-gcp-project
GOOGLE_CLOUD_LOCATION=us-east5
GOOGLE_APPLICATION_CREDENTIALS=/home/myuser/.config/gcloud/application_default_credentials.json
VERTEX_PROJECT_ID=my-gcp-project
VERTEX_REGION=us-east5
VERTEX_CLAUDE_1M=true
```

> **Note:** In Docker, the credentials file path must match the mount target inside the container. If you use `PI_HOST_USER`, paths like `/home/<user>/.config/...` resolve correctly via the home symlink.

## Gemini

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `GEMINI_API_KEY` | string | — | Google Gemini API key for external AI agent access via acpx |

```env
GEMINI_API_KEY=AIzaSy...
```

## Pidash (Web Dashboard)

Pidash is the live web dashboard that aggregates all pi sessions. See Pidash Dashboard for usage details.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PI_PIDASH_PORT` | integer | `19190` | Port for the pidash HTTP/WebSocket server |
| `PI_PIDASH_ENABLE` | string | enabled | Disable pidash by setting to `false`, `0`, `no`, or `off` |

```bash
# Custom port
PI_PIDASH_PORT=9999 pi

# Disable pidash entirely
PI_PIDASH_ENABLE=false pi
```

```env
PI_PIDASH_PORT=9999
PI_PIDASH_ENABLE=false
```

> **Note:** Pidash is enabled by default. Setting `PI_PIDASH_ENABLE` to any value other than `false`, `0`, `no`, or `off` (case-insensitive) keeps it enabled.

## Pidiff (Diff Viewer)

Pidiff is the standalone diff viewer for branch comparisons and inline review comments. See Pidiff Viewer for usage details.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PI_PIDIFF_PORT` | integer | `19290` | Port for the pidiff HTTP/WebSocket server |
| `PI_PIDIFF_ENABLE` | string | enabled | Disable pidiff by setting to `false`, `0`, `no`, or `off` |

```bash
# Custom port
PI_PIDIFF_PORT=9999 pi

# Disable pidiff entirely
PI_PIDIFF_ENABLE=false pi
```

```env
PI_PIDIFF_PORT=9999
PI_PIDIFF_ENABLE=false
```

## Discord Bot

The Discord bot runs inside the pidash daemon for remote session control via DMs. See Discord Bot Integration for setup instructions.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `DISCORD_BOT_TOKEN` | string | — | Discord bot authentication token |
| `DISCORD_ALLOWED_USERS` | string | — | Comma-separated Discord user IDs allowed to control pi |

```env
DISCORD_BOT_TOKEN=MTIz...your-bot-token
DISCORD_ALLOWED_USERS=123456789012345678,987654321098765432
```

These variables can be set either in your main `.env` file or in a dedicated `~/.pi/discord.env` file. The pidash server reads `~/.pi/discord.env` at startup and loads any variables not already set in the environment.

```bash
# Dedicated Discord config file
cat > ~/.pi/discord.env << 'EOF'
DISCORD_BOT_TOKEN=your-token-here
DISCORD_ALLOWED_USERS=your-discord-user-id
EOF
```

> **Warning:** Without `DISCORD_ALLOWED_USERS`, no Discord users can interact with pi, even if the bot token is set.

## Container Configuration

Variables specific to Docker container operation. See Docker Setup for full container usage.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PI_HOST_USER` | string | `node` | Host username. Creates `/home/<user>` inside the container with symlinks so host-mounted paths resolve correctly |
| `TZ` | string | — | Container timezone for timestamps (e.g., `Asia/Jerusalem`, `America/New_York`) |

```env
PI_HOST_USER=myakove
TZ=Asia/Jerusalem
```

When `PI_HOST_USER` is set to a value other than `node`, the init entrypoint:

1. Creates `/home/<PI_HOST_USER>` with correct ownership
2. Symlinks container tool directories (`.npm-global`, `.pi`, `.local`, etc.) into the new home
3. Reverse-symlinks mounted host content back to `/home/node` for compatibility
4. Updates `HOME` and `PATH` to use the new home directory

## External AI Agents (acpx)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `ACPX_AGENTS` | string | `""` (empty) | Comma-separated list of external AI agent providers to register as pi model providers |

```env
ACPX_AGENTS=cursor,gemini
```

Supported agents include `cursor`, `codex`, and `gemini`. Each agent is registered as a pi model provider, allowing model switching via the pi interface.

## MCP Launchpad

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `MCPL_CONFIG_FILES` | string | — | Path to the MCP Launchpad configuration JSON file |

```env
MCPL_CONFIG_FILES=/home/myuser/.config/mcpl/mcp.json
```

> **Note:** In Docker, this path must match the mount target inside the container.

## Memory and Dreaming

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PI_DREAM_INTERVAL_HOURS` | float | `3` | Interval in hours between automatic memory consolidation runs. Valid range: `0.5` to `24` |

```env
PI_DREAM_INTERVAL_HOURS=6
```

Values outside the `0.5`–`24` range are ignored and the default of `3` hours is used.

## Git Configuration

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `GIT_SSH_COMMAND` | string | `ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10` | SSH command with keepalive/timeout settings for git operations |
| `GIT_CONFIG_GLOBAL` | string | — | Path to global git config file. Set automatically in the container when `.gitconfig` is mounted read-only |

```env
GIT_SSH_COMMAND=ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10
```

> **Note:** Both variables are set automatically by the container entrypoint. Override them only if you need custom SSH or git config behavior.

## Docker-Safe Wrapper

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `DOCKER_SAFE_RUNTIME` | string | `docker` | Container runtime for the `docker-safe` read-only CLI wrapper. Set to `podman` for Podman environments |

```bash
DOCKER_SAFE_RUNTIME=podman docker-safe ps
```

The `docker-safe` command also accepts `--runtime docker|podman` as a CLI flag, which takes precedence over this variable.

## Debugging

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PI_ASYNC_DEBUG` | string | — | Enable debug logging for async (background) agents. Set to any non-empty value to enable |
| `TMPDIR` | string | system default | Temporary directory for Python CLI tools (review fetching, polling). Falls back to the system temp directory |

```env
PI_ASYNC_DEBUG=1
TMPDIR=/tmp/pi-work
```

Debug logs for async agents are written to `$TMPDIR/pi-async-debug.log`.

## Neovim Integration

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `NVIM` | string | — | Neovim RPC socket path. Automatically set by Neovim when pi runs inside a Neovim terminal |

This variable is not user-configured. When present, pi-config registers Neovim-specific features (opening files in the editor, syncing state).

## Dockerfile Build Variables

These variables are baked into the Docker image and do not need user configuration.

| Variable | Value | Description |
|----------|-------|-------------|
| `DEBIAN_FRONTEND` | `noninteractive` | Suppresses interactive prompts during `apt-get` |
| `PLAYWRIGHT_BROWSERS_PATH` | `/home/node/.cache/ms-playwright` | Playwright browser cache location |
| `AGENT_BROWSER_ARGS` | `--no-sandbox,--disable-dev-shm-usage` | Chromium flags for container-safe browser automation |

## Internal Variables

These variables are managed internally by pi-config. Do not set them manually.

| Variable | Type | Description |
|----------|------|-------------|
| `PI_SUBAGENT_CHILD` | `"1"` | Set automatically in subagent child processes to prevent infinite recursion. Gates registration of orchestrator-level features (pidash, pidiff, dreaming, cron, subagent tool) so they only run in the top-level pi process |

## Quick Reference

Minimal `.env` file for a Docker setup with Vertex AI:

```env
TZ=America/New_York
PI_HOST_USER=myuser
GOOGLE_CLOUD_PROJECT=my-project
GOOGLE_APPLICATION_CREDENTIALS=/home/myuser/.config/gcloud/application_default_credentials.json
VERTEX_PROJECT_ID=my-project
VERTEX_REGION=us-east5
VERTEX_CLAUDE_1M=true
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Extended `.env` with all optional features:

```env
TZ=America/New_York
PI_HOST_USER=myuser

# Vertex AI
GOOGLE_CLOUD_PROJECT=my-project
GOOGLE_CLOUD_LOCATION=us-east5
GOOGLE_APPLICATION_CREDENTIALS=/home/myuser/.config/gcloud/application_default_credentials.json
VERTEX_PROJECT_ID=my-project
VERTEX_REGION=us-east5
VERTEX_CLAUDE_1M=true

# GitHub
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GH_CONFIG_DIR=/home/myuser/.config/gh

# Gemini
GEMINI_API_KEY=AIzaSy...

# External agents
ACPX_AGENTS=cursor,gemini

# MCP
MCPL_CONFIG_FILES=/home/myuser/.config/mcpl/mcp.json

# Dashboard ports
PI_PIDASH_PORT=19190
PI_PIDIFF_PORT=19290

# Dreaming
PI_DREAM_INTERVAL_HOURS=3
```
