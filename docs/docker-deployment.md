# Running Pi in a Docker Container

Run pi inside an isolated Docker container to sandbox the agent's access to your filesystem. The container ensures pi can only read/write your mounted project directory and pi settings — everything else on your host stays protected.

## Prerequisites

- Docker installed and running on your host
- A project directory you want pi to work in
- API credentials for your LLM provider (Vertex AI, Gemini, etc.)
- A GitHub token (`GITHUB_TOKEN`) for GitHub operations

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

## Step 1: Create an environment file

Create `~/.pi/.env` with your credentials and container-specific settings:

```env
# Timezone (for correct timestamps)
TZ=America/New_York

# Host username — required when your host user is not "node"
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

# Gemini (optional — enables image generation)
GEMINI_API_KEY=xxx
PI_IMAGE_MODEL=gemini-3-pro-image
```

> **Warning:** Paths in the environment file (like `GOOGLE_APPLICATION_CREDENTIALS`) must use your **container home path** (`/home/<PI_HOST_USER>/...`), not the host path. The `PI_HOST_USER` mechanism creates symlinks so these paths resolve correctly inside the container.

## Step 2: Run with the environment file

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

## Step 3: Set up a shell alias

Add this to your `~/.bashrc` or `~/.zshrc` to start pi from any project directory:

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

## Understanding the volume mounts

Every mount serves a specific purpose:

| Mount | Mode | Purpose |
|---|---|---|
| `$PWD:$PWD` | rw | Your project directory — the only writable workspace |
| `$HOME/.pi:$HOME/.pi` | rw | Pi settings, sessions, memory, and installed packages |
| `$HOME/.gitconfig:$HOME/.gitconfig` | ro | Git configuration (user name, email, aliases) |
| `$HOME/.gitignore-global:$HOME/.gitignore-global` | ro | Global gitignore patterns |
| `$HOME/.ssh:$HOME/.ssh` | ro | SSH keys for git push/pull |
| `$HOME/.config/gh:$HOME/.config/gh` | ro | GitHub CLI authentication |
| `/tmp/pi-work:/tmp/pi-work` | rw | Temp files that persist across container restarts |

> **Note:** Read-only (`:ro`) mounts prevent the agent from modifying your host configuration. The container automatically copies `.gitconfig` to a writable location internally so git operations still work.

## How PI_HOST_USER works

The container runs as user `node` (UID 1000) with home directory `/home/node`. When you mount host paths that expand to `/home/youruser/...`, they won't resolve inside the container without help.

Setting `PI_HOST_USER=youruser` tells the init script to:

1. Create symlinks between `/home/youruser` and `/home/node`
2. Set `HOME` to `/home/youruser` inside the container
3. Ensure all mounted paths resolve correctly

If you skip this variable, mounts that use `$HOME` expansion may not resolve inside the container.

## Filesystem isolation

The container enforces strict filesystem boundaries:

- **Read-write:** Your project directory (`$PWD`) and pi settings (`~/.pi`)
- **Read-only:** Git, GitHub, and SSH configuration
- **Blocked:** All other host directories, other git repos, system files

This means the agent cannot accidentally modify files outside your project or access sensitive data on your host.

## Network mode

The `--network host` flag shares your host's network stack with the container. This is required for:

- Local MCP servers (via `mcpl`)
- LiteLLM proxy
- File preview (agents serve generated HTML via a local HTTP server)
- Pidash and Pidiff web dashboards

If you only use cloud-based LLM providers and don't need local services, you can omit `--network host`.

## Advanced Usage

### Optional mounts

Add these mounts to enable additional features:

| Mount | Mode | Purpose |
|---|---|---|
| `$HOME/.config/gcloud/application_default_credentials.json` (same path) | ro | Google Cloud ADC for Claude via Vertex AI |
| `$HOME/.config/mcpl/mcp.json` (same path) | ro | MCP server configuration for `mcpl` |
| `$HOME/.agents:$HOME/.agents` | rw | User-level skills |
| `$HOME/.config/cursor/auth.json` (same path) | ro | Cursor CLI auth for acpx models |
| `$HOME/.config/glab-cli:$HOME/.config/glab-cli` | ro | GitLab CLI config |
| `$HOME/.coderabbit:$HOME/.coderabbit` | rw | CodeRabbit CLI auth and review data |
| `$HOME/screenshots:$HOME/screenshots` | ro | Share screenshots/images with the agent |
| `/var/run/docker.sock:/var/run/docker.sock` | ro | Docker container inspection via `docker-safe` |
| `/var/run/podman/podman.sock:/var/run/podman/podman.sock` | ro | Podman container inspection via `docker-safe` |

When using `mcpl`, add the config path to your `.env` file too:

```env
MCPL_CONFIG_FILES=/home/youruser/.config/mcpl/mcp.json
```

### Docker socket access

To let the agent inspect running containers (read-only), mount the Docker socket:

```bash
-v /var/run/docker.sock:/var/run/docker.sock:ro \
--group-add $(stat -c '%g' /var/run/docker.sock)
```

The init script automatically handles socket permissions — it detects the socket's group ID and either adds the container user to that group or sets an ACL.

The agent uses a restricted `docker-safe` wrapper that only allows read-only commands:

| Allowed | Blocked |
|---------|---------|
| `ps`, `logs`, `inspect`, `top`, `stats` | `exec`, `run`, `rm`, `cp` |
| `port`, `diff`, `images`, `version`, `info` | `build`, `push`, `pull`, `stop`, `kill` |

For Podman, mount the Podman socket instead and set the runtime:

```bash
-v /var/run/podman/podman.sock:/var/run/podman/podman.sock:ro
```

### Dashboard configuration

Two web dashboards start automatically alongside your pi session. See [Using the Web Dashboard and Diff Viewer](dashboards-and-diffs.html) for full details on using them.

| Dashboard | Default Port | Environment Variable | URL |
|---|---|---|---|
| Pidash | 19190 | `PI_PIDASH_PORT` | `http://localhost:19190` |
| Pidiff | 19290 | `PI_PIDIFF_PORT` | `http://localhost:19290` |

To use custom ports or disable either dashboard, add to your `.env`:

```env
# Custom ports
PI_PIDASH_PORT=9999
PI_PIDIFF_PORT=9998

# Or disable entirely
PI_PIDASH_ENABLE=false
PI_PIDIFF_ENABLE=false
```

### External agent providers (acpx)

To route prompts through external AI agents like Cursor, set `ACPX_AGENTS` in your `.env` and mount the auth file:

```env
ACPX_AGENTS=cursor
```

```bash
-v "$HOME/.config/cursor/auth.json":"$HOME/.config/cursor/auth.json":ro
```

See [Using External AI Agents (Cursor, Claude, Gemini)](external-ai-agents.html) for setup details.

### Passing arguments to pi

Any arguments after the image name are forwarded to `pi`:

```bash
# Run a specific slash command
docker run --rm -it ... ghcr.io/myk-org/pi-config:latest /implement add retry logic

# Start with a prompt
docker run --rm -it ... ghcr.io/myk-org/pi-config:latest "fix the failing tests"
```

### Building from source

```bash
git clone https://github.com/myk-org/pi-config.git
cd pi-config
docker build -t ghcr.io/myk-org/pi-config:latest .
```

> **Note:** The image is built for **linux/amd64** only. On ARM hosts, build with `--platform linux/amd64`.

### Project settings inside the container

Per-project settings in `.pi/pi-config-settings.json` override environment variables for that project. These work identically inside and outside the container:

```json
{
  "co_author": true,
  "use_worktrees": false,
  "dream_interval_hours": 3
}
```

See [Configuration and Environment Variables Reference](configuration-reference.html) for all available settings.

### Complete alias with all optional mounts

Here's a full alias including every optional mount:

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
  -v "$HOME/.coderabbit":"$HOME/.coderabbit":rw \
  -v "$HOME/screenshots":"$HOME/screenshots":ro \
  -v /tmp/pi-work:/tmp/pi-work:rw \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  --group-add $(stat -c '%g' /var/run/docker.sock) \
  -w "$PWD" \
  ghcr.io/myk-org/pi-config:latest'
```

## Environment variables reference

These are the container-specific variables you can set in your `.env` file. For the complete environment variables reference, see [Configuration and Environment Variables Reference](configuration-reference.html).

| Variable | Required | Description |
|---|---|---|
| `PI_HOST_USER` | Yes (if your username ≠ `node`) | Maps host home directory into container |
| `TZ` | No | Timezone for timestamps (e.g., `America/New_York`) |
| `GOOGLE_CLOUD_PROJECT` | Provider-dependent | Google Cloud project ID |
| `GOOGLE_CLOUD_LOCATION` | Provider-dependent | Google Cloud region |
| `GOOGLE_APPLICATION_CREDENTIALS` | Provider-dependent | Path to ADC JSON (container path) |
| `VERTEX_PROJECT_ID` | Provider-dependent | Vertex AI project |
| `VERTEX_REGION` | Provider-dependent | Vertex AI region |
| `VERTEX_CLAUDE_1M` | No | Enable 1M context for Claude on Vertex |
| `GITHUB_TOKEN` | Yes | GitHub personal access token |
| `GITHUB_API_TOKEN` | Yes | GitHub API token (can be same as above) |
| `GH_CONFIG_DIR` | No | GitHub CLI config directory (container path) |
| `GEMINI_API_KEY` | No | Gemini API key (for image generation) |
| `PI_IMAGE_MODEL` | No | Gemini model for image generation |
| `ACPX_AGENTS` | No | Comma-separated acpx agents (e.g., `cursor`) |
| `PI_PIDASH_PORT` | No | Pidash dashboard port (default: `19190`) |
| `PI_PIDIFF_PORT` | No | Pidiff diff viewer port (default: `19290`) |
| `PI_PIDASH_ENABLE` | No | Set `false` to disable pidash |
| `PI_PIDIFF_ENABLE` | No | Set `false` to disable pidiff |
| `PI_CO_AUTHOR` | No | Add co-author trailer to commits |
| `PI_USE_WORKTREES` | No | Force git worktree workflow |
| `PI_DREAM_INTERVAL_HOURS` | No | Memory dreaming interval (default: `3`) |
| `MCPL_CONFIG_FILES` | No | Path to MCP Launchpad config (container path) |

## Pre-installed tools

The container image comes with all tools ready to use:

| Tool | Purpose |
|---|---|
| `git`, `gh`, `glab` | Version control, GitHub CLI, GitLab CLI |
| `uv` / `uvx` | Python package management and execution |
| `go` | Go development |
| `node` / `npm` | JavaScript runtime (Node.js 22) |
| `bun` | Fast JavaScript runtime (required by coms-net) |
| `kubectl` / `oc` | Kubernetes and OpenShift CLI |
| `mcpl` | MCP server access |
| `acpx` | Agent proxy for external AI models |
| `agent-browser` | Browser automation (Chromium via Playwright) |
| `docker-safe` | Read-only Docker/Podman inspection wrapper |
| `cr` | CodeRabbit CLI for local AI code reviews |
| `prek` | Pre-commit hook runner |
| `mcp-proxy` | MCP transport proxy |
| `cursor`, `claude` | External AI agent CLIs |
| `jq`, `curl` | JSON processing, HTTP requests |

## Container startup lifecycle

On every container start, the entrypoint automatically:

1. Installs/updates pi to the latest version
2. Installs or updates the `pi-config` package from GitHub
3. Installs `myk-pi-tools` CLI from the latest source
4. Registers companion packages (`pi-web-access`, `pi-tasks`)
5. Copies `.gitconfig` to a writable location (since the mount is read-only)
6. Configures SSH timeouts for git operations (15s keepalive, 10s connect timeout)
7. Ensures `.pi/memory/`, `.worktrees/`, and `.pi/tasks/` are in the global gitignore
8. Starts pi with any arguments you passed

This means you always get the latest version of pi and all extensions on every session.

## Troubleshooting

### Mounted paths don't resolve inside the container

Make sure `PI_HOST_USER` in your `.env` file matches your host username exactly. Without it, paths like `/home/youruser/.ssh` won't resolve because the container's default home is `/home/node`.

### Permission denied on mounted files

The container runs as user `node` (UID 1000). If your host files are owned by a different UID, you may see permission errors. Ensure your host user's UID is 1000, or adjust file permissions on the host.

### Container can't reach local services

Make sure you included `--network host` in your `docker run` command. Without it, the container has its own network namespace and can't reach services on `localhost`.

### Git push/pull hangs

The container sets SSH keepalive and connection timeouts automatically (15-second keepalive interval, 10-second connection timeout). If git operations still hang, check that your SSH keys are correctly mounted at `$HOME/.ssh` with `:ro` mode.

### Startup WARNING about cached packages

A `WARNING` on stderr during startup is normal when pi-config is already cached in `~/.pi`. The container runs `pi install` and `pi update` on every start to stay current. If pi misbehaves, verify your network connectivity.

## Related Pages

- [Installing and Starting Your First Session](quickstart.html)
- [Configuration and Environment Variables Reference](configuration-reference.html)
- [Using the Web Dashboard and Diff Viewer](dashboards-and-diffs.html)
- [Command Safety Guards and Enforcement](command-enforcement.html)
- [Using ACPX Provider for External Agent Models](acpx-provider.html)
