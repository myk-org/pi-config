---
description: "Run a prompt via ai-cli-runner to any AI CLI (cursor, claude, gemini). Full model access including all variants. Use for peer review, code review, or any task — /external-ai <agent> [--model <model>] [--fix|--peer|--resume] <prompt>"
argument-hint: "<agent> [--model <model>] [--fix|--peer|--resume] <prompt>"
---

## Raw Arguments

```text
$ARGUMENTS
```

# ai-cli-runner Multi-Agent Prompt Command

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug
> while executing this command — DO NOT work around it silently. Ask the user:
> "Should I create a GitHub issue for this?" Route to:
> `myk-org/pi-config` for plugin/command spec issues,
> `myk-org/ai-cli-runner` for ai-cli-runner package issues.
> Do not silently skip steps or apply manual fixes that hide the root cause.

🚨 **CRITICAL: NEVER set a timeout on AI CLI execution commands** (Step 5 and Step 9).
External agents can take minutes to complete (reading files, thinking, multi-step tool calls).
Any bash call running an AI CLI prompt MUST NOT include a timeout parameter. Let it run
until it finishes. Quick probes (`--version`, model listing) may use bounded timeouts (e.g., 30s).

Run a prompt through [ai-cli-runner](https://github.com/myk-org/ai-cli-runner) which calls
AI CLI tools directly via subprocess — giving full model access including all variants
(reasoning levels, fast mode, context sizes).

## Supported Providers

| Provider | Binary | Notes |
|----------|--------|-------|
| `cursor` | `agent` | `--print` for non-interactive, `--workspace` for cwd |
| `claude` | `claude` | `-p` for non-interactive print mode |
| `gemini` | `gemini` | Stdin prompt |

For other providers (codex, copilot, droid, kiro, etc.), use `/acpx-prompt` instead.

## Usage

- `/external-ai cursor fix the tests`
- `/external-ai claude review this code`
- `/external-ai gemini explain this function`
- `/external-ai cursor --model gpt-5.4-high review the architecture`
- `/external-ai cursor --model claude-4.6-opus-max-thinking --fix fix the code`
- `/external-ai cursor --fix fix the code quality issues`
- `/external-ai cursor --peer review this code`
- `/external-ai cursor --model gpt-5.4-xhigh --peer review the architecture`
- `/external-ai cursor,claude review this code`
- `/external-ai cursor --resume explain the last change`
- `/external-ai cursor --model gpt-5.4-high --resume continue reviewing`
- `/external-ai claude --resume what about the edge cases?`
- `/external-ai review this code` — uses last saved agent from `.pi/external-ai-config.json`
- `/external-ai --peer review this` — uses last saved peers from `.pi/external-ai-config.json`

## Workflow

### Step 1: Prerequisites Check

```bash
myk-pi-tools --version
```

If not found, prompt to install: `uv tool install myk-pi-tools`

### Step 2: Parse Arguments

Read the **Raw Arguments** section above. Tokenize by whitespace and parse as follows:

1. **Consume flags** — strip `--fix`, `--peer`, `--resume`, and `--model <value>` from the token stream.
   `--model` consumes the NEXT token as the model value.
2. **Detect agent spec** — the next non-flag token is an agent spec if it matches a known provider name
   or is a comma-separated list of provider names.
3. **Remainder is the prompt** — everything after the agent spec (or after flags if no agent)

**Known providers:** `cursor`, `claude`, `gemini`

**Unknown provider handling:** If any agent name is not one of the 3 known providers,
abort with: "Unknown provider: `<name>`. Supported: cursor, claude, gemini.
For other agents (codex, copilot, droid, kiro, etc.), use `/acpx-prompt` instead."

**Flag validation:**

- `--model` takes the next token as its value. If `--model` appears without a value,
  abort with: "`--model` requires a model name (e.g., `--model gpt-5.4-high`)."
- `--model` can be combined with any other flag (`--fix`, `--peer`, `--resume`).
- `--resume` can be combined with `--fix` but NOT with `--peer` (peer mode manages sessions automatically).
  If `--resume` and `--peer` are both passed, abort with: "`--resume` and `--peer` cannot be used together — peer mode manages sessions automatically."
- `--fix` and `--peer` are **mutually exclusive**. If both are passed,
  abort with: "`--fix` and `--peer` cannot be used together."
- Multiple agents and `--fix` are **mutually exclusive**. If more than one
  agent is specified with `--fix`, abort with:
  "`--fix` can only be used with a single agent."
- If `--fix` appears more than once, abort with: "Duplicate --fix flag."
- If `--peer` appears more than once, abort with: "Duplicate --peer flag."
- If `--resume` appears more than once, abort with: "Duplicate --resume flag."

**Parsing order:**

1. **Consume leading flags first** — strip any `--fix` or `--peer` from the token stream
2. **Check if the next token is an agent spec** — a token is an agent spec if:
   - It matches a known provider name exactly (e.g., `cursor`, `claude`)
   - OR it's a comma-separated list where ALL parts match known provider names
3. **If the first non-flag token looks like an agent but contains unknown names**, abort with
   the unknown provider message above
4. **If no agent spec found** (first non-flag token is not a recognized provider), fall through
   to saved config below

**No agent specified — use saved config:**

Check for saved configuration:

```bash
mkdir -p .pi
cat .pi/external-ai-config.json 2>/dev/null
```

The config file structure:

```json
{
  "lastAgents": "cursor --model gpt-5.4-high",
  "lastPeers": "cursor,claude"
}
```

If the file doesn't exist, is empty, or contains invalid JSON, treat as no config.

**If `--peer` was passed** and `lastPeers` exists and is non-empty:
Ask via AskUserQuestion: `Last used peers: LAST_PEERS. Use these?`
Options: `Yes, use LAST_PEERS`, `Change providers`, `Cancel`.
Yes = use `lastPeers` as the agent spec.
Change = ask: `Enter provider(s) for peer review:`.
Cancel = abort.

**If `--peer` was passed** but `lastPeers` is missing/empty:
Ask via AskUserQuestion: `Select providers for peer review:`
Options: `cursor,claude`, `cursor,gemini`, `claude,gemini`, `cursor,claude,gemini`, `Cancel`.
Cancel = abort.

**If `--fix` was passed or no flags** and `lastAgents` exists and is non-empty:
Ask via AskUserQuestion: `Last used: LAST_AGENTS. Use this?`
Options: `Yes, use LAST_AGENTS`, `Change provider/model`, `Cancel`.
Yes = use `lastAgents` as the agent spec.
Change = show provider selection (see below).
Cancel = abort.

**If `--fix` was passed or no flags** and `lastAgents` is missing/empty:
Show provider selection (see below).

**Provider selection (when no provider resolved yet):**

Ask via AskUserQuestion: `Select provider:`
Options: `cursor`, `claude`, `gemini`, `Cancel`.
Cancel = abort.

After selecting a provider, ask: `Select model (or use default):`
Fetch models via `myk-pi-tools ai-cli models PROVIDER` and present them.
Options: list of model IDs + `default (DEFAULT_MODEL)` + `Cancel`.
Cancel = abort.
`default` = use the provider's default model from the table below.

**Empty prompt check:** After resolving agent spec, if the remaining prompt text is
empty or whitespace-only, abort with:
"No prompt provided. Usage: `/external-ai <provider> [--model <model>] [--fix | --peer] <prompt>`"

**Default model handling:** If no `--model` was specified for a provider,
you must still pass a model to `ai-cli-runner`. Use these defaults:

| Provider | Default model |
|----------|---------------|
| `cursor` | `composer-2-fast` |
| `claude` | `claude-sonnet-4-6` |
| `gemini` | `gemini-2.5-flash` |

These match each CLI's default behavior. When generating the Python script (Step 5),
use the default model if none was specified by the user.

When `--model` is specified, use that model.
When not specified, use the default from the table above.

### Step 2b: Display Execution Summary

Before proceeding, display a summary of what will be executed so the user knows
exactly what is about to be sent. **No black magic.**

```text
Provider: <provider>
Model: <model> (or "default: <default_model>" if using default)
Mode: <read-only | fix | peer>
Resume: <yes | no>
```

No confirmation prompt needed — the user already confirmed by providing arguments
or selecting from the interactive prompts above.

### Step 3: Session Management

Sessions allow the AI CLI to maintain conversation context across prompts.

**Session behavior by mode:**

| Mode | Session behavior |
|------|------------------|
| **Normal** (no flags) | Stateless — fresh session each call |
| **`--resume`** | Continue the last session — adds session resume flag to CLI |
| **`--fix`** | Stateless by default. Combine with `--resume` to continue a session |
| **`--fix --resume`** | Continue the last session in fix mode |
| **`--peer`** | Automatic sessions — first round is fresh, all subsequent rounds use `--continue`/`-c`/`--resume latest` to maintain conversation context. Do NOT combine with `--resume` |

**Session resume flags per provider:**

| Provider | Resume flag | Binary |
|----------|------------|--------|
| `cursor` | `--continue` | `agent` |
| `claude` | `-c` | `claude` |
| `gemini` | `--resume latest` | `gemini` |

When `--resume` is active or in peer mode follow-up rounds, pass `--resume`
to the `myk-pi-tools ai-cli run` command.

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
   - **Commit first**: Stage only tracked modified files with `git add -u`
     and create a checkpoint commit with the message
     `chore: checkpoint before ai-cli changes`. This avoids staging
     untracked files (e.g., `.envrc`, `.claude/`) that may contain
     secrets or local config. After the commit, proceed. If untracked
     files remain, that is expected — do not treat them as dirty.
     If the commit fails, display the raw output and abort.
   - **Continue anyway**: Proceed and remember the workspace was dirty.
   - **Abort**: Stop immediately.
4. If the user declines the non-git prompt from step 1, abort.
5. If proceeding despite a dirty worktree (via **Continue anyway**),
   remember that state so Steps 7-8 (`--fix`) or Step 9e (`--peer`)
   can warn that diffs may include pre-existing edits.

### Step 5: Run Prompt

**If `--peer` was passed, skip Steps 5-8 and jump to Step 9 (Peer Review Loop).**

**MANDATORY:** Always use `myk-pi-tools ai-cli run` — never generate inline Python scripts.

**Single provider:**

```bash
myk-pi-tools ai-cli run --provider <PROVIDER> --model <MODEL> "<PROMPT>"
```

With resume:

```bash
myk-pi-tools ai-cli run --provider <PROVIDER> --model <MODEL> --resume "<PROMPT>"
```

**Multi-agent execution:**

When multiple providers are specified (without `--peer`), run all agents **in parallel**
by delegating each to a separate subagent or running sequential CLI calls:

```bash
myk-pi-tools ai-cli run --provider <P1> --model <M1> "<PROMPT>"
myk-pi-tools ai-cli run --provider <P2> --model <M2> "<PROMPT>"
```

Collect results from all providers and display grouped by provider.

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

**No timeout:** NEVER pass a timeout parameter to bash when running ai-cli commands.
Agents need time to read files, think, and execute multi-step tool calls.

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

Display the output to the user.

The CLI outputs structured JSON to stdout:

```json
{
  "success": true,
  "text": "<response>",
  "provider": "cursor",
  "model": "gpt-5.4-high",
  "usage": {
    "input_tokens": 1234,
    "output_tokens": 567,
    "cache_read_tokens": 890,
    "cost_usd": 0.0123,
    "duration_ms": 5000
  }
}
```

Parse the JSON and display:

1. The agent's response text
2. A usage summary:

```text
Provider: <provider>
Model: <model>
Mode: [read-only | fix]
Tokens: in=<input_tokens> out=<output_tokens> cache_read=<cache_read_tokens>
Cost: $<cost_usd>
Duration: <duration_ms>ms
```

Omit fields that are missing or zero. On error (`"success": false`), display the `error` field.

**Save config:** See "Persist Config" section after Step 9e.

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

Execute via `myk-pi-tools ai-cli run` (read-only mode — append the read-only guard to the prompt).
This first round is a **fresh session** — do NOT pass `--resume`.
Do NOT display intermediate results to the user.
If the command fails, abort the peer loop and report the error.

**Multi-agent:** Send the peer framing prompt to ALL agents in parallel
using `run_parallel_with_limit`. Collect and merge findings from all agents,
deduplicating where the same issue is raised by multiple agents.

**Multi-agent group context:** In the first round, each agent reviews
independently (no group context yet). Their individual responses are
collected for use in subsequent rounds.

If ALL agents report no findings, skip to Step 9e.
If only SOME agents report no findings, continue to Step 9b with the findings
from agents that did report issues.

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

**Multi-agent:** Merge and deduplicate findings from all agents.

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

Always include the model when the provider was invoked with `--model`.
If no model was specified, omit the model parenthetical (e.g., `## cursor findings:`).
```

This enables a true group conversation where every peer has full
visibility into the discussion. Each peer can agree, disagree, or
build on other peers' findings.

When sending to peer A, include findings from peers B, C, etc.
When sending to peer B, include findings from peers A, C, etc.

Execute via `myk-pi-tools ai-cli run --resume`. Do NOT display intermediate results.
**Use `--resume`** for this and all subsequent rounds so the peer agent has full
conversation context from previous rounds.

**Multi-agent:** Send the response to ALL agents in parallel. Each agent uses `--resume`.

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

**Multi-agent convergence:** ALL peers must independently confirm no remaining issues.

**Claude's behavior across rounds:**

- Claude SHOULD change its mind when a peer agent provides a better argument
- Claude SHOULD NOT stubbornly hold a position just to "win"
- If a disagreement persists for 3+ rounds on the same point, note it as
  "unresolved disagreement" and move on

#### 9e: Summary to User

After the loop exits, present a comprehensive summary:

```text
## Peer Review Complete — {N} round(s)

Provider(s): <provider>[, <provider2>, ...]

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

**Multi-agent group summary:** When multiple peers participated, add:

```text
### Group Dynamics

| Finding | Raised By | Agreed By | Resolution |
|---------|-----------|-----------|------------|
| Missing null check | cursor | claude, gemini | All agreed, fixed |
```

**Save config:** See "Persist Config" section below.

### Persist Config (runs once after successful completion)

After successful execution (Step 6 for normal mode, Step 9e for peer mode), persist
the agent spec using the CLI. Run exactly once per successful completion.

**Skip if any step failed** — do not persist config after errors or aborted runs.

```bash
# After normal/fix mode:
myk-pi-tools ai-cli save-config --agents "<normalized agent string>"

# After peer mode:
myk-pi-tools ai-cli save-config --peers "<normalized agent string>"
```

**Normalized agent string:** The exact agent spec used for the run, as the user would type it
(e.g., `cursor --model gpt-5.4-high`, `cursor,claude`).
