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

## Running Tests

```bash
# Linting / pre-commit checks
pre-commit run --all-files

# Python tests
uv run pytest
```

## Python Dependencies

Never use `pip` directly — always use `uv`:

```bash
uv add <package>        # Add dependency
uv run <command>        # Run with managed deps
uvx <tool>              # Run a tool
```
