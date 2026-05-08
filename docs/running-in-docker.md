# Running pi-config in Docker

Run pi inside an isolated Docker container so the agent can only access your project directory and pi settings — nothing else on your host. This guide walks you through pulling the image, configuring mounts and environment variables, and customizing tool access for your workflow.

## Prerequisites

- Docker installed and running on your host
- A project directory you want pi to work in
- API credentials for your LLM provider (Vertex AI, Gemini, etc.)

## Quick start

```bash
docker pull ghcr.io/myk-org/pi-config:latest

docker run --rm -it \
  --name "pi-config-$(basename $PWD)-$(date +%s)" \
  --network host \
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

This starts an interactive pi session in your current project directory. The container is destroyed when you exit (`--rm`).

## Setting up the environment file

Create a `.env` file (e.g., `~/.pi/.env`) with your credentials and preferences:

```env
# Timezone (for correct timestamps in logs and sessions)
TZ=America/New_York

# Host username — maps /home/<user> paths between host and container
PI_HOST_USER=youruser

# Google Cloud / Vertex AI
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION=us-east5
GOOGLE_APPLICATION_CREDENTIALS=/home/youruser/.config/gcloud/application_default_credentials.json
VERTEX_PROJECT_ID=your-project-id
VERTEX_REGION=us-east5
VERTEX_CLAUDE_1M=true

# GitHub
GITHUB_TOKEN=ghp_xxx
GITHUB_API_TOKEN=ghp_xxx
GH_CONFIG_DIR=/home/youruser/.config/gh

# Gemini (optional)
GEMINI_API_KEY=xxx

# MCP Launchpad config (must match mount target path)
MCPL_CONFIG_FILES=/home/youruser/.config/mcpl/mcp.json
```

> **Warning:** Paths in the environment file (like `GOOGLE_APPLICATION_CREDENTIALS` and `GH_CONFIG_DIR`) must use your **container home path** (`/home/<PI_HOST_USER>/...`), not the host path. The `PI_HOST_USER` symlink mechanism makes this work.

Pass the file when starting the container:

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

## Understanding the volume mounts

Every mount serves a specific purpose. Here's what each one does:

| Mount | Mode | Purpose |
|---|---|---|
| `$PWD:$PWD` | rw | Your project directory — the only writable workspace |
| `$HOME/.pi:$HOME/.pi` | rw | Pi settings, sessions, memory, and installed packages |
| `$HOME/.gitconfig:$HOME/.gitconfig` | ro | Git configuration (user name, email, aliases) |
| `$HOME/.gitignore-global:$HOME/.gitignore-global` | ro | Global gitignore patterns |
| `$HOME/.ssh:$HOME/.ssh` | ro | SSH keys for git operations |
| `$HOME/.config/gh:$HOME/.config/gh` | ro | GitHub CLI authentication |
| `/tmp/pi-work:/tmp/pi-work` | rw | Temp files that persist across container restarts |

> **Note:** Read-only (`:ro`) mounts prevent the agent from modifying your host configuration. The container automatically copies `.gitconfig` to a writable location internally so git operations still work.

## How PI_HOST_USER works

When your host username isn't `node` (the container's default user), mounted paths like `$HOME/.ssh` resolve to `/home/youruser/.ssh` — but the container's home is `/home/node`. Setting `PI_HOST_USER` fixes this by creating symlinks between `/home/youruser` and `/home/node` so all paths resolve correctly.

Set it to your host username:

```env
PI_HOST_USER=youruser
```

If you skip this variable, mounts that use `$HOME` expansion may not resolve inside the container.

## Creating a shell alias

Add this to your `~/.bashrc` or `~/.zshrc` to start pi from any project directory with a single command:

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
  -v /tmp/pi-work:/tmp/pi-work:rw \
  -w "$PWD" \
  ghcr.io/myk-org/pi-config:latest'
```

Then run from any project:

```bash
cd ~/projects/my-app
pi-docker
```

> **Tip:** The alias pulls the latest image on every run. If you prefer faster startup, remove the `docker pull` line and update manually with `docker pull ghcr.io/myk-org/pi-config:latest`.

## Filesystem isolation

The container enforces strict filesystem boundaries:

- **Accessible (read-write):** Your project directory (`$PWD`) and pi settings (`~/.pi`)
- **Accessible (read-only):** Git, GitHub, and SSH configuration
- **Blocked:** All other host directories, other git repos, system files

This means the agent cannot accidentally modify files outside your project or access sensitive data on your host.

## Network mode

The `--network host` flag shares your host's network stack with the container. This is required for:

- Local MCP servers
- LiteLLM proxy
- File preview (agents serve generated HTML via HTTP)
- Pidash and Pidiff dashboards

If you only use cloud-based LLM providers and don't need any of the above, you can omit `--network host`.

## Advanced Usage

### Optional mounts

Add these mounts to enable additional features:

| Mount | Mode | Purpose |
|---|---|---|
| `$HOME/.config/gcloud/application_default_credentials.json:$HOME/.config/gcloud/application_default_credentials.json` | ro | Google Cloud ADC for Claude via Vertex AI |
| `$HOME/.config/mcpl/mcp.json:$HOME/.config/mcpl/mcp.json` | ro | MCP server configuration for `mcpl` |
| `$HOME/.agents:$HOME/.agents` | rw | User-level skills |
| `$HOME/.config/cursor/auth.json:$HOME/.config/cursor/auth.json` | ro | Cursor CLI auth for acpx cursor models |
| `$HOME/.config/glab-cli:$HOME/.config/glab-cli` | ro | GitLab CLI config |
| `$HOME/screenshots:$HOME/screenshots` | ro | Share screenshots with the agent |
| `/var/run/docker.sock:/var/run/docker.sock` | ro | Docker container inspection via `docker-safe` |
| `/var/run/podman/podman.sock:/var/run/podman/podman.sock` | ro | Podman container inspection via `docker-safe` |

### Docker socket access

To let the agent inspect running containers (read-only), mount the Docker socket and add the Docker group:

```bash
-v /var/run/docker.sock:/var/run/docker.sock:ro \
--group-add $(stat -c '%g' /var/run/docker.sock)
```

The agent uses a restricted `docker-safe` wrapper that only allows read-only commands: `ps`, `logs`, `inspect`, `top`, `stats`, `port`, `diff`, `images`, `version`, and `info`. All state-modifying commands (`exec`, `run`, `rm`, `build`, etc.) are blocked.

For Podman, mount the Podman socket instead:

```bash
-v /var/run/podman/podman.sock:/var/run/podman/podman.sock:ro
```

### External agent providers (acpx)

To route prompts through external AI agents like Cursor or Gemini, set the `ACPX_AGENTS` variable in your `.env` file:

```env
ACPX_AGENTS=cursor
```

You'll also need to mount the corresponding auth file. For Cursor:

```bash
-v "$HOME/.config/cursor/auth.json":"$HOME/.config/cursor/auth.json":ro
```

### Dashboard ports

Two web dashboards run alongside your pi session:

| Dashboard | Default Port | Environment Variable | URL |
|---|---|---|---|
| Pidash | 19190 | `PI_PIDASH_PORT` | `http://localhost:19190` |
| Pidiff | 19290 | `PI_PIDIFF_PORT` | `http://localhost:19290` |

To use custom ports, add to your `.env` file:

```env
PI_PIDASH_PORT=9999
PI_PIDIFF_PORT=9998
```

To disable either dashboard:

```env
PI_PIDASH_ENABLE=false
PI_PIDIFF_ENABLE=false
```

### Passing arguments to pi

Any arguments after the image name are forwarded to `pi`:

```bash
# Run a specific task non-interactively
docker run --rm -it ... ghcr.io/myk-org/pi-config:latest /implement add retry logic

# Start with a specific prompt
docker run --rm -it ... ghcr.io/myk-org/pi-config:latest "fix the failing tests"
```

### Building from source

> **Note:** The image is built for **linux/amd64** only. On ARM hosts, build with `--platform linux/amd64`.

```bash
git clone https://github.com/myk-org/pi-config.git
cd pi-config
docker build -t ghcr.io/myk-org/pi-config:latest .
```

### Complete alias with all optional mounts

Here's a full alias including all optional mounts for a complete setup:

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
  -v "$HOME/.config/mcpl/mcp.json":"$HOME/.config/mcpl/mcp.json":ro \
  -v "$HOME/.agents":"$HOME/.agents":rw \
  -v "$HOME/.config/gcloud/application_default_credentials.json":"$HOME/.config/gcloud/application_default_credentials.json":ro \
  -v "$HOME/.config/cursor/auth.json":"$HOME/.config/cursor/auth.json":ro \
  -v "$HOME/.config/glab-cli":"$HOME/.config/glab-cli":ro \
  -v "$HOME/screenshots":"$HOME/screenshots":ro \
  -v /tmp/pi-work:/tmp/pi-work:rw \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  --group-add $(stat -c '%g' /var/run/docker.sock) \
  -w "$PWD" \
  ghcr.io/myk-org/pi-config:latest'
```

## Pre-installed tools

The container image comes with all tools pre-installed:

| Tool | Purpose |
|---|---|
| `git`, `gh`, `glab` | Version control, GitHub CLI, GitLab CLI |
| `uv` / `uvx` | Python package management and execution |
| `go` | Go development |
| `node` / `npm` | JavaScript runtime |
| `kubectl` / `oc` | Kubernetes and OpenShift CLI |
| `mcpl` | MCP server access |
| `acpx` | Agent proxy for external AI models |
| `agent-browser` | Browser automation (Chromium pre-installed) |
| `docker-safe` | Read-only Docker/Podman inspection wrapper |
| `prek` | Pre-commit hook runner |
| `jq`, `curl` | JSON processing, HTTP requests |

## Troubleshooting

### Startup warning about cached packages

A `WARNING` on stderr during startup is normal when pi-config is already cached in `~/.pi`. The container runs `pi install` and `pi update` on every start to stay current. If the warning persists or pi misbehaves, check your network connectivity.

### Mounted paths don't resolve inside the container

Make sure `PI_HOST_USER` in your `.env` file matches your host username exactly. Without it, paths like `/home/youruser/.ssh` won't resolve because the container's default home is `/home/node`.

### Permission denied on mounted files

The container runs as user `node` (UID 1000). If your host files are owned by a different UID, you may see permission errors. Ensure your host user's UID is 1000, or adjust file permissions accordingly.

### Container can't reach local services

Make sure you included `--network host` in your `docker run` command. Without it, the container has its own network namespace and can't reach services on `localhost`.

### Git push/pull hangs

The container sets SSH keepalive and connection timeouts automatically (15-second keepalive interval, 10-second connection timeout). If git operations still hang, check that your SSH keys are correctly mounted at `$HOME/.ssh` with `:ro` mode.
