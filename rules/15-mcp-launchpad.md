# MCP Launchpad (mcpl)

Use the `mcpl` command for all MCP server interactions.

MCP Launchpad is a unified CLI for discovering and executing tools from multiple MCP servers.
If a task requires functionality outside current capabilities, always check `mcpl` for available tools.

---

## mcpl Commands

| Command                                      | Purpose                                             |
|----------------------------------------------|-----------------------------------------------------|
| `mcpl search "<query>"`                      | Search all tools (shows required params, 5 results) |
| `mcpl search "<query>" --limit N`            | Search with more results                            |
| `mcpl list`                                  | List all MCP servers                                |
| `mcpl list <server>`                         | List tools for a server (shows required params)     |
| `mcpl list --refresh`                        | Refresh and list all MCP servers                    |
| `mcpl inspect <server> <tool>`               | Get full schema                                     |
| `mcpl inspect <server> <tool> --example`     | Get schema + example call                           |
| `mcpl call <server> <tool> '{}'`             | Execute tool (no arguments)                         |
| `mcpl call <server> <tool> '{"param": "v"}'` | Execute tool with arguments                         |
| `mcpl verify`                                | Test all server connections                         |

---

## Workflow

**Never guess tool names** - always discover them first.

1. **Search first** to find the right tool:

   ```bash
   mcpl search "list projects"
   ```

2. **Get example** for complex tools:

   ```bash
   mcpl inspect sentry search_issues --example
   ```

3. **Call with required params**:

   ```bash
   mcpl call vercel list_projects '{"teamId": "team_xxx"}'
   ```

### Alternative: List Server Tools

If you know which server to use but not the tool name:

```bash
mcpl list vercel    # Shows all tools with required params
```

---

## Error Recovery

If a tool call fails, mcpl provides helpful suggestions:

- **Tool not found**: Shows similar tool names from that server
- **Missing parameters**: Shows required params and an example call
- **Validation errors**: Shows expected parameter types

---

## Troubleshooting

| Command                                      | Purpose                                             |
|----------------------------------------------|-----------------------------------------------------|
| `mcpl verify`                                | Test all server connections                         |
| `mcpl session status`                        | Check daemon and server connection status           |
| `mcpl session stop`                          | Restart daemon (stops current, auto-restarts)       |
| `mcpl config`                                | Show current configuration                          |
| `mcpl call <server> <tool> '{}' --no-daemon` | Bypass daemon for debugging                         |

### Common Issues

- **Server not connecting**: Run `mcpl verify` to test connections
- **Stale connections**: Run `mcpl session stop` then retry
- **Timeout errors**: Increase with `MCPL_CONNECTION_TIMEOUT=120`

---

## For Orchestrator

- Use `mcpl search` or `mcpl list` for discovery
- Delegate actual MCP tool execution to agents
- When delegating, tell agents that MCP servers are available via `mcpl`

## For Agents

- Use the full mcpl workflow above
- Always search or list before calling unknown tools
- Execute tools as needed for your task
