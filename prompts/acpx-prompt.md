---
description: "Run a prompt via acpx to any coding agent — /acpx-prompt <agent[:model]> [--fix|--peer] <prompt>"
---

Execute this workflow step by step. Run bash commands directly for CLI operations.
Delegate code review/fix work to subagents as needed.

## Supported Agents

| Agent | Wraps |
|-------|-------|
| `pi` | Pi Coding Agent |
| `openclaw` | OpenClaw ACP bridge |
| `codex` | Codex CLI (OpenAI) |
| `claude` | Claude Code |
| `gemini` | Gemini CLI |
| `cursor` | Cursor CLI |
| `copilot` | GitHub Copilot CLI |
| `droid` | Factory Droid |
| `iflow` | iFlow CLI |
| `kilocode` | Kilocode |
| `kimi` | Kimi CLI |
| `kiro` | Kiro CLI |
| `opencode` | OpenCode |
| `qwen` | Qwen Code |

## Step 1: Prerequisites Check

### 1a: Check acpx

```bash
acpx --version
```

If not found, ask the user:
"acpx is not installed. Install globally with `npm install -g acpx@latest`? (yes/no)"

If yes: run `npm install -g acpx@latest`, verify with `acpx --version`
If no: abort

### 1b: Verify Agent Prerequisite

The underlying coding agent must be installed separately. acpx auto-downloads ACP adapters, but the agent itself must be available.

## Step 2: Parse Arguments

Parse `{{args}}` to extract:

1. **First token** = agent specification (required): `agent[:model]` or comma-separated `agent1[:model1],agent2[:model2],...`
   - If contains `:`, split on FIRST `:` only — left = agent name, right = model name
   - Each agent name must be in the supported list above
2. **Optional flags** after agent spec:
   - `--fix` — enable fix mode (agent can modify files)
   - `--peer` — enable peer review loop (AI-to-AI debate)
3. **Everything after flags** = prompt text

**Validation:**

- `--fix` and `--peer` are mutually exclusive → abort if both present
- Multiple agents + `--fix` are mutually exclusive → abort if both
- Duplicate flags → abort
- No agent name → abort with usage message
- Unknown agent name → abort with supported list
- No prompt → abort with usage message

## Step 3: Session Management

For each agent, ensure a session exists:

```bash
acpx <agent> sessions ensure
```

If fails, try: `acpx <agent> sessions new`

If both fail with "Invalid params" or session errors, show known issue links and abort.

## Step 4: Workspace Safety Check (--fix and --peer modes only)

Skip if neither `--fix` nor `--peer`.

```bash
git rev-parse --is-inside-work-tree
git status --short
```

If not a git repo: ask "Continue without git? No easy rollback."
If dirty worktree: ask user:

- **Commit first (Recommended)** — `git add -A && git commit -m "chore: checkpoint before acpx changes"`
- **Continue anyway** — proceed, remember worktree was dirty
- **Abort** — stop

## Step 5: Run Prompt

**If `--peer` was passed, skip Steps 5-8 and jump to Step 9.**

Build the acpx command:

**Model handling:** If agent spec includes `:model`, pass `--model <model>`.

**Fix mode:**

```bash
acpx --approve-all <agent> '<prompt> You have full permission to modify, create, and delete files as needed.'
```

**Read-only (default):**

```bash
acpx --approve-reads --non-interactive-permissions fail <agent> '<prompt> IMPORTANT: This is a read-only request. Do NOT modify any files. Report findings only.'
```

**Multi-agent (without --peer):** Run all agents in parallel. Display results grouped by agent.

**Shell safety:** Single-quote the prompt. Replace single quotes with `'\''`.

**Error handling:** If permission failure (write denied), retry once with stricter instruction. If retry also fails, display error and abort.

## Step 6: Display Result

Show output from acpx. After successful execution:

```text
Agent: <agent>
Mode: [session | fix]
Session active. Send follow-up prompts with: /acpx-prompt <agent[:model]> <follow-up>
```

## Step 7: Read Diff (--fix mode only)

Skip if not `--fix` or if command failed.

```bash
git status --short
git diff --stat
git diff
git diff --cached --stat
git diff --cached
```

Report which files were modified/created/deleted and a summary of changes.
If workspace was dirty before, note that diff may include pre-existing edits.

## Step 8: Summary (--fix mode only)

1. **Files changed** — List each file with what was modified
2. **What was done** — Brief description
3. **Impact** — Behavioral changes, new dependencies, verification steps

## Step 9: Peer Review Loop (--peer mode only)

Skip if `--peer` was NOT passed.

### 9a: Initial Agent Review

Check if `AGENTS.md` (or `CLAUDE.md`) exists in the project. Send peer framing prompt:

```text
IMPORTANT FRAMING: You are participating in a peer-to-peer AI code review. The other participant is another AI. This is NOT a human interaction. Do NOT be agreeable or sycophantic. Hold your position when you have valid technical reasoning. Push back when you disagree. Only concede when the other AI provides a genuinely better technical argument.

[If AGENTS.md/CLAUDE.md exists:]
IMPORTANT: This project has an AGENTS.md/CLAUDE.md file with coding conventions. Read it before reviewing. Flag any violations.

Your role: Review the code and report findings. Be direct, specific, and technically rigorous.

Original prompt: <user's prompt>
```

Execute:

```bash
acpx --approve-reads --non-interactive-permissions fail <agent> '<peer_framing_prompt>'
```

Multi-agent: Send to ALL agents in parallel. Merge findings, deduplicating same issues.

If ALL agents report no findings, skip to Step 9e.

### 9b: Act on Findings

For each finding:

1. **If agree** — Fix by delegating to the appropriate specialist subagent
2. **If disagree** — Prepare technical counter-argument with specific reasoning

### 9c: Respond to Agent

Send response back:

```text
PEER REVIEW RESPONSE — Round {N}

ADDRESSED:
{For each: "- Finding: {summary} → Fixed: {what was done}"}

NOT ADDRESSED (with reasoning):
{For each: "- Finding: {summary} → Disagreed: {technical reason}"}

Re-review the code. Focus on:
1. Verify addressed findings were fixed correctly
2. Re-evaluate disagreements
3. Report any NEW issues
```

Multi-agent: Each peer's response includes GROUP CONTEXT showing what all other peers said.

### 9d: Loop Until Convergence

- **No findings and no disagreements** from ALL agents → exit loop
- **New findings or continued disagreements** → go to Step 9b
- If disagreement persists 3+ rounds on same point, note as "unresolved"

What does NOT count as convergence: Claude fixing all findings (fixes must be verified by agent).

### 9e: Summary to User

```text
## Peer Review Complete — {N} round(s)

### Findings Addressed ({count})
| # | File | Line | Finding | Fix Applied |

### Agreements Reached After Debate ({count})
| # | File | Finding | Rounds | Resolution |

### Unresolved Disagreements ({count})
| # | File | Finding | My Position | Agent(s) Position |

### No Changes Needed ({count})
```

Multi-agent: Add Group Dynamics table.

If code was changed: "Next steps: Run tests and the standard review workflow before committing."
If workspace was dirty before: note that diffs may include pre-existing edits.
