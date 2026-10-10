# Project Settings Internals

How project-level settings are defined, resolved, and consumed. For the user-facing key reference — every setting
with its type, default, and environment variable — see [Configuration & Settings](configuration.html). This page
covers the machinery underneath: the schema source, the CLI, prompt injection, and the settings TUI.

## Settings Files and Resolution

Settings live in `.pi/pi-config-settings.jsonc` (preferred) or `.pi/pi-config-settings.json` at the repository
root; `.jsonc` allows comments and wins if both exist. A global fallback lives at
`~/.pi/pi-config-settings.jsonc` or `.json`. Values resolve project file → global file → environment variable →
default.

See [Configuration & Settings](configuration.html) for the full resolution walkthrough.

## `settings-keys.json` Is the Single Source of Truth

All setting keys, types, env vars, and defaults are defined in `settings-keys.json` at the repository root. Both
the TypeScript extension and the Python CLI derive from this single file, so the two implementations cannot drift
apart. When adding a key, edit `settings-keys.json` first — never hardcode defaults in either implementation.

## CLI

```bash
uv run myk-pi-tools settings get                   # all keys as JSON
uv run myk-pi-tools settings get dco use_worktrees # specific keys
```

## Agent Prompt Injection

Use `{{SETTINGS:key1,key2}}` in agent `.md` files to inject resolved values at prompt assembly time. The
placeholder is replaced by `substituteSettingsPlaceholders` in `rule-placeholders.ts` before the system prompt
reaches any model (native or CLI/ACPX), as a JSON object of the resolved values.

This is **not** the same pipeline as orchestrator rules. Agents only get `{{SETTINGS:…}}` JSON injection; rules
use conditional assembly — `{{IF:}}` / `{{IFNOT:}}` blocks, comparison literals, and whole-file
`requires_setting` / `requires` frontmatter gates. See [Rules and Layers](rules-and-layers.html) for the full
conditional grammar and the distinction between the two mechanisms.

Never instruct agents to read `pi-config-settings.jsonc` / `.json` manually.

## Settings TUI

The `/pi-config-settings [project|global]` slash command opens an interactive TUI overlay for editing settings.
For what it looks like from the user side, see [Configuration & Settings](configuration.html); the internals:

- **Two scopes:** `project` (writes to `<repo>/.pi/pi-config-settings.json`) and `global` (writes to `~/.pi/pi-config-settings.json`). Press Tab to switch.
- **Source indicators:** Each setting shows its source: `P` (project file), `G` (global file), `E` (env var), `D` (default).
- **Smart pickers:** Provider and model fields use fuzzy-searchable `SelectList` from `ctx.modelRegistry`.
  `image_model` is hard-filtered to provider `google` **and** image-capable models; if that filtered list is
  empty, the TUI falls back to free-text `InputSubmenu`.
- **Agent lists:** `acpx_agents` and `cli_agents` use multi-select with ☑/☐ toggles.
- **Agent overrides:** Nested per-agent provider/model editor.
- **Secret masking:** Keys matching `token|secret|password|auth` are masked in the list and never prefilled in the editor.
- **JSONC preservation:** The TUI always writes to `.json` (not `.jsonc`) to preserve user comments in `.jsonc` files.
- **Immediate save:** Each change writes immediately with `clearSettingsCache()`.

Files: `extensions/orchestrator/settings-tui.ts`, `settings-tui-helpers.ts`, `settings-tui-submenus.ts`.

## Module

`extensions/orchestrator/project-settings.ts`

## Related Pages

- [Configuration & Settings](configuration.html) — the full settings key reference and resolution order.
- [Rules and Layers](rules-and-layers.html) — how rules consume settings through conditionals and frontmatter gates.
- [CLI Provider Internals](cli-provider.html) and [Async & Runtime Internals](async-internals.html) — extensions driven by these settings.
