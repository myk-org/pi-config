# Pi Config — Repo Contributor Rules

## Commands

- All tests: `tox`
- Pre-commit: `prek run --all-files`
- Python tests: `uv run --group tests pytest`
- Node tests: `npx tsx --test tests/node/**/*.test.ts`
- Sidecar TS tests (required for `extensions/{providers,shared}/`): `npx tsx --test packages/pi-sidecar/tests/test_ts/*.test.ts`
- TypeScript gate (all 7 projects): `npm run typecheck` (test-only: `npm run typecheck:tests`)
- Full verify: `prek run --all-files && tox && npm run typecheck`

## Definition of Done

1. All gates exit 0: `prek run --all-files`, `uv run --group tests pytest`, `npx tsx --test tests/node/**/*.test.ts`, `npm run typecheck`.
2. Update docs when code/features change:
   - New, changed, or removed feature/command/tool → `docs/features.md` + `README.md` feature table (sync enforced by `tests/python/test_features_doc.py`);
     new prompt template → `docs/features.md` + `README.md` prompt table; new CLI tool/dep → `docs/features.md` + `README.md` tools table + `Dockerfile`.
   - New/modified extension module → `contributing/repo-structure.md`; new/removed agent → `contributing/repo-structure.md` +
     `rules/10-agent-routing.md` + `rules/50-agent-bug-reporting.md`; dev workflow → `DEVELOPMENT.md`.
3. **LLM-facing capability is TAUGHT, not just built:** document new tools, params, keys, or modes in BOTH `rules/` (injected every
   turn) and the tool/schema description (`docs/` alone is for humans).
4. Commit as `type(scope): description`.

## Logging Requirements

All new/modified runtime code (extensions, sidecar, CLI, scripts) MUST log via `createLogger` (`info` key events, `debug` internal
flow, `warn` recoverable issues, `error` failures) — use `createLogger`, never `console.*`.
**Exempt:** static browser assets under `*/renderer/static/` (use `console.*`) and test files (`createLogger` only when injecting a required logger, never in assertions).

## When Working On... (Navigation)

- **Repository layout & module inventory:** `contributing/repo-structure.md`
- **Workspace suites, `withSubagentChildEnv`, `npm pack`, published installs, & docs preview:** `contributing/testing-and-packaging.md`
- **pi-sidecar workspace, HTTP/Python API, `cost_usd`, & session `api_key` contracts:** `docs/pi-sidecar.md`, `contributing/testing-and-packaging.md`
- **Task completion contract (`assignee: "user"`, `completedBy`, `completionNote`, storage):** `docs/commands-and-tools.md`, `docs/configuration.md`
- **Agents, routing, conflict handoff (`conflict-resolver`), & model overrides:** `docs/managing-custom-agents.md`, `contributing/enforcement-honesty-map.md`
- **Rules layers, conditional assembly (`{{IF:...}}`), & `settings-keys.json`:** `docs/rules-and-layers.md`, `docs/project-settings.md`
- **Prompts, slash commands, templates, & autocomplete:** `docs/custom-slash-commands.md`, `docs/extension-commands.md`
- **Async internals, oneshot guards, providers restore/thinking-level, & timer lifecycle:** `docs/async-internals.md`
- **Self-reload handshake (`reload.flag` / `reload.pending` / `reload.done`):** `docs/configuration.md#reload-handshake`
- **Daemons (`pidash` / `pidiff`), WebSockets, & lockfiles:** `docs/daemon-and-websockets.md`
- **Inter-agent messaging (`coms` steer, priority, broadcast, origin, queue recovery):** `docs/inter-agent-communication.md`
- **Trail code-map gate (`trail_*`):** `docs/commands-and-tools.md`
- **Memory architecture & enforcement honesty map (`checkRemoteExecBlock`, `*(enforced)*`):** `docs/memory-architecture.md`, `contributing/enforcement-honesty-map.md`
- **MCP (`builtin:mcp`) & stream logging (`log_providers`):** `docs/mcp-servers.md`, `docs/configuration.md`
- **Skill self-improvement (`/adopt-skill`, provenance):** `docs/skill-self-improvement.md`
- **Reviews CLI, `qodo_cli_state`, & mandatory Reviews DB ↔ `extensions/orchestrator/review-learning.ts` coupling:** `docs/automating-code-reviews.md`, `docs/curating-project-memory.md`
- **Local review workflows (`/qodo-review`) & docs site (`docs/*.md` sources only):** `docs/built-in-workflows.md`, `docs/pi-docsite.md`

## Boundaries & When Blocked

- **Blocked:** stop after 3 failed test attempts with full output; fix pre-commit issues directly; check `package.json`/`pyproject.toml` before asking about missing deps.
- **Always:** run `prek run --all-files && tox && npm run typecheck` before committing; use `uv run` for Python (never bare
  `python`/`pip`); update `AGENTS.md`/`README.md` when structure, commands, or features change.
- **Ask first:** modifying `rules/` (affects all users) or changing enforcement logic.
- **Never (do this instead):**
  - Never `git add .` — stage explicit file paths.
  - Never `--no-verify`, force push, or commit to `main`/protected branches — fix hooks and work on an issue branch.
  - Never hand-edit generated `docs/*.html` or run `pi-docsite` in PRs — edit `docs/*.md` and let `.github/workflows/docs.yml` build on `main`.
  - Never add `pi install git:github.com/myk-org/pi-config`, `git+https` `myk-pi-tools`, or `git clone` of this repo in `entrypoint.sh` — install from npm and PyPI.
  - Never edit `.pi/pi-config-settings.json(c)` or `~/.pi/...` settings via agent tools (`dangerous_command_allowlist` protection;
    code-enforced) — ask the user to update settings via `/pi-config-settings`.
