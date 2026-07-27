# External AI Agents & CLI

Trigger prompts across different AI providers directly from your terminal or chat session to leverage provider-specific capabilities like Cursor's fast models or Claude's extended reasoning.

## Prerequisites

- The external AI CLIs (`cursor`, `claude`, or `gemini` binaries from `ai-cli-runner`) must be installed and authenticated on your system.
- The `myk-pi-tools` CLI must be installed and accessible in your environment.

## Quick Example

List available models for a provider and run a simple prompt:

```bash
# See what models are available for Claude
myk-pi-tools ai-cli models claude

# Run a single prompt through Claude
myk-pi-tools ai-cli run "Summarize the changes in src/main.rs" --provider claude --model claude-3-5-sonnet-20241022
```

## Step-by-Step Guide

### 1. Using the Chat Command

When working inside Pi, you can use the `/external-ai` slash command to delegate tasks to an external provider without leaving your chat session.

```text
/external-ai cursor explain the authentication flow
```

If you don't specify a model, Pi will use the provider's default model (e.g., `composer-2-fast` for Cursor).

### 2. Selecting a Specific Model

To explicitly request a model, append `--model`:

```text
/external-ai cursor --model gpt-5.4-high review the latest PR
```

### 3. Granting Write Access

By default, all external AI requests are treated as read-only. Append the `--fix` flag to let the agent modify, create, or delete files directly in your workspace:

```text
/external-ai claude --fix rewrite the error handling in database.ts
```

> **Note:** If your git workspace is dirty (uncommitted changes) when running a `--fix` command, Pi will prompt you to create a checkpoint commit before the agent begins making modifications. This ensures you can easily roll back unwanted changes.

### 4. Continuing a Session

If you need to ask follow-up questions or iterate on previous changes, use the `--resume` flag to maintain conversation context with the agent:

```text
/external-ai cursor --resume add tests for the edge cases too
```

## Advanced Usage

### Peer Review Mode

You can start an AI-to-AI debate using the `--peer` flag. In this mode, Pi acts as an orchestrator, bouncing feedback back and forth with the external agent until both agree on the code changes.

```text
/external-ai cursor --model gpt-5.4-xhigh --peer review this pull request
```

Pi will collect the findings from the peer agent, evaluate them, apply fixes if it agrees, or present a technical counter-argument if it disagrees. The loop continues automatically until all parties reach consensus.

### Multi-Agent Group Debates

You can instruct multiple providers to review the same code simultaneously. Pass a comma-separated list of providers:

```text
/external-ai cursor,claude --peer review the architecture design
```

Each agent will review independently, and Pi will synthesize their findings. During the peer loop, each agent receives the full context of what the other agents said, enabling true group consensus.

### Persisting Agent Configurations

Pi remembers your last used provider and model. You can manually save your preferred agent setup so you don't have to specify it every time:

```bash
# Save default agent configuration for standard requests
myk-pi-tools ai-cli save-config --agents "cursor --model gpt-5.4-high"

# Save default peers configuration for peer review loops
myk-pi-tools ai-cli save-config --peers "cursor,claude"
```

Once saved, you can omit the provider and run prompts implicitly:

```text
/external-ai write a unit test for this script
```

## Troubleshooting

- **Command fails with a permission error:** The agent attempted to modify files during a read-only prompt. Retry with the `--fix` flag.
- **Unknown provider error:** Ensure you are using `cursor`, `claude`, or `gemini`. For other agents, use the ACPX integration instead.
- **Agent gets stuck or takes too long:** External models can take several minutes to read files and execute multi-step tool calls. Do not cancel the process prematurely; the CLI intentionally does not enforce strict timeouts.

For more details on modifying runtime variables, see [Configuration & Settings](configuration.html). To learn how commands like `/external-ai` are structured under the hood, see [Creating Slash Commands](custom-slash-commands.html).

## Related Pages

- [Managing Custom Agents](managing-custom-agents.html)
- [Inter-Agent Communication Network](inter-agent-communication.html)
- [ACPX Provider Integration](acpx-provider.html)
