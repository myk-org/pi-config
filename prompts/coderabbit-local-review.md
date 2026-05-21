---
description: "Run CodeRabbit CLI local review — /coderabbit-local-review [--autorabbit] [--base <branch>] [--type uncommitted|committed]"
argument-hint: "[--autorabbit] [--base <branch>] [--base-commit <commit>] [--type <type>] [--config <file>]"
---

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug
> while executing this command — DO NOT work around it silently. Ask the user:
> "Should I create a GitHub issue for this?" Route to:
> `myk-org/pi-config` for prompt/extension issues, or to the relevant tool's repository for CLI issues.
> Do not silently skip steps or apply manual fixes that hide the root cause.

## Raw Arguments

```text
$ARGUMENTS
```

# CodeRabbit Local Review

Run a local CodeRabbit AI code review via `myk-pi-tools coderabbit review`.

## Usage

- `/coderabbit-local-review` — One-shot review: present findings, ask user which to fix
- `/coderabbit-local-review --autorabbit` — Fully automatic loop: review → fix all → re-review → until approved
- `/coderabbit-local-review --base main` — Review against `main` branch
- `/coderabbit-local-review --base-commit abc123` — Review changes since specific commit
- `/coderabbit-local-review --type uncommitted` — Review only uncommitted changes
- `/coderabbit-local-review --type committed` — Review only committed (not pushed) changes
- `/coderabbit-local-review --config custom-rules.yaml` — Pass additional instructions file

`--dir` is automatically set to the current working directory — never pass it explicitly.

## Workflow

### Phase 0: Parse Arguments (MANDATORY — DO NOT SKIP)

Read the **Raw Arguments** section above. Parse as follows:

1. Check if `--autorabbit` appears in the raw arguments
   - YES → autorabbit mode = ON, remove `--autorabbit` from the text
   - NO → autorabbit mode = OFF
2. The remaining text is the cleaned arguments — pass these through to the CLI
3. `--autorabbit` is a **command-level flag** — NEVER pass it to the CLI

### Phase 1: Prerequisites

```bash
uv run myk-pi-tools coderabbit validate
```

If exit code is non-zero, show the error message and **stop here** — do not proceed.

### Phase 2: Build Command

Build: `uv run myk-pi-tools coderabbit review --dir <cwd> [cleaned args]`

**Always include:**

- `--dir <current working directory>`

**Pass through from cleaned arguments:**

| User flag | CLI flag |
|-----------|----------|
| `--base <branch>` | `--base <branch>` |
| `--base-commit <commit>` | `--base-commit <commit>` |
| `--type <type>` | `-t <type>` |
| `--config <file>` | `-c <file>` |

**Note:** The CLI auto-detects `.coderabbit.yaml` in the project root and passes `-c` automatically — do NOT add it manually.

### Phase 3: Execute Review (Async)

**Spawn as async subagent:**

- Agent: `worker`
- Task: `Run: <the exact command from Phase 2> 2>/tmp/pi-work/cr-review.log.
  Return the EXACT raw stdout output — do NOT summarize, interpret, or rephrase it.
  The stderr is redirected to a log file — do NOT read or include it.`
- async: true
- **No timeout** — the CLI handles rate limits with automatic retries. NEVER set a timeout.
- Name: `CodeRabbit Review`

Tell the user:

> 🐰 Running: `<the exact command>`
> CodeRabbit review started in background. Results will appear when complete.

**If autorabbit mode is ON → skip to Phase 6 after dispatching. Do NOT wait for results here.**

### Phase 4: Handle Results (One-Shot Mode Only)

**Skip if autorabbit mode is ON.**

The CLI outputs a single JSON object to stdout:

| Output | Meaning |
|--------|---------|
| `{"findings": [...]}` | Review found issues — present them |
| `{"coderabbit": "approved"}` | No issues found |

If the CLI exits non-zero — stop, show the error to the user, do not continue.

#### Present Findings

If `{"findings": [...]}`, each item has:

- `severity` — critical, major, minor, trivial, info
- `fileName` — file path
- `codegenInstructions` — what to fix
- `suggestions` — code fix snippets

Group by severity:

```text
## 🐰 CodeRabbit Review Results

### ⚠️ Critical ({count})
| File | Issue | Suggestion |
|------|-------|------------|

### 🔶 Major ({count})
### 🔷 Minor ({count})
### 💬 Trivial ({count})
### ℹ️ Info ({count})
```

#### Approved

If `{"coderabbit": "approved"}`:

> 🐰 CodeRabbit review complete — no issues found! ✅

### Phase 5: User Action (One-Shot Mode Only)

**Skip if autorabbit mode is ON.**

Ask the user: do you want me to fix any of these findings?

Options: `all` / `critical only` / `no`

If yes, delegate to appropriate specialist agents passing `codegenInstructions` and `suggestions`.

### Phase 6: Autorabbit Loop (--autorabbit Mode Only)

**Skip if autorabbit mode is OFF.**

🤖 **NO USER INTERACTION. FULLY AUTOMATIC. User kills the async agent to stop.**

#### Loop Flow

```text
┌─────────────────────────────────────────────────────────────────┐
│  Cycle N                                                        │
│                                                                 │
│  1. Spawn worker: Run: uv run myk-pi-tools coderabbit review   │
│     --dir <root> [flags]                                        │
│              ↓                                                  │
│  2. CLI output:                                                 │
│     {"coderabbit":"approved"} ──────────────────────→ DONE      │
│     {"findings":[...]} ─────────────────────────────→ continue  │
│     exit non-zero ──────────────────────────────────→ STOP      │
│              ↓                                                  │
│  3. Fix ALL findings (DO NOT COMMIT)                            │
│     - Delegate to specialist agents by file type                │
│     - Pass codegenInstructions + suggestions                    │
│     - MUST address every finding. Skip ONLY with explicit reason │
│              ↓                                                  │
│  4. Store cycle: uv run myk-pi-tools coderabbit store            │
│     JSON: {"cycle": N, "findings": [{"severity": "...",         │
│       "fileName": "...", "codegenInstructions": "...",          │
│       "action": "fixed"|"skipped", "skipReason": "..."}]}       │
│              ↓                                                  │
│  5. Log: "[autorabbit] Cycle N: fixed {count}. Re-reviewing..." │
│              ↓                                                  │
│  6. Go to step 1                                                │
└─────────────────────────────────────────────────────────────────┘
```

**NO commits between cycles.** All fixes stay uncommitted.

#### Exit and Commit

When loop exits (`{"coderabbit":"approved"}` received):

1. Single commit: `fix: apply CodeRabbit auto-fixes` (stage all changed files)
2. Report:

```text
🐰 CodeRabbit approved! ✅

Cycles: {total_cycles}
Total findings fixed: {total_findings}
Commit: {commit_hash}
```

#### Exit Conditions

1. `{"coderabbit":"approved"}` received from the CLI
2. User kills the async agent

```text
FORBIDDEN exit reasons:
  - "All comments have been addressed"
  - "The same findings keep appearing"
  - "Too many cycles"
  - "An error occurred"
```

#### Status Updates

```text
[autorabbit] Cycle {N}: reviewing...
[autorabbit] Cycle {N}: {count} findings — fixing...
[autorabbit] Cycle {N}: fixes applied. Re-reviewing...
[autorabbit] 🐰 Approved after {N} cycles! Committing...
```
