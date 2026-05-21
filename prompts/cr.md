---
description: "Run CodeRabbit CLI review — /cr [--autorabbit] [--base <branch>] [--type uncommitted|committed]"
argument-hint: "[--autorabbit] [--base <branch>] [--base-commit <commit>] [--type <type>] [--config <file>]"
---

## Raw Arguments

```text
$ARGUMENTS
```

# CodeRabbit CLI Review

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug
> while executing this command — DO NOT work around it silently. Ask the user:
> "Should I create a GitHub issue for this?" Route to:
> `myk-org/pi-config` for prompt/extension issues, or to the relevant tool's repository for CLI issues.
> Do not silently skip steps or apply manual fixes that hide the root cause.

Run a local CodeRabbit AI code review using the `cr` CLI in agent mode.
Results are parsed and presented as structured review findings.

## Usage

- `/cr` — One-shot review: present findings, ask user which to fix
- `/cr --autorabbit` — Fully automatic loop: review → fix all → re-review → until approved
- `/cr --base main` — Review against `main` branch
- `/cr --base-commit abc123` — Review changes since specific commit
- `/cr --type uncommitted` — Review only uncommitted changes
- `/cr --type committed` — Review only committed (not pushed) changes
- `/cr --config .coderabbit.yaml` — Pass additional instructions file

## Workflow

### Phase 0: Parse Arguments (MANDATORY — DO NOT SKIP)

Read the **Raw Arguments** section above. Parse as follows:

1. Check if `--autorabbit` appears in the raw arguments
2. If YES: set autorabbit mode = ON, remove `--autorabbit` from the text.
   The remaining text (if any) is the cleaned arguments.
3. If NO: autorabbit mode = OFF, the entire raw arguments text is the cleaned arguments.
4. Use ONLY the cleaned arguments for all subsequent CLI calls.
5. `--autorabbit` is a **command-level flag**, NOT a `cr` CLI argument.
   **NEVER** pass `--autorabbit` to `cr review`.

### Phase 1: Prerequisites

#### Step 1: Check `cr` is installed

```bash
cr --version
```

If not found, tell the user:

> CodeRabbit CLI (`cr`) is not installed. Install it:
>
> ```bash
> curl -fsSL https://cli.coderabbit.ai/install.sh | sh
> ```

#### Step 2: Check authentication

```bash
cr auth status 2>&1
```

If not authenticated, tell the user:

> Not authenticated with CodeRabbit. Run:
>
> ```bash
> cr auth login
> ```

If either check fails, **stop here** — do not proceed.

### Phase 2: Build Command

Build the `cr review` command from the cleaned arguments (Phase 0).

**Always include these flags:**

- `--agent` — structured JSON output (MANDATORY, never omit)
- `--dir <project-root>` — the current working directory / project root

**Parse cleaned arguments for optional flags:**

| Flag | Pass through to `cr review` |
|------|-----------------------------|
| `--base <branch>` | `--base <branch>` |
| `--base-commit <commit>` | `--base-commit <commit>` |
| `--type <type>` | `-t <type>` (values: `all`, `committed`, `uncommitted`) |
| `--config <file>` | `-c <file>` |

**Blocked flags (NEVER pass through):**

- `--interactive` — blocked, we always use `--agent`
- `--plain` — blocked, we always use `--agent`
- `--autorabbit` — command-level flag, not a `cr` CLI flag

**Example commands:**

```bash
# Default: review all changes
cr review --agent --dir /path/to/project

# With base branch
cr review --agent --dir /path/to/project --base main

# Only uncommitted
cr review --agent --dir /path/to/project -t uncommitted

# With base commit
cr review --agent --dir /path/to/project --base-commit abc1234
```

### Phase 3: Execute Review (Async)

**Dispatch the review as an async subagent.**

Delegate to a `worker` agent with this task:

```text
Run the following command and return the EXACT raw stdout output.
Do NOT summarize, interpret, or rephrase the output.

<the cr review command from Phase 2>
```

- `async: true`
- Name: `CodeRabbit Review`

Tell the user:

> 🐰 CodeRabbit review started in background. Results will appear when complete.

**If autorabbit mode is ON, skip to Phase 6 (Autorabbit Loop) after
dispatching the first review. Do NOT wait for results here.**

### Phase 4: Handle Results (One-Shot Mode Only)

**Skip this phase if autorabbit mode is ON.**

When the async agent returns, parse the output.

**The `--agent` flag outputs one JSON object per line.** Parse each line as JSON.

#### Event types

| `type` | Handling |
|--------|----------|
| `finding` | Collect — these are the review comments |
| `review_context` | Log for context |
| `status` | Log progress |
| `complete` | Review finished |
| `error` | Check for rate limit or report error |

#### Rate Limit Handling

If any `error` event mentions rate limit:

1. Extract the wait time from the error message
2. Tell the user: "CodeRabbit rate-limited. Will retry in X minutes."
3. Spawn another async worker that sleeps for the wait time + 30 seconds,
   then re-runs the same `cr review` command
4. Present results when the retry completes

**Never cap retries.** The async agent runs until it succeeds or the user kills it.

#### Present Findings

Group findings by severity and present as a table:

```text
## 🐰 CodeRabbit Review Results

### ⚠️ Critical ({count})

| File | Line | Issue | Suggestion |
|------|------|-------|------------|
| src/foo.py | 42 | Race condition detected | Use mutex lock |

### 🔶 Major ({count})

| File | Line | Issue | Suggestion |
|------|------|-------|------------|
| ... | ... | ... | ... |

### 🔷 Minor ({count})

...

### 💬 Trivial ({count})

...

### ℹ️ Info ({count})

...
```

**For each finding, use these fields from the JSON:**

- `fileName` — file path
- `severity` — critical, major, minor, trivial, info
- `codegenInstructions` — what to fix (show as "Suggestion")
- `suggestions` — code fix snippets

#### No Findings

If the review completes with zero findings:

> 🐰 CodeRabbit review complete — no issues found! ✅

### Phase 5: User Action (One-Shot Mode Only)

**Skip this phase if autorabbit mode is ON.**

After presenting findings, ask the user:

> Do you want me to fix any of these findings?

Options:

- `all` — fix all findings
- `critical` — fix only critical/major
- `no` — just informational, don't fix

If the user wants fixes, delegate to appropriate specialist agents
based on file types, passing the `codegenInstructions` and `suggestions`
from each finding.

### Phase 6: Autorabbit Loop (--autorabbit Mode Only)

**Skip this phase if autorabbit mode is OFF.**

🤖 **ABSOLUTE RULE: NO USER INTERACTION DURING THE AUTORABBIT LOOP.**

**NEVER call AskUserQuestion during Phase 6. NEVER present options,
dialogs, choices, or questions to the user. The loop is FULLY AUTOMATIC.
The ONLY way the user stops the loop is by killing the async agent.**

#### Loop Flow

```text
┌─────────────────────────────────────────────────────────────────┐
│  Cycle N                                                        │
│                                                                 │
│  1. Run `cr review --agent --dir <root>` (+ user flags)         │
│              ↓                                                  │
│  2. Parse findings from JSON output                             │
│              ↓                                                  │
│  3. Zero findings? ──YES──→ DONE (approved!) — exit loop        │
│              │                                                  │
│             NO                                                  │
│              ↓                                                  │
│  4. Fix ALL findings automatically                              │
│     - Group by file type                                        │
│     - Delegate to appropriate specialist agents                 │
│     - Pass codegenInstructions + suggestions from each finding  │
│              ↓                                                  │
│  5. Commit fixes: "fix: address CodeRabbit review (cycle N)"    │
│              ↓                                                  │
│  6. Log status: "[autorabbit] Cycle N: fixed {count} findings.  │
│     Re-reviewing..."                                            │
│              ↓                                                  │
│  7. Go to step 1 (next cycle)                                   │
└─────────────────────────────────────────────────────────────────┘
```

#### Rate Limit During Autorabbit

If rate-limited during the loop:

1. Log: `[autorabbit] Rate-limited. Waiting {minutes} minutes...`
2. Sleep for the wait time + 30 seconds
3. Retry the review (same cycle)
4. **Never stop on rate limit — always wait and retry.**

#### Exit Conditions

The loop MUST run until one of these conditions is met:

1. **Zero findings** — CodeRabbit returns no findings. Exit and report success.
2. **User kills the async agent** — user explicitly stops it.

**No other reason is valid to exit the loop.**

```text
VIOLATION — The following rationalizations are FORBIDDEN reasons to exit:

  - "All comments have been addressed"
  - "The same findings keep appearing"
  - "The loop seems stuck"
  - "Too many cycles"
  - "An error occurred"
  - Any variation of the AI deciding there is no more work to do
```

If any command fails, log the error, wait 1 minute, and retry.
Errors are recoverable — NEVER treat a command failure as a reason to exit.

#### Completion Report

When the loop exits with zero findings:

```text
🐰 CodeRabbit approved! ✅

Cycles: {total_cycles}
Total findings fixed: {total_findings}
Commits: {list of commit hashes}
```

#### Status Updates

Each cycle displays a status update:

```text
[autorabbit] Cycle {N}: reviewing...
[autorabbit] Cycle {N}: {count} findings — fixing...
[autorabbit] Cycle {N}: fixes committed. Re-reviewing...
[autorabbit] Rate-limited. Waiting {minutes} minutes...
[autorabbit] 🐰 Approved after {N} cycles! No findings.
```
