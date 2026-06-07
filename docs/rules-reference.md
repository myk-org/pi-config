# Orchestrator Rules Reference

Rules in `rules/` are the orchestrator's behavioral contract. They load automatically in **alphabetical order** (by numeric prefix) at session start and inject into the orchestrator's system prompt via the `before_agent_start` hook. Specialist agents **never** see these rules — they are scoped to the orchestrator only.

> **Note:** Rules take effect on the **next pi session**. Running sessions are not affected by rule file changes. See [Extension Architecture and Lifecycle Hooks](extension-architecture.html) for details on the injection mechanism.

---

## Loading Mechanism

| Property | Value |
|----------|-------|
| Source directory | `rules/` |
| File format | Markdown (`.md`) |
| Load order | Alphabetical (numeric prefix: `00`, `05`, `10`, … `60`) |
| Injection point | `before_agent_start` event (orchestrator only) |
| Skipped for | All specialist subagents (`PI_SUBAGENT_CHILD=1`) |

The extension reads all `.md` files from the `rules/` directory, sorts them, concatenates their contents, and appends the result to the orchestrator's system prompt.

---

## 00 — Orchestrator Core

**File:** `rules/00-orchestrator-core.md`

Defines the orchestrator's fundamental role: it is a **manager** that delegates work to specialist agents and never performs direct edits.

### Forbidden Actions

| Action | Status |
|--------|--------|
| `edit`, `write`, `bash` (except `mcpl`) | ❌ Forbidden |
| Delegating slash commands to agents | ❌ Forbidden |
| `read` (single files) | ✅ Allowed |
| `bash` for `mcpl` only | ✅ Allowed |
| Ask clarifying questions | ✅ Allowed |
| Analyze, plan, route via `subagent` | ✅ Allowed |
| Execute slash commands directly | ✅ Allowed |

### Delegation Targets

| Work type | Delegate to |
|-----------|------------|
| `edit` / `write` | Language specialist via `subagent` |
| Git commands | `git-expert` via `subagent` |
| MCP tools | Manager agents via `subagent` |
| Multi-file exploration | `worker` agent via `subagent` |

### Pre-Implementation Checklist

Before any code change, the orchestrator verifies:

1. Root cause investigated (read relevant code, understand the problem)
2. GitHub issue created (when issue-first workflow applies)
3. On issue branch (`feat/issue-N-...` or `fix/issue-N-...`)

> **Tip:** The checklist is skipped when the issue-first workflow does not apply. See [rule 05](#05--issue-first-workflow) for skip conditions.

---

## 05 — Issue-First Workflow

**File:** `rules/05-issue-first-workflow.md`

Requires creating a GitHub issue and a dedicated branch before code changes. See [Your First Coding Workflow](first-workflow.html) for a guided walkthrough.

### Workflow Steps

1. Analyze the user's request
2. Check skip conditions (see below)
3. Investigate root cause — read source, identify files, verify the problem exists
4. Delegate issue creation to `github-expert`
5. Ask user: "Issue #N created. Do you want to work on it now?"
6. On confirmation, delegate branch creation to `git-expert`
7. Proceed with implementation

### Skip Conditions

| Condition | Effect |
|-----------|--------|
| Trivial fix (typo, single-line change) | Skip entire workflow |
| Question or explanation (no code changes) | Skip |
| Exploration or research | Skip |
| User says "just do it" or "quick fix" | Skip |
| Urgent hotfix with time pressure | Skip |

### Branch Naming

| Type | Pattern | Example |
|------|---------|---------|
| Feature | `feat/issue-N-description` | `feat/issue-70-issue-first-workflow` |
| Bug fix | `fix/issue-N-description` | `fix/issue-42-memory-leak` |
| Refactor | `refactor/issue-N-description` | `refactor/issue-99-cleanup-utils` |
| Docs | `docs/issue-N-description` | `docs/issue-15-update-readme` |

### Issue Requirements

Every issue **must** include:

- Type (fix/feat/refactor/docs)
- Problem or feature description
- Root cause analysis (for bugs — affected files, functions, why)
- Proposed fix approach
- **`## Done` section with checkboxes** — these define the completion contract

```markdown
## Done

- [ ] Deliverable 1
- [ ] Deliverable 2
- [ ] Deliverable 3
```

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| User says "just fix it" | Skip workflow, do directly |
| Partial requirements provided | Ask clarifying questions, then create issue |
| Issue already exists | Ask if user wants to continue existing issue |
| Urgent/hotfix request | Skip workflow, note in commit message |
| Multiple unrelated requests | Create separate issues for each |

> **Warning:** Issues are never closed until **all** checkboxes in the `## Done` section are checked. Unchecked deliverables that are no longer needed must be explicitly removed or marked N/A.

---

## 10 — Agent Routing

**File:** `rules/10-agent-routing.md`

Maps task domains to specialist agents. For the full agent list, see [Specialist Agents Reference](agents-reference.html).

### Routing Table

| Domain | Agent |
|--------|-------|
| Python (`.py`) | `python-expert` |
| Go (`.go`) | `go-expert` |
| Frontend (JS/TS/React/Vue/Angular) | `ts-expert` |
| Java (`.java`) | `java-expert` |
| Shell scripts (`.sh`) | `bash-expert` |
| Markdown (`.md`) | `technical-documentation-writer` |
| Docker | `docker-expert` |
| Kubernetes / OpenShift | `kubernetes-expert` |
| Jenkins / CI / Groovy | `jenkins-expert` |
| Git operations (local) | `git-expert` |
| GitHub (PRs, issues, releases, workflows) | `github-expert` |
| Tests | `test-automator` |
| Debugging | `debugger` |
| API docs | `api-documenter` |
| External repo security audit | `security-auditor` |
| External AI agents | `/acpx-prompt` |
| External library/framework docs | `docs-fetcher` |
| No specialist match | `worker` (fallback) |

### Routing Principle: Intent over Tool

Route based on **what the task is**, not which CLI tool is involved.

| Task | Correct Route | Reason |
|------|--------------|--------|
| Running Python tests | `python-expert` | Intent is testing Python code |
| Editing Python files with sed | `python-expert` | Intent is Python file modification |
| Creating a PR | `github-expert` | Intent is GitHub interaction |
| Committing changes | `git-expert` | Intent is local git operation |
| Shell script creation | `bash-expert` | Intent is shell scripting |

### Documentation Routing

External library/framework documentation (React, FastAPI, Django, Oh My Posh, etc.) **must** go through `docs-fetcher`. The orchestrator is forbidden from calling `fetch_content` on external docs directly.

```text
# Correct
subagent(agent="docs-fetcher", task="Fetch React hooks documentation...")

# Forbidden
fetch_content(https://react.dev/...)
```

`docs-fetcher` tries `llms.txt` first (LLM-optimized format) and extracts only relevant sections.

---

## 15 — MCP Launchpad

**File:** `rules/15-mcp-launchpad.md`

Governs MCP (Model Context Protocol) server interaction via the `mcpl` CLI. See [Customization and Extension Recipes](customization-recipes.html) for MCP server setup.

### Command Reference

| Command | Purpose |
|---------|---------|
| `mcpl search "<query>"` | Search all tools (5 results default) |
| `mcpl search "<query>" --limit N` | Search with custom result count |
| `mcpl list` | List all MCP servers |
| `mcpl list <server>` | List tools for a specific server |
| `mcpl list --refresh` | Refresh and list all servers |
| `mcpl inspect <server> <tool>` | Get full tool schema |
| `mcpl inspect <server> <tool> --example` | Get schema with example call |
| `mcpl call <server> <tool> '{}'` | Execute tool (no arguments) |
| `mcpl call <server> <tool> '{"param": "v"}'` | Execute tool with arguments |
| `mcpl verify` | Test all server connections |

### Workflow

```bash
# 1. Search for the right tool
mcpl search "list projects"

# 2. Get example for complex tools
mcpl inspect sentry search_issues --example

# 3. Call with required params
mcpl call vercel list_projects '{"teamId": "team_xxx"}'
```

### Orchestrator vs Agent Usage

| Role | Allowed |
|------|---------|
| Orchestrator | `mcpl search`, `mcpl list` (discovery only) |
| Specialist agents | Full `mcpl` workflow including `mcpl call` |

### Troubleshooting Commands

| Command | Purpose |
|---------|---------|
| `mcpl verify` | Test all server connections |
| `mcpl session status` | Check daemon and connection status |
| `mcpl session stop` | Restart daemon |
| `mcpl config` | Show current configuration |
| `mcpl call <server> <tool> '{}' --no-daemon` | Bypass daemon for debugging |

---

## 20 — Code Review Loop

**File:** `rules/20-code-review-loop.md`

Mandatory review cycle after every code change. See [Running the Automated Code Review Loop](code-review-loop.html) for usage guidance.

### Review Agents

| Agent | Focus Area |
|-------|-----------|
| `code-reviewer-quality` | General code quality and maintainability |
| `code-reviewer-guidelines` | Project guidelines and style (AGENTS.md) |
| `code-reviewer-security` | Bugs, logic errors, security vulnerabilities |

All three run as **async subagents** (`async: true`) in a single assistant turn. They execute in parallel — the orchestrator does not block waiting for results.

### Standard Loop (Manual Reviews)

1. Specialist writes or modifies code
2. All 3 reviewers launch in parallel (`async: true`)
3. Merge and deduplicate findings from all reviewers
4. If any reviewer has comments → fix code → go to step 2
5. Run `test-automator`
6. Tests pass? → **Done**. Tests fail? → Fix code, then:
   - Minor fix (test/config only) → re-run tests (step 5)
   - Substantive code change → full re-review (step 2)

### Deduplication Criteria

| Condition | Action |
|-----------|--------|
| Same file/line + same issue type | Keep most actionable version |
| Conflicting suggestions | Priority: security > correctness > performance > style |
| Complementary findings (different types, same code) | Keep both |

### Staged Review Mode (Automated Workflows)

Used by automated flows (autorabbit, autoqodo) instead of parallel review:

- **Stage 1 — Spec Compliance:** Does the code meet requirements? All deliverables implemented? No scope creep?
- **Stage 2 — Code Quality:** Quality, security, and guidelines checks (only after Stage 1 passes)

### Baseline Test Comparison

Before declaring test failures as blockers, the rule compares against a clean baseline:

1. Save all changes (staged, unstaged, untracked)
2. Reset to `HEAD`, run tests → baseline failure count
3. Restore changes, run tests → current failure count
4. Only **new failures** (current minus baseline) block the review

> **Note:** Pre-existing failures are noted but do not block. If `git apply` fails, baseline comparison is skipped.

---

## 25 — Documentation Updates

**File:** `rules/25-documentation-updates.md`

Mandatory documentation check after any code addition, change, or removal.

### Update Matrix

| Change Type | Files to Check |
|-------------|---------------|
| New feature/command/tool | `README.md` (feature table, usage examples) |
| New or modified extension module | `AGENTS.md` (repository structure) |
| New agent added/removed | `AGENTS.md`, `rules/10-agent-routing.md`, `rules/50-agent-bug-reporting.md` |
| New prompt template | `README.md` (prompt templates table) |
| Docker/container changes | `README.md` (Docker section), `Dockerfile` |
| New CLI tool or dependency | `README.md` (tools table), `Dockerfile` |
| Dev workflow changes | `DEVELOPMENT.md` |

> **Warning:** Documentation drift is treated as a bug. This step is never skipped.

---

## 30 — Prompt Templates

**File:** `rules/30-prompt-templates.md`

Governs how the orchestrator executes slash commands backed by prompt templates (files in `prompts/`). See [Using Slash Commands and Prompt Templates](slash-commands.html) for the full command reference.

### Execution Rules

| Rule | Description |
|------|-------------|
| Template is authority | Follow the template's instructions exactly |
| Never delegate the command itself | The orchestrator executes the prompt, not an agent |
| Template decides delegation | If the template says "delegate to X", delegate. Otherwise, follow normal rules. |
| Template overrides general rules | Template instructions take priority over general delegation rules when they conflict |

### Correct Execution Pattern

```text
# WRONG — delegating the entire command
/mycommand → subagent(agent="worker", task="/mycommand ...")

# RIGHT — orchestrator runs the command, delegates sub-tasks
/mycommand → orchestrator follows prompt → delegates sub-tasks as instructed
```

---

## 35 — Memory

**File:** `rules/35-memory.md`

Defines the orchestrator's memory usage obligations. See [Working with Project Memory](memory-system.html) for user-facing guidance and [Memory Scoring, Embeddings, and Situation Reports](memory-internals.html) for implementation details.

### Memory Tools

| Tool | Purpose | Mandatory Usage |
|------|---------|----------------|
| `memory_search` | Hybrid keyword + vector search | Before answering questions about prior sessions, preferences, past decisions |
| `memory_reinforce` | Bump evidence count, prevent decay | When a memory is relevant to the current task |
| `memory_add` | Write new memory entry | When learning something worth remembering |
| `memory_remove` | Delete outdated entry | When information is outdated, wrong, or superseded |
| `memory_topics` | List topic files with hotness scores | Inspection and organization |
| `session_search` | Search past conversation summaries | When user references something from a prior session |

### Memory Categories

| Category | Storage File |
|----------|-------------|
| `preference` | `topics/preferences.md` |
| `lesson` | `topics/lessons.md` |
| `pattern` | `topics/patterns.md` |
| `decision` | `topics/decisions.md` |
| `done` | `topics/completions.md` |
| `mistake` | `topics/mistakes.md` |

### Auto-Injection Pipeline

Three mechanisms inject memories automatically — no tool calls needed:

1. **Situation Report** — token-budgeted summary of scored memories (always present)
2. **Contextual Memory Recall** — vector similarity search (threshold > 0.65) against the current message
3. **Session History Recall** — keyword search against past conversation summaries

> **Note:** Trivial messages ("ok", "thanks", "yes", messages < 6 chars) skip vector and session search.

### Entry Quality Rules

| Requirement | Example |
|-------------|---------|
| One line only (~100 chars max) | `"buildah chown -R breaks cache mounts — use --mount=type=cache with correct uid"` |
| Specific and actionable | `"Attach child processes to pi (no detached:true) — kills on exit"` |
| No fluff, no context, no explanation | ❌ `"We had issues with buildah and Docker caching and tried several approaches"` |

### Per-Turn Self-Improvement Triggers

| Event | Action |
|-------|--------|
| User corrected you | `memory_add(category: "lesson")` |
| Something failed | `memory_add(category: "mistake")` |
| User said "don't do X" / "always do Y" | `memory_add(category: "preference")` |
| PR merged | `memory_add(category: "done")` |
| Non-obvious pattern discovered | `memory_add(category: "pattern")` |
| Technical decision made | `memory_add(category: "decision")` |

### Capacity Signal

The situation report header shows usage:

```text
# Project Memory [72% — 1,224/1,700 tokens]
```

- **Below 80%** — add freely
- **Above 80%** — consolidate first (merge related, remove outdated)

### Dreaming (Background Consolidation)

| Property | Value |
|----------|-------|
| Trigger | `/dream` command or session shutdown |
| Execution | Async + fireAndForget (never blocks session) |
| Actions | Extract memories, deduplicate, reorganize, remove stale |
| Restriction | Never removes or modifies **pinned** entries |

### Skill Creation

Multi-step workflows (3+ steps, trial-and-error, non-obvious commands) are saved as reusable skills via `/create-skill <name>`. Skills are stored at `~/.agents/skills/<name>/SKILL.md`.

---

## 40 — Critical Rules

**File:** `rules/40-critical-rules.md`

Mandatory behavioral constraints enforced across all orchestrator actions. Several of these rules are backed by code-level enforcement in `extensions/orchestrator/enforcement.ts`.

### Questions Are Not Instructions

When the user asks a question (contains `?`):

| Allowed | Forbidden |
|---------|-----------|
| Answer the question | Modify, create, or delete files |
| Use read-only commands (`read`, `grep`, `ls`, `cat`) | Run state-changing commands (`git commit`, `rm`, `write`) |
| Search memory (`memory_search`) | Create branches, PRs, issues |
| Ask for confirmation before acting | "Fix" something noticed while answering |

### Task Focus

During multi-step workflows:

- Side questions do **not** end the workflow — answer, then resume
- The workflow completes only when all steps are done (e.g., PR created, issue closed)

### Parallel Execution

| Requirement | Detail |
|-------------|--------|
| Default mode | Maximize parallelism — all independent operations in one message |
| Sequential only when | There is a proven dependency between operations |
| Async required when | Task is independent AND does not need immediate result |
| Kill unused agents | Immediately kill async agents whose results are no longer needed |

### Sync Agent Time Estimates

| Mode | `estimatedSeconds` Requirement | Threshold |
|------|-------------------------------|-----------|
| Single sync | Required on top-level params | Must be < 30s |
| Parallel sync | Required on each task | Max must be < 30s |
| Chain sync | Required on each step | Sum must be < 30s |
| Async | Not required | N/A |

> **Note:** Calls ≥ 30s without `async: true` are rejected by the tool.

### Subagent `cwd`

**Always** pass `cwd` when delegating to subagents — in all modes (single, parallel, chain, async). Omitting `cwd` causes enforcement checks to run against the wrong repository.

### Multi-PR / Multi-Branch Work

When working on multiple PRs or branches simultaneously, **always** use `git worktree`:

```bash
git worktree add .worktrees/pr-42 origin/fix/issue-42
git worktree add .worktrees/pr-43 origin/feat/issue-43
```

> **Warning:** Branch switching in the main worktree corrupts parallel agent work. The `use_worktrees` project setting enforces this by blocking `git checkout` and `git switch`. See [Configuration and Environment Variables Reference](configuration-reference.html).

### User Interaction

**Always** use the `ask_user` tool for approvals, selections, and confirmations. Never ask questions via plain text in the response.

### Technical Honesty

When the user proposes an approach:

1. Evaluate critically
2. Present alternatives with tradeoffs (if they exist)
3. Let the user decide

### Web Access

| Use case | Tool |
|----------|------|
| Research and search queries | `web_search` |
| Extracting content from URLs, YouTube, GitHub repos | `fetch_content` |
| Interactive pages (clicks, forms, screenshots) | `agent-browser` CLI |
| ❌ Never use | `curl` for reading web pages, SearXNG MCP |

### External Code Security Audit

Before adopting external code from untrusted sources, delegate to `security-auditor`:

| Source | Audit approach |
|--------|---------------|
| Git repos | Clone to `/tmp/pi-work/`, run `security-auditor` |
| Pi skills | Clone/download source, run `security-auditor` |
| PyPI packages | Clone source repo, check install hooks, scan code |
| npm packages | Download source, check `postinstall`, scan code |
| MCP servers | Audit server source before adding config |
| Docker images | Inspect Dockerfile, check base image provenance |
| Remote scripts (`curl \| bash`) | **Always block** — download first, audit, then run |

**Skip when:** User says "skip audit", source previously approved, or well-known package (e.g., `requests`, `react`).

### Temp Files

All temp files go to `/tmp/pi-work/<cwd-basename>/`. Never create temp files in the project directory.

### Python Execution

```bash
# Correct
uv run --with requests script.py
uv run --with requests --with pandas script.py

# Forbidden
uv run pip install requests
python3 script.py
pip install requests
```

### External Git Repository Exploration

Clone to `/tmp/pi-work/` with `--depth 1` for shallow clone. Never use `fetch_content` to browse repository files.

```bash
git clone --depth 1 https://github.com/org/repo.git /tmp/pi-work/repo
```

### Code-Level Enforcement

The `enforcement.ts` module backs several critical rules with `tool_call` event blocks:

| Enforced Rule | Block Condition |
|---------------|-----------------|
| Python/pip restriction | Direct `python3` / `pip` outside `uv` |
| Pre-commit restriction | Direct `pre-commit` (must use `prek`) |
| Git commit/push | Outside `git-expert` agent |
| Protected branch commits | Commit to `main` or other protected branches |
| Protected branch pushes | Push to protected branches |
| `git add .` / `git add -A` | Blanket staging forbidden — stage specific files |
| Staging gitignored files | `git check-ignore` blocks ignored files |
| Git hooks bypass | `--no-verify` and `core.hooksPath=/dev/null` forbidden |
| Merged branch commits | Commit to branches with merged PRs |
| Remote script execution | `curl \| bash`, `wget \| sh`, process substitution patterns |
| Repeat command spam | Same command ≥ 3 times in a row |
| Sleep in loops | `sleep > 5s` inside loops |
| Standalone sleep | `sleep > 30s` outside loops |
| `mktemp` location | Must use `/tmp/pi-work/` prefix |
| Docker/podman in container | Must use `docker-safe` wrapper |
| Memory writes by specialists | Only orchestrator can write memories |
| Worktree enforcement | `git checkout`/`switch` blocked when `use_worktrees` is enabled |
| Dangerous commands | User confirmation required (via `ctx.ui.select`) |

---

## 45 — File Preview

**File:** `rules/45-file-preview.md`

Serves generated HTML or browser-viewable files via a local HTTP server for user preview.

### Server Launch Sequence

```bash
HTTPD=~/.pi/agent/git/github.com/myk-org/pi-config/scripts/httpd.py
PORT=$(uv run python3 $HTTPD --find-port)
nohup uv run python3 $HTTPD --port $PORT --dir /path/to/serve \
  > /tmp/pi-work/$(basename $PWD)/httpd-$PORT.log 2>&1 &
disown
sleep 0.5
if ! kill -0 $! 2>/dev/null; then
  echo "Server failed to start:"
  cat /tmp/pi-work/$(basename $PWD)/httpd-$PORT.log
fi
```

| Parameter | Description |
|-----------|-------------|
| `--find-port` | Returns a free port number |
| `--port PORT` | Port to listen on |
| `--dir PATH` | Directory to serve files from |

After launch, the orchestrator tells the user:

> File is being served at `http://localhost:<port>/<filename>` — open this URL in your browser.


> **Note:** `nohup` + `disown` are required because `uv run` creates a parent process chain. Without them, bash cleanup kills the `uv` parent and terminates the server.

---

## 50 — Agent Bug Reporting

**File:** `rules/50-agent-bug-reporting.md`

Defines the process when the orchestrator discovers a logic flaw in an agent's configuration (files in `agents/`).

### Covered Agents

All 24 agents defined in the `agents/` directory:

`api-documenter`, `bash-expert`, `code-reviewer-quality`, `code-reviewer-guidelines`, `code-reviewer-security`, `debugger`, `docs-fetcher`, `docker-expert`, `ts-expert`, `git-expert`, `github-expert`, `go-expert`, `java-expert`, `jenkins-expert`, `kubernetes-expert`, `planner`, `python-expert`, `reviewer`, `scout`, `security-auditor`, `technical-documentation-writer`, `test-automator`, `test-runner`, `worker`

> **Note:** Built-in pi agents and agents from other sources are **not** covered.

### Trigger Conditions

| Trigger | Not a Trigger |
|---------|--------------|
| Flawed logic in agent instructions | Runtime errors (network, missing files) |
| Agent producing incorrect results from its config | External tool failures |
| Agent behavior contradicts its purpose | User code bugs |
| Instructions causing systematic errors | Expected behavior user disagrees with |

### Workflow

1. Orchestrator discovers agent logic bug
2. **Ask user:** "I found a logic bug in [agent]. Do you want me to create a GitHub issue?"
3. If yes → delegate to `github-expert` to create issue in `myk-org/pi-config`
4. Continue with original task

### Issue Format

- **Title:** `bug(agents): [agent-name] - brief description`
- **Repository:** `myk-org/pi-config`
- **Body sections:** Agent, Bug Description, Expected Behavior, Actual Behavior, Impact, Suggested Fix, Context

---

## 55 — Coms Protocol

**File:** `rules/55-coms-protocol.md`

Inter-agent communication protocol for talking to other pi sessions. See [Communicating Between Pi Sessions](inter-agent-communication.html) for setup and usage.

### Systems

| System | Activation | Tool Prefix | Transport |
|--------|-----------|-------------|-----------|
| P2P | `/coms start` | `coms_` | Direct peer-to-peer |
| Networked | `/coms-net start` | `coms_net_` | Hub server relay |

Both systems can be active simultaneously.

### Tool Reference

| Action | P2P Tool | Networked Tool |
|--------|----------|---------------|
| List peers | `coms_list` | `coms_net_list` |
| Send message | `coms_send` | `coms_net_send` |
| Poll for response | `coms_get` | `coms_net_get` |
| Block until response | `coms_await` | `coms_net_await` |

### Inbound Messages (Replying)

Inbound messages appear as `[from <peer> @ <cwd>] <message>`. The orchestrator's assistant text **is** the reply — it is captured automatically by the `agent_end` hook.

```text
# WRONG — creates a new conversation instead of replying
Receive inbound → coms_send(peer="pi-2", msg="reply text")

# RIGHT — assistant text is the reply
Receive inbound → write answer as normal assistant text
```

### Outbound Messages (Initiating)

```text
1. coms_list                          # Find peers
2. coms_send(peer="pi-2", msg="...")  # Send question
3. coms_await                         # Wait for response (ESC to cancel)
```

### Key Rules

- `coms_await` / `coms_net_await` are interruptible (user can press ESC)
- Never use send tools to reply to inbound messages
- Always check peers (`list`) before sending
- When system is unspecified, try both `coms_` and `coms_net_`

---

## 60 — Task Tracking

**File:** `rules/60-task-tracking.md`

Mandatory task tracking for multi-step workflows (3+ steps). See [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) for related async agent management.

### When to Create Tasks

| Use tasks for | Skip tasks for |
|---------------|---------------|
| Feature implementation | Single-step actions |
| Bug fixes with multiple files | Questions or explanations |
| Issue-first or code-review workflows | `/btw` side questions |
| Multi-file refactoring | Trivial fixes (typos) |

### Task Granularity

```text
# BAD — too vague
- Implement the fix
- Review code
- Create PR

# GOOD — specific and actionable
- Investigate root cause in extensions/orchestrator/utils.ts
- Create GitHub issue with root cause analysis
- Create branch fix/issue-N-description from origin/main
- Edit extensions/orchestrator/utils.ts — add timeout parameter
- Run code review loop (3 async reviewers)
- Fix review findings (if any)
- Run test-automator
- Commit changes
- Push branch to origin
- Create PR with description
```

### Task Lifecycle

1. **Create** all tasks via `TaskCreate` before starting work
2. **Mark `in_progress`** via `TaskUpdate` before starting each task
3. **Mark `completed`** via `TaskUpdate` immediately after finishing each task
4. Work through tasks in order — do not skip
5. Do not start new work while unchecked tasks exist (unless user explicitly pivots)

### Side Question Handling

When the user asks a side question while tasks are active:

1. Answer the question
2. Resume the next unchecked task immediately

### Enforcement

The extension injects reminders if tasks are ignored for **4+ turns**. Obsolete tasks are removed via `TaskUpdate` with `status: "deleted"`.

### Integration

Task tracking works alongside other workflow rules:

| Rule | Integration |
|------|-------------|
| 05 — Issue-first workflow | Create tasks for the full issue workflow |
| 20 — Code review loop | Include review steps as individual tasks |
| 25 — Documentation updates | Include doc updates as tasks when applicable |

## Related Pages

- [Extension Architecture and Lifecycle Hooks](extension-architecture.html)
- [Configuration and Environment Variables Reference](configuration-reference.html)
- [Specialist Agents Reference](agents-reference.html)
- [Running the Automated Code Review Loop](code-review-loop.html)
- [Command Safety Guards and Enforcement](command-enforcement.html)
