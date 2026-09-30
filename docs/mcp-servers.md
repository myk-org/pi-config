# MCP Servers

pi-config does not ship an MCP client. Since pi 0.99.0, MCP is built into pi itself
(`builtin:mcp`), so servers are configured in `mcp.json` and managed with `/mcp`.

There is no external MCP binary to install and no separate bridge process.

## Configuration

Servers live in `mcp.json` under a `mcpServers` key. pi reads the user-level file at
`~/.pi/agent/mcp.json` and a project-level `mcp.json` once the project is trusted.

```json
{
  "mcpServers": {
    "local-jenkins": {
      "command": "npx",
      "args": ["-y", "mcp-jenkins"],
      "env": { "JENKINS_URL": "https://jenkins.internal" }
    },
    "docs": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }
    }
  }
}
```

pi infers the transport from the keys present: `command`/`args`/`env`/`cwd` means stdio,
`url`/`headers`/`oauth` means streamable HTTP. The legacy SSE transport is not supported.
`${VAR}` in a value expands from the environment.

After editing `mcp.json`, run `/mcp` to reconnect, or restart pi.

## Managing servers

| Command | Purpose |
|---|---|
| `/mcp` | Interactive manager: state, tool count, exposure, and the config file each server came from |
| `/mcp reconnect` | Reconnect after editing `mcp.json` |
| `/mcp login` / `/mcp logout` | Manage OAuth for a server |
| `pi mcp list` | List configured servers from the shell |
| `pi mcp add` / `pi mcp remove` | Add or remove a server from the shell |

Outside the TUI, `/mcp` prints status.

## How tools reach the model

An MCP server can expose dozens of tools. Declaring all of them on every request would
bloat the context window, so each server has an **exposure** that decides when its tools
become visible. The default is `codemode`, and it is the right choice for almost every
server.

| Exposure | Behaviour | Cost when unused |
|---|---|---|
| `codemode` (default) | Not declared to the model. Reached from `codemode` scripts, which find tools with `searchTools()`. | 0 |
| `codemode-deferred` | As above, and the tool list is not even in the `codemode` description — only the server name and tool count. | 0 |
| `deferred` | Not declared until the `tool_search` tool loads them, then called directly. | 0 |
| `direct` | Declared to the model like built-in tools. | Full schema, every request |
| `hidden` | Registered but not callable. | 0 |

The `codemode` description has its own budget, `codemode.inlineBudget` (default 3000
tokens). Tools that do not fit are found with `searchTools()`, so the cost of a large
server is bounded rather than proportional to its tool count.

Set a server's exposure, and per-tool overrides, in the same `mcp.json`:

```json
{
  "mcpServers": {
    "jira": {
      "command": "npx",
      "args": ["-y", "mcp-jira"],
      "exposure": "codemode"
    },
    "github": {
      "url": "https://mcp.githubcopilot.com/mcp/",
      "exposure": "deferred",
      "toolExposure": {
        "search_code": "direct",
        "delete_*": "hidden"
      }
    }
  }
}
```

`toolExposure` keys are tool names as the server offers them, or patterns where `*`
matches any characters. An exact name beats a pattern; among patterns the first match
wins. `pi mcp list` marks tools whose exposure differs from their server's.

Reserve `direct` for the one or two tools you reach for constantly. A server set to
`direct` costs tokens whether or not the task needs it.

## Calling a tool

With `codemode` or `deferred` exposure, the agent writes a `codemode` script or lets
`tool_search` load the tool — there is no shell round-trip and no separate discovery
step. Tools loaded by `tool_search` are recorded in the transcript and stay declared on
that branch.

To confirm a server is healthy, run `/mcp` and check its state and tool count. pi logs
MCP activity to `~/.pi/agent/mcp.log`.

## Resources

Servers offering MCP resources gain `list_mcp_resources`, `read_mcp_resource`, and
`list_mcp_resource_templates` automatically. They reach every server whose exposure is
not `hidden`, and take the widest exposure among them.
