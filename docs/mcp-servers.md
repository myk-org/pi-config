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

### Upgrading from the `mcpc` bridge

Before pi 0.99, pi-config reached MCP through the external `mcpc` binary, which read
`~/.pi/pi-config/mcp.json`. `builtin:mcp` reads `~/.pi/agent/mcp.json` instead, so an
existing install would upgrade to a pi that finds no servers at all — silently, with no
error to look for.

pi-config copies the file across for you at startup, and only when
`~/.pi/agent/mcp.json` does not already exist. Your existing `~/.pi/agent/mcp.json` is
never overwritten, and the old file is left in place for you to delete whenever you
like. The copy is logged to `~/.pi/logs/mcp-config-migration/`; if it fails, the reason
is in there and you can copy the file by hand.

## Managing servers

| Command | Purpose |
|---|---|
| `/mcp` | Interactive manager: state, tool count, exposure, and the config file each server came from |
| `/mcp reconnect` | Reconnect after editing `mcp.json` |
| `/mcp login` / `/mcp logout` | Manage OAuth for a server |
| `pi mcp list` | List configured servers from the shell |
| `pi mcp add` / `pi mcp remove` | Add or remove a server from the shell |

Outside the TUI, `/mcp` prints status.

## OAuth sign-in

A server that answers `401` and advertises OAuth signs in with `pi mcp login <server>` or
`/mcp login`. Tokens are stored in `~/.pi/agent/mcp-auth.json` and refreshed when they expire
or the server rejects them; signing out deletes them.

pi identifies itself to the authorization server in one of two ways. When the server
advertises Client ID Metadata Documents (CIMD) for public clients, pi uses its document —
client ID `https://pi.dev/oauth/client.json`, redirect URI `http://127.0.0.1:<port>/callback`
— and skips registration. Otherwise pi registers a client dynamically (DCR). A client
registered earlier stays in use while its redirect URI matches, until you sign out.

`oauth.clientRegistration` on the server chooses the method:

| Value | Behaviour |
|---|---|
| `auto` (default) | The document when the server supports it; registers instead when `clientName` or a non-default `callbackUrl` is set |
| `dcr` | Always registers a client |
| `cimd` | Always uses the document; sign-in fails if the server does not support CIMD for public clients |

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "oauth": { "clientRegistration": "dcr" }
    }
  }
}
```

`pi mcp add --oauth-client-registration <mode>` sets the mode when adding a server. `cimd`
cannot be combined with `clientId` or `clientName`.

`pi mcp login <server> -l` and `pi mcp logout <server> -l` accept `-l` for a server defined in
the project's `.pi/mcp.json`, the same scoping `-l` gives `pi mcp add` and `pi mcp remove`:

```bash
pi mcp login example -l
pi mcp logout example -l
```

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
