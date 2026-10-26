# Pidash TUI Parity

Pidash is not a viewer — it is a peer surface. Every prompt the agent asks and
every operation the TUI offers is answerable from either surface, and state
converges: anything done in the TUI reflects in the browser and vice versa.
This page documents the parity contract and the seamless-switch walkthrough
(issue #968).

## The parity contract

| Surface | TUI | Browser | Convergence |
|---|---|---|---|
| ask_user questions | overlay dialog | inline action card | first answer wins; other surface sees the prompt closed |
| Dangerous-command approvals | `ui.select` prompt | same prompt rendered inline | first answer wins; enforcement semantics identical either way |
| Commit-trailer selection | `ui.select` prompt | same prompt rendered inline | first answer wins |
| Project-agent confirmation | `ui.confirm` prompt | same prompt rendered inline | first answer wins |
| `/tasks` menus | bridged select menus | Tasks panel (dedicated) | both operate the same live TaskStore |
| Coms peers | pool widget | Coms panel | same registry, same `deliverPrompt` path |
| New session / compact | `/new`, `/compact` | sidebar `+`, InfoBar `compact` | session lifecycle events broadcast to all browsers |
| Memory status | situation report (implicit) | Memory panel | read from the same scoring/topic modules |
| MCP servers | `/mcp` | MCP panel | both drive `pi mcp` |
| Settings | `/pi-config-settings` | Settings page | both write through the live settings module |

Two invariants hold everywhere:

1. **Operations go through the live session's extension state.** The browser
   sends a `pidash-command`; the owning extension applies it via its own module
   (TaskStore, coms `deliverPrompt`, project-settings writer); an event
   broadcasts the new state to every connected browser. The daemon never writes
   a store directly.
2. **First answer wins.** Prompt bridging (`extensions/shared/ui-bridge.ts`)
   renders the prompt in the TUI *and* the browser simultaneously. Whichever
   surface answers first resolves the prompt; the other sees it closed
   (`ui-dismiss` for the browser, `done()` for the TUI dialog). Enforcement
   semantics are never bypassed — the browser is just another transport for
   the same decision.

## Seamless-switch walkthrough

A scripted session driven alternately from TUI and browser with zero dead
ends. Run it yourself to verify parity after changes.

1. **Start** — `pi` in a project; open `http://localhost:19190` in two browser
   tabs (both watch the session).
2. **Chat from browser** — type a prompt in tab A. Streaming appears in the
   TUI, tab A, and tab B simultaneously.
3. **Ask from TUI side** — prompt the agent with something that triggers
   `ask_user` (e.g. "ask me a question with options"). The question appears as
   an action card in both tabs AND as a dialog in the TUI. Answer in tab B.
   The TUI dialog closes instantly; tab A's card shows "✓ Answered".
4. **Dangerous approval from browser** — ask the agent to run a command that
   trips the dangerous-command gate. The approval prompt (allow once / always
   allow project / always allow everywhere / no) renders in both surfaces.
   Answer "No" from the TUI: both browser cards close. Re-run and answer
   "Yes — run once" from the browser: the command executes with identical
   enforcement semantics.
5. **Tasks from browser** — open the Tasks panel (InfoBar `☐` icon). Create
   "Demo task". The TUI task widget updates live. Start it from the browser;
   the TUI spinner picks it up. Complete it from the TUI `/tasks` menu — the
   panel's counter updates without refresh. Both tabs converge.
6. **Coms from browser** — with a peer session running, open the Coms panel:
   the peer appears with live busy/queue/context state. Send a message from
   the browser; the peer receives it through the same path as `coms_send`,
   and the reply surfaces in chat.
7. **Session lifecycle from browser** — click `+` in the sidebar: name the
   session, pick a model, create. The session switches everywhere (TUI shows
   the new session; browsers replay it). Trigger `compact` from the InfoBar —
   compaction runs and context usage drops in every surface.
8. **Memory + MCP + Settings** — Memory panel shows the situation report,
   topics, and budget usage. MCP panel lists servers (`pi mcp list`) with
   login/logout. The Settings page shows every key from `settings-keys.json`
   with project/global scope tabs; toggle a boolean — it writes through the
   live settings module (atomic write, comments-lost semantics identical to
   `/pi-config-settings`) and both tabs refresh the stored value.
9. **Switch mid-flight** — while the agent streams, switch sessions from the
   TUI (`/resume`) — the browser follows. Switch back from the browser session
   menu — the TUI follows. No dead ends in either direction.

## Architecture notes

- **Prompt bridging** — `extensions/shared/ui-bridge.ts` (`createBridgedUi`):
  `select`/`confirm`/`input` built on `ctx.ui.custom` so a browser answer can
  close the TUI dialog via the `done` callback. Degrades to plain prompts when
  the event bus or `ui.custom` is unavailable.
- **Event flow** — browser → daemon (`pidash-command`) → pi session
  (`handleWsMessage`) → owning extension (`pi.events`) → result event →
  daemon → every browser watching the session.
- **Settings writes** — `extensions/pidash/browser-ops.ts` reads and writes
  through `getSettingsPath`/`parseSettingsFile`/`writeSettingsFile` and clears
  the settings cache; `settings-keys.json` is the single source of truth for
  the key list, types, and defaults.
- **Tests** — `tests/node/shared/ui-bridge.test.ts` (race semantics),
  `tests/node/pitasks/pidash-bridge.test.ts` (task ops + live broadcast),
  `tests/node/pidash/browser-ops.test.ts` (settings round-trip),
  `tests/node/pidash/parity-projections.test.ts` (coms/settings pure
  projections).
