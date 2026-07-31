# .pi/agents/security-auditor.md
---
name: security-auditor
description: Audits external repositories for security risks before adoption — checks for malicious code, data exfiltration, supply chain risks, and trust signals.
tools: read, bash
---

# Security Auditor

You are a security auditor specializing in evaluating external repositories for safe adoption.
Your job is to determine: **Is this repo safe for us to use?**
```

Then start a new Pi session and ask:

```text
Audit this GitHub repository before we adopt it.
```

Because the agent keeps the same `name: security-auditor`, your project version takes precedence for this repo.

## Step-by-Step

### 1. Choose the right scope

Use the smallest scope that matches how broadly you want the agent to apply.

| Scope | Put the file here | Best for |
|---|---|---|
| Project-only | `.pi/agents/` | One repository with project-specific behavior |
| Global | `~/.pi/agent/agents/` | The same specialist across all repositories |

> **Tip:** Project-local agents win over global agents when both use the same `name:`.

### 2. Create the agent file

Start with a `.md` file that has YAML frontmatter at the top, then write the instructions below it.

```markdown
---
name: security-auditor
description: Audits external repositories for security risks before adoption — checks for malicious code, data exfiltration, supply chain risks, and trust signals.
tools: read, bash
---

# Security Auditor

You are a security auditor specializing in evaluating external repositories for safe adoption.
```

Use these fields:

- `name` — the agent ID Pi uses when selecting or dispatching the agent
- `description` — a short summary of what the agent is for
- `tools` — a comma-separated allowlist such as `read, bash` or `read, write, edit, bash`

You can also add optional `provider` and `model` frontmatter if you want that agent to prefer a specific backend.

> **Warning:** Give agents the fewest tools they need. If an agent can work with `read` alone, do not add write-capable tools. For shell-heavy agents, see [Implementing Command Guards](safety-enforcements.html) for details.

### 3. Keep the instructions narrow

The bundled specialists are very specific: one agent reviews, another runs tests, another audits third-party repos. Follow the same pattern for your own agents.

Good custom-agent prompts usually include:

- what the agent should do
- what it must not do
- the format you want back
- any repo-specific rules that matter every time

A strong prompt is usually better than a long prompt. Short, opinionated instructions are easier for Pi to follow reliably.

### 4. Route the agent from normal chat

If you want Pi to pick your specialist from everyday requests, add a project rule that tells the orchestrator when to use it.

```markdown
# .pi/rules/custom-agents.md

- When the task is to audit a third-party repository before adoption, delegate to `security-auditor`.
- When the task is to run tests and explain failures without fixing code, delegate to `test-runner`.
```

Write the rule in plain language. Be specific about both the trigger and the agent name.

> **Note:** Project rules are loaded automatically for that repository. Start a new session after adding or changing them.

### 5. Test the routing

Start a fresh session, then try a request that should clearly match your rule.

Examples that align with bundled specialists already in the project:

```text
Audit this dependency repo before we vendor it.
```

```text
Run the tests and summarize the failures without fixing anything.
```

A good test prompt is narrow enough that only one specialist should make sense. If Pi chooses the wrong one, tighten the wording in your rule instead of making the agent prompt broader.

### 6. Use workflow-only agents when chat routing is the wrong fit

Some specialists should only run inside a specific flow rather than being selected from general chat. In that case, keep them out of your chat-routing rules and dispatch them from a prompt template or slash command instead.

Built-in workflows already do this for review specialists such as `/issue-review`, `/pr-review`, and `/review-local`. See [Creating Slash Commands](custom-slash-commands.html) for details.

## Advanced Usage

### Override order

When two agents use the same `name:`, Pi resolves them in this order:

| Highest precedence | Use case |
|---|---|
| `.pi/agents/` | Override behavior for one repository |
| `~/.pi/agent/agents/` | Reuse a specialist everywhere |
| Bundled defaults | Fallback when you have not overridden anything |

This is the easiest way to customize a built-in agent for one repo without affecting your other work.

### Reuse a built-in pattern instead of starting from scratch

If your new agent is “like the existing one, but stricter,” copy the shape of a bundled specialist and change only what matters:

- `security-auditor` for third-party repo checks
- `test-runner` for test execution and failure summaries
- `reviewer` for read-only analysis
- `worker` for broad, write-capable tasks

This gets you productive faster than inventing a brand-new prompt structure.

### Pin a provider or model for one agent

If one specialist works better on a specific backend, set defaults in project settings:

```json
{
  "agent_provider": "cli-cursor",
  "agent_model": "cursor:cursor-grok-4.5-high-fast",
  "agent_overrides": {
    "test-runner": {
      "provider": "cli-claude",
      "model": "claude-3-5-sonnet"
    }
  }
}
```

Use this when one agent needs a different model from the rest of your session. See [Configuration & Settings](configuration.html) for details.

### Force an agent to inherit the parent session model

You can explicitly clear an override with `null`:

```json
{
  "agent_overrides": {
    "reviewer": {
      "provider": null,
      "model": null
    }
  }
}
```

This is useful when you want most agents pinned, but one specialist should always follow the current session.

### Prefer workflow agents for long or structured jobs

If the agent needs multiple phases, parallel reviewers, scheduled runs, or background execution, put it behind a workflow instead of normal chat routing. See [Creating Slash Commands](custom-slash-commands.html) and [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) for details.

## Troubleshooting

- **Pi does not pick the new agent:** Start a new session, confirm the file is under `.pi/agents/` or `~/.pi/agent/agents/`, and make sure the frontmatter includes both `name:` and `description:`.
- **Pi picks the wrong specialist:** Make your routing rule more explicit. If the task is really workflow-only, dispatch it from a slash command instead of relying on everyday chat.
- **The agent has too much authority:** Reduce the `tools:` list first. Many specialists only need `read` and `bash`.
- **The agent uses the wrong model:** Check `provider:` / `model:` frontmatter and your `agent_provider`, `agent_model`, and `agent_overrides` settings. See [Configuration & Settings](configuration.html) for details.
- **A project-level agent is not found from a subdirectory:** Put it under the repository’s `.pi/agents/` folder, then start a new session from anywhere inside that repo.

## Related Pages

- [Creating Slash Commands](custom-slash-commands.html)
- [Built-in Workflow Commands](built-in-workflows.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
- [Inter-Agent Communication Network](inter-agent-communication.html)
- [Implementing Command Guards](safety-enforcements.html)
