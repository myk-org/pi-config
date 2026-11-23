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

# All suites (Python + Node)
tox

# Python tests
uv run --group tests pytest

# Node tests
npx tsx --test tests/node/**/*.test.ts

# TypeScript type-check gate (strict tsc --noEmit, all 7 projects incl. tests/node via tsconfig.tests.json)
npm run typecheck
npm run typecheck:tests
```

Additional workspace test suites:

- `packages/pi-sidecar/tests/` — required whenever changing `extensions/{providers,shared}/`:
  run `npx tsx --test packages/pi-sidecar/tests/test_ts/*.test.ts`, preserve shared types/re-exports
  consumed by `packages/pi-sidecar/src/sessions.ts`, and run `.pi/skills/sidecar-test/` before release.
- `packages/pi-vertex-claude/test/` (vitest)
- `packages/pi-docsite/tests/`
- `extensions/pidiff/pidiff-ui` is an npm workspace providing React for Node `pidiff-ui` tests; shared TUI fakes live in `tests/node/helpers/`.

**Test environment hygiene:** No suite may depend on ambient env for asserted behavior. Wrap synchronous tool registration in
`withSubagentChildEnv` (`tests/node/helpers/subagent-env.ts`), assert `assert.ok(tool)` immediately, never wrap async bodies,
and cover `PI_SUBAGENT_CHILD=1` in its own test.

## Packaging, Installs, and Docs Preview

- **npm pack (`package.json` `files`):** Keep explicit daemon scripts (`scripts/pidash-server.ts`, `scripts/pidiff-server.ts`,
  `scripts/pidiff-git-diff.ts`, `scripts/pidiff-git-ignore.ts`, `scripts/daemon-shared.ts`, `scripts/serve-ui.ts`,
  `scripts/pidash-discord.ts`, `scripts/httpd.py`) and UI `src/`+`dist/` (never the entire `extensions/pidash/` directory).
  `prepack` runs `npm run build:extension-uis`.
- **Published installs only:** User install/runtime uses npm + PyPI only (`npm:pi-orchestrator-config`,
  `npm:@myk-org/pi-vertex-claude`, `npm:pi-web-access`, PyPI `myk-pi-tools`; `httpd.py` reads from
  `~/.pi/agent/npm/node_modules/pi-orchestrator-config`). Never add `pi install git:github.com/myk-org/pi-config`,
  `git+https` `myk-pi-tools`, or `git clone` of `myk-org/pi-config` in `entrypoint.sh` (verified by `tests/python/test_install.py`).
- **CLI in prompts/rules:** Always reference `uvx myk-pi-tools@latest <subcommand>` in prompts and rules (runs published PyPI,
  so verify local CLI fixes against the working tree; release scripts use the local build).
- **Docs site preview (discard output):** `docs/*.md` are hand-written source; `.github/workflows/docs.yml` builds the site on
  `main` and `docs-guard.yml` rejects generated output in PRs. Never commit generated `.html`, `llms*.txt`, `search-index.json`,
  or `assets/`. Inter-page links use `.html`, one H1 per page. Local preview (discard output before committing):

```bash
uv run --package pi-docsite pi-docsite --docs-dir docs --tagline "Agent orchestration for pi: routing, subagents, background work, memory, providers, and sidecar."
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
