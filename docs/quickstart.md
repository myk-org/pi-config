# Installation & Quickstart

Initialize your project configuration, spin up the background daemons, and run your first custom agent workflow to automate your codebase tasks locally. This setup enables your agents to operate seamlessly across different workflows and repositories.

## Prerequisites

- Node.js (>= 22)
- Git installed and configured
- `pi` (installed via `@earendil-works/pi-coding-agent`)
- `uv` (Python package manager)

## Quick Install

To install the orchestrator and all dependencies in a single step, run the interactive installer from the command line:

```bash
uv run scripts/install.py --all
```

*This command automatically selects and installs all required dependencies without prompting.*

## Step-by-Step Guide

### 1. Run the Interactive Installer

If you prefer to selectively install tools, run the installation script without the `--all` flag.

```bash
uv run scripts/install.py
```

Follow the prompts to choose your required components (such as browser automation, python tools, or specific `pi` packages).

### 2. Initialize Project Settings

Project-level configurations give your agents context about how they should interact with your specific repository.

Create a `.pi/pi-config-settings.json` file in your repository root:

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

> **Note:** These settings override global defaults and apply immediately to the current project.

### 3. Start the Daemons

In your terminal, start a new `pi` session. Once inside the chat environment, initialize the background tasks required for your workflows.

```text
/pidiff start
/pidash start
```

These commands spin up the local diff tracker and dashboard backend respectively.

> **Tip:** You can check the health and state of all running services at any time by running `/status`.

### 4. Run Your First Agent Workflow

With the daemons running and settings configured, instruct the orchestrator to begin a task.

```text
/scout-and-plan Review the authentication module and propose a migration plan to JWT.
```

The orchestrator will automatically pick up the request and dispatch the appropriate agents based on your task.

## Advanced Usage

### Ignoring Project Data Files

To prevent the orchestrator's local databases and worktrees from polluting your git history, ensure they are added to your global `.gitignore`.

| Method | Command |
|--------|---------|
| **Old Way (Manual File Edit)** | `echo ".pi/" >> ~/.gitignore` |
| **New Way (Scripted)** | `git config --global core.excludesfile ~/.config/git/ignore && echo ".pi/" >> ~/.config/git/ignore` |

### Environment Variable Fallbacks

If you prefer not to use a `.pi/pi-config-settings.json` file, you can rely on environment variables. Project settings are resolved in the following priority:
1. Local `.pi/pi-config-settings.json`
2. Global `~/.pi/pi-config-settings.json`
3. Environment variables (e.g., `PI_DREAM_INTERVAL_HOURS=3`)
4. System defaults

For more details on interacting with the system from your terminal, see [myk_pi_tools CLI Reference](cli-reference.html).

## Troubleshooting

- **"Cannot continue without pi" error:** Ensure `@earendil-works/pi-coding-agent` is installed globally via npm before running the python installer.
- **Daemons failing to start:** Verify that the required ports are available. The `/pidiff` command logs its current port and process ID in `.pi/tmp/pidiff.port`.
- **Pre-commit hook failures:** If Git hooks complain about formatting, run `prek run --all-files` to automatically apply fixes before committing.

## Related Pages

- [Configuration & Settings](configuration.html)
- [myk_pi_tools CLI Reference](cli-reference.html)
