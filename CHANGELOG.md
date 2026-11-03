# Changelog

## [4.24.1] - 2026-11-03

- Dreaming no longer stores re-derivable changelog: `[done]` takes non-derivable outcomes only (conclusions, measurements, root causes) and reorganizing prunes PR/version/ticket
  history, so `completions` shrinks instead of rotating changelog for changelog. A live run took this project's topic from 18 entries to 2, keeping the cost baseline and the
  self-reload finding.
- Learned memory now survives maintenance: anything a dream deletes that is pinned, enforced, or review-distilled is restored when it finishes, and a topic file it deleted is
  rebuilt. A deliberate removal is respected because removals are recorded as tombstones rather than inferred from score state — the inference inverted whenever the scheduled
  rebuild ran mid-dream.
- `completions` is capped at 6,000 characters through per-topic caps, applied by both write paths. The cap is never satisfied by deleting memory: an over-cap topic is reported and
  left intact.

## [4.24.0] - 2026-11-03

- `/pr-review` asks how to decide after the findings table — `Post all`, `Skip all`, or
  `Decide one by one` — instead of one bulk answer for everything.
- Deciding one by one gives each finding its own dialog (post, skip, skip with reason, more
  context, stop), captures the skip reason at decision time, keeps author questions on their
  Approve / Edit / Skip path, and stores a reason even for a bare skip.
- Every `ask_user` prompt offers "💬 Discuss with AI first", which returns a sentinel meaning
  "talk about this decision first" rather than an answer; a caller that passes that row itself
  gets one row, and `allowDiscuss: false` removes it.
- Docs: the `ask_user` reference covers `allowDiscuss` and the sentinel; the workflow page
  documents the mode choice and the real turn cost.

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
