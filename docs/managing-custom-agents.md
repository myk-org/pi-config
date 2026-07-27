# Managing Custom Agents

Create specialized AI agents to handle specific, recurring tasks within your workflow. By defining dedicated agents with distinct instructions, tools, and routing rules, you prevent the primary orchestrator from becoming overloaded and ensure complex tasks follow strict procedures.

## Prerequisites

- A running background daemon. See [Daemon & Websocket Networking](daemon-and-websockets.html).

## Quick Example

To create a new specialist agent, define a Markdown file in the `agents/` directory containing YAML frontmatter and the system instructions.

For example, to create a basic log analyzer, create a file named `agents/log-analyzer.md`:

```markdown
---
name: log-analyzer
description: Parses server logs to identify crash stack traces and performance bottlenecks.
tools: read, bash
---

# Log Analyzer

You are an expert at reading unstructured application logs.

## Your Task

1. Read the provided log files using `bash` tools like `grep` and `awk`.
2. Identify any stack traces or lines containing "ERROR" or "FATAL".
3. Summarize the frequency of each error type.
```

## Step-by-Step Guide

### 1. Create the Agent Profile

All custom agents live in the `agents/` directory. Create a new file named `<agent-name>.md`.

The file must begin with a YAML block defining:
- `name`: The exact string identifier for your agent.
- `description`: A clear explanation of what the agent does. The orchestrator reads this to decide when to invoke the agent.
- `tools`: A comma-separated list of capabilities the agent can use.

Everything below the YAML block becomes the agent's system prompt. Use structured markdown headings, clear numbered lists, and specific domain rules.

### 2. Configure Agent Routing

The orchestrator needs to know when to dispatch tasks to your new agent. Open `rules/10-agent-routing.md` and add your agent to the "Routing Table" section.

```markdown
| Domain/Tool | Agent |
|---|---|
| Python (.py) | `python-expert` |
| Server Logs (.log) | `log-analyzer` |
```

If your agent handles a broader task intent rather than just a specific file type, add a bullet point to the "Routing by Intent, Not Tool" section in the same file to clarify edge cases.

### 3. Register the Agent for Bug Reporting

To ensure the orchestrator can report bugs if it detects logic flaws in your agent's instructions, add your new agent's name to the alphabetical list in `rules/50-agent-bug-reporting.md`:

```markdown
- kubernetes-expert
- log-analyzer
- planner
```

### 4. Test Your Agent

Agents and rules are loaded dynamically from the filesystem. Your changes will take effect immediately on your next session.

1. Start a new Pi chat session.
2. Ask the orchestrator to perform a task matching your new agent's domain (e.g., "Find the cause of the crash in `app.log`").
3. Verify that the orchestrator routes the task to your `log-analyzer` agent.

## Advanced Usage

### Using External AI Agents

You can route specific domains to external AI providers (like Claude, Gemini, or Cursor) instead of handling them locally. To do this, point the intent to the special `/acpx-prompt` handler in your routing table.

See [External AI Agents & CLI](external-ai-agents.html) for detailed configuration.

### Tool Selection

Only give your agent the tools it actually needs to accomplish its domain tasks. The `tools` list in the YAML frontmatter restricts what the agent is permitted to execute:

- `read`: Allows the agent to read file contents, search patterns, and list directories.
- `write` / `edit`: Allows the agent to create new files or modify existing source code.
- `bash`: Allows the agent to execute shell commands.

> **Warning:** Be cautious when granting the `bash` tool to agents that process untrusted external data. For securing bash capabilities, see [Implementing Command Guards](safety-enforcements.html).

### Prompt Templates vs Agents

If you only need the AI to format text, translate a snippet, or perform a quick stateless transformation, do not create a full agent. Use a Prompt Template instead. Specialist agents should be reserved for complex workflows that require multi-step reasoning, tool usage, or iterative loops.

## Troubleshooting

- **Agent isn't selected:** Ensure the agent's file name exactly matches the name you placed in `rules/10-agent-routing.md`. Start a completely new session to ensure the orchestrator has loaded the latest routing table.
- **Agent forgets instructions:** Keep your Markdown system prompt concise. Use bullet points instead of long paragraphs. If your agent's instructions are too long or contain contradictory steps, the underlying model may ignore them.

## Related Pages

- [External AI Agents & CLI](external-ai-agents.html)
- [Inter-Agent Communication Network](inter-agent-communication.html)
- [Automating Code Reviews](automating-code-reviews.html)
