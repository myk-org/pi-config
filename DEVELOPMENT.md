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
> To test changes that affect child processes, run `pi update npm:pi-orchestrator-config` first.

## Releases

Releases run via `/release` (see README "Scoped releases" for the full picture). This repo
has a `release-map.toml`, so releases are **scoped**: only packages that changed since their
own last registry-published version get bumped and released; the rest stay put.

- `myk-pi-tools release plan` — read-only detection of what changed (run it anytime);
  it also reports unmapped changes (files that belong to no package) so nothing
  ships-nowhere silently
- `/release` decides per-package versions with you, then bumps via `release bump-scoped`
- Each package versions from its own registry history; tags are per-package
  (`<name>@<version>`) and each shipped package gets its own GitHub release
- Without a map (any other repo), `/release` is the standard lockstep flow — unchanged

Contributors don't need to do anything release-specific: conventional commits
(`feat:`, `fix:`, `BREAKING CHANGE:`) drive the version decisions, and the map's
`paths`/`exclude-paths` decide which package a change belongs to. If you add a new
top-level source directory, check that `release-map.toml` maps it to a package.

## Running Tests

```bash
# Linting / pre-commit checks
prek run --all-files

# Python tests
uv run pytest

# TypeScript type-check gate (strict tsc --noEmit, all five projects)
npm run typecheck
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
cat .pi/tmp/worker-*/status.json  # Check async agent status
```

## Python Dependencies

Never use `pip` directly — always use `uv`:

```bash
uv add <package>        # Add dependency
uv run <command>        # Run with managed deps
uvx <tool>              # Run a tool
```
