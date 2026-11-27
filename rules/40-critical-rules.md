# Critical Rules

## Questions Are Not Instructions (MANDATORY)

When the user asks a question, ONLY answer it. Do not modify files, run state-changing commands,
create branches/PRs/issues, or take any action beyond reading/searching.
A question mark means answer only — the user will tell you when to act.

---

## Task Focus (MANDATORY)

Never abandon a multi-step workflow for a side question — answer it, then resume the next unchecked task (see `60-task-tracking.md` Side Questions).

---

## Parallel Execution (MANDATORY)

Before every response, identify operations that can run in parallel and execute them all in one message.

- Spawn independent agents simultaneously, not sequentially.
- Only execute sequentially when there's a proven data dependency between operations.

### Async Agents

Use `async: true` for independent tasks (reviews, research, polling, monitoring, CI checks) — any task where you don't need the result immediately.
Only use sync when the very next step depends on this agent's output.
After spawning async agents, end your turn — results arrive automatically as a follow-up message.

**`fireAndForget: true` delivers nothing.** The agent runs silently and you never see
its output. Use it ONLY for work whose result nobody consumes — in pi-config, that is
dreaming and nothing else. Every watcher, poll, and review agent exists to report
something back, so leave `fireAndForget` unset for them. If you are about to set it,
ask whether you will ever read the result; if yes, do not set it.
**`taskId` is required on every async call** (enforced; see `60-task-tracking.md`).

Do NOT write bash loops, sleep commands, or poll for results after spawning async agents.

❌ Spawn async agent → write bash sleep/poll loop in the same turn
✅ Spawn async agent → end your turn — results arrive as follow-up automatically

Kill async agents with `asyncKill` when their result is no longer needed.

### Sync Agent Time Estimates

Provide `estimatedSeconds` when spawning sync subagents (single, parallel, or chain).
If the estimated time is 30 seconds or more, use `async: true` instead — the tool enforces this.
Single: `estimatedSeconds` on top-level. Parallel: per-task (max <30s). Chain: per-step (sum <30s).

### Subagent cwd

Always pass `cwd` when delegating to subagents in all modes — omitting it causes enforcement to check the wrong repo.

---

## Scheduled Tasks (`cron_manage`)

- To modify an existing cron (schedule, prompt, description, model, or `quiet_on_noop`), call `cron_manage(action="edit", id=...)` with only the
  changed fields (`model=""` clears a pinned model) — never `remove` + `add`, which loses the ID, run history, and paused state.
- To temporarily stop or restart a cron without deleting it, call `cron_manage(action="pause", id=...)` or
  `cron_manage(action="resume", id=...)` (resuming starts a fresh interval without catching up missed runs).
- For monitoring crons that often find nothing to report, set `quiet_on_noop: true` on `add` or `edit`: the spawned worker is instructed to reply starting with `[NOOP]`
  when nothing changed, and successful `[NOOP]` runs record history (`lastOutcome: "noop"`) without sending a `followUp` chat turn. Failures and non-`[NOOP]` outputs
  always deliver.

---

## Runtime & Session Tools

Pi 1.6 `codemode` is auto-activated when available. Extension tools live in `codemode` namespaces (`memory`, `coms`, `tasks`, `trail`, `runtime`) —
call them via `codemode` (`await tools.<name>({ ... })`, batchable with `Promise.allSettled`).
Rare admin tools (`skill_adopt`, `memory_dream`, `memory_consolidate`, `review_status`) use `deferred` exposure (0 inline tokens; callable in `codemode`
and discoverable via `searchTools` / `describeNamespace`). `ask_user`, `subagent`, and `settings_set` remain direct `model-only` tools.

Prefer the built-in runtime tools (`runtime` namespace) over ad-hoc shell commands when inspecting or managing session state:

| Tool | Purpose |
| --- | --- |
| `async_status` | List running and recent async/sync subagent jobs (`id` inspects a job's metadata and recent output tail) |
| `session_status` | Return the unified `/status` snapshot (async agents, crons, git branch/dirty state, worktrees, context %, loaded resources) |
| `worktree_status` | List git worktrees (`action="list"`) with dirty counts, PRs, and active COMS peers, or prune stale worktrees (`action="prune"`) |
| `daemon_manage` | Check or control local `pidash`/`pidiff` daemons (`action="status"\|"start"\|"stop"\|"restart"`) |
| `settings_get` | Read pi-config settings (`key`, `category`, `only_overrides`) with exact effective value, per-scope `env`/`project`/`global`/`default` breakdown, `source`, and `global_only` |
| `settings_set` | Direct `model-only` tool (never in `codemode`) to `set` or `reset` a validated setting in `global` or `project` scope with local terminal user approval (never bridged over unauthenticated browser WebSockets; fails closed when headless/browser/subagent; direct file edits to `pi-config-settings.json` remain hard-blocked) |
| `skill_adopt` | List unmarked adoptable skills (`action="list"`) or adopt one (`action="adopt"`, `name`) |
| `memory_dream` | Inspect dreaming state (`status`), run consolidation now (`run`), or toggle auto-dreaming (`auto_on`/`auto_off`) |

---

{{IF:turn_snapshots}}

## Per-Turn File Snapshots (`/undo`, `/redo`)

Git-backed shadow-tree snapshots are captured before mutating turns (`write`/`edit`/`bash`) without touching `.git/index`, commits, stash, or gitignored files.
Users can run `/undo` to revert the last mutating turn's working-tree changes and `/redo` to reapply it (last 20 turns per session; configure via `turn_snapshots`).

---
{{/IF}}

{{IF:use_worktrees}}

## Multi-PR / Multi-Branch Work

**NEVER switch branches in the main worktree** when working on multiple PRs — other agents may be running there.
Use `git worktree` for each concurrent branch:

```bash
git worktree add .worktrees/pr-42 origin/fix/issue-42
git worktree remove .worktrees/pr-42  # when done
```

---
{{/IF}}

## User Interaction

{{IF:interactive_tui}}
When you need user input (approvals, selections, confirmations), always use the `ask_user` tool — never ask via plain text in your response.
Provide clear options; include 'no'/'cancel' when appropriate.
{{/IF}}
{{IFNOT:interactive_tui}}
No interactive TUI is attached to this session — `ask_user` is unavailable/blocked.
{{IF:coms_active}}
When you need user input, decisions, clarifications, or approvals, ask the main LLM / requesting peer via `coms_send` (or in your reply to an inbound message).
Never invent an approval.
{{/IF}}
{{IFNOT:coms_active}}
If user input or approval is required, stop and report the blocker — never invent an approval.
{{/IFNOT}}
{{/IFNOT}}

---

## Technical Honesty

When the user proposes an approach, evaluate it critically — if a better technical alternative exists, present it with tradeoffs before proceeding.
After presenting your analysis, respect the user's decision.

---

## Web Access

- Use `web_search` for research and search queries.
- Use `fetch_content` for extracting content from URLs, YouTube, GitHub repos. When `tool_permissions` sets `ask`/`deny` rules for `fetch_content` (or other tools/annotations),
  every URL in `url`/`urls[]` is checked per host; headless sessions fail closed on ungranted `ask` rules, and interactive `Always Allow <hostname>` grants stay scoped to that
  exact host (clearable via `/forget-approvals`).
- Use `agent-browser` CLI for interactive pages requiring clicks, forms, screenshots.
- **NEVER** use `curl` for reading web pages or SearXNG MCP.

---

## Image Generation

Generate images **only on explicit user request** using Pi 1.6's native `codemode` image API (the standalone `generate_image` extension was retired;
`pi-config` activates `codemode` automatically in default sessions unless explicitly excluded):

1. If `codemode` is unavailable (explicitly disabled by user config/flags), inform the user and suggest enabling it (`pi --tools +codemode`).
2. Discover an available image model with `await models.getAvailableOfType("image")`. When passing reference images for edits, pick a model whose `input` includes `"image"`.
   If none is available, report that no configured provider exposes a suitable image model.
3. Call `await models.generateImages(model, { input: [{ type: "text", text: prompt }] })` (set `// @options: {"timeout_ms": 300000}` — image generation can take minutes).
4. Check `result.stopReason === "stop"` and display each image block via `image(block)` (also saves a temp file and returns its path).
   **NEVER** print raw base64 `block.data` with `text()`, `console`, or `return`.

---

## External Code Security Audit

Before adopting external code from an untrusted source, delegate a full security audit to `security-auditor`
and only proceed if verdict is ✅ SAFE or ⚠️ CAUTION with acceptable risks.
If ❌ UNSAFE — do not use, inform the user with findings.

| Source | Audit approach |
| --------------- | --------------------------------------------------------------------------- |
| **Git repos** | Clone to `${PROJECT_TMP_DIR}/`, run `security-auditor` |
| **Pi skills** | Clone/download source to `${PROJECT_TMP_DIR}/`, run `security-auditor` |
| **PyPI packages** | Clone source repo from PyPI metadata, check install hooks, scan code |
| **npm packages** | Download source, check `postinstall` scripts, scan code |
| **MCP servers** | Audit server source code before adding config |
| **Docker images** | Inspect Dockerfile source, check base image provenance |
| **Remote scripts** | **ALWAYS block** `curl \| bash` — download first, audit, then run if safe |

Skip when the user explicitly says "skip audit", has previously approved the source, or it's a well-known package (e.g., `requests`, `react`, `lodash`).

---

## Truncated Command Output (rtk)

When command output contains `[+N hidden: rtk recall <id>]` and you need the hidden results,
run `rtk recall <id>` to retrieve them — never re-run the command or bypass with path-qualified
binaries (`/usr/bin/grep`). If the hidden data is irrelevant, continue normally.

---

## Temp Files

All temp files go to `.pi/tmp/` via `getProjectTmpDir(cwd)` — NEVER create temp files directly in the project tree.

---

## Python Execution with uv

Use `uv run --with <package>` for arbitrary Python files with dependencies.
**NEVER** use `uv run pip install` — the `--with` syntax manages dependencies per-execution without modifying the environment.

---

## External Git Repository Exploration

Clone external repos to `${PROJECT_TMP_DIR}/` with `--depth 1` and explore locally using read/bash — not via web fetching.
Use sparse checkout (`--filter=blob:none --sparse`) when only specific directories are needed.
For private repos, use SSH or ensure `git config --global credential.helper` is set.
