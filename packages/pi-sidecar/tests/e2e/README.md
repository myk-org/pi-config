# Live e2e (opt-in)

Excluded from default pytest and tox (`addopts = -m "not e2e"`).

**Prerequisites:** at least one of `claude`, `gemini`, or `agent`|`cursor` on `PATH`.

```bash
uv run --group tests pytest -m e2e -n auto
```

`-n auto` (pytest-xdist) parallelizes the battery — faster than serial. Each xdist
worker starts and stops its own sidecar (`sidecar_url` is session-scoped per worker,
not shared). Serial runs honor `SIDECAR_HOST` / `SIDECAR_PORT`; under `-n auto`
ports are always auto-picked. Workers reuse `dist/server.js` when present; if
`dist/server.js` is missing, one worker runs `npm run build`, serialized across
workers via `fcntl` flock on `dist/.npm-build.lock` (Unix only — on Windows run
e2e serially without `-n auto`).

## Session flow

Default `E2E_TEST_CWD=/tmp/e2e-pi-sidecar-tests` (base path). Under `-n auto`, each
worker’s effective cwd/settings root is `{E2E_TEST_CWD}/{PYTEST_XDIST_WORKER}`
(e.g. `gw0`); serial runs use the base path as-is.

1. `installed_agents` — PATH only (`claude` / `gemini` / `agent|cursor`); ignores env
2. `agent_env` — sets **both** `CLI_AGENTS` and `ACPX_AGENTS`, plants settings under `{cwd}/.pi/pi-config-settings.json` (never `~/.pi` or the repo `.pi`)
3. `sidecar_url` — start/stop sidecar with **cwd=`{cwd}`** so ACPX project settings win
4. `working_models` — `dict[provider → model]` for `google` + each `cli-*` / `acpx-*`.
   Broken/missing providers are omitted (warned); **only that provider’s param cases fail**.

**Test params:** LLM/prompt cases take `provider` + `model` (from `working_models`); provider-status cases take `provider` only. Validation/smoke cases skip the probe.

Logs: SEND prompt / RECV text (`log_cli=true`). All calls via `pi_sidecar_client`.
E2e forces `httpx` `verify=False` (no SSL verify). Agents planted under the worker cwd only:
`{cwd}/.pi/agents` (Pi), `{cwd}/.claude/agents` (Claude), `{cwd}/.gemini/agents` (Gemini).
