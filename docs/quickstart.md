# Quickstart

Get pi-config running on your machine and delegate your first task to a specialist agent in under 5 minutes. pi-config turns pi into an orchestrator that automatically routes your work to 24 domain-specific agents — Python, Docker, Kubernetes, Git, and more.

## Prerequisites

- [pi](https://github.com/badlogic/pi-mono) installed (or Docker if using the container method)
- A GitHub token (`GITHUB_TOKEN`) if you plan to work with PRs and issues
- An API key for your LLM provider (e.g., Anthropic, Google Cloud Vertex AI)

## Quick Example

```bash
# Install the pi-config package
pi install git:github.com/myk-org/pi-config

# Start a session in your project directory
cd /path/to/your/project
pi
```

Then type a task — pi-config automatically delegates it to the right specialist:

```text
Add retry logic to the HTTP client in src/api.py
```

The orchestrator detects this involves Python and routes it to the `python-expert` agent, which writes the code, then sends it through three code reviewers in parallel before running tests.

## Step 1: Install pi-config

Choose one method: Docker (recommended) or native.

### Option A: Docker (Recommended)

Docker gives you filesystem isolation, consistent tooling, and all dependencies pre-installed in a single image.

```bash
docker pull ghcr.io/myk-org/pi-config:latest
```

> **Note:** The image is built for **linux/amd64** only. On ARM hosts (e.g., Apple Silicon), Docker will emulate automatically, but you can also build with `--platform linux/amd64`.

### Option B: Native

```bash
# Core package (orchestrator extension + 24 agents + prompt templates)
pi install git:github.com/myk-org/pi-config

# CLI tools for PR review, releases, and memory management
uv tool install git+https://github.com/myk-org/pi-config

# Recommended companion tools
npm install -g acpx           # External AI agent proxy
npm install -g pi-web-access  # Web search/fetch skills
```

## Step 2: Configure Your Environment

### Native Setup

No configuration file is required for basic usage. Just start pi from any project directory.

For GitHub integration, ensure your `gh` CLI is authenticated:

```bash
gh auth login
```

### Docker Setup

Create a `.env` file (e.g., at `~/.pi/.env`):

```env
# Your timezone
TZ=America/New_York

# Your host username (maps container paths to your host HOME)
PI_HOST_USER=youruser

# GitHub authentication
GITHUB_TOKEN=YOUR_GITHUB_TOKEN
GH_CONFIG_DIR=/home/youruser/.config/gh
```

> **Tip:** The `PI_HOST_USER` variable creates a symlink inside the container so that mounted host paths (like `$HOME/.ssh`) resolve correctly.

Run the container from your project directory:

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

The container installs/updates pi and pi-config automatically on each start, then drops you into a pi session.

## Step 3: Delegate Your First Task

Once inside a pi session, describe what you want done in plain language:

```text
Fix the type errors in src/models.py
```

The orchestrator reads your request and routes it to the appropriate specialist agent based on a built-in routing table:

| Domain | Agent |
|--------|-------|
| Python (.py) | `python-expert` |
| Go (.go) | `go-expert` |
| Frontend (JS/TS/React) | `frontend-expert` |
| Docker | `docker-expert` |
| Kubernetes/OpenShift | `kubernetes-expert` |
| Git (local operations) | `git-expert` |
| GitHub (PRs, issues) | `github-expert` |
| Tests | `test-automator` |
| Shell scripts | `bash-expert` |

You can also name the agent explicitly:

```text
Use docker-expert to optimize the multi-stage build in the Dockerfile
```

## Step 4: Use Workflow Commands

For multi-step tasks, use slash commands that chain agents together:

```text
/implement add Redis caching to the session store
```

This runs a three-stage pipeline: **scout** (analyzes the codebase) → **planner** (designs the approach) → **worker** (implements it).

Other workflow commands:

| Command | What It Does |
|---------|-------------|
| `/implement <task>` | Scout → planner → worker pipeline |
| `/scout-and-plan <task>` | Scout → planner (plan only, no code changes) |
| `/implement-and-review <task>` | Worker → 3 reviewers → worker (with review loop) |
| `/pr-review 42` | Review PR #42 and post comments |
| `/release` | Create a GitHub release with changelog |
| `/review-local main` | Review uncommitted changes against a branch |

## What Happens After Code Changes

Every code change automatically goes through a review loop:

1. The specialist agent writes or modifies code
2. Three reviewers run **in parallel**: code quality, project guidelines, and security
3. If reviewers find issues, the agent fixes them and reviewers run again
4. Once all reviewers approve, tests run via `test-automator`
5. Task completes only when tests pass

You don't need to trigger this — it happens automatically.

## Advanced Usage

### Shell Alias for Docker

Add this to your `~/.bashrc` or `~/.zshrc` to start pi-config with a single command from any project directory:

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

Then run `pi-docker` from any project directory.

### Background Agents

Spawn agents in the background for long-running tasks. Results surface automatically when complete:

```text
Run security-auditor in the background to audit the auth module
```

Check on background agents anytime:

```text
/async-status
```

### Agent Chaining and Parallel Execution

You can request multiple agents work simultaneously:

```text
Run python-expert on src/api.py and frontend-expert on src/components/ in parallel
```

Or chain agents so each builds on the previous result:

```text
Run scout and planner in a chain to analyze the auth module
```

### Project Memory

pi-config stores per-repo lessons in `.pi/memory/memory.md`. Save something for future sessions:

```text
/remember this project uses SQLAlchemy 2.0 async sessions exclusively
```

Run memory consolidation to organize and deduplicate stored knowledge:

```text
/dream
```

For native (non-Docker) installs, add the memory directory to your global gitignore:

```bash
echo '.pi/memory/' >> ~/.gitignore-global
git config --global core.excludesFile ~/.gitignore-global
```

> **Note:** The Docker container handles this automatically.

### Pidash — Live Web Dashboard

Pi-config includes a web dashboard that runs alongside your terminal session:

```bash
# Opens automatically — visit in your browser:
http://localhost:19190
```

The dashboard shows live conversations across all pi sessions, lets you send messages from the browser, and supports model switching. See Pidash Dashboard for details.

### Google Cloud Vertex AI

To use Claude models through Google Cloud instead of the Anthropic API:

```bash
pi install git:github.com/myk-org/pi-vertex-claude@feat/1m-context-window-support
```

Add these to your `.env`:

```env
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION=us-east5
GOOGLE_APPLICATION_CREDENTIALS=/home/youruser/.config/gcloud/application_default_credentials.json
VERTEX_PROJECT_ID=your-project-id
VERTEX_REGION=us-east5
```

### Custom Agents

Override any bundled agent or add your own. Place a `.md` file in `~/.pi/agent/agents/` (user-level) or `.pi/agents/` (project-level):

```markdown
---
name: my-custom-agent
description: Handles our internal deployment tooling
tools: read, write, edit, bash
---

You are an expert in our internal deployment system. Always check
the deploy-config.yaml before making changes.
```

Project-level agents take priority over user-level, which take priority over bundled agents. See Agent Configuration for the full format.

### Scheduled Tasks

Schedule recurring work within your pi session:

```text
/cron add every 2h check for new issues assigned to me
/cron list
/cron remove
```

Cron tasks run while pi is active, survive `/reload`, and stop on exit.

## Updating

### Docker

```bash
docker pull ghcr.io/myk-org/pi-config:latest
```

The container also runs `pi update` automatically on each start.

### Native

```bash
pi update                          # Update the pi-config package
uv tool upgrade myk-pi-tools      # Update the CLI tools
```

After updating, run `/reload` inside pi or restart the session.

## Troubleshooting

- **Container start shows `WARNING` about cached packages** — This is normal. The entrypoint checks for existing packages before installing. If pi misbehaves, verify network connectivity and run `pi install git:github.com/myk-org/pi-config` manually inside the container.

- **Host paths don't resolve inside Docker** — Make sure `PI_HOST_USER` in your `.env` matches your host username. This creates the symlinks needed for mounted paths to work.

- **Agent not found errors** — Run `/reload` to re-discover agents. For custom agents, verify the file has valid YAML frontmatter with `name`, `description`, and `tools` fields.

- **Permission denied on mounted volumes** — The container runs as user `node` (UID 1000). If your host UID differs, the mounted files may not be writable. Ensure your project directory is owned by UID 1000 or adjust permissions.
