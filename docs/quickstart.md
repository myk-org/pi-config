# Installation & Quickstart

Get pi-config installed, configure your project, start the local daemons, and run your first agent workflow so you can automate repository tasks in under a minute.

## Prerequisites

- Node.js (>= 22)
- Git installed and configured
- `pi` >= 0.99.0 (install with `npm install -g @earendil-works/pi-coding-agent`)
- `uv` (Python package manager)

> **Note:** pi-config requires pi **0.99.0 or newer**. On an older version, CLI/ACPX providers stay unregistered and pi warns on session start.

## Quick Example

```bash
# Install everything non-interactively
uv run scripts/install.py --all

# Start a session, then in the chat:
# /pidash start
# /pidiff start
# /scout-and-plan Review the authentication module and propose a migration plan to JWT.
```

## Step-by-Step Guide

### 1. Install pi-config and tooling

Install the pi package (no git clone needed):

```bash
pi install npm:pi-orchestrator-config
uv tool install myk-pi-tools
```

To get everything at once — the pi package, `myk-pi-tools`, `prek`, `acpx`, `agent-browser`, `graft`, Playwright, and the git-excludes setup — run the interactive installer instead:

```bash
uv run https://raw.githubusercontent.com/myk-org/pi-config/main/scripts/install.py
```

Follow the prompts to select packages. To skip prompts and install everything available:

```bash
uv run scripts/install.py --all   # from a pi-config checkout
```

> **Note:** The installer exits if `pi` is missing. Install `@earendil-works/pi-coding-agent` globally first. Only `myk-pi-tools` and `prek` require `uv`; the other steps require Node.js.

When it finishes, start a session:

```bash
pi
```

### 2. Add project settings

Create `.pi/pi-config-settings.jsonc` in your repository root (`.json` also works; if both exist the `.jsonc` file wins):

```json
{
  "commit_trailer": "Assisted-by",
  "dco": true,
  "dream_interval_hours": 3,
  "pidash_enable": true,
  "pidiff_enable": true,
  "cli_agents": ["claude", "cursor"]
}
```

> **Note:** Project settings override global defaults for the current repository. See [Configuration & Settings](configuration.html) for the full option list.

Prefer not to hand-edit JSON? Open the settings TUI from any session and edit the same keys with arrows and search:

```text
/pi-config-settings
```

### 3. Start the background daemons

Inside an active `pi` TUI session:

```text
/pidash start
/pidiff start
```

- `/pidash start` launches the web dashboard (default `http://localhost:19190`).
- `/pidiff start` launches the per-project diff viewer on a free local port.

Check daemon state anytime:

```text
/pidash status
/pidiff status
```

> **Tip:** Open the dashboard URL from the status output to monitor sessions and background work. See [Using the Web Dashboard](using-the-web-dashboard.html).

### 4. Run your first workflow

```text
/scout-and-plan Review the authentication module and propose a migration plan to JWT.
```

This chains a scout pass (find relevant code) into a planner pass (implementation plan) without writing changes yet. For creating and routing specialists, see [Managing Custom Agents](managing-custom-agents.html).

## Advanced Usage

### Install only what you need

| Mode | Command | Behavior |
|------|---------|----------|
| Pi package only | `pi install npm:pi-orchestrator-config` | Extensions, agents, prompts, skills, rules — nothing else |
| Interactive | `uv run scripts/install.py` | Step through packages and confirm |
| Non-interactive | `uv run scripts/install.py --all` | Auto-select every available tool |

The installer can also add `.pi/` and `.worktrees/` to your global git excludes file so local agent data is not committed.

### Configure via environment variables

Skip the settings file when you prefer env vars. Resolution order:

1. `.pi/pi-config-settings.jsonc` (project; `.json` is the fallback name)
2. `~/.pi/pi-config-settings.jsonc` (global; `.json` is the fallback name)
3. Environment variables (for example `PI_DREAM_INTERVAL_HOURS=3`, `CLI_AGENTS=claude,cursor`)
4. Built-in defaults

See [Configuration & Settings](configuration.html) for keys and env var names. For CLI utilities used by review and memory workflows, see [myk_pi_tools CLI Reference](cli-reference.html).

### Keep project data out of git

| Method | Command |
|--------|---------|
| Preferred | `git config --global core.excludesfile ~/.config/git/ignore && echo ".pi/" >> ~/.config/git/ignore` |
| Manual | Append `.pi/` (and `.worktrees/` if you use worktrees) to whatever `git config --global core.excludesfile` points at (`~/.config/git/ignore` when unset) |

> **Tip:** The installer Environment Setup step can configure these entries for you.

## Troubleshooting

- **"Cannot continue without pi":** Install the coding agent globally (`npm install -g @earendil-works/pi-coding-agent`), confirm `pi` is on your `PATH`, then re-run the installer.
- **"pi X is below minimum required version 0.99.0":** Update pi with `npm install -g @earendil-works/pi-coding-agent`, then `/reload` or restart the session.
- **Daemon fails to start:** Confirm `pidash_enable` / `pidiff_enable` are not set to `false`. Run `/pidash status` or `/pidiff status`. For pidash failures, check `~/.pi/pidash-server.log`.
- **pidash says TUI-only:** Start daemons from an interactive `pi` session, not a headless/CLI-only mode.
- **Pre-commit / formatting failures:** Run `prek run --all-files` to apply fixes, then retry the commit.

## Related Pages

- [Configuration & Settings](configuration.html)
- [Using the Web Dashboard](using-the-web-dashboard.html)
- [Built-in Workflow Commands](built-in-workflows.html)
- [Creating Slash Commands](custom-slash-commands.html)
- [myk_pi_tools CLI Reference](cli-reference.html)
