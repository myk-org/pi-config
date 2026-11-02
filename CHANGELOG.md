# Changelog

## [4.23.0] - 2026-11-02

- Minimum pi version raised to 1.5.0 — the extension floor, the sidecar floor, and every manifest move together.
- Interactive dialogs (ask_user and the pidash bridge) now report "blocked on user input" while they wait, so terminals that track program status show pi as waiting instead of busy.
- This changelog ships with the package and pi reads it after `pi update --extensions`, so an update now tells you what changed.
- The `subagent` tool keeps its `agentScope` values as a real enum after pi 1.5.0 changed how `StringEnum` types itself, so the parameter stays validated and documented.
- Release workflow keeps this changelog current on every bump, and a changelog-only change now marks the package as affected.
- Docs: MCP OAuth client registration (`auto` / `dcr` / `cimd`), `PI_SELF_UPDATE_COMMAND` for wrapper installs, and the billed-vs-estimated cost contract.

## [4.22.4] - 2026-11-02

- Minimum pi version raised to 1.5.0 (extension and sidecar floors, manifests).
- Sidecar reports cost billed by the provider instead of only estimated cost.
- Status reporting for interactive dialogs blocked waiting on user input.
