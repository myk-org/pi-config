# Skill Self-Improvement

A skill is an instruction file a future session reads instead of rediscovering a workflow. It rots when
the code it documents moves: a renamed flag, a deleted script, a step that now fails.

Skill maintenance keeps the project's own skills true while you work, without a background model call:

- a skill you maintain carries `skill-maintenance: auto` in its frontmatter;
- while you use it, a failed step triggers one mid-turn nudge to fix it;
- agents may patch a maintained skill, and every write is recorded;
- a skill nobody marked is never modified by an agent.

## The Marker

```markdown
---
name: searxng
description: Search with the local SearXNG instance. Use for web search.
skill-maintenance: auto
---
```

`skill-maintenance: auto` is the whole opt-in. It says two things: this skill is ours to maintain, and an
agent that finds it wrong may fix it. There is no setting to turn on.

Skills are created marked: the `/create-skill` workflow and the dream pass both stamp the marker, and an
unmarked creation is refused by the write guard with the exact line to add.

## `/adopt-skill <name>`

Marks an existing project skill. Idempotent, and it lists only the unmarked skills under
`<project>/.pi/skills/` in autocomplete.

```text
/adopt-skill searxng
```

It inserts `skill-maintenance: auto` into the frontmatter (creating frontmatter when the file has none) and
prepends the instruction that tells an agent what the marker asks of it:

> **IMPORTANT — keep this skill true:** if it was wrong, incomplete or misleading while you used it, fix it
> now (and its description, if routing was wrong), then say one line: `Skill updated: <name> — <why>`.

A shipped, user-global or third-party skill is refused with *copy it into the project first* — maintenance
never reaches outside the project. Re-running on a maintained skill answers *already maintained*.

## Ownership: Whose File May Be Written

A skill file is writable only when it is **marked** *and* its real path (after `realpath`) is under
`<project>/.pi/skills/`. Everything else is blocked, with the reason naming what it is:

| Location | Result |
|---|---|
| `<project>/.pi/skills/<name>/SKILL.md` (marked) | Allowed |
| `<project>/.pi/skills/<name>/…` (unmarked) | Blocked — run `/adopt-skill <name>` |
| Any skill where the write itself adds `skill-maintenance: auto` | Allowed — otherwise creation could never start |
| Skills shipped in the `pi-orchestrator-config` package (`node_modules`, `skills/`) | Blocked — product surface |
| User-global skills (`~/.pi/agent/skills/`, `~/.agents/skills/`) | Blocked — shared by every project |
| Skills from another repository or marketplace | Blocked — somebody else's file |
| Anything under `.pi/skills/` reached through a symlink (including a dangling one) | Blocked — the path resolves outside |

The rule is enforced in code by a `tool_call` guard on `write`/`edit`/`multi_edit`, so a blocked write is
refused before it happens and the agent is told what to do instead.

### The shell reads skills, never writes them

A `bash` command that names a skills area passes only when **every** `;`, `&&`, `||` or `|` segment is a read:
an allowlisted verb (`cat`, `less`, `head`, `tail`, `grep`, `rg`, `ls`, `stat`, `wc`, `diff`, `md5sum`,
`sha256sum`) with no write operator. `mkdir` is the one exception, and only for a directory inside this
project's own `.pi/skills/` that resolves there — the `SKILL.md` itself still has to be written with
`write`/`edit`, where the marker and ownership apply.

Everything else blocks, including the shapes that defeated earlier versions: `>`, `>>`, `>&`, `tee`, `cp`, `mv`,
`rm`, `sed -i`, `install`, `dd`, `truncate`, `chmod`; a bare `SKILL.md`; a `cd`; a command substitution
(`$(…)`, backticks); an option that runs a program (`--pre`); a path through a symlink; and any reference the
guard cannot resolve. The shell is not a second way to write a skill — one write path means one place to be
correct.

Known limit, stated rather than guessed at: a path built by shell expansion — `t=…; … > "$t"`, `eval`,
`find -exec` — carries no literal reference, so no text rule can see it. The change still reaches the turn-end
notice.

## Provenance

Every allowed skill write is recorded as it happens in `.pi/data/skill-review.jsonl`, one JSON line per file:

```json
{"skill":"searxng","action":"patched","file":"SKILL.md","sessionId":"…","turnId":"…:42","at":"2026-01-01T00:00:00.000Z"}
```

`action` is `patched` when the file already existed and `written` when it was created. Attribution comes from
the write call itself, not from diffing the tree afterwards, so a line names the session and turn that made
the change. Records are appended (`O_APPEND`), so two sessions writing at once cannot overwrite each other;
the file is rotated once it passes 1 MB.

## The Notice

After the turn, if a maintained skill file changed, Pi shows one line:

```text
📙 Self-improvement review: Skill 'image-pixel-measurement' patched · Skill 'homeassistant' written (references/voice-pe-ecosystem.md)
```

One line per turn, one entry per skill, and nothing when nothing changed. The content of an edit is
deliberately not reported — the action is the signal, and the provenance record has the file. If the
provenance write fails, the line says so instead of claiming the change was recorded.

## Related Pages

- [Background Memory Consolidation (Dreaming)](background-dreaming.html) — the dream pass, which creates
  maintained skills
- [Commands and Tools](commands-and-tools.html) — `/create-skill` and the other workflow commands
- [Memory Architecture](memory-architecture.html) — topic files, scoring, and promotion
