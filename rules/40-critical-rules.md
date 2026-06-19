# Critical Rules

## Questions Are Not Instructions (MANDATORY)

**When the user asks a question, ONLY answer the question.**

- ❌ **DO NOT** modify files, create files, or delete files
- ❌ **DO NOT** run commands that change state (git commit, git push, rm, write, edit)
- ❌ **DO NOT** create branches, open PRs, open issues, or merge anything
- ❌ **DO NOT** "fix" something you noticed while answering
- ❌ **DO NOT** take ANY action beyond reading/searching to formulate the answer
- ✅ **DO** answer the question
- ✅ **DO** use read-only commands (read, bash with grep/cat/ls/rg, memory_search) to find the answer
- ✅ **DO** ask for confirmation before taking action if the answer implies something should be done

**A question mark (?) means ANSWER ONLY.** The user will explicitly tell you to act when they want action.

---

## Task Focus (MANDATORY)

**When executing a multi-step workflow** (e.g., implement → review → commit → push → PR):

- **NEVER abandon the workflow** when the user asks a side question
- Answer the side question, then **IMMEDIATELY resume** the original workflow from where you left off
- Side questions, async agent results, and interruptions do NOT end the current task
- The workflow is complete ONLY when all steps are done (e.g., PR created, issue closed)

❌ **WRONG:** User asks a question mid-workflow → answer → stop (forget the workflow)
✅ **RIGHT:** User asks a question mid-workflow → answer → resume workflow from the next pending step

**After EVERY response, ask yourself:** "Was I in the middle of a workflow? If yes, what's the next step?"

## Parallel Execution (MANDATORY)

**Before EVERY response:** Can operations run in parallel?

- **YES** → Execute ALL in ONE message
- **NO** → PROVE dependency

### Parallel Execution Examples

❌ **WRONG:** Agent1 → wait → Agent2 → wait → Agent3
✅ **RIGHT:** Agent1 + Agent2 + Agent3 in ONE message

Always maximize parallelism. Only execute sequentially when there's a proven dependency between operations.

### Async Agents (MANDATORY)

**ALWAYS use `async: true`** for independent tasks that can run in parallel —
code reviews, opening issues, research, analysis, polling, monitoring,
waiting for builds/CI, and any task where you don't need the result immediately.
Only use sync (default) when the **very next step** depends on this agent's output.

❌ **WRONG:** Spawn 3 sync reviewers → wait for all → respond
✅ **RIGHT:** Spawn 3 async reviewers → end turn → results arrive as follow-up

❌ **WRONG:** `sleep 60 && check status` — blocks the session
✅ **RIGHT:** Spawn async agent → end turn → system delivers result automatically

**After spawning async agents, END YOUR TURN.** Do NOT write bash loops, sleep commands,
or poll for results. The system delivers async results automatically as a follow-up message
that starts a new LLM turn. Your only job is to spawn the agent and stop.
(`fireAndForget: true` agents are silent — no follow-up message is delivered.)

❌ **WRONG:** Spawn async agent → `while true; do sleep 30; check status; done`
❌ **WRONG:** Spawn async agent → `bash("sleep 60 && cat result.json")`
❌ **WRONG:** Spawn async agent → keep talking / checking / waiting in the same turn
✅ **RIGHT:** Spawn async agent → end turn → result arrives as follow-up → process it then

**Kill async agents when their result is no longer needed.**
Don't let them run to completion wasting resources. Use `asyncKill` immediately.

❌ **WRONG:** Re-dispatch to correct cwd → old agent keeps running in the background
✅ **RIGHT:** Kill the old agent → then dispatch the replacement

### Sync Agent Time Estimates (MANDATORY)

**ALWAYS provide `estimatedSeconds`** when spawning sync subagents (single, parallel, or chain).
If the estimated time is **30 seconds or more**, you **MUST use `async: true`** instead.

- **Single sync**: `estimatedSeconds` on the top-level params
- **Parallel sync**: `estimatedSeconds` on each task — max must be < 30s
- **Chain sync**: `estimatedSeconds` on each step — sum must be < 30s
- **Async**: Not required (async agents don't block the session)

The tool enforces this — calls without `estimatedSeconds` or ≥ 30s are rejected.

### Subagent cwd (MANDATORY)

**ALWAYS pass `cwd`** when delegating to subagents — in ALL modes (single, parallel, chain, async).

- Use the project directory when working in the current repo
- Use the target repo path when working in external repos (e.g., `${PROJECT_TMP_DIR}/...`)

❌ **WRONG:** Omit cwd (subagent inherits session cwd, enforcement checks wrong repo)
✅ **RIGHT:** Always pass explicit cwd

---

## Multi-PR / Multi-Branch Work (MANDATORY)

**When working on multiple PRs or branches simultaneously:**

- ❌ **NEVER** switch branches in the main worktree — other agents may be running there
- ✅ **ALWAYS** use `git worktree` for each PR/branch when handling more than one

```bash
# Create a worktree for each PR (inside the repo)
git worktree add .worktrees/pr-42 origin/fix/issue-42
git worktree add .worktrees/pr-43 origin/feat/issue-43

# Work in each directory independently
# When done, clean up
git worktree remove .worktrees/pr-42
```

**Why:** Branch switching in the main worktree corrupts parallel agent work.
Agent A switches to branch X, Agent B thinks it's still on branch Y —
wrong diffs, wrong commits, wrong everything.
Worktrees give each branch its own directory, fully isolated.

---

## User Interaction (MANDATORY)

**When you need user input** (approvals, selections, confirmations):

- ✅ **ALWAYS** use the `ask_user` tool
- ❌ **NEVER** ask questions via plain text in your response

Provide clear, concise options. Include a 'no' or 'cancel' option when appropriate.

---

## Technical Honesty (MANDATORY)

**When the user proposes an idea, approach, or solution:**

- ✅ **Evaluate it critically** — consider if there's a better technical alternative
- ✅ **Present alternatives first** — if you know a better way, say so with clear reasoning before proceeding
- ✅ **Show tradeoffs** — explain pros/cons of the user's approach vs alternatives
- ✅ **Let the user decide** — after presenting alternatives, the user makes the final call
- ❌ **NEVER agree blindly** — "you're right" without evaluation is not helpful
- ❌ **NEVER disagree blindly** — push back only when you have concrete technical reasoning

The user's idea may be the best option — but they should hear alternatives if they exist.
After presenting your analysis, respect the user's decision.

---

## Web Access (MANDATORY)

**When accessing the web:**

- ✅ Use `web_search` tool for research and search queries
- ✅ Use `fetch_content` tool for extracting content from URLs, YouTube, GitHub repos
- ✅ Use `agent-browser` CLI for interactive pages requiring clicks, forms, screenshots
- ❌ **NEVER** use `curl` for reading web pages
- ❌ **NEVER** use SearXNG MCP

---

## External Code Security Audit (MANDATORY)

**Before adopting any external code from an untrusted source:**

1. Obtain the source code (clone repo, download package source, inspect skill files)
2. Delegate a full security audit to `security-auditor`
3. Only proceed if the audit verdict is ✅ SAFE or ⚠️ CAUTION with acceptable risks
4. If ❌ UNSAFE — do not use, inform the user with findings

### What triggers an audit

| Source | Trigger | Audit approach |
|--------|---------|----------------|
| **Git repos** | Adopting external repo/tool/library | Clone to `${PROJECT_TMP_DIR}/`, run `security-auditor` |
| **Pi skills** | `pi skill install`, adding skill files | Clone/download source to `${PROJECT_TMP_DIR}/`, run `security-auditor` |
| **PyPI packages** | `uv add <unknown-pkg>`, `uv run --with <unknown-pkg>` | Clone source repo from PyPI metadata, check install hooks, scan code |
| **npm packages** | `npm install <unknown-pkg>` | Download source, check `postinstall` scripts, scan code |
| **MCP servers** | Adding new server to `mcp.json` | Audit the server source code before adding config |
| **Docker images** | `FROM unknown-registry/image` in Dockerfile | Inspect Dockerfile source, check base image provenance |
| **Remote scripts** | `curl \| bash`, `wget \| sh` | **ALWAYS block** — download first, audit, then run if safe |

### Skip when

- User explicitly says "skip audit" or "I already reviewed it"
- The tool/package is from a trusted source the user has previously approved
- Well-known, widely-used packages (e.g., `requests`, `flask`, `react`, `lodash`)

---

## Temp Files

**ALL temp files MUST go to the project temp dir** (`getProjectTmpDir(cwd)` → `<cwd>/.pi/tmp/`).

- The `.pi/` directory is already gitignored — no risk of committing temp files

NEVER create temp files directly in the project tree — always use `.pi/tmp/` via `getProjectTmpDir()`.

---

## Python Execution with uv

**MANDATORY** - When running arbitrary Python files:

- **ONLY** use `uv run --with <package>` syntax
- **FORBIDDEN** - `uv run pip install` - NEVER use this

### Python uv Examples

✅ **Correct:**

```bash
uv run --with requests script.py
uv run --with requests --with pandas script.py
```

❌ **Wrong:**

```bash
uv run pip install requests
```

The `--with` syntax ensures dependencies are managed per-execution without modifying the environment.

---

## External Git Repository Exploration

**When exploring external Git repositories, clone locally first.**

Clone to `${PROJECT_TMP_DIR}/` and explore using read/bash (find, rg, grep) - NOT via web fetching.

### Clone the Bare Minimum

- ✅ Use `--depth 1` for shallow clone (no history)
- ✅ Use sparse checkout if only specific directories are needed
- ✅ Delete the clone when done if not needed

### Git Clone Examples

✅ **Correct:**

```bash
# Shallow clone to temp directory
git clone --depth 1 https://github.com/org/repo.git ${PROJECT_TMP_DIR}/repo

# Sparse checkout for specific directory only
git clone --depth 1 --filter=blob:none --sparse https://github.com/org/repo.git ${PROJECT_TMP_DIR}/repo
cd ${PROJECT_TMP_DIR}/repo && git sparse-checkout set src/utils

# Clean up when done
rm -rf ${PROJECT_TMP_DIR}/repo
```

❌ **Wrong:**

```bash
# Full clone with history
git clone https://github.com/org/repo.git ${PROJECT_TMP_DIR}/repo

# Using web fetch to browse repository files
fetch_content(https://github.com/org/repo/blob/main/src/file.py)
```

### Private Repositories

For private repositories, ensure authentication is configured:

- **SSH**: `git clone --depth 1 git@github.com:org/private-repo.git ${PROJECT_TMP_DIR}/repo`
- **Credential helper**: Ensure `git config --global credential.helper` is set

Local exploration is faster, more reliable, and provides full file access without web scraping limitations.
