# Pi Config — Repo Contributor Rules

Modifying agents, rules, extensions, or prompt templates here changes behavior for all pi users. Treat changes with care.

## Commands

- All tests: `tox`
- Pre-commit: `prek run --all-files`
- Python tests: `uv run --group tests pytest`
- Node tests: `npx tsx --test tests/node/**/*.test.ts`
- Full verify: `prek run --all-files && tox`

## pi-sidecar (Monorepo Workspace)

pi-sidecar lives under `packages/pi-sidecar/` as an npm workspace package. It is the ONLY external consumer of pi-config extensions (acpx-provider, cli-provider, providers).
`extensions/pidiff/pidiff-ui` is also a workspace so root `npm install` provides React for Node pidiff-ui tests.

**When changing pi-config code, you MUST verify pi-sidecar is not broken:**

- Extensions (`extensions/acpx-provider/`, `extensions/cli-provider/`, `extensions/providers/`, `extensions/shared/`): run pi-sidecar tests — `npx tsx --test packages/pi-sidecar/tests/test_ts/*.test.ts`
- Shared types or re-exports: check `packages/pi-sidecar/src/sessions.ts` imports
- Before release: run live sidecar smoke test (see `.pi/skills/sidecar-test/`)

**CLI commands:** `npx pi-sidecar` (start server), `npx pi-sidecar-start` (background start/stop).

The sidecar's internal agent dir is configurable (startSidecar `agentDir` option / `PI_SIDECAR_AGENT_DIR`, default
`/tmp/pi-sidecar-agent`) so deployments can supply custom providers, auth, and settings; settings are read once at
process start from the configured dir — see `packages/pi-sidecar/README.md`.

**Public API contract:** The HTTP REST API (`/health`, `/models`, `/providers`, `/sessions`) and the Python client (`pi_sidecar_client`) are the external contract — never break these.
Internal code, imports, and structure can change freely.

`prompt` usage reports `cost_usd` as the accumulation of driver-reported costs: a number means costs
were reported, `null` means nothing usable was reported, and a number with `cost_partial: true` is a lower
bound because at least one turn's cost was unknowable. A model whose source published no price has
all-zero Pi price metadata, which means *unknown pricing* rather than *free*, so the sidecar cannot derive a
cost for those turns — but a driver may still report one, and that reported amount is always kept. A
catalog all-zero cost is authoritative: that model is free and reports `cost_usd: 0` with
`cost_partial: false`. Provenance is carried by `Symbol.for("pi-config.pricingUnknown")`
(`extensions/shared/pricing-provenance.ts`), never inferred from the value, so no model or provider id is
special-cased. Read `cost_usd` together with `cost_partial`; consumers must not coalesce `null` to `0` nor
present a partial total as complete — see `packages/pi-sidecar/CONSUMER-GUIDE.md`.

`GET /providers` lists all provider IDs registered in the initialized runtime,
including built-ins and extensions, regardless of ambient auth or whether
`GET /models` includes their models. It returns `{ "providers": [...] }` with
records containing `provider` (exact ID) and `supportsSessionApiKey` (boolean capability, not
credential availability); no credentials or auth diagnostics. Python
`SidecarClient.get_providers()` returns a typed list of the same records.
Use discovery to enumerate providers and `/models/:provider/status` for details
about a known ID.

`GET /models/:provider/status` includes public boolean `supportsSessionApiKey`
(including on non-loopback and unknown-provider 404 responses). It reflects
provider API-key capability independent of server auth; headless-excluded and
ambient CLI/ACPX providers report false.

`POST /models/for-api-key` accepts `{ "provider": string, "api_key": string }` for
key-capable providers. Python `await SidecarClient.get_models_for_api_key(provider, api_key)`
returns `{ "models": [...], "modelListingSupported": boolean }`. `true` means native
key-scoped listing ran (an empty list means no models); `false` means no native
listing, so the user must supply a model ID. The key and result are request-local:
never cache them or add key-listed models to the shared catalog. Listing does
not verify that a model can complete a prompt.

`POST /sessions` and `pi_sidecar_client` optionally accept a non-empty `api_key`
(at most 1,024 UTF-16 code units). It overrides stored/environment credentials
only for the selected API-key-capable provider and session; omission preserves
fallback. Reject unsupported auth (including CLI/ACPX ambient-login markers);
delete/expiry removes the in-memory key. Never log, return, persist, or pass it
to nested agents. See `packages/pi-sidecar/README.md` for usage.

pi-sidecar tests are part of the test suite. Breaking pi-sidecar is breaking the project.

## Definition of Done

A change is complete when ALL pass:

1. `prek run --all-files` exits 0
2. `uv run --group tests pytest` exits 0
3. `npx tsx --test tests/node/**/*.test.ts` exits 0
4. AGENTS.md / README.md updated if structure/commands/features changed
5. Files committed with message: `type(scope): description`

## Logging Requirements

All new or modified code MUST include proper `log.debug/info/warn/error` calls via `createLogger`. No code change is complete without logging.

**Scope:** pi runtime and Node processes — extensions, sidecar, CLI tools, scripts.
**Exempt:** static browser assets under `*/renderer/static/` copied verbatim into a docs site
(no bundler, no pi runtime, no session id). Use `console.*` there — a browser page has no chat
TUI to leak into. Keep such assets consistent with their siblings.

- **info**: key events (boot, shutdown, peer joined/left, connections, state changes)
- **debug**: internal flow (function entry/exit, decisions, variable state)
- **warn**: recoverable issues (timeouts, retries, self-heal)
- **error**: failures (crashes, broken connections, data corruption)

User switches log level on the fly via settings — debug must show everything needed for root cause analysis without adding manual debug logs.

## When Blocked

- Tests fail after 3 attempts → stop, report with full output
- Pre-commit hook fails → fix the specific issue, don't bypass with --no-verify
- Missing dependency → check package.json/pyproject.toml first, then ask
- NEVER: use `git add .`, force push, skip tests, bypass hooks, commit to protected branches

## Project

- Stack: TypeScript (extensions), Python (myk_pi_tools CLI), Markdown (agents, rules, prompts)
- Structure: see `contributing/repo-structure.md`
- Test: `tests/node/` (tsx + node:test), `tests/python/` (pytest), `packages/pi-sidecar/tests/` (sidecar TS + Python), `packages/pi-vertex-claude/test/` (vitest),
  `packages/pi-docsite/tests/` (pytest for the generator, jsdom + node:test for the shipped browser assets)
- Key packages: `pi-web-access`, `@myk-org/pi-sidecar`, `pi-sidecar-client`, `@myk-org/pi-vertex-claude`
- Container: `ghcr.io/myk-org/pi-config:latest` (see Dockerfile)
- **User install/runtime is npm + PyPI only — never a `myk-org/pi-config` git clone.**
  `pi install git:github.com/myk-org/pi-config` (and the vertex git-subdir) is forbidden
  in entrypoint, `scripts/install.py`, session hints, prompts, and user-facing docs.
  Sources: `npm:pi-orchestrator-config`, `npm:@myk-org/pi-vertex-claude`,
  `npm:pi-web-access`, PyPI `myk-pi-tools`. Container specialists and `httpd.py`
  come from `~/.pi/agent/npm/node_modules/pi-orchestrator-config`. Tests:
  `tests/python/test_install.py`. Allowed: this repo for *developers*; optional
  `docker build` from a clone; third-party git (e.g. mcp-proxy).
- Docs: `docs/*.md` are the hand-written source; `.html`, `llms*.txt`, and
  `search-index.json` are generated from them by `uv run --group docs pi-docsite
  --docs-dir docs --tagline "Agent orchestration for pi: routing, subagents, background work, memory, providers, and sidecar."`
  — never hand-edit the generated files. `--tagline` is not optional in practice: omitting it
  blanks the meta description and tagline on every page.
  - **MANDATORY — MANDATORY REGENERATION.** Whenever you change ANY `docs/*.md`,
    you MUST re-run the `pi-docsite` command above in the same change, and you MUST
    commit the regenerated `.html`, `llms.txt`, `llms-full.txt`, and `search-index.json`
    alongside the markdown that caused them. Editing `docs/*.md` and leaving the
    generated files stale is an incomplete change, not a follow-up task.
  - The output is deterministic: repeated runs are byte-identical. If a rebuild shows
    unrelated churn, that is a real regression from your edit — investigate it, do not
    commit the churn.
  - Use the `pi-docsite` skill (`.pi/skills/` or `~/.pi/agent/skills/pi-docsite/`) when
    you need to build, rebuild, or debug the docs site, or add a docs page.
- **CLI specialist agents (container):** `entrypoint.sh` runs
  `scripts/symlink-cli-specialists.sh` from the npm unpack
  (`~/.pi/agent/npm/node_modules/pi-orchestrator-config`) to `ln -sfn`
  package `agents/*.md` into the mounted project’s `.cursor/agents/`,
  `.claude/agents/`, and `.gemini/agents/` (all gitignored). Native installs
  do not auto-sync — see `docs/cli-provider.md` / README Docker section.

## When Adding an Agent

1. Create `agents/<name>.md` with YAML frontmatter (name, description, tools)
2. Add routing in `rules/10-agent-routing.md`
3. Add to agent list in `rules/50-agent-bug-reporting.md`
4. Test: start pi session, verify orchestrator routes to new agent

Frontmatter `description` is one sentence. If the agent points at a packaged
skill, resolve the path at runtime (`ls ~/.pi/agent/npm/node_modules/pi-orchestrator-config/skills/<name>/SKILL.md`
with a local fallback) — a bare relative path breaks outside this checkout.

## Delegating Conflicts

`git-expert` never resolves merge, rebase, or cherry-pick conflicts: it is routinely pinned to a
small model, so `enforcement.ts` blocks `git add`, `git restore`, `git rm`, `git update-index`,
`git reset`, `git checkout --ours|--theirs`, and the `--continue`/`--skip`/`--quit` flags of
`merge|rebase|cherry-pick|revert|am` in its process while `git ls-files --unmerged` reports
anything, and refuses a command that starts one of those sequencers and then stages in the same
line. Delegate to `conflict-resolver` (`subagent(agent="conflict-resolver")`) whenever
a merge, rebase, or cherry-pick leaves unmerged paths. Do not work around the block.

## When Removing an Agent

1. Delete `agents/<name>.md`
2. Remove from `rules/10-agent-routing.md`
3. Remove from `rules/50-agent-bug-reporting.md`

## When Modifying Rules

Rules load from 3 layers (later overrides earlier):

| Layer | Path | Range |
|-------|------|-------|
| Package | `rules/` | `00-69` |
| User | `~/.pi/agent/rules/` | `70-89` |
| Project | `<project>/.pi/rules/` | `90-99` |

Rules auto-load alphabetically. Changes take effect on next pi session.

**Conditional assembly** — see `docs/project-settings.md` (Rules assembly). Essentials:

- `{{IF:key}}` / `{{IFNOT:key}}` — settings truthiness (`isSettingTruthy`: empty object/array falsy)
  or feature predicates (`coms_active`, `external_ai_agents`). Unknown setting keys fail closed
  (strip block + warn), including `{{IFNOT:typo}}`.
- `{{IF:key==value}}` / `{{IF:key!=value}}` — literal compare
- Frontmatter: `requires_setting` / `requires` (AND). Per-file conditionals then join then placeholders.

Writing effective rules:

- Fewer lines = more compliance. One sentence per concept.
- Reserve MANDATORY/NEVER for data loss, security, or irreversible changes.
- Use precise, scoped language — ambiguous rules get exploited.
- Numbered checklists over flowcharts. Merge overlapping sub-sections.
- Gate setting/feature-specific prose with `{{IF}}`/`{{IFNOT}}` or frontmatter so off settings do not inject dead tokens.

## When Reviewing Local Changes

Use `/qodo-review [--autofix] [--fast|--deep] [--ticket <url>] [path ...]` before committing
or opening a PR to review local changes with Qodo and session context. Repeat `--ticket <url>`
for multiple tickets; paths are optional git pathspecs. Default mode asks which findings to fix;
`--autofix` fixes findings without approval, stopping after at most 3 cycles or sooner on no
progress. It does not commit, push, create a PR, or post results.

## When Adding a Prompt Template

1. Create `prompts/<name>.md` with YAML frontmatter (`description: "..."`)
2. Add autocomplete in `extensions/orchestrator/extended-autocomplete.ts` (only when the prompt has completable arguments — skip for free-text-only prompts)

## When Adding a Source Template

- `prompts/create-X.md` (prompt) → `templates/X-prompt.md` (template)
- Templates use `{{PLACEHOLDER}}` for dynamic values, no YAML frontmatter

## When Overriding Subagent Models

- `list_models` — discover available models and providers (optional `provider` filter). Returns `provider/model-id` pairs for subagent overrides.
- `subagent(model="provider/model-id")` — explicit model override for a subagent call.
  Bare `model-id` overrides model only; provider follows the normal resolution chain
  (overrides > frontmatter > settings > parent). `provider/model-id` selects both.

## When Modifying Extensions

- **pidiff** runs as a per-project server (one per cwd, not shared).
  Random free port, tracked via `.pi/tmp/pidiff.port` and `.pi/tmp/pidiff.pid`.
  Header and stale-banner **Refresh** reload the current diff in place (tree and
  panes stay mounted). Refresh is disabled while the WebSocket is down.
  Nested gitignores do not skip whole top-level dirs
  (`extensions/foo/node_modules` does not ignore `extensions/`).
  Daemon scripts include `scripts/pidiff-git-ignore.ts` (chokidar skip filter).
- Timers (`setInterval`/`setTimeout`) must not read captured `ctx.mode` unguarded —
  getters call `assertActive()` and crash the process after `/reload`. Use
  `isLiveExtensionCtx` (`extensions/shared/live-ctx.ts`) and clear intervals on
  `session_shutdown`.
- npm pack of `pi-orchestrator-config` must include daemon scripts
  (`scripts/pidash-server.ts`, `pidiff-server.ts`, `pidiff-git-ignore.ts`, `daemon-shared.ts`,
  `serve-ui.ts`, `pidash-discord.ts`, `httpd.py`) and pidash/pidiff UI `src/` + `dist/` —
  never a whole-tree `extensions/pidash/` entry (that packs `node_modules`).
  Pre-publish: `prepack` runs `npm run build:extension-uis` so gitignored `dist/`
  exists before `npm pack` / `npm publish` (`prepack` covers both).
- Oneshot (`-p` / `--print` / `--mode json`): pitasks, pidash, pidiff, and coms
  skip register via `extensions/shared/oneshot.ts`; shutdown dream also skipped.
  See `docs/async-internals.md` (Oneshot invocations). `--mode rpc` is not oneshot.
- Extension commands: see `docs/extension-commands.md`
- Graft (`graft_enable=true`) applies to main agents and subagents. Every substantive prompt retrieves from Graft before raw project
  navigation. Children only consume existing graphs; stale graphs remain usable and failures fail open. Main processes own rebuilds under
  the cross-process lock.
- COMS queue recovery is irreversible: call `coms_queue_inspect`, review its body-free result, then pass its one-time `preview_id` to
  `coms_queue_clear` or `coms_queue_delete`. Never use `coms_send.clearPrevious`; it is rejected. Preview tokens are owner-bound and
  expire after five minutes. RPC recovery providers retain at most 20 previews per provider and must implement an atomic
  `clearQueueIfSnapshot(snapshot)` operation; clients never call an unconditional clear after validating a preview.
- Async agents, async-only list, acpx `supportsAsyncLlm` + sidecar settings, temp dirs: see `docs/async-internals.md`
- CLI providers (`cli-*`): see `docs/cli-provider.md`
- **MCP:** built into pi as `builtin:mcp` (#848). Servers in `mcp.json` —
  user `~/.pi/agent/mcp.json`, project `mcp.json` once trusted. Managed with
  `/mcp` and `pi mcp add|remove|list|login|logout`; no external binary, no
  `mcpc` bridge, no separate OAuth store. Tools reach the model through
  `codemode` (default) or `deferred`, so an unused server costs no context.
  See `docs/mcp-servers.md`. Our extensions register none of the built-in
  MCP tool or command names, and all three built-ins are `replaceable` — a
  collision would displace the built-in silently, so keep it that way.
- **Provider stream logging** (#848): one shared
  `provider_stream_event` hook (`extensions/shared/provider-stream-log.ts`)
  replaces per-provider stream logging. The event fires per parsed chunk and
  pi awaits handlers in stream order, so the gate is mandatory — it is
  `log_providers` at its non-default `debug` level. Never `console.*`.
- CLI/ACPX model metadata (context window, maxTokens, cost): cached from
  `https://models.dev/api.json` at `~/.pi/pi-config/models.dev.json` (refresh after
  1 day). Mapping is CLI/ACPX only — native pi models are untouched. Thinking
  from id (`-high`, `[effort=xhigh]`), not catalog `reasoning`. See
  `extensions/shared/models-dev.ts`
- Cold-start default model restore (#753): `startup`|`resume` (`new` only when no model is selected); skips non-empty `enabledModels`; trusted project merge — see `docs/cli-provider.md`
- CLI/ACPX spawn cwd (#768): session cwd (`POST /sessions` / `ctx.cwd`), not
  sidecar `process.cwd()`. Cursor `--workspace` matches that folder. Dual
  `session-cwd.ts` copies (extensions/shared + packages/pi-sidecar/src) must
  keep `Symbol.for("pi-config.sessionCwdAls")` in sync — sidecar cannot import
  the extension file (`tsconfig` rootDir). See `docs/cli-provider.md`.
  Headless Cursor `--approve-mcps`: `CLI_APPROVE_MCPS` wins (`false` opts out);
  otherwise sidecar (`SIDECAR_PORT` — `startSidecar()` stamps it while running,
  including default 9100, `options.port`, and ephemeral `0`; `close()` restores
  the inherited value). Executable consumers should call `bindSidecarListenExit()`
  so `StartedSidecarHandle.ready` / `.stopped` fatal failures exit 1. Headless Gemini defaults
  `GEMINI_CLI_TRUST_WORKSPACE=true` but preserves an explicit parent value.
- Extension ops logs (cli-provider, dreaming): `~/.pi/logs/` — never `console.*` (leaks into chat). See `docs/cli-provider.md` Logging
- Memory system: see `docs/memory-architecture.md`
- Enforcement honesty (code vs injected): see `contributing/enforcement-honesty-map.md`
- Memory inventory CLI: `uv run myk-pi-tools memory status`
- Project settings: see `docs/project-settings.md`
- Settings keys definition: `settings-keys.json` (repo root) — single source of truth for all setting keys, types, env vars, and defaults.
  Both TypeScript (`extensions/orchestrator/project-settings.ts`) and Python (`myk_pi_tools/settings/commands.py`) derive from this file.
- Settings CLI: `uv run myk-pi-tools settings get [key ...]` — resolve settings (project → global → env → default). No args = all keys.
- Settings TUI: `/pi-config-settings [project|global]` — interactive settings editor in the pi session.
- Agent settings injection: use `{{SETTINGS:key1,key2}}` in agent `.md` files — `substituteSettingsPlaceholders` only (not rules `assembleRuleText`). See `docs/project-settings.md`.
  Never instruct agents to read `pi-config-settings.jsonc`/`.json` manually.
- When adding slash command arguments: update autocomplete in `extended-autocomplete.ts`
- Memory `*(enforced)*` marker: entries with this marker are hash-keyed — never change their text, only add/remove whole entries
- Remote script exec enforcement (`checkRemoteExecBlock` in `enforcement-helpers.ts`):
  blocks `curl | bash`, `eval $(curl)`, nested `$(bash -c "$(curl)")`,
  prefix assignments (`VAR=$(curl) cmd`), path-prefixed exec (`/bin/bash -c`).
  Uses variable-flow analysis: allows a safe `VAR=$(curl ...)` capture followed by an
  UNRELATED interpreter/`eval` call (e.g. `code=$(curl ...); uv run python3 -c '...'`), but still
  blocks when the exec consumes the curl output — inline `$(curl)`, a captured var fed to
  exec (`x=$(curl ...); uv run python3 -c "$x"`), or a shell reading untrackable stdin/file input.
- Native `cli-*` / `acpx-*` providers: use `extensions/shared/create-runtime-provider.ts`
  (`createProvider` + `/login` + fetch/filter) — never legacy `registerProvider(name, bag)`

## When Modifying Docker

Update `Dockerfile` AND `README.md` Docker section when adding CLI tools or system deps.
Never assume a tool exists in the container.
`entrypoint.sh` must not `git clone` `myk-org/pi-config`; register via `npm:…` and read
agents/`httpd.py` from the npm unpack.

## Boundaries

- ✅ Always: run `tox` before committing; update AGENTS.md/README.md when structure changes
- ✅ Always: use `uv run` for Python, never bare `python`/`pip`
- ⚠️ Ask first: modifying rules (affects all users), changing enforcement logic
- 🚫 Never: `git add .`, `--no-verify`, commit to main/protected branches, hand-edit the
  generated `docs/*.html`, add `pi install git:github.com/myk-org/pi-config`
  (or git+https install of `myk-pi-tools` from this repo) for users

## Documentation

`docs/*.md` are hand-written and are the single source of truth. Everything else in
`docs/` — `*.html`, `llms.txt`, `llms-full.txt`, `search-index.json`, `assets/` — is
generated and committed.

Regenerate after changing any `docs/*.md`:

```bash
uv run --group docs pi-docsite --docs-dir docs \
  --tagline "Agent orchestration for pi: routing, subagents, background work, memory, providers, and sidecar."
```

The output is deterministic: repeated runs are byte-identical, so a rebuild that shows
unrelated churn means a real change. Each page must have exactly one H1, which becomes
its title and its sidebar entry; headings inside code fences are ignored.

Edit the markdown, never the HTML. If a page renders wrong, fix the markdown or the
templates under `scripts/docs_render/`.
