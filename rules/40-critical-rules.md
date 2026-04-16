# Critical Rules

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
✅ **RIGHT:** Spawn 3 async reviewers → continue → results surface when complete

❌ **WRONG:** `sleep 60 && check status` — blocks the session
✅ **RIGHT:** Spawn async agent to poll and notify when done

### Subagent cwd (MANDATORY)

**ALWAYS pass `cwd`** when delegating to subagents — in ALL modes (single, parallel, chain, async).

- Use the project directory when working in the current repo
- Use the target repo path when working in external repos (e.g., `/tmp/pi-work/...`)

❌ **WRONG:** Omit cwd (subagent inherits session cwd, enforcement checks wrong repo)
✅ **RIGHT:** Always pass explicit cwd

---

## User Interaction (MANDATORY)

**When you need user input** (approvals, selections, confirmations):

- ✅ **ALWAYS** use the `ask_user` tool
- ❌ **NEVER** ask questions via plain text in your response

Provide clear, concise options. Include a 'no' or 'cancel' option when appropriate.

---

## Web Access (MANDATORY)

**When accessing the web:**

- ✅ Use `web_search` tool for research and search queries
- ✅ Use `fetch_content` tool for extracting content from URLs, YouTube, GitHub repos
- ✅ Use `agent-browser` CLI for interactive pages requiring clicks, forms, screenshots
- ❌ **NEVER** use `curl` for reading web pages
- ❌ **NEVER** use SearXNG MCP

---

## External Repo Security Audit (MANDATORY)

**Before adopting any external repository, tool, or library:**

1. Clone to `/tmp/pi-work/`
2. Delegate a full security audit to `security-auditor`
3. Only proceed if the audit verdict is ✅ SAFE or ⚠️ CAUTION with acceptable risks
4. If ❌ UNSAFE — do not use, inform the user with findings

**This applies to:**

- CLI tools being considered for installation
- Libraries being evaluated for integration
- External extensions or plugins
- Any third-party code that will run in our environment

**Skip when:**

- User explicitly says "skip audit" or "I already reviewed it"
- The tool is from a trusted source the user has previously approved

---

## Temp Files

**ALL temp files MUST go to `/tmp/pi-work/`** - NEVER create temp files in project directory.

This keeps the project directory clean and prevents accidental commits of temporary files.

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

Clone to `/tmp/pi-work/` and explore using read/bash (find, rg, grep) - NOT via web fetching.

### Clone the Bare Minimum

- ✅ Use `--depth 1` for shallow clone (no history)
- ✅ Use sparse checkout if only specific directories are needed
- ✅ Delete the clone when done if not needed

### Git Clone Examples

✅ **Correct:**

```bash
# Shallow clone to temp directory
git clone --depth 1 https://github.com/org/repo.git /tmp/pi-work/repo

# Sparse checkout for specific directory only
git clone --depth 1 --filter=blob:none --sparse https://github.com/org/repo.git /tmp/pi-work/repo
cd /tmp/pi-work/repo && git sparse-checkout set src/utils

# Clean up when done
rm -rf /tmp/pi-work/repo
```

❌ **Wrong:**

```bash
# Full clone with history
git clone https://github.com/org/repo.git /tmp/pi-work/repo

# Using web fetch to browse repository files
fetch_content(https://github.com/org/repo/blob/main/src/file.py)
```

### Private Repositories

For private repositories, ensure authentication is configured:

- **SSH**: `git clone --depth 1 git@github.com:org/private-repo.git /tmp/pi-work/repo`
- **Credential helper**: Ensure `git config --global credential.helper` is set

Local exploration is faster, more reliable, and provides full file access without web scraping limitations.
