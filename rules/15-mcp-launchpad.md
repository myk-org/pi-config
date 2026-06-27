# MCP Launchpad (mcpl)

Use the `mcpl` command for all MCP server interactions.
If a task requires functionality outside current capabilities, check `mcpl` for available tools.
Orchestrator discovers tools via `mcpl search`/`mcpl list` and delegates execution to agents.

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
| `mcpl call <server> <tool> '{}' --no-daemon` | Bypass daemon for debugging                         |
| `mcpl verify`                                | Test all server connections                         |
| `mcpl session status`                        | Check daemon and server connection status           |
| `mcpl session stop`                          | Restart daemon (stops current, auto-restarts)       |
| `mcpl config`                                | Show current configuration                          |

---

## Workflow

**Never guess tool names** — always discover first.

1. **Search** → `mcpl search "list projects"` (or `mcpl list <server>` if you know the server)
2. **Inspect** → `mcpl inspect sentry search_issues --example` (for complex tools)
3. **Call** → `mcpl call vercel list_projects '{"teamId": "team_xxx"}'`

---

## Error Recovery

On failure, mcpl suggests fixes: similar tool names (not found), required params + example (missing params), or expected types (validation errors).

## Troubleshooting

- **Server not connecting**: `mcpl verify` → **Stale connections**: `mcpl session stop` then retry → **Timeouts**: set `MCPL_CONNECTION_TIMEOUT=120`
