# Extension Commands

Extension commands (like `/pidash`, `/pidiff`, `/btw`, `/status`) are registered in
the extension source files under `extensions/`. Each command uses
`context.registerCommand()` with a name, description, and handler.

## Known Extension Commands

| Command | Source | Description |
|---------|--------|-------------|
| `/btw` | `btw.ts` | Quick side questions |
| `/pidash` | `pidash/pidash.ts` | Manage pidash daemon (start/stop/restart/status) |
| `/pidiff` | `pidiff/pidiff.ts` | Manage pidiff daemon (start/stop/restart/status) |
| `/status` | `status.ts` | Unified session status snapshot |
| `/async-status` | `async-agents.ts` | Background agent status |
| `/dream` | `dreaming.ts` | Memory consolidation |
| `/dream-auto` | `dreaming.ts` | Toggle automatic dreaming |
| `/cron` | `cron.ts` | Schedule recurring tasks |
| `/nvim-changed-files` | `nvim.ts` | Send changed files to nvim quickfix |
| `/coms` | `coms/coms-wrapper.ts` | P2P agent communication (start/stop/status) |
| `/coms-net` | `coms/coms-net-wrapper.ts` | Networked agent communication (start/connect/disconnect/stop/status) |
| `/external-ai-models-refresh` | `extended-autocomplete.ts` | Refresh AI CLI model cache |

## Adding an Extension Command

1. Register via `context.registerCommand()` in the extension source file under `extensions/`
2. When adding slash command arguments: update autocomplete in `extensions/orchestrator/extended-autocomplete.ts`
   - Extension commands: update the entry in the `completions` map
   - Prompt templates: update the entry in `completions` AND ensure the command is in `promptTemplateCommands`
   - If adding a new completable command, follow the existing patterns (static items, cached fetchers, etc.)
