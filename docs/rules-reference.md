# Orchestrator Rules Reference

Orchestrator rules are markdown files in the `rules/` directory that define the orchestrator's behavior. They load automatically in **alphabetical order** (by numeric prefix) at the start of each pi session and are injected into the orchestrator's system prompt via the `before_agent_start` hook in `extensions/orchestrator/rules.ts`.

> **Note:** Rules apply to the **orchestrator only** — specialist agents ignore them. Each rule file begins with a scope declaration that enforces this boundary.

| Property | Value |
|----------|-------|
| Location | `rules/` directory |
| Format | Markdown (`.md`) |
| Load order | Alphabetical (numeric prefix) |
| Takes effect | Next pi session start |
| Injected via | `before_agent_start` hook in `extensions/orchestrator/rules.ts` |
| Target | Orchestrator only (not specialist agents) |

---

## Rule Loading Mechanism

The `registerRules()` function in `extensions/orchestrator/rules.ts` reads all `.md` files from the `rules/` directory, sorts them alphabetically, and concatenates their contents into the orchestrator's system prompt. This happens on every `before_agent_start` event.

```text
rules/
├── 00-orchestrator-core.md      # Loads first
├── 05-issue-first-workflow.md
├── 10-agent-routing.md
├── 15-mcp-launchpad.md
├── 20-code-review-loop.md
├── 25-documentation-updates.md
├── 30-prompt-templates.md
├── 35-memory.md
├── 40-critical-rules.md
├── 45-file-preview.md
├── 50-agent-bug-reporting.md
├── 55-coms-protocol.md
└── 60-task-tracking.md          # Loads last
```

> **Tip:** To add a new rule, create a file with a numeric prefix that places it in the desired load order. See [Customization and Extension Recipes](customization-recipes.html) for details.

---

## 00 — Orchestrator Core

**File:** `rules/00-orchestrator-core.md`

Defines the fundamental separation between the orchestrator (manager) and specialist agents (workers). The orchestrator delegates all implementation work and never directly modifies files.

### Forbidden Actions

| Action | Status | Alternative |
|--------|--------|-------------|
| `edit`, `write`, `bash` tools | ❌ Forbidden | Delegate to specialist agents via `subagent` |
| Delegating slash commands | ❌ Forbidden | Execute slash commands directly |
| Git commands | ❌ Forbidden | Delegate to `git-expert` |
| MCP tool execution | ❌ Forbidden | Delegate to specialist agents |
| Multi-file exploration | ❌ Forbidden | Delegate to `worker` agent |

### Allowed Direct Actions

| Action | Status |
|--------|--------|
| Read files (read tool) | ✅ Allowed |
| Run `mcpl` via bash for MCP discovery | ✅ Allowed |
| Ask clarifying questions | ✅ Allowed |
| Analyze and plan | ✅ Allowed |
| Route tasks to agents via `subagent` | ✅ Allowed |
| Execute slash commands and their internal operations | ✅ Allowed |

### Pre-Implementation Checklist

Before any code changes (when the issue-first workflow applies):

1. Root cause investigated? (read code, understand the problem)
2. GitHub issue created?
3. On issue branch (`feat/issue-N-...` or `fix/issue-N-...`)?

---

## 05 — Issue-First Workflow

**File:** `rules/05-issue-first-workflow.md`

Requires a GitHub issue and dedicated branch before starting code changes. Defines the full lifecycle from user request to issue closure.

### When to Apply

| Condition | Action |
|-----------|--------|
| New features or enhancements | **Use** workflow |
| Bug fixes requiring code changes | **Use** workflow |
| Refactoring tasks | **Use** workflow |
| Multi-file modifications | **Use** workflow |
| Trivial fixes (typos, single-line) | **Skip** workflow |
| Questions or explanations | **Skip** workflow |
| Exploration or research | **Skip** workflow |
| User says "just do it" / "quick fix" | **Skip** workflow |
| Urgent hotfixes | **Skip** workflow |

### Workflow Steps

1. Analyze and understand the request
2. Determine if workflow should be skipped
3. Investigate root cause — read source code, identify affected files and functions
4. Delegate to `github-expert` to create issue with type, description, root cause analysis, proposed fix, and deliverables checklist
5. Ask user: "Issue #N created. Do you want to work on it now?"
6. On confirmation, delegate to `git-expert` to fetch main and create issue branch
7. Implement changes, following the code review loop
8. Check off deliverables as completed
9. Close issue when all deliverables are done

### Branch Naming

| Type | Pattern | Example |
|------|---------|---------|
| Feature | `feat/issue-<N>-<description>` | `feat/issue-70-issue-first-workflow` |
| Fix | `fix/issue-<N>-<description>` | `fix/issue-42-memory-leak` |
| Refactor | `refactor/issue-<N>-<description>` | `refactor/issue-99-cleanup-utils` |
| Docs | `docs/issue-<N>-<description>` | `docs/issue-15-update-readme` |

### Issue Requirements

Every issue **must** include a `## Done` section with checkboxes:

```markdown
## Done

- [ ] Deliverable 1
- [ ] Deliverable 2
- [ ] Deliverable 3
```

> **Warning:** Issues must never be closed with unchecked deliverables. If a deliverable is no longer needed, remove it or mark as N/A before closing.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| User says "just fix it" | Skip workflow, do directly |
| Partial requirements | Ask clarifying questions, then create issue |
| Issue already exists | Ask if user wants to continue existing issue |
| Urgent/hotfix request | Skip workflow, note in commit message |
| Multiple unrelated requests | Create separate issues for each |

---

## 10 — Agent Routing

**File:** `rules/10-agent-routing.md`

Maps task domains to specialist agents. See [Specialist Agents Reference](agents-reference.html) for full agent specifications.

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
| Kubernetes/OpenShift | `kubernetes-expert` |
| Jenkins/CI/Groovy | `jenkins-expert` |
| Git operations (local) | `git-expert` |
| GitHub (PRs, issues, releases, workflows) | `github-expert` |
| Tests | `test-automator` |
| Debugging | `debugger` |
| API docs | `api-documenter` |
| External repo security audit | `security-auditor` |
| External AI agents | `/acpx-prompt` |
| External library/framework docs | `docs-fetcher` |
| No specialist match | `worker` (fallback) |

### Routing Principles

Route by **task intent**, not by tool:

| Task | Correct Route | Reasoning |
|------|---------------|-----------|
| Running Python tests | `python-expert` | Intent is Python, not shell |
| Editing Python files with sed/awk | `python-expert` | Intent is Python code modification |
| Creating a PR | `github-expert` | GitHub operation, not local git |
| Committing changes | `git-expert` | Local git operation |
| React documentation lookup | `docs-fetcher` | External library docs |

### docs-fetcher Routing

The orchestrator must **never** fetch external documentation directly. All external doc lookups go through `docs-fetcher`.

```text
# Correct — delegate to docs-fetcher
subagent(agent="docs-fetcher", task="Fetch React hooks documentation...")

# Wrong — orchestrator fetching directly
fetch_content(https://react.dev/...)
```

`docs-fetcher` tries `llms.txt` first (optimized for LLMs), then extracts only relevant sections.

---

## 15 — MCP Launchpad

**File:** `rules/15-mcp-launchpad.md`

Defines how to use the `mcpl` CLI for MCP (Model Context Protocol) server interactions. See [Slash Commands and Extension Commands Reference](commands-reference.html) for related commands.

### mcpl Commands

| Command | Purpose |
|---------|---------|
| `mcpl search "<query>"` | Search all tools (shows required params, 5 results) |
| `mcpl search "<query>" --limit N` | Search with custom result limit |
| `mcpl list` | List all MCP servers |
| `mcpl list <server>` | List tools for a specific server |
| `mcpl list --refresh` | Refresh and list all servers |
| `mcpl inspect <server> <tool>` | Get full tool schema |
| `mcpl inspect <server> <tool> --example` | Get schema + example call |
| `mcpl call <server> <tool> '{}'` | Execute tool with no arguments |
| `mcpl call <server> <tool> '{"param": "v"}'` | Execute tool with arguments |
| `mcpl verify` | Test all server connections |

### Workflow

```text
1. Search for the tool:    mcpl search "list projects"
2. Get an example call:    mcpl inspect sentry search_issues --example
3. Call with params:       mcpl call vercel list_projects '{"teamId": "team_xxx"}'
```

### Troubleshooting Commands

| Command | Purpose |
|---------|---------|
| `mcpl verify` | Test all server connections |
| `mcpl session status` | Check daemon and server connection status |
| `mcpl session stop` | Restart daemon |
| `mcpl config` | Show current configuration |
| `mcpl call <server> <tool> '{}' --no-daemon` | Bypass daemon for debugging |

### Role Separation

| Role | Can Do |
|------|--------|
| Orchestrator | `mcpl search` / `mcpl list` for discovery only |
| Specialist agents | Full `mcpl` workflow including `mcpl call` |

---

## 20 — Code Review Loop

**File:** `rules/20-code-review-loop.md`

Mandatory review process after every code change. Three reviewers run in parallel, and the loop repeats until all approve. See [Running the Automated Code Review Loop](code-review-loop.html) for a usage guide.

### Review Agents

| Agent | Focus Area |
|-------|------------|
| `code-reviewer-quality` | General code quality and maintainability |
| `code-reviewer-guidelines` | Project guidelines and style (AGENTS.md) |
| `code-reviewer-security` | Bugs, logic errors, security vulnerabilities |

> **Note:** All three reviewers are enforced as `async: true` by the `ASYNC_ONLY_AGENTS` set in `extensions/orchestrator/subagent-tool.ts`. Sync calls are automatically rejected.

### Standard Loop (Manual Reviews)

1. Specialist writes/fixes code
2. All 3 review agents dispatched **in parallel** (async)
3. Merge and deduplicate findings from all reviewers
4. If any reviewer has comments → fix code → go to step 2
5. Run `test-automator`
6. If tests fail → fix code:
   - Minor fix (test/config only) → re-run tests (step 5)
   - Substantive code change → full re-review (step 2)
7. Done when all reviewers approve **AND** tests pass

### Deduplication Criteria

| Condition | Action |
|-----------|--------|
| Same file/line range + same issue type or root cause | Keep most actionable version |
| Conflicting suggestions | Priority: security > correctness > performance > style |
| Complementary findings on same code (different issue types) | Keep both |

### Baseline Test Comparison

Before declaring test failures as blockers, compare against baseline:

1. Save all changes (staged + unstaged + untracked)
2. Reset to clean state (`git reset --hard HEAD`)
3. Run tests → record baseline failure count
4. Restore changes (`git apply`)
5. Run tests → record current failure count
6. Only **new failures** (current minus baseline) block the review

> **Note:** Pre-existing failures are noted in the review but do not block. If `git apply` and `git apply --3way` both fail, skip baseline comparison and note "baseline comparison unavailable."

### Staged Review Mode (Automated Workflows)

For automated review flows (autorabbit, autoqodo), use a two-stage order instead of parallel:

| Stage | Focus | Rationale |
|-------|-------|-----------|
| Stage 1 | Spec compliance — requirements met, all deliverables implemented, no scope creep | Don't polish code that doesn't meet spec |
| Stage 2 | Code quality, security, guidelines | Quality review on spec-compliant code |

Each stage loops independently until passed before advancing to the next.

---

## 25 — Documentation Updates

**File:** `rules/25-documentation-updates.md`

Mandatory documentation check after any code change. Maps change types to documentation files that must be reviewed and updated.

### Change-to-Documentation Map

| Change Type | Files to Check |
|-------------|----------------|
| New feature/command/tool | `README.md` (feature table, usage examples) |
| New or modified extension module | `AGENTS.md` (repository structure) |
| New agent added/removed | `AGENTS.md`, `rules/10-agent-routing.md`, `rules/50-agent-bug-reporting.md` |
| New prompt template | `README.md` (prompt templates table) |
| Docker/container changes | `README.md` (Docker section), `Dockerfile` |
| New CLI tool or dependency | `README.md` (tools table), `Dockerfile` |
| Dev workflow changes | `DEVELOPMENT.md` |

> **Warning:** Documentation drift is treated as a bug. This step must not be skipped.

---

## 30 — Prompt Templates

**File:** `rules/30-prompt-templates.md`

Governs how the orchestrator executes prompt templates (slash commands). See [Using Slash Commands and Prompt Templates](slash-commands.html) for usage details.

### Execution Rules

| Rule | Description |
|------|-------------|
| Prompt is the authority | Follow the template's instructions exactly |
| Never delegate the template itself | The orchestrator executes the prompt, not an agent |
| Prompt decides delegation | If the prompt says "delegate to X," delegate. If it says "run this bash command," run it. |
| Orchestrator maintains control | The orchestrator owns the prompt workflow |
| Template overrides general rules | When a prompt's instructions conflict with general delegation rules, the prompt wins |

```text
# Correct — orchestrator executes prompt, delegates sub-tasks as directed
/mycommand → orchestrator follows prompt → delegates sub-tasks per prompt instructions

# Wrong — delegating the entire prompt to an agent
/mycommand → delegate entire prompt to an agent
```

---

## 35 — Memory

**File:** `rules/35-memory.md`

Defines the scored memory system, memory tools, and per-turn self-improvement obligations. See [Working with Project Memory](memory-system.html) for a usage guide and [Memory Scoring, Embeddings, and Situation Reports](memory-internals.html) for architecture details.

### Memory Tools

| Tool | Purpose | Mandatory? |
|------|---------|------------|
| `memory_search` | Search memories by keyword or category | Yes — before answering questions about prior sessions |
| `memory_reinforce` | Bump evidence count to prevent decay | Yes — when a memory is relevant to current task |
| `memory_add` | Add new memories (pinned or learned) | Yes — when learning something worth remembering |
| `memory_remove` | Remove outdated or incorrect memories | No |
| `memory_topics` | List topic files with hotness scores | No |
| `session_search` | Search past conversation summaries | No |

### Memory Categories

| Category | Storage File |
|----------|-------------|
| `preference` | `.pi/memory/topics/preferences.md` |
| `lesson` | `.pi/memory/topics/lessons.md` |
| `pattern` | `.pi/memory/topics/patterns.md` |
| `decision` | `.pi/memory/topics/decisions.md` |
| `done` | `.pi/memory/topics/completions.md` |
| `mistake` | `.pi/memory/topics/mistakes.md` |

### Auto-Injection Pipeline

Three mechanisms inject memories into the system prompt automatically:

| Mechanism | Source | Trigger |
|-----------|--------|---------|
| Situation Report | Token-budgeted summary of scored memories | Every `before_agent_start` |
| Contextual Memory Recall | Vector similarity search (threshold > 0.65) | Every `before_agent_start` (non-trivial messages) |
| Session History Recall | Keyword search over past conversation summaries | Every `before_agent_start` (non-trivial messages) |

> **Note:** Trivial messages ("ok", "thanks", "yes", emoji-only, messages < 6 chars) skip vector/session search via the social closer gate.

### Capacity Signal

The situation report header shows memory usage:

```text
# Project Memory [72% — 1,224/1,700 tokens]
```

| Usage | Action |
|-------|--------|
| Below 80% | Add memories freely |
| Above 80% | Consolidate first — merge related entries, remove outdated ones |

### Per-Turn Self-Improvement Triggers

| Event | Action |
|-------|--------|
| User corrected you | `memory_add(text: "...", category: "lesson")` |
| Something failed | `memory_add(text: "...", category: "mistake")` |
| User said "don't do X" / "always do Y" | `memory_add(text: "...", category: "preference")` |
| PR merged | `memory_add(text: "...", category: "done")` |
| Non-obvious pattern discovered | `memory_add(text: "...", category: "pattern")` |
| Technical decision made | `memory_add(text: "...", category: "decision")` |

### Memory Quality Rules

- One line only — max ~100 characters
- Specific and actionable — concrete "do X" or "don't do Y"
- No fluff — no context, background, or explanation

### CLI Interface

```bash
uv run myk-pi-tools memory add -c <category> -s "summary"           # Add to Learned
uv run myk-pi-tools memory add -c <category> -s "summary" --pinned  # Add to Pinned
uv run myk-pi-tools memory forget -c <category> -s "summary"        # Remove
uv run myk-pi-tools memory show                                     # Show memory file
uv run myk-pi-tools memory migrate                                  # DB→md migration
uv run myk-pi-tools memory path                                     # Print file path
```

See [myk-pi-tools CLI Reference](cli-reference.html) for complete CLI documentation.

### Dreaming (Background Consolidation)

Dreaming runs as an async fire-and-forget agent — never blocking the session.

| Trigger | Type |
|---------|------|
| `/dream` command | Manual |
| Session shutdown | Automatic |

Dreaming reads the session, extracts learnings, adds new entries, deduplicates, and removes stale entries. Pinned entries are never removed.

---

## 40 — Critical Rules

**File:** `rules/40-critical-rules.md`

Mandatory behavioral constraints that apply across all orchestrator actions. See [Command Safety Guards and Enforcement](command-enforcement.html) for enforcement details.

### Questions Are Not Instructions

When the user asks a question (contains `?`), the orchestrator must **only answer** — no file modifications, no state changes, no PRs, no issues.

| Allowed | Forbidden |
|---------|-----------|
| Read-only commands (read, grep, cat, ls) | Modify/create/delete files |
| `memory_search` | Run state-changing commands |
| Answer the question | Create branches, PRs, or issues |
| Ask for confirmation before acting | "Fix" something noticed while answering |

### Task Focus

During multi-step workflows, side questions do not end the current task. Answer the question, then immediately resume the workflow from the next pending step.

### Parallel Execution

| Rule | Description |
|------|-------------|
| Maximize parallelism | If operations have no dependencies, execute all in one message |
| Async by default | Use `async: true` for independent tasks (reviews, research, analysis) |
| Sync only when blocked | Use sync only when the very next step depends on the agent's output |
| Kill unused agents | Kill async agents immediately when their result is no longer needed |

### Sync Agent Time Estimates

| Mode | `estimatedSeconds` | Threshold |
|------|---------------------|-----------|
| Single sync | Required on top-level params | Must be < 30s |
| Parallel sync | Required on each task | Max must be < 30s |
| Chain sync | Required on each step | Sum must be < 30s |
| Async | Not required | — |

> **Warning:** Sync calls without `estimatedSeconds` or with values ≥ 30s are rejected by the subagent tool.

### Subagent cwd

Always pass `cwd` when delegating to subagents — in all modes (single, parallel, chain, async). Omitting `cwd` causes enforcement to check the wrong repository.

### Multi-PR / Multi-Branch Work

When working on multiple PRs simultaneously, use `git worktree` for each branch:

```bash
git worktree add .worktrees/pr-42 origin/fix/issue-42
git worktree add .worktrees/pr-43 origin/feat/issue-43
# Work in each directory independently
git worktree remove .worktrees/pr-42
```

> **Warning:** Never switch branches in the main worktree when other agents may be running — it corrupts parallel agent work.

### User Interaction

Always use the `ask_user` tool for user input (approvals, selections, confirmations). Never ask questions via plain text in the response.

### Technical Honesty

Evaluate user proposals critically. Present alternatives with tradeoffs before proceeding. Let the user make the final call.

### Web Access

| Tool | Use For |
|------|---------|
| `web_search` | Research and search queries |
| `fetch_content` | Extracting content from URLs, YouTube, GitHub repos |
| `agent-browser` | Interactive pages (clicks, forms, screenshots) |

> **Warning:** Never use `curl` for reading web pages. Never use SearXNG MCP.

### External Code Security Audit

Before adopting external code from untrusted sources, delegate a security audit to `security-auditor`.

| Source | Audit Approach |
|--------|----------------|
| Git repos | Clone to temp dir, run `security-auditor` |
| Pi skills | Clone source, run `security-auditor` |
| PyPI packages | Clone source repo, check install hooks |
| npm packages | Download source, check `postinstall` scripts |
| MCP servers | Audit server source code |
| Docker images | Inspect Dockerfile source |
| Remote scripts (`curl \| bash`) | **Always block** — download first, audit, then run |

Skip audits when: user says "skip audit", tool is previously approved, or package is well-known (e.g., `requests`, `react`, `lodash`).

### Temp Files

All temp files must go to `<cwd>/.pi/tmp/` via `getProjectTmpDir()`. The `.pi/` directory is already gitignored.

### Python Execution

Use `uv run --with <package>` syntax only. Never use `uv run pip install`.

```bash
# Correct
uv run --with requests script.py
uv run --with requests --with pandas script.py
```

### External Git Repository Exploration

Clone external repos to `${PROJECT_TMP_DIR}/` with `--depth 1` for shallow clones. Never use full clones or `fetch_content` to browse repository files.

---

## 45 — File Preview

**File:** `rules/45-file-preview.md`

Serves generated or modified browser-viewable files (HTML, frontend) via a built-in HTTP server.

### Preview Workflow

1. Save the file under `$PWD` or `${PROJECT_TMP_DIR}`
2. Find a free port and launch the server:

```bash
HTTPD=~/.pi/agent/git/github.com/myk-org/pi-config/scripts/httpd.py
PORT=$(uv run python3 $HTTPD --find-port)
nohup uv run python3 $HTTPD --port $PORT --dir /path/to/serve > ${PROJECT_TMP_DIR}/httpd-$PORT.log 2>&1 &
disown
sleep 0.5
if ! kill -0 $! 2>/dev/null; then echo "Server failed to start:"; cat ${PROJECT_TMP_DIR}/httpd-$PORT.log; fi
```

3. Tell the user: `http://localhost:<PORT>/<filename>`
4. Keep the server running until the user confirms they're done

| Parameter | Description |
|-----------|-------------|
| `--find-port` | Returns an available port number |
| `--port <N>` | Port to serve on |
| `--dir <path>` | Directory containing files to serve |

> **Note:** `nohup` + `disown` are required because `uv run` creates a parent process chain. Works in both containers (`--network host`) and native installs.

---

## 50 — Agent Bug Reporting

**File:** `rules/50-agent-bug-reporting.md`

Defines the process for reporting logic bugs discovered in specialist agent configurations. Applies only to agents defined in the `agents/` directory.

### Covered Agents

api-documenter, bash-expert, code-reviewer-quality, code-reviewer-guidelines, code-reviewer-security, debugger, docs-fetcher, docker-expert, ts-expert, git-expert, github-expert, go-expert, java-expert, jenkins-expert, kubernetes-expert, planner, python-expert, reviewer, scout, security-auditor, technical-documentation-writer, test-automator, test-runner, worker

> **Note:** Built-in pi agents and agents from other sources are **not** covered by this rule.

### Trigger Conditions

| Trigger | Not a Trigger |
|---------|---------------|
| Flawed logic in agent instructions | Runtime errors (network, missing files) |
| Agent producing incorrect results due to config | External tool failures |
| Behavior contradicting intended purpose | User code bugs |
| Instructions causing systematic errors | Expected behavior user disagrees with |

### Workflow

1. Orchestrator discovers agent logic bug
2. Asks user: "I found a logic bug in [agent]. Do you want me to create a GitHub issue for this?"
3. If user confirms → delegate to `github-expert` to create issue in `myk-org/pi-config`
4. Continue with original task

### Issue Format

| Field | Content |
|-------|---------|
| Title | `bug(agents): [agent-name] - brief description` |
| Repository | `myk-org/pi-config` |
| Body sections | Agent, Bug Description, Expected Behavior, Actual Behavior, Impact, Suggested Fix, Context |

---

## 55 — Coms Protocol

**File:** `rules/55-coms-protocol.md`

Inter-agent communication protocol for talking between pi sessions. See [Communicating Between Pi Sessions](inter-agent-communication.html) for a usage guide.

### Communication Systems

| System | Activation | Tool Prefix | Transport |
|--------|-----------|-------------|-----------|
| P2P | `/coms start` | `coms_` | Direct peer-to-peer |
| Networked | `/coms-net start` | `coms_net_` | Hub server relay |

Both systems can be active simultaneously. When listing peers or sending messages, try both systems.

### Tool Reference

| Action | P2P Tool | Networked Tool |
|--------|----------|----------------|
| List peers | `coms_list` | `coms_net_list` |
| Send message | `coms_send` | `coms_net_send` |
| Poll for response | `coms_get` | `coms_net_get` |
| Block until response | `coms_await` | `coms_net_await` |

### Inbound vs Outbound Messages

| Direction | How to Reply |
|-----------|-------------|
| **Inbound** (message received from peer) | Write your answer as normal assistant text — the `agent_end` hook automatically sends it back. **Do not** call any send tool. |
| **Outbound** (initiating a conversation) | Call `coms_send` / `coms_net_send`, then `coms_await` / `coms_net_await` for the response. |

### Outbound Example (P2P)

```text
1. coms_list                          # Find available peers
2. coms_send(peer="pi-2", msg="...")  # Send the question
3. coms_await                         # Wait for response (ESC to interrupt)
```

### Message Queue

Messages are processed in **FIFO order**. If multiple messages arrive while the peer is busy, they queue — nothing is dropped. Each message gets a dedicated turn and response.

### Structured Task Delegation

Send structured tasks with the `tasks` parameter:

```text
coms_send(target="coder", prompt="Implement these features", tasks=[
  {"subject": "Add auth middleware", "description": "JWT validation for all /api routes"},
  {"subject": "Write tests", "description": "Unit tests for auth middleware"}
])
```

---

## 60 — Task Tracking

**File:** `rules/60-task-tracking.md`

Mandatory task creation and tracking for multi-step workflows (3+ steps). Tasks persist across turns and provide automatic workflow resume after interruptions.

### When to Create Tasks

| Condition | Create Tasks? |
|-----------|---------------|
| Multi-step workflow (3+ steps) | Yes |
| Feature implementation | Yes |
| Bug fixes with multiple files | Yes |
| Issue-first or code-review workflows | Yes |
| Refactoring across multiple files | Yes |
| Single-step actions | No |
| Questions or explanations | No |
| `/btw` side questions | No |
| Trivial fixes | No |

### Task Lifecycle

1. **Create** all tasks before starting work (`TaskCreate`)
2. **Mark `in_progress`** via `TaskUpdate` before starting each task
3. **Mark `completed`** via `TaskUpdate` immediately after finishing each task
4. Work through tasks in order — do not skip
5. Do not start new work while unchecked tasks exist (unless user explicitly pivots)

### Task Granularity

Tasks must be **specific and actionable**, not high-level summaries:

```text
# Good — specific steps
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

### Async Agent taskId

Every async agent call **must** include `taskId`. This is enforced by the subagent tool.

| Scenario | taskId Value | Behavior |
|----------|-------------|----------|
| Agent linked to a task | Task ID (e.g., `"5"`) | Task auto-completes on success |
| Agent not linked to a task | `"-1"` | No auto-completion |

```text
# Linked to task 5 — auto-completes on success
subagent(agent="code-reviewer-quality", task="...", cwd="...",
         async=true, name="Review Quality", taskId="5")

# Not linked to any task
subagent(agent="worker", task="...", cwd="...",
         async=true, name="Qodo Poll", taskId="-1")
```

> **Warning:** Async calls without `taskId` are rejected. Never manually `TaskUpdate` a task to `completed` if it has an async agent — the agent handles it automatically.

### Enforcement

The extension injects reminders if tasks are ignored for 4+ consecutive turns. Tasks persist in the task widget and are injected into every turn context.

## Related Pages

- [Extension Architecture and Lifecycle Hooks](extension-architecture.html)
- [Specialist Agents Reference](agents-reference.html)
- [Running the Automated Code Review Loop](code-review-loop.html)
- [Working with Project Memory](memory-system.html)
- [Command Safety Guards and Enforcement](command-enforcement.html)
