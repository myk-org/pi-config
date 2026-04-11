---
description: Run a prompt via acpx to any supported coding agent
---

# acpx Multi-Agent Prompt Command

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug
> while executing this command — DO NOT work around it silently. Ask the user:
> "Should I create a GitHub issue for this?" Route to:
> `myk-org/pi-config` for plugin/command spec issues,
> `openclaw/acpx` for acpx CLI issues.
> Do not silently skip steps or apply manual fixes that hide the root cause.

Run a prompt through [acpx](https://github.com/openclaw/acpx) to any ACP-compatible coding agent.

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

## Usage

- `/acpx-prompt codex fix the tests`
- `/acpx-prompt cursor review this code`
- `/acpx-prompt gemini explain this function`
- `/acpx-prompt codex:o3-pro review the architecture`
- `/acpx-prompt codex --fix fix the code quality issues`
- `/acpx-prompt codex:gpt-4o --fix fix the code quality issues`
- `/acpx-prompt gemini --peer review this code`
- `/acpx-prompt cursor:gpt-4o,claude:sonnet --peer review the architecture`
- `/acpx-prompt cursor,codex review this code`
- `/acpx-prompt cursor,gemini,codex --peer review the architecture`

## Workflow

### Step 1: Prerequisites Check

#### 1a: Check acpx

```bash
acpx --version
```

If not found, ask the user via AskUserQuestion:

"acpx is not installed. It provides structured access to multiple coding agents (Codex, Cursor, Gemini, etc.) via the Agent Client Protocol.

Install it now?"

Options:

- **Yes (Recommended)** — Install globally with `npm install -g acpx@latest`
- **No** — Abort

If user selects Yes, run:

```bash
npm install -g acpx@latest
```

Verify installation:

```bash
acpx --version
```

If installation fails, display the error and abort.

#### 1b: Verify Agent Prerequisite

The underlying coding agent must be installed separately. acpx auto-downloads ACP adapters, but the agent itself (e.g., Codex CLI, Cursor CLI) must be available.

### Step 2: Parse Arguments

Parse `{{args}}` to extract the agent name(s) and prompt:

1. The **first token** is the agent specification (required). Format:
   `agent[:model]` or comma-separated `agent1[:model1],agent2[:model2],...`
   Each agent name must be one of the supported agents listed above.
   The optional `:model` suffix selects a specific model for that agent.
2. After the agent specification, consume optional flags:
   - `--fix` — enable fix mode (agent can modify files)
   - `--peer` — enable peer review loop (AI-to-AI debate)
3. Everything after flags is the prompt text.

**Agent:model parsing:**

Split the first token by commas to get individual agent specs. For each spec:

- If it contains `:`, split on the FIRST `:` only — left side is agent name,
  right side is model name (model names may contain colons, e.g., `openai:gpt-4o`)
- If no `:`, the agent name is the full spec and no model override is used

**Flag validation:**

- `--fix` and `--peer` are **mutually exclusive**. If both are passed,
  abort with: "`--fix` and `--peer` cannot be used together."
- Multiple agents and `--fix` are **mutually exclusive**. If more than one
  agent is specified with `--fix`, abort with:
  "`--fix` can only be used with a single agent."
- If `--fix` appears more than once, abort with: "Duplicate --fix flag."
- If `--peer` appears more than once, abort with: "Duplicate --peer flag."

If no agent name is provided, abort with:
"No agent specified. Usage: `/acpx-prompt <agent[:model]>[,agent2[:model2],...] [--fix | --peer] <prompt>`

Supported agents: pi, openclaw, codex, claude, gemini, cursor, copilot, droid, iflow, kilocode, kimi, kiro, opencode, qwen"

If an agent name is not recognized, abort with:
"Unknown agent: `<name>`. Each agent in a comma-separated list
must be recognized. Supported agents: pi, openclaw, codex, claude,
gemini, cursor, copilot, droid, iflow, kilocode, kimi, kiro,
opencode, qwen"

If no prompt is provided after the agent name, abort with:
"No prompt provided. Usage: `/acpx-prompt <agent[:model]>[,agent2[:model2],...] [--fix | --peer] <prompt>`"

### Step 3: Session Management

Ensure a session exists for the current directory:

**Multi-agent:** Run `sessions ensure` for each agent in the list.

```bash
acpx <agent> sessions ensure
```

If this fails, try creating a new session:

```bash
acpx <agent> sessions new
```

If session creation also fails, check the error output:

- If the error contains "Invalid params" or "session" and "not found", display:

  "acpx session management failed for `<agent>`. This is a known issue — see:
  - <https://github.com/openclaw/acpx/issues/152>
  - <https://github.com/openclaw/acpx/issues/161>"

  Display the error and abort.

- For any other error, display the error and abort.

### Step 4: Workspace Safety Check (--fix and --peer modes)

**Skip this step if neither --fix nor --peer was passed.**

Before running in fix or peer mode, inspect the workspace state.

```bash
git rev-parse --is-inside-work-tree
git status --short
```

Follow this decision process:

1. If the current directory is not a Git repository, ask the user via
   AskUserQuestion:
   "This directory is not a Git repository. Continue anyway?
   I won't be able to show a git diff or provide an easy rollback point."
2. If the current directory is a Git repository and `git status --short`
   shows any output (modified, staged, or untracked files), ask the user via
   AskUserQuestion with the following options (in this order):
   - **Commit first (Recommended)** — Create a checkpoint commit of the
     current changes before proceeding, so the agent's changes are
     cleanly isolated
   - **Continue anyway** — Proceed despite uncommitted changes; the final
     diff summary may include pre-existing edits
   - **Abort** — Stop here to handle changes manually
3. Handle the response:
   - **Commit first**: Stage all changes with `git add -A` and create a
     checkpoint commit with the message `chore: checkpoint before acpx changes`.
     After the commit, verify with `git status --porcelain -z` that the
     output is empty (workspace is clean) before proceeding. If the commit
     fails or the workspace is still dirty, display the raw output and abort.
   - **Continue anyway**: Proceed and remember the workspace was dirty.
   - **Abort**: Stop immediately.
4. If the user declines the non-git prompt from step 1, abort.
5. If proceeding despite a dirty worktree (via **Continue anyway**),
   remember that state so Steps 7-8 (`--fix`) or Step 9e (`--peer`)
   can warn that diffs may include pre-existing edits.

### Step 5: Run Prompt

**If `--peer` was passed, skip Steps 5-8 and jump to Step 9 (Peer Review Loop).**

Build and execute the acpx command.

**Model handling:** If the agent spec includes a `:model` suffix (e.g., `codex:gpt-4o`),
pass it to acpx with `--model <model>`. Otherwise, omit the `--model` flag.

**Fix mode:**

```bash
acpx --approve-all <agent> '<prompt>'
acpx --approve-all <agent> --model <model> '<prompt>'
```

**Read-only prompt guard (non-fix mode):**

When `--fix` is NOT passed, append to the user's prompt:

```text
IMPORTANT: This is a read-only request. Do NOT modify, create, or
delete any files. Report your findings only.
```

In fix mode, append to the user's prompt:

```text
You have full permission to modify, create, and delete files as needed.
Make all necessary changes directly.
```

**Session mode (persistent, default):**

```bash
acpx --approve-reads --non-interactive-permissions fail <agent> '<prompt>'
acpx --approve-reads --non-interactive-permissions fail <agent> --model <model> '<prompt>'
```

**Permissions summary:**

| Mode | Flag | Description |
|------|------|-------------|
| Default | `--approve-reads --non-interactive-permissions fail` | Agent can read files only, writes blocked |
| Fix (`--fix`) | `--approve-all` | Agent can read and write files |

**Multi-agent execution:**

When multiple agents are specified (without `--peer`), run all agents **in parallel**:

- Send the same prompt to each agent simultaneously
- Each agent uses its own model override if specified via `:model`
- Collect results from all agents
- Display results grouped by agent:

```text
## Results from <agent1>:
<agent1 output>

## Results from <agent2>:
<agent2 output>
```

**Shell safety:** Single-quote the prompt to prevent shell expansion. Replace any single quotes in the prompt with `'\''` before interpolation.

**Error handling:**

If the command exits with a non-zero code:

- If the error indicates a **permission failure** (write denied, permission
  rejected, or similar), this means the agent attempted to modify files
  without `--fix` mode. Retry the prompt once with a stricter instruction
  appended:

  ```text
  CRITICAL: You are NOT allowed to modify any files. Your previous
  attempt was blocked because you tried to write files. This is a
  read-only review. Report findings as text only. Do NOT use any
  file modification tools.
  ```

  If the retry also fails with a permission error, display the error
  and abort.

- For any other error, display the raw output as an error.

### Step 6: Display Result

Display the output from acpx to the user. acpx formats output as a readable stream with tool updates by default.

After successful execution, display:

```text
Agent: <agent>
Mode: [session | fix]
```

If in session mode, also show:

```text
Session active. Send follow-up prompts with: /acpx-prompt <agent[:model]> <follow-up>
```

### Step 7: Read Diff (--fix mode only)

**Skip this step if --fix was NOT passed or if the command failed.**

After the agent completes in fix mode, inspect what changed:

```bash
git status --short
git diff --stat
git diff
git diff --cached --stat
git diff --cached
```

If the diff is too large (over ~200 lines), use `--stat` summary only.

If the workspace was already dirty before running, note that the diff
may include pre-existing edits.

Report to the user:

- Which files were modified/created/deleted
- A summary of the changes
- Verify suggestion: what command to run to confirm changes work

### Step 8: Summary (--fix mode only)

**Skip this step if --fix was NOT passed or if the command failed.**

Present a clear summary:

1. **Files changed** — List each file with what was modified
2. **What was done** — Brief description in plain language
3. **Impact** — Behavioral changes, new dependencies, verification steps

### Step 9: Peer Review Loop (--peer mode only)

**Skip this step if --peer was NOT passed.**

Claude orchestrates an AI-to-AI debate loop with the target agent(s) until
all participants agree on the code. When multiple agents are specified,
each agent reviews independently in parallel, and Claude evaluates the
merged findings.

**CRITICAL RULE: Only the peer agent(s) can end the loop.** Claude fixing
code does NOT count as convergence. After EVERY fix round, Claude MUST
send the fixes back to the peer agent(s) (Step 9c) for re-review. The loop
ends ONLY when each peer agent confirms no remaining issues. With multiple
peers, ALL peer agents must agree before the loop exits.

#### 9a: Initial Agent Review

Initialize a round counter at 1. Use the current counter value in the Step 9c
response template (`Round {N}`), then increment the counter after sending.

Before sending the peer framing prompt, check if `AGENTS.md` exists
in the project. If it does, include the AGENTS.md convention block
in the framing prompt. If `AGENTS.md` does not exist, omit that
block from the prompt.

Send the first prompt to the agent with peer review framing:

**If `AGENTS.md` exists:**

```text
IMPORTANT FRAMING: You are participating in a peer-to-peer AI code
review. The other participant is another AI (Claude). This is NOT a
human interaction. Do NOT be agreeable or sycophantic. Hold your
position when you have valid technical reasoning. Push back when you
disagree. Only concede a point when the other AI provides a genuinely
better technical argument.

IMPORTANT: This project has a AGENTS.md file with coding conventions
and project guidelines. Read it before reviewing. Flag any violations
of those conventions as findings.

Your role: Review the code and report findings. Be direct, specific,
and technically rigorous. For each finding, explain WHY it matters and
provide a concrete fix or suggestion.

Original prompt: <user's prompt>
```

**If `AGENTS.md` does NOT exist:**

```text
IMPORTANT FRAMING: You are participating in a peer-to-peer AI code
review. The other participant is another AI (Claude). This is NOT a
human interaction. Do NOT be agreeable or sycophantic. Hold your
position when you have valid technical reasoning. Push back when you
disagree. Only concede a point when the other AI provides a genuinely
better technical argument.

Your role: Review the code and report findings. Be direct, specific,
and technically rigorous. For each finding, explain WHY it matters and
provide a concrete fix or suggestion.

Original prompt: <user's prompt>
```

Execute via acpx:

```bash
acpx --approve-reads --non-interactive-permissions fail <agent> '<peer_framing_prompt>'
acpx --approve-reads --non-interactive-permissions fail <agent> --model <model> '<peer_framing_prompt>'
```

Do NOT display intermediate results to the user.
If the command fails, abort the peer loop and report the error.

**Multi-agent:** Send the peer framing prompt to ALL agents in parallel.
Collect and merge findings from all agents, deduplicating where the same
issue is raised by multiple agents.

**Multi-agent group context:** In the first round, each agent reviews
independently (no group context yet). Their individual responses are
collected for use in subsequent rounds.

If ALL agents report no findings, skip to Step 9e.
If only SOME agents report no findings, continue to Step 9b with the findings
from agents that did report issues. Agents that reported no findings still
participate in subsequent rounds via GROUP CONTEXT.

#### 9b: Claude Acts on Findings

For each finding from the agent(s):

1. **Evaluate the finding** — Does Claude agree it's a valid issue?
2. **If Claude agrees** — Fix the code by delegating to the
   appropriate specialist agent (follow the normal agent routing rules).
3. **If Claude disagrees** — Prepare a technical counter-argument
   explaining WHY the finding is not valid, not applicable, or would
   cause other issues.

**Rules for disagreement:**

- Claude MUST provide specific technical reasoning, not just "I disagree"
- Reference the actual code, explain trade-offs, cite patterns or conventions
- If the project has established conventions (AGENTS.md, etc.) that
  support Claude's position, cite them explicitly
- Claude should be open to changing its mind if the agent makes a good
  point in the next round

**Multi-agent:** Merge and deduplicate findings from all agents. When the
same issue is raised by multiple agents, keep the most actionable version
and note which agents flagged it.

**After completing all fixes and counter-arguments, proceed to Step 9c.
This is MANDATORY — do NOT skip to the summary.**

#### 9c: Claude Responds to Agent

After acting on all findings, send a response back to the agent:

```text
PEER REVIEW RESPONSE — Round {N}

IMPORTANT FRAMING: You are in an ongoing peer-to-peer AI code review
with another AI (Claude). This is NOT a human interaction. Do NOT back
down from valid technical positions just to be agreeable.

Here is what I (Claude) did with your findings:

ADDRESSED:
{For each addressed finding:
  "- Finding: {summary} → Fixed: {what was done}"}

NOT ADDRESSED (with reasoning):
{For each disagreement:
  "- Finding: {summary} → Disagreed: {technical reason}"}

Please re-review the code. Focus on:
1. Verify that addressed findings were fixed correctly
2. Re-evaluate your positions on the disagreements
3. Report any NEW issues you find in the updated code.
```

**Multi-agent group context:** When multiple peers are involved, each
peer's response MUST include what ALL other peers said. Append a
"GROUP CONTEXT" section to the response for each peer:

```text
GROUP CONTEXT — What other peers said in Round {N}:

{For each OTHER peer (not the recipient):
  "## {peer_name} (model: {model}) findings:
  {summary of that peer's findings and positions}
  "}

Always include the model when the agent was invoked with a `:model` override.
If no model was specified, omit the model parenthetical (e.g., `## cursor findings:`).
```

This enables a true group conversation where every peer has full
visibility into the discussion. Each peer can agree, disagree, or
build on other peers' findings.

When sending to peer A, include findings from peers B, C, etc.
When sending to peer B, include findings from peers A, C, etc.

Execute via acpx (same command pattern). Do NOT display intermediate results.

**Multi-agent:** Send the response to ALL agents in parallel. Each agent
re-reviews independently.

#### 9d: Loop Until Convergence

Parse each agent's response:

- **No findings and no remaining disagreements** — All AIs agree. Exit loop.
- **New findings or continued disagreements** — Go to Step 9b.

**Convergence criteria (checked ONLY from each peer agent's response in Step 9c):**

- All agents explicitly state no remaining issues, OR
- All agents' responses contain no actionable findings (only acknowledgments)

**What does NOT count as convergence:**

- Claude fixing all findings (fixes must be verified by the agent)
- Claude agreeing with all findings (the agent must confirm the fixes are correct)
- A single round completing (minimum: agent reviews → Claude fixes → agent re-reviews)

**Multi-agent convergence:** When multiple peers are involved, convergence
requires ALL peers to independently confirm no remaining issues. If peer A
agrees but peer B still has findings, the loop continues. A single peer
cannot end the loop for the group.

**Claude's behavior across rounds:**

- Claude SHOULD change its mind when a peer agent provides a better argument
- Claude SHOULD NOT stubbornly hold a position just to "win"
- If a disagreement persists for 3+ rounds on the same point, note it as
  "unresolved disagreement" and move on

#### 9e: Summary to User

After the loop exits, present a comprehensive summary:

```text
## Peer Review Complete — {N} round(s)

Agent(s): <agent>[, <agent2>, ...]

### Findings Addressed ({count})

| # | File | Line | Finding | Fix Applied |
|---|------|------|---------|-------------|
| 1 | src/foo.py | 42 | Missing null check | Added guard clause |

### Agreements Reached After Debate ({count})

| # | File | Finding | Rounds | Resolution |
|---|------|---------|--------|------------|
| 1 | src/baz.py | Error swallowing | 2 | Claude conceded, added logging |

### Unresolved Disagreements ({count})

| # | File | Finding | Claude's Position | Agent(s) Position |
|---|------|---------|-------------------|------------------|
| 1 | src/qux.py | Naming convention | Follows project style | Prefers stdlib convention |

### No Changes Needed ({count})

Items where the agent initially flagged but later agreed no change was needed.
```

**Summary rules:**

- **Always use tables** — consistent format
- **Show both sides** for unresolved disagreements
- **Include round count** for debated items
- **Next steps reminder** — If any code was changed, end with:
  "Next steps: Run tests and the standard review workflow before committing."
- **Dirty worktree warning** — If the workspace was already dirty before
  the peer review, note: "Workspace had pre-existing changes; resulting
  diffs may include edits not made during this peer review."

**Multi-agent group summary:** When multiple peers participated, add a
section showing the group dynamics:

```text
### Group Dynamics

| Finding | Raised By | Agreed By | Resolution |
|---------|-----------|-----------|------------|
| Missing null check | cursor | claude, codex | All agreed, fixed |
| Naming convention | codex | — | Only codex flagged, Claude disagreed, codex conceded |
```
