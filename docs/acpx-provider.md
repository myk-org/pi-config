# Using ACPX Provider for External Agent Models

Route pi's LLM requests through external coding agents like Cursor, Codex, Gemini, or Copilot — so you can use their exclusive models (e.g., Cursor's GPT-5.4, Codex's o3-pro) as if they were native pi models. This lets you switch between providers mid-session without leaving pi.

## Prerequisites

- **acpx** installed globally: `npm install -g acpx@latest`
- The external agent's CLI installed and authenticated (e.g., Cursor CLI with a valid `auth.json`)
- The `ACPX_AGENTS` environment variable set with the agents you want to use

## Quick Start

Set the environment variable and start pi:

```bash
export ACPX_AGENTS=cursor
pi
```

Pi discovers all models available through Cursor and registers them as selectable models. Switch to a Cursor model using pi's model selector, and all subsequent LLM requests flow through Cursor's backend.

## Step-by-Step Setup

### 1. Install acpx

```bash
npm install -g acpx@latest
```

> **Tip:** The native installer (`scripts/install.py`) includes acpx in its Node.js tools checklist and will offer to install it for you.

### 2. Install and authenticate the target agent

Each agent requires its own CLI to be installed and authenticated. For example, for Cursor you need the Cursor CLI agent installed with a valid authentication token.

### 3. Configure ACPX_AGENTS

Set the `ACPX_AGENTS` environment variable to a comma-separated list of agents:

```bash
# Single agent
export ACPX_AGENTS=cursor

# Multiple agents
export ACPX_AGENTS=cursor,gemini,copilot
```

Agent names must be lowercase alphanumeric (with hyphens and underscores allowed). Invalid names are silently ignored.

**In Docker**, add this to your `.env` file:

```env
ACPX_AGENTS=cursor
```

And mount the agent's auth file. For Cursor:

```bash
-v "$HOME/.config/cursor/auth.json":"$HOME/.config/cursor/auth.json":ro
```

See [Running Pi in a Docker Container](docker-deployment.html) for the full Docker setup.

### 4. Start a pi session

```bash
pi
```

On session start, you'll see a notification for each configured agent:

```
acpx-cursor: 12 models discovered
```

The discovered models are now available in pi's model selector. Each model is named with the pattern `Model Name (agent)` — for example, `Gpt 5.4 (cursor)`.

### 5. Select an ACPX model

Use pi's model switching to pick an ACPX model. Model IDs follow the format `agent:model-id` — for example, `cursor:gpt-5.4` or `gemini:gemini-2.5-pro`.

Once selected, all pi LLM requests — including orchestrator reasoning, agent delegation, and tool calls — are routed through that external agent.

## How It Works

When you select an ACPX model, pi creates a persistent session with the external agent. The key behaviors:

- **Persistent sessions** — each agent maintains its own conversation history on its side. Pi sends only the latest user message per turn, not the full conversation.
- **System prompt** — pi's system prompt is sent once at session creation time, instructing the external agent to act as a backend LLM.
- **Per-model sessions** — switching between models on the same agent creates separate sessions, so each model gets its own conversation context.
- **Automatic cleanup** — all ACPX sessions are gracefully closed when your pi session ends.

## ACPX Provider vs /external-ai vs /acpx-prompt

Pi offers three ways to use external agents. Each serves a different purpose:

| Feature | ACPX Provider | `/external-ai` | `/acpx-prompt` |
|---------|--------------|----------------|----------------|
| **What it does** | Routes pi's LLM backend through an external agent | Sends a one-off prompt via ai-cli-runner subprocess | Sends a prompt to any ACP-compatible agent via acpx |
| **Model integration** | Full — model appears in pi's model selector | None — runs as a CLI subprocess | None — runs as a slash command |
| **Conversation context** | Maintains persistent session with external agent | Stateless by default (supports `--resume`) | Stateless by default (supports `--resume`) |
| **Supported agents** | Any agent in `ACPX_AGENTS` | cursor, claude, gemini only | All ACP agents (codex, copilot, droid, kiro, etc.) |
| **File modification** | Yes (through pi's normal tools) | Only with `--fix` flag | Only with `--fix` flag |
| **Peer review** | No | Yes (`--peer`) | Yes (`--peer`) |
| **Use case** | Use an external model as pi's brain | Get a second opinion, run a code review | Delegate tasks to any ACP-compatible agent |

**When to use which:**

- **ACPX Provider** — you want pi to *think* using Cursor's GPT-5.4 or another exclusive model for all interactions
- **`/external-ai`** — you want to send a quick prompt to cursor, claude, or gemini and get a response back (see [Using Slash Commands and Prompt Templates](slash-commands.html))
- **`/acpx-prompt`** — you want to delegate a task to any ACP-compatible agent, including ones like codex, copilot, or droid (see [Using Slash Commands and Prompt Templates](slash-commands.html))

## Advanced Usage

### Multiple agents

Register several agents to access models from different providers simultaneously:

```env
ACPX_AGENTS=cursor,gemini,copilot
```

Each agent gets its own provider (`acpx-cursor`, `acpx-gemini`, `acpx-copilot`) and its own set of discovered models. You can switch between them at any time during a session.

### Default model

Every registered agent always has a `agent:default` model (e.g., `cursor:default`). This uses whatever model the agent considers its default — no explicit model selection on the agent side.

### Model naming

ACPX model IDs include capability metadata in brackets. For example, a model might be listed internally as `gpt-5.4[context=272k,supports=vision]`. In pi's model selector, this appears with a cleaned-up display name like `Gpt 5.4 (cursor)`, but the full ID with brackets is used when communicating with the agent.

### Non-blocking startup

Model discovery runs in the background after session start. If you switch to an ACPX model before discovery completes, pi waits for it to finish before sending the first request. This means your session starts instantly — no delay from agent handshakes.

### Subagent behavior

ACPX providers are only loaded in the parent pi session. Subagents (specialist agents spawned by the orchestrator) use the parent's model via the `--model` flag and do not spawn their own ACPX runtimes. This avoids unnecessary agent connections and prevents nested session conflicts.

## Troubleshooting

### "no models discovered" warning

This means pi connected to the agent but couldn't retrieve its model list.

- Verify the agent CLI is installed and authenticated
- Check that the agent is running and responsive
- For Cursor in Docker, ensure `auth.json` is mounted correctly:
  ```bash
  -v "$HOME/.config/cursor/auth.json":"$HOME/.config/cursor/auth.json":ro
  ```

### "runtime init failed" in debug output

The ACPX runtime couldn't start for the given agent.

- Ensure `acpx` is installed: `npm install -g acpx@latest`
- The `acpx` npm package must also be in pi-config's dependencies (it is by default)
- Check that the agent name in `ACPX_AGENTS` is spelled correctly (lowercase, alphanumeric only)

### "Unknown acpx agent" error during streaming

This happens if you try to use a model ID for an agent that wasn't in `ACPX_AGENTS` at session start. Restart your pi session with the correct `ACPX_AGENTS` value.

### Model discovery is slow

Discovery creates a temporary session with each agent to query available models. If an agent CLI is slow to initialize, this can take several seconds. Since discovery runs in the background, it won't block your session — but model completions won't appear in the selector until discovery finishes.

### Session state directory

ACPX sessions store state files under `~/.acpx/pi-<pid>/`. These are cleaned up automatically on session shutdown. If pi exits unexpectedly, stale state files may remain — they are safe to delete:

```bash
rm -rf ~/.acpx/pi-*
```

> **Note:** For full environment variable documentation including `ACPX_AGENTS`, see [Configuration and Environment Variables Reference](configuration-reference.html).

## Related Pages

- [Using External AI Agents (Cursor, Claude, Gemini)](external-ai-agents.html)
- [Configuration and Environment Variables Reference](configuration-reference.html)
- [Running Pi in a Docker Container](docker-deployment.html)
- [Using Slash Commands and Prompt Templates](slash-commands.html)
- [Slash Commands and Extension Commands Reference](commands-reference.html)
