# External AI Agents & CLI

Run prompts through Cursor, Claude, or Gemini from your terminal or Pi chat when you want that provider’s models, tools, and session behavior without leaving your workflow.

## Prerequisites

- `myk-pi-tools` installed and on your `PATH` (for example `uv tool install myk-pi-tools`)
- Provider CLIs installed and authenticated:
  - **cursor** → `agent` binary
  - **claude** → `claude` binary
  - **gemini** → `gemini` binary

## Quick Example

```bash
# List models for Claude
myk-pi-tools ai-cli models claude

# Run a one-shot prompt
myk-pi-tools ai-cli run "Summarize the changes in src/main.rs" --provider claude --model claude-sonnet-4-6
```

Inside a Pi session:

```text
/external-ai cursor explain the authentication flow
```

## Step-by-Step Guide

### 1. Pick a provider and model

Supported providers: `cursor`, `claude`, `gemini`.

| Provider | Default model (when `--model` is omitted) |
|----------|-------------------------------------------|
| `cursor` | `composer-2-fast` |
| `claude` | `claude-sonnet-4-6` |
| `gemini` | `gemini-2.5-flash` |

```bash
myk-pi-tools ai-cli models cursor
```

```text
/external-ai cursor --model gpt-5.4-high review the latest PR
```

### 2. Run a read-only prompt

By default, `/external-ai` and `ai-cli run` are read-only — the external agent should not modify files.

```text
/external-ai gemini explain this function
```

```bash
myk-pi-tools ai-cli run "List security concerns in the auth package" --provider cursor
```

### 3. Allow writes with `--fix`

```text
/external-ai claude --fix rewrite the error handling in database.ts
```

> **Note:** In a dirty git worktree, Pi asks whether to create a checkpoint commit (`chore: checkpoint before ai-cli changes`) or continue anyway before applying changes.


> **Warning:** `--fix` works with a single provider only. It cannot be combined with `--peer` or a comma-separated provider list.

### 4. Continue a session with `--resume`

```text
/external-ai cursor --resume add tests for the edge cases too
```

```bash
myk-pi-tools ai-cli run "Continue from the last review" --provider cursor --resume
```

| Mode | Session behavior |
|------|------------------|
| Default | Fresh session each call |
| `--resume` | Continue the most recent session |
| `--session-id <id>` | Resume a specific session (CLI only; mutually exclusive with `--resume`) |

## Advanced Usage

### Peer review loops

Use `--peer` for an AI-to-AI review loop. Pi orchestrates rounds: the peer reports findings, Pi applies agreed fixes or returns technical counter-arguments, then the peer re-reviews until peers report no remaining issues.

```text
/external-ai cursor --model gpt-5.4-xhigh --peer review this pull request
```

Multiple peers (comma-separated) review in parallel; later rounds share group context:

```text
/external-ai cursor,claude --peer review the architecture design
```

> **Warning:** Do not combine `--peer` with `--fix` or `--resume`. Peer mode manages sessions automatically via `--session-id` after the first round.

### Persist defaults

Save last-used agents or peer sets to `.pi/external-ai-config.json`:

```bash
myk-pi-tools ai-cli save-config --agents "cursor --model gpt-5.4-high"
myk-pi-tools ai-cli save-config --peers "cursor,claude"
```

Then omit the provider:

```text
/external-ai write a unit test for this script
/external-ai --peer review this
```

### Extra CLI flags

Pass through flags the underlying binary understands:

```bash
myk-pi-tools ai-cli run "Review auth" --provider cursor --cli-flags=--trust
```

### Other providers

For agents outside `cursor` / `claude` / `gemini` (for example Codex or Copilot), use ACPX instead of `/external-ai`. See [ACPX Provider Integration](acpx-provider.html).

For registering `cli-*` providers inside Pi sessions, see [Configuration & Settings](configuration.html). To customize slash-command behavior, see [Creating Slash Commands](custom-slash-commands.html).

## Troubleshooting

- **Permission / unexpected file changes:** You ran without `--fix`, or the agent ignored read-only instructions. Retry with `--fix` after a clean or checkpointed tree.
- **Unknown provider:** Use only `cursor`, `claude`, or `gemini` with `/external-ai`. Other agents need [ACPX Provider Integration](acpx-provider.html).
- **`agent` / `claude` / `gemini` not found:** Install and authenticate that provider’s CLI separately, then confirm it is on your `PATH`.
- **Long-running or “stuck” agents:** Multi-step tool use can take several minutes. Do not cancel early — execution commands intentionally run without strict timeouts.
- **`--resume` and `--peer` together:** Not allowed; drop one of the flags.

## Related Pages

- [ACPX Provider Integration](acpx-provider.html)
- [Google Vertex Claude Provider](vertex-claude-provider.html)
- [Pi Sidecar HTTP API](pi-sidecar.html)
- [Configuration & Settings](configuration.html)
- [Built-in Workflow Commands](built-in-workflows.html)
