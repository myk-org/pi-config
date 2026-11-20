# Pi Config — Repo Contributor Rules

Modifying agents, rules, extensions, or prompt templates here changes behavior for all pi users. Treat changes with care.

## Commands

- All tests: `tox`
- Pre-commit: `prek run --all-files`
- Python tests: `uv run --group tests pytest`
- Node tests: `npx tsx --test tests/node/**/*.test.ts`
- TypeScript gate: `npm run typecheck` (strict across all 7 projects incl. `tests/node/**/*.ts` via `tsconfig.tests.json`; test-only: `npm run typecheck:tests`; TUI fakes
  in `tests/node/helpers/`)
- Full verify: `prek run --all-files && tox && npm run typecheck`

## pi-sidecar (Monorepo Workspace)

`packages/pi-sidecar/` is an npm workspace and the ONLY external consumer of pi-config extensions (`acpx-provider`, `cli-provider`, `providers`).
`extensions/pidiff/pidiff-ui` is also a workspace (provides React for Node pidiff-ui tests).

- **Required checks:** changes to `extensions/{acpx-provider,cli-provider,providers,shared}/` must pass `npx tsx --test packages/pi-sidecar/tests/test_ts/*.test.ts`;
  shared types/re-exports must preserve `packages/pi-sidecar/src/sessions.ts`; run `.pi/skills/sidecar-test/` before release.
- **CLI & config:** `npx pi-sidecar` / `npx pi-sidecar-start`. Agent dir (`startSidecar` `agentDir` / `PI_SIDECAR_AGENT_DIR`, default `/tmp/pi-sidecar-agent`) is read
  once at startup.
- **Public API contract (never break):** HTTP REST (`/health`, `/models`, `/providers`, `/sessions`, `/sessions/:id/events`, `/transcripts/recording`) and
  `pi_sidecar_client`.
- **Contracts (see `packages/pi-sidecar/README.md` & `packages/pi-sidecar/CONSUMER-GUIDE.md`):**
  - `cost_usd` (`number | null`) + `cost_partial`: unknown pricing uses `Symbol.for("pi-config.pricingUnknown")` (`extensions/shared/pricing-provenance.ts`), never
    inferred; `Usage.cost.totalFromProvider: true` is authoritative (incl. `0`), while catalog estimates on unknown-pricing models yield `null` / `cost_partial: true`.
    Never coalesce `null` to `0`.
  - `GET /providers` returns all registered provider IDs (`{ provider, supportsSessionApiKey }`, no credentials); `GET /models/:provider/status` always returns public
    `supportsSessionApiKey` (even on non-loopback/404; CLI/ACPX/headless-excluded report `false`).
  - `POST /models/for-api-key` & `SidecarClient.get_models_for_api_key` return request-local `{ models, modelListingSupported }` (never cached/shared);
    `trustKeyScopedListing` in agent-dir `models.json` unions live `baseUrl`-pinned results with manifest `models[]` (manifest wins on id collision; `source: "listing" |
    "manifest"`).
  - `POST /sessions` & `pi_sidecar_client` optional `api_key` (≤1,024 UTF-16 units) overrides credentials for key-capable providers only; reject unsupported/ambient
    CLI/ACPX; delete/expiry clears it; never log, return, persist, or forward to nested agents.

## Tests

- **No suite may depend on ambient env for asserted behavior:** wrap synchronous registration in `withSubagentChildEnv` (`tests/node/helpers/subagent-env.ts`), assert
  `assert.ok(tool)` immediately, never wrap async bodies, and cover `PI_SUBAGENT_CHILD=1` in its own test.

## Definition of Done

1. All gates pass: `prek run --all-files`, `uv run --group tests pytest`, `npx tsx --test tests/node/**/*.test.ts`, `npm run typecheck`.
2. Update docs when code/features change: new feature/command/tool → `README.md` feature table; new prompt template → `README.md` prompt table; new CLI tool/dep →
   `README.md` tools table + `Dockerfile`; new/modified extension module → `contributing/repo-structure.md`; new/removed agent → `contributing/repo-structure.md` +
   `rules/10-agent-routing.md` + `rules/50-agent-bug-reporting.md`; dev workflow change → `DEVELOPMENT.md`; plus `AGENTS.md` as needed.
3. **LLM-facing capability is TAUGHT, not just built:** new tools, params, keys, or modes must be documented in BOTH `rules/` (injected every turn) and the tool/schema
   description (`docs/` alone is for humans).
4. Committed as `type(scope): description`.

## Task Completion Contract

- `TaskUpdate`, `TaskBulkUpdate`, and lifecycle helpers refuse starting or completing `assignee: "user"` tasks (even combined with reassignment); reassignment alone,
  content edits, and deletion remain supported.
- Manual `/tasks done`, browser panel, and overlay set `completedBy: user` regardless of assignee; only user-assigned completions send a follow-up notice (no retries).
  `TaskGet`/details expose `completionNote`; logs must never contain it. Reopening clears the outcome in single and bulk updates.
- Storage: `PI_TASK_SCOPE=session` (default, `.pi/tasks/tasks-<sessionId>.json`), `project` (`.pi/tasks/tasks.json`), or `PI_TASKS` override (path, bare id
  `~/.pi/tasks/<id>.json`, or `off`). Peer `coms_task*` uses the target peer's advertised `task_store_path`.

## Logging Requirements

All new/modified runtime code (extensions, sidecar, CLI, scripts) MUST log via `createLogger` (`info` key events, `debug` internal flow, `warn` recoverable issues,
`error` failures; never `console.*`).
**Exempt:** static browser assets under `*/renderer/static/` (use `console.*`) and test files (`createLogger` only when injecting a required logger, never in assertions).

## Project & Docs

- **Stack & structure:** TypeScript (extensions), Python (`myk_pi_tools`), Markdown (agents, rules, prompts); structure in `contributing/repo-structure.md`. Container:
  `ghcr.io/myk-org/pi-config:latest` (`Dockerfile`).
- **Additional suites:** `packages/pi-sidecar/tests/`, `packages/pi-vertex-claude/test/` (vitest), `packages/pi-docsite/tests/`.
- **User install/runtime is npm + PyPI only** (`npm:pi-orchestrator-config`, `npm:@myk-org/pi-vertex-claude`, `npm:pi-web-access`, PyPI `myk-pi-tools`; container
  specialists/`httpd.py` read from `~/.pi/agent/npm/node_modules/pi-orchestrator-config`). NEVER add `pi install git:github.com/myk-org/pi-config` or `git+https`
  `myk-pi-tools` (tested in `tests/python/test_install.py`).
- **Docs (`docs/*.md`):** hand-written source; `.github/workflows/docs.yml` builds the site on `main` and `docs-guard.yml` rejects generated output in PRs. **NEVER run
  `pi-docsite` in a PR or commit generated `.html`, `llms*.txt`, `search-index.json`, or `assets/`.** Inter-page links use `.html`; one H1 per page; output is
  deterministic. Local preview (discard output): `uv run --package pi-docsite pi-docsite --docs-dir docs --tagline "Agent orchestration for pi: routing, subagents,
  background work, memory, providers, and sidecar."` (`--tagline` required; see `.pi/skills/pi-docsite/` or `~/.pi/agent/skills/pi-docsite/`).
- **CLI specialists (container):** `entrypoint.sh` runs `scripts/symlink-cli-specialists.sh` from npm unpack into `.cursor/agents/`, `.claude/agents/`, `.gemini/agents/`
  (gitignored); native installs do not auto-sync (see `docs/cli-provider.md`).

## Agents, Rules, Prompts & Docker

- **Add/remove agent:** manage `agents/<name>.md` (one-sentence `description` frontmatter; resolve packaged skills via
  `~/.pi/agent/npm/node_modules/pi-orchestrator-config/skills/<name>/SKILL.md` with local fallback) and update `rules/10-agent-routing.md` (+
  `rules/50-agent-bug-reporting.md` if needed).
- **Conflicts:** `git-expert` is blocked by `enforcement.ts` from conflict resolution/sequencer flags while unmerged paths exist — delegate to `conflict-resolver`
  (`rules/10-agent-routing.md`).
- **Model override:** `list_models` + `subagent(model="provider/model-id")` (`rules/10-agent-routing.md`).
- **Rules (`rules/` `00-69`, `~/.pi/agent/rules/` `70-89`, `<project>/.pi/rules/` `90-99`):** conditional assembly (`{{IF:key}}`, `{{IFNOT:key}}`, `==`/`!=`,
  `requires_setting`/`requires`; unknown keys fail closed) — see `docs/project-settings.md`. Keep rules tight (1 sentence/concept, gate off-settings, reserve
  MANDATORY/NEVER for data loss/security/irreversibility).
- **Local review:** `/qodo-review [--autofix] [--fast|--deep] [--ticket <url>] [path ...]` (max 3 autofix cycles; does not commit/push/create PR).
- **Prompts & templates:** `prompts/<name>.md` (`description` frontmatter) + autocomplete in `extensions/orchestrator/extended-autocomplete.ts` (when args are
  completable); source templates `prompts/create-X.md` → `templates/X-prompt.md` (`{{PLACEHOLDER}}`, no frontmatter).
- **Docker:** update `Dockerfile` + `README.md` Docker section when changing CLI tools/deps; never `git clone` `myk-org/pi-config` in `entrypoint.sh`.

## Extensions & Tooling Invariants

- **pidiff:** per-project server (free port, `.pi/run/pidiff.{port,pid}`, `.pi/tmp` legacy read); Refresh reloads in place (disabled when WS down); nested gitignores do
  not skip top-level dirs; daemon scripts include `scripts/pidiff-git-diff.ts` and `scripts/pidiff-git-ignore.ts`.
- **Timers & reload:** guard callbacks with `isLiveExtensionCtx` (`extensions/shared/live-ctx.ts`) and clear intervals on `session_shutdown`.
- **npm pack:** keep explicit daemon scripts (`scripts/pidash-server.ts`, `pidiff-server.ts`, `pidiff-git-diff.ts`, `pidiff-git-ignore.ts`, `daemon-shared.ts`,
  `serve-ui.ts`, `pidash-discord.ts`, `httpd.py`) and UI `src/`+`dist/` (never whole `extensions/pidash/`); `prepack` runs `npm run build:extension-uis`.
- **Oneshot (`-p`/`--print`/`--mode json`):** pitasks, pidash, pidiff, coms, and shutdown dream skip via `extensions/shared/oneshot.ts` (`--mode rpc` is not oneshot; see
  `docs/async-internals.md`). Commands: `docs/extension-commands.md`.
- **Trail (`trail_enable`):** gates first project nav of substantive turn on `trail_*` (children get 5 read-only tools); map in `graft/` or `.trail/cache/` from worktree
  root; never write main map; fail open.
- **coms:** `steer: true` (mid-turn, ack-only, 5/turn cap), `priority: true`, `coms_broadcast`, `coms_history` (`~/.pi/coms/history.jsonl`), `⚙busy` + ~60s signals.
  `/coms tell` and `m` composer set `origin: "user"` via `globalThis.__comsUserSend` (`resolvePromptOrigin` accepts literal `true` only; display-only, unauthenticated).
  Queue recovery: `coms_queue_inspect` → 5m owner-bound `preview_id` → `coms_queue_clear`/`delete` (never `clearPrevious`; RPC providers keep ≤20 previews and atomic
  `clearQueueIfSnapshot`).
- **Async & CLI/ACPX providers (`docs/async-internals.md`, `docs/cli-provider.md`):** native `cli-*`/`acpx-*` providers MUST use
  `extensions/shared/create-runtime-provider.ts` (`createProvider` + `/login` + fetch/filter) — **never legacy `registerProvider(name, bag)`**; `models.dev` cached at
  `~/.pi/pi-config/models.dev.json` (1d TTL; thinking from id); cold-start restore on `startup`/`resume` (skips non-empty `enabledModels`); spawn cwd uses session cwd
  (`Symbol.for("pi-config.sessionCwdAls")` synced between `extensions/shared/session-cwd.ts` and `packages/pi-sidecar/src/session-cwd.ts`); Cursor `--approve-mcps`
  (`CLI_APPROVE_MCPS` > `SIDECAR_PORT`; `bindSidecarListenExit()` exits 1 on fatal errors); Gemini defaults `GEMINI_CLI_TRUST_WORKSPACE=true`; ops logs in `~/.pi/logs/`.
- **Self-reload handshake (`docs/configuration.md#reload-handshake`):** deploy writes nonce to `.pi/run/reload.flag` via same-dir atomic rename; `extensions/reload-flag/`
  awaits `ctx.waitForIdle()`, calls `ctx.reload()`, and writes `.pi/run/reload.done` (+ `.pi/tmp/reload.done` mirror). Confirm reload by comparing `.pi/run/reload.done`
  to flag nonce. Live foreign `reload.pending` survives (OS `startToken` catches PID reuse); oneshot/headless never touches handshake; worktrees do NOT auto-reload.
- **MCP (`builtin:mcp`, `docs/mcp-servers.md`):** `mcp.json` via `/mcp` or `pi mcp ...`, surfaced via `codemode`/`deferred`; extensions must not collide with built-in
  replaceable MCP tool/command names.
- **Stream logging:** shared `provider_stream_event` (`extensions/shared/provider-stream-log.ts`) gated on `log_providers` `debug`.
- **Memory & enforcement:** `docs/memory-architecture.md` (conflict gate allows distinct targets/quoted examples, rejects polarity flips until `overrideConflicts`);
  `contributing/enforcement-honesty-map.md`; `*(enforced)*` entries are hash-keyed (never mutate text); `checkRemoteExecBlock` (`enforcement-helpers.ts`) blocks `curl |
  bash`, `eval $(curl)`, nested `$(bash -c "$(curl)")`, prefix assignments (`VAR=$(curl) cmd`), and path-prefixed exec (`/bin/bash -c`), while allowing a safe `VAR=$(curl
  ...)` capture followed by an unrelated interpreter/`eval` call (blocking if exec consumes the captured var or reads untrackable stdin/file input).
- **CLI & settings:** always `uvx myk-pi-tools@latest <subcommand>` in prompts/rules (runs published PyPI, so verify local CLI fixes against working tree; release scripts
  use local build). `settings-keys.json` is single source of truth for TS + Python; TUI `/pi-config-settings [project|global]`; agents use `{{SETTINGS:key1,key2}}` (never
  read JSON manually).
- **Skill maintenance (`docs/skill-self-improvement.md`):** `extensions/orchestrator/skill-maintenance.ts` (non-blocking; `pi.getCommands()` + `.pi/skills/` fallback;
  `/adopt-skill`; provenance `.pi/data/skill-review.jsonl`).
- **Reviews & learning (`README.md#qodo-cli-read-source-qodo_cli_state`):** `reviews address` applies `<path>:<line>|<reply>` / `*|<reply>` atomically;
  `reviews fetch`/`poll --source qodo` uses `qodo` CLI when authed (fail-open to GitHub sticky scrape; read-only, replies via `reviews address`; see `README.md` for
  `qodo_cli_state.approved`, `reviewing`, `review_complete`, and `reason` semantics); `reviews store-session <json>` stores `qodo-<pr>-<sha>.json` idempotently.
  **MANDATORY coupling:** `.pi/data/reviews.db` feeds `extensions/orchestrator/review-learning.ts` (`getAddressedComments`/`getLatestReview`) — store/schema/status changes
  must preserve distillation.

## Boundaries & When Blocked

- **Blocked:** stop after 3 failed test attempts with full output; fix pre-commit issues directly; check `package.json`/`pyproject.toml` before asking about missing deps.
- **Always:** run `tox` + full gates before commit; use `uv run` for Python (never bare `python`/`pip`); update `AGENTS.md`/`README.md` when structure/commands/features
  change.
- **Ask first:** modifying `rules/` (affects all users), changing enforcement logic.
- **Never:** `git add .`, `--no-verify`, force push, commit to `main`/protected branches, hand-edit generated `docs/*.html` or run `pi-docsite` in PRs, add
  `git:github.com/myk-org/pi-config` installs, or edit `.pi/pi-config-settings.json(c)` / `~/.pi/...` settings via agent tools (`dangerous_command_allowlist` protection;
  code-enforced).
