# Using External AI Agents (Cursor, Claude, Gemini)

Get a second opinion from another AI by routing prompts to Cursor, Claude, or Gemini CLIs directly from your pi session. Use `/external-ai` for peer reviews, code generation, multi-agent debates, and any task where you want a different model's perspective.

## Prerequisites

- **AI CLI binaries installed:** At least one of `cursor` (agent CLI), `claude`, or `gemini` must be available on your system and authenticated.
- **myk-pi-tools installed:** The CLI that wraps the AI calls. Install with `uv tool install myk-pi-tools` if not already present.

## Quick Example

Ask Claude to review your code (read-only by default):

```
/external-ai claude review the error handling in this module
```

Ask Cursor to fix test failures (with file modification enabled):

```
/external-ai cursor --fix fix the failing tests
```

Run a peer review debate between pi and Gemini:

```
/external-ai gemini --peer review this code for correctness and edge cases
```

## Step-by-Step: Read-Only Review

The most common use case is getting a second opinion on code without modifying any files.

1. **Pick a provider and write your prompt:**

   ```
   /external-ai cursor explain why this function is slow and suggest improvements
   ```

2. **Pi runs the prompt** through the selected provider's CLI. The agent is explicitly told not to modify any files.

3. **View the results.** Pi displays the agent's response along with a usage summary showing tokens consumed, cost, and duration.

That's it. The external agent reads your project files, analyzes them, and reports back — all within your pi session.

## Choosing a Provider and Model

Three providers are supported:

| Provider | CLI Binary | Default Model |
|----------|------------|---------------|
| `cursor` | `agent` | `composer-2-fast` |
| `claude` | `claude` | `claude-sonnet-4-6` |
| `gemini` | `gemini` | `gemini-2.5-flash` |

Override the model with `--model`:

```
/external-ai cursor --model gpt-5.4-high review the architecture
```

Use Tab completion after `/external-ai` to browse available providers, and after `--model` to browse available models for each provider. If models seem stale, run `/external-ai-models-refresh` to update the cache.

> **Tip:** If you omit the provider name entirely, pi checks your saved config from the last run and asks whether to reuse it.

## Modes of Operation

### Read-Only (Default)

The external agent can read your files but cannot modify anything. Use this for reviews, explanations, and analysis.

```
/external-ai gemini explain the authentication flow in this project
```

### Fix Mode (`--fix`)

Enable file modifications so the agent can directly edit your code.

```
/external-ai cursor --fix fix the code quality issues
```

Before running in fix mode, pi checks your Git workspace state and offers to create a checkpoint commit so you can easily roll back. After the agent finishes, pi shows a diff summary of all changes made.

### Peer Review Mode (`--peer`)

Start an AI-to-AI debate loop where the external agent reviews your code and pi acts on the findings — fixing agreed issues, pushing back on disagreements, and sending changes back for re-review until both sides converge.

```
/external-ai claude --peer review this module for bugs and design issues
```

The loop works like this:

1. The external agent reviews the code and reports findings.
2. Pi evaluates each finding — fixing valid issues and preparing counter-arguments for disagreements.
3. Pi sends the fixes and counter-arguments back to the external agent.
4. The agent re-reviews, confirms fixes, and raises new issues or concedes points.
5. Steps 2–4 repeat until the agent reports no remaining issues.

> **Note:** Only the peer agent can end the loop. Pi fixing code doesn't count as convergence — the agent must verify the fixes are correct.

After convergence, pi displays a structured summary showing addressed findings, agreements reached after debate, unresolved disagreements, and per-round usage/cost tracking.

### Multi-Agent Reviews

Specify multiple providers separated by commas:

```
/external-ai cursor,claude review this code
```

Both agents run in parallel and their findings are collected. In peer mode, each agent gets full visibility into what the others said (group context), enabling a true multi-agent discussion:

```
/external-ai cursor,gemini --peer review the error handling strategy
```

## Session Management

By default, each `/external-ai` call starts a fresh conversation. Use `--resume` to continue where you left off:

```
/external-ai claude --resume what about the edge cases we discussed?
```

For precise session targeting, use `--session-id`:

```
/external-ai claude --session-id abc123 continue reviewing the auth module
```

| Flag | Behavior |
|------|----------|
| *(none)* | Fresh session each time |
| `--resume` | Continue the most recent session |
| `--session-id <id>` | Resume a specific session by ID |

> **Note:** `--resume` and `--peer` cannot be combined — peer mode manages sessions automatically across rounds.

## Combining Flags

Flags can be combined where it makes sense:

```
/external-ai cursor --model gpt-5.4-high --fix fix the code
/external-ai cursor --fix --resume continue fixing from where we left off
```

These combinations are **not allowed:**

| Combination | Why |
|-------------|-----|
| `--fix` + `--peer` | Mutually exclusive modes |
| `--resume` + `--peer` | Peer mode manages sessions automatically |
| `--fix` + multiple agents | Fix mode only works with a single agent |

## Saved Configuration

After each successful run, pi saves your provider and model choices to `.pi/external-ai-config.json`. Next time you run `/external-ai` without specifying a provider, pi offers to reuse your last selection:

```
/external-ai review this code
```

Pi will prompt: *"Last used: cursor. Use this?"* with options to accept, change, or cancel.

Peer mode saves its own config separately, so `/external-ai --peer review this` remembers your last peer providers independently.

## Advanced Usage

### Passing Extra CLI Flags

Send additional flags directly to the underlying AI CLI binary with `--cli-flags`:

```
/external-ai cursor --cli-flags=--trust review the security model
```

This is useful for provider-specific options that aren't exposed through `/external-ai` directly.

### Using Custom Models for Multi-Agent Peer Reviews

When running multi-agent peer reviews, you can specify different models for each provider using `--model`:

```
/external-ai cursor --model gpt-5.4-high --peer review the architecture
```

The usage summary at the end breaks down token usage and cost per provider, per round, and in aggregate — so you can see exactly what each agent contributed.

### AGENTS.md-Aware Reviews

If your project has an `AGENTS.md` file with coding conventions and guidelines, the peer review framing automatically instructs the external agent to read it and flag any violations. No extra configuration needed.

## Troubleshooting

**"Unknown provider" error**
Only `cursor`, `claude`, and `gemini` are supported by `/external-ai`. For other AI agents (codex, copilot, droid, kiro, etc.), use the `/acpx-prompt` command instead.

**Agent tries to modify files in read-only mode**
Pi automatically retries with a stricter read-only instruction. If it fails twice, the error is shown. Consider using `--fix` if you actually want modifications.

**"myk-pi-tools not found"**
Install it with `uv tool install myk-pi-tools`. See [Installing and Starting Your First Session](quickstart.html) for full setup instructions.

**Model autocomplete not showing results**
Run `/external-ai-models-refresh` to rebuild the model cache. The cache refreshes automatically every 5 minutes, but a manual refresh is useful after installing a new CLI or updating provider credentials.

**Long-running prompts**
External agents can take several minutes for complex tasks (reading many files, multi-step tool calls). There is no timeout — the command runs until the agent finishes. This is by design.

For the full list of flags and argument syntax, see [Slash Commands and Extension Commands Reference](commands-reference.html). For CLI details on the underlying `myk-pi-tools ai-cli` subcommands, see [myk-pi-tools CLI Reference](cli-reference.html).

## Related Pages

- [Using ACPX Provider for External Agent Models](acpx-provider.html)
- [Using Slash Commands and Prompt Templates](slash-commands.html)
- [Slash Commands and Extension Commands Reference](commands-reference.html)
- [myk-pi-tools CLI Reference](cli-reference.html)
- [Common Workflow Recipes](workflow-recipes.html)
