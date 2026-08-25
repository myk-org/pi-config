# MCP client (mcpc)

Use the `mcpc` command for all MCP server interactions.
If a task needs a tool outside current capabilities, check `mcpc` for available tools.
Orchestrator discovers tools via `mcpc grep` / `mcpc @<session> tools-list` and delegates execution to agents.

Config file (user-owned): `~/.pi/pi-config/mcp.json`.
Pi runs `mcpc connect ~/.pi/pi-config/mcp.json --stdio` on process start when that file exists.
After you edit `mcp.json`, run `/mcpc connect` (or restart pi). Already-active servers stay as `mcpc` reports them.

## mcpc commands

| Command | Purpose |
|---|---|
| `mcpc` / `mcpc --json` | Active sessions and OAuth profiles |
| `mcpc grep "<query>"` | Search tools across sessions |
| `mcpc @<session>` | Server info and tools overview |
| `mcpc @<session> tools-list` | List tools |
| `mcpc @<session> tools-get <name>` | Tool schema |
| `mcpc @<session> tools-call <name> …` | Call a tool (`arg:=value` or JSON) |
| `mcpc @<session> restart` | Restart that session bridge |

`--stdio` is required on connect. Do not omit it.

## Workflow

1. **Search** → `mcpc grep "list projects"` (or `mcpc @<session> tools-list`)
2. **Inspect** → `mcpc @<session> tools-get <tool>`
3. **Call** → `mcpc @<session> tools-call <tool> '{"param":"v"}'`

## Troubleshooting

- **Connect failed at pi start:** session still works; check `~/.pi/logs/orchestrator/` and `/mcpc connect`
- **Missing binary:** `npm install -g @apify/mcpc`
- **No config file:** create `~/.pi/pi-config/mcp.json` (standard `mcpServers` JSON)
