# Skill Self-Improvement

A skill is an instruction file a future session reads instead of rediscovering a workflow. It rots when
the code it documents moves: a renamed flag, a deleted script, a step that now fails.

Skill maintenance keeps your adopted skills true while you work, without a background model call or
blocking tool guards:

- Pi's built-in `pi.getCommands()` supplies every skill loaded into the session (project `.pi/skills/` and
  `.agents/skills/`, user-global `~/.pi/agent/skills/` and `~/.agents/skills/`, and symlinked shared skills),
  falling back to `.pi/skills/` only when `pi.getCommands()` is unavailable;
- a skill you maintain carries `skill-maintenance: auto` in its frontmatter;
- while you use an adopted skill, a failed step triggers one mid-turn steer nudge to fix it;
- `write`/`edit`/`multi_edit` skill changes across all scopes (plus direct `.pi/skills/` tree diffs) are
  recorded in `.pi/data/skill-review.jsonl` and summarized in one line at turn end;
- no `write`/`edit` or `bash` calls are ever blocked.

## The Marker

```markdown
---
name: searxng
description: Search with the local SearXNG instance. Use for web search.
skill-maintenance: auto
---
```

`skill-maintenance: auto` is the whole opt-in. It marks a skill as adopted so agents keep it true as they
use it, and enables the mid-turn steer nudge when a step fails. There is no setting to turn on.

Skills are created marked: the `/create-skill` workflow and the dream pass both stamp the marker, and
writing a brand-new `SKILL.md` under `<project>/.pi/skills/<name>/SKILL.md` (in either the main checkout or
a linked worktree) without it automatically stamps `skill-maintenance: auto` and the maintainer instruction
on write.

## `/adopt-skill <name>`

Marks any non-package skill loaded into the session (project, user-global, `.agents/skills/`, or symlinked
shared skill). Idempotent, and autocomplete lists unmarked adoptable skills with their scope
(`project — mark for maintenance`, `user — mark for maintenance`).

```text
/adopt-skill searxng
```

It inserts `skill-maintenance: auto` into the frontmatter (creating frontmatter when the file has none) and
prepends the instruction that tells an agent what adoption asks of it:

> **IMPORTANT — keep this skill true:** this skill is adopted and it is your responsibility to fix or improve
> it whenever it is wrong, incomplete, or misleading while you use it (and add missing trigger keywords to its
> description if routing missed), then say one line: `Skill updated: <name> — <why>`.

Shipped package skills (`origin === "package"`, paths under `node_modules/.../skills/`, or symlinks pointing
to a registered package skill) are excluded from `/adopt-skill`. Re-running on a maintained skill answers
*already maintained*.

## Mid-Turn Nudge

When an adopted skill was used during the current turn (invoked via `/skill:<name>` or read from its skill
directory across any scope) and a tool call fails, Pi sends one `steer` nudge per adopted skill asking the
agent to fix the skill or note why it still applies. Unmarked skills never trigger a nudge.

## Provenance

Every skill change made via `write`, `edit`, or `multi_edit` across any scope is recorded as it happens in
`.pi/data/skill-review.jsonl`, one JSON line per file:

```json
{"skill":"searxng","action":"patched","file":"SKILL.md","sessionId":"…","turnId":"…:42","at":"2026-01-01T00:00:00.000Z"}
```

`action` is `patched` when the file already existed and `written` when it was created. Attribution comes from
the write call itself, so each line names the session and turn that made the change. Records are appended
(`O_APPEND`), so two sessions writing at once cannot overwrite each other; the file is rotated once it passes
1 MB. Provenance covers `write`/`edit`/`multi_edit` tool changes across all scopes; shell edits to
external, user-global, or symlinked skill paths are not snapshotted.

## The Notice

After the turn (or at the start of the next turn if a turn was aborted), if a skill file changed via
`write`/`edit`/`multi_edit` across any scope or via direct `.pi/skills/` tree diffs, Pi shows one line:

```text
📙 Self-improvement review: Skill 'image-pixel-measurement' patched · Skill 'homeassistant' written (references/voice-pe-ecosystem.md)
```

One line per turn, one entry per skill, and nothing when nothing changed. The content of an edit is
deliberately not reported — the action is the signal, and the provenance record has the file. Shell edits to
external, user-global, or symlinked skill paths are not snapshotted and do not appear in the turn-end notice.
If the provenance write fails, the line says so instead of claiming the change was recorded.

## Related Pages

- [Background Memory Consolidation (Dreaming)](background-dreaming.html) — the dream pass, which creates
  maintained skills
- [Commands and Tools](commands-and-tools.html) — `/create-skill` and the other workflow commands
- [Memory Architecture](memory-architecture.html) — topic files, scoring, and promotion
