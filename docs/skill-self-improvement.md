# Skill Self-Improvement

A skill is an instruction file a future session reads instead of rediscovering a workflow. It rots when
the code it documents moves: a renamed flag, a deleted script, a step that now fails.

The post-turn skill review closes that gap. After a substantive turn, Pi asks a small review agent whether
the turn contradicts one of the project's own skills, and patches it when it does.

## What Review Runs

| Condition | Effect |
|---|---|
| The turn used at least one tool | Review may run (a plain answer teaches no command). |
| A tool call in the turn was blocked | No review — a blocked turn is not a lesson. |
| A review is already in flight, or one ran within the last 5 minutes | No review. |
| `skill_review` is `false` | No review. |
| The session is a subagent child, an oneshot (`-p`, `--mode json`), or has no async LLM path | No review. |

The review runs as the `skill-reviewer` agent in the background. It reads the turn digest (what the
assistant said, which tools ran) and the skills under `.pi/skills/`. Its text output is never consumed —
provenance and the notice come from a filesystem diff — so it is one of the two documented `fireAndForget`
agents (dreaming is the other, see `rules/35-memory.md`).

## Ownership: Whose File May Be Patched

The review may patch **only skills this project owns**, and ownership is decided by real path after
`realpath` — not by matching a prefix string.

| Location | Owned? |
|---|---|
| `<project>/.pi/skills/<name>/` (SKILL.md, `references/*.md`, new skill directories) | Yes |
| Skills shipped in the `pi-orchestrator-config` npm package | No — product surface |
| User-global skills under `~/.pi/agent/skills/` and `~/.agents/skills/` | No — shared across projects |
| Skills installed from other repositories or marketplaces | No |
| Anything inside `.pi/skills/` reached through a symlink that resolves outside | No |

A shipped skill is product surface and a third-party skill is somebody else's file; patching either is data
loss nobody sees coming. The review child is also denied a shell and every write tool outside the owned
directory, so the rule is enforced, not just stated.

## Provenance

Every file the review adds or modifies is recorded in `.pi/data/skill-review.jsonl`, one JSON line per file:

```json
{"skill":"searxng","action":"patched","file":"SKILL.md","sessionId":"…","turnId":"…:42","at":"2026-01-01T00:00:00.000Z"}
```

`action` is `patched` when the skill already existed and `written` when the review created it. The record is
derived from a before/after snapshot of the owned tree, so a bad patch is attributable and revertible even
if the review agent reported nothing.

## The Notice

When the review changed something, Pi shows one line after the turn:

```text
📙 Self-improvement review: Skill 'image-pixel-measurement' patched · Skill 'homeassistant' written (references/voice-pe-ecosystem.md)
```

One line per turn, one entry per skill, and nothing at all when nothing changed. The content of an edit is
deliberately not reported — the action is the signal, the provenance record has the file.

## Related Pages

- [Background Memory Consolidation (Dreaming)](background-dreaming.html) — the dream pass, which may also
  create project skills
- [Memory Architecture](memory-architecture.html) — topic files, scoring, and promotion
