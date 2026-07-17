# CLI Provider Extension

Registers real CLI tools as pi providers under the `cli-*` namespace, parallel to `acpx-*`.

## Settings

| Setting | Env | Example |
|---------|-----|---------|
| `cli_agents` | `CLI_AGENTS` | `"cursor"` or `["claude","gemini","cursor"]` |

```json
{
  "cli_agents": ["claude", "cursor"]
}
```

Empty / unset → extension registers nothing.

## Providers and models

| Provider id | Binary | Model id shape |
|-------------|--------|----------------|
| `cli-claude` | `claude` | `claude:<model>` |
| `cli-gemini` | `gemini` | `gemini:<model>` |
| `cli-cursor` | `agent` | `cursor:<model>` |

Select e.g. `cli-cursor:composer-2` in the pi model picker.

## Sessions

Session ids are stored under `~/.pi/cli-sessions/` and passed back via `--resume` / `--continue` on later turns.

## Async

Unlike `acpx-provider`, this extension **loads in subagent children** (`PI_SUBAGENT_CHILD`).  
`supportsAsyncLlm` is **true** for `cli-*` — no coerce-to-sync, no sidecar required.

`acpx-*` behavior is unchanged (still capability-gated).

## Module

`extensions/cli-provider/`
