# Development Guide

## Testing Extensions Locally

To test changes to extensions without installing them:

```bash
pi -ne -e ~/git/pi-config/extensions/orchestrator/index.ts
```

| Flag | Purpose |
|------|---------|
| `-ne` | Disables extension discovery so the installed version doesn't conflict |
| `-e <path>` | Loads the extension from a local file for this session only |

> **Note:** `-ne -e` only loads your extension in the **parent** process.
> Subagent child processes load the **installed** version from `~/.pi/agent/`.
> To test changes that affect child processes, run `pi update git:github.com/myk-org/pi-config` first.

## Running Tests

```bash
# Linting / pre-commit checks
pre-commit run --all-files

# Python tests
uv run pytest
```

## Debugging a Running Container

Container names include the project directory: `pi-config-<project>-<timestamp>`.

Requires [`fzf`](https://github.com/junegunn/fzf) on the host. Add to your `~/.bashrc` or `~/.zshrc`:

```bash
alias pi-docker-exec='docker exec -it $(docker ps --filter name=pi-config --format "{{.Names}}" | fzf --height 40% --reverse --prompt "Select container: ") bash'
```

This lists all running pi-config containers via `fzf` — select one and it drops you into a bash shell.

Useful debug commands inside the container:

```bash
ps aux | grep pi              # Find stuck pi/subagent processes
pkill -f 'pi.*--mode.*json'   # Kill stuck subagent processes
cat /tmp/pi-async-agents/*/status.json  # Check async agent status
```

## Python Dependencies

Never use `pip` directly — always use `uv`:

```bash
uv add <package>        # Add dependency
uv run <command>        # Run with managed deps
uvx <tool>              # Run a tool
```
