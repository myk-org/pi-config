# Project Settings Internals

How project-level settings are defined, resolved, and consumed. For the user-facing key reference — every setting
with its type, default, and environment variable — see [Configuration & Settings](configuration.html). This page
covers the machinery underneath: the schema source, the CLI, prompt injection, and the settings TUI.

## Settings Files and Resolution

Settings live in `.pi/pi-config-settings.json` at the repository root; a global fallback lives at
`~/.pi/pi-config-settings.json`. Values resolve project file → global file → environment variable →
default.

`pi-config-settings.json` is the only settings filename read or written (issue #1086). A legacy
`pi-config-settings.jsonc` used to win over the `.json` file, which silently hid settings written to
`.json` — including `dangerous_command_allowlist` entries added by an approval, so the gate started
prompting for commands it had already allowed. The legacy file is handled once: if its `.json`
counterpart is absent its parsed content is written to `.json` — published by an atomic rename, so a
concurrent reader never parses a partial file — and the file is renamed to
`pi-config-settings.jsonc.migrated`; if `.json` already exists it is left alone and ignored; if it
cannot be parsed it is refused, never overwritten (same contract as a corrupt settings file), and
settings writes to that directory are refused until the file is repaired so a fresh `.json` cannot
bypass it; a legacy file that git tracks or that is a symlink is never migrated, because a clone
could otherwise ship a tracked `.jsonc` and have it laundered into the untracked `.json` that
`projectSettingsTrust` accepts. That tracked-file refusal applies to the project scope only: a
home directory cannot be attacked by a repo shipping a file, and refusing there would break a
dotfiles-managed `~/.pi`. The migration logs paths only, never values.

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

Never instruct agents to read `pi-config-settings.json` manually.

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
- **Write format:** The TUI writes plain JSON (atomic write-then-rename) to the scope's settings file.
  Comments in the written file are lost on write, by design; the shipped `pi-config-settings.example.json`
  is the reference.
- **Immediate save:** Each change writes immediately with `clearSettingsCache()`.

Files: `extensions/orchestrator/settings-tui.ts`, `settings-tui-helpers.ts`, `settings-tui-submenus.ts`.

## Module

`extensions/orchestrator/project-settings.ts`

## Related Pages

- [Configuration & Settings](configuration.html) — the full settings key reference and resolution order.
- [Rules and Layers](rules-and-layers.html) — how rules consume settings through conditionals and frontmatter gates.
- [CLI Provider Internals](cli-provider.html) and [Async & Runtime Internals](async-internals.html) — extensions driven by these settings.
