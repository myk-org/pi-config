# Testing, Packaging, and Docs Preview

Contributor reference for workspace test suites, test-environment hygiene, npm packaging, published-install
invariants, and local docs preview.

## Workspace Test Suites & Sidecar Checks

- **Core suites:** `tox`, `uv run --group tests pytest`, `npx tsx --test tests/node/**/*.test.ts`, and
  `npm run typecheck` (strict across all 7 TypeScript projects including `tests/node/**/*.ts` via
  `tsconfig.tests.json`; test-only: `npm run typecheck:tests`).
- **pi-sidecar (`packages/pi-sidecar/`):** Required whenever changing `extensions/{providers,shared}/`:
  run `npx tsx --test packages/pi-sidecar/tests/test_ts/*.test.ts`, preserve shared types and re-exports
  consumed by `packages/pi-sidecar/src/sessions.ts`, and run `.pi/skills/sidecar-test/` before release.
  Full HTTP and Python API contracts live in `packages/pi-sidecar/README.md`,
  `packages/pi-sidecar/CONSUMER-GUIDE.md`, and `docs/pi-sidecar.md`.
- **Other workspaces:** `packages/pi-vertex-claude/test/` (vitest), `packages/pi-docsite/tests/`, and
  `extensions/pidiff/pidiff-ui` (npm workspace providing React for Node `pidiff-ui` tests). Shared TUI
  fakes live in `tests/node/helpers/`.

## Test Environment Hygiene

No test suite may depend on ambient environment variables for asserted behavior:

- Wrap synchronous tool registration in `withSubagentChildEnv` (`tests/node/helpers/subagent-env.ts`).
- Assert `assert.ok(tool)` immediately after registration.
- Never wrap async test bodies in `withSubagentChildEnv`.
- Cover `PI_SUBAGENT_CHILD=1` behavior in its own dedicated test.

## Packaging & Published-Install Invariants

- **`npm pack` (`package.json` `files`):** Keep explicit daemon scripts (`scripts/pidash-server.ts`,
  `scripts/pidiff-server.ts`, `scripts/pidiff-git-diff.ts`, `scripts/pidiff-git-ignore.ts`,
  `scripts/daemon-shared.ts`, `scripts/serve-ui.ts`, `scripts/pidash-discord.ts`, `scripts/httpd.py`)
  and UI `src/` + `dist/` (never pack the entire `extensions/pidash/` directory). `prepack` runs
  `npm run build:extension-uis`.
- **Published installs only (npm + PyPI):** User install and runtime rely on published packages only
  (`npm:pi-orchestrator-config`, `npm:@myk-org/pi-vertex-claude`, `npm:pi-web-access`, PyPI
  `myk-pi-tools`; `scripts/httpd.py` reads from `~/.pi/agent/npm/node_modules/pi-orchestrator-config`). Never
  add `pi install git:github.com/myk-org/pi-config`, `git+https` `myk-pi-tools`, or `git clone` of
  `myk-org/pi-config` in `entrypoint.sh` (verified by `tests/python/test_install.py`).
- **CLI in prompts and rules:** Always reference `uvx myk-pi-tools@latest <subcommand>` in prompts and
  rules. Because `uvx` runs published PyPI, verify local CLI fixes against the working tree; release
  scripts use the local build.

## Docs Site Local Preview

`docs/*.md` files are hand-written sources; `.github/workflows/docs.yml` builds the site on `main` and
`docs-guard.yml` rejects generated output in PRs. Never run `pi-docsite` in a PR or commit generated
`.html`, `llms*.txt`, `search-index.json`, or `assets/`. Inter-page links use `.html` and each page
must have exactly one H1.

To preview locally (discard generated output before committing):

```bash
uv run --package pi-docsite pi-docsite --docs-dir docs --tagline "Agent orchestration for pi: routing, subagents, background work, memory, providers, and sidecar."
```
