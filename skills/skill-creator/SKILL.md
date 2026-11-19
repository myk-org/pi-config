---
name: skill-creator
description: "Save successful workflows as reusable pi skills. Use when a workflow worked well and should be preserved for future use."
---

# Create Skills from Experience

## When to Use

After completing a task that involved a non-obvious workflow:

- Multi-step debugging process that worked
- Build/deploy procedure that required specific steps
- Integration pattern that took multiple attempts to get right
- Any workflow where you think "I should remember how to do this"

## How to Create a Skill

1. **Identify the workflow** — what steps did you follow? What worked?
2. **Write the SKILL.md** — save to `.pi/skills/<name>/SKILL.md` (the project's own skills dir)
3. **Keep it specific and actionable** — steps, commands, verification

## SKILL.md Format

```markdown
---
name: skill-name
description: "One-line description of what this skill does and when to use it."
skill-maintenance: auto
---

# Skill Title

## When to Use

- Trigger condition 1
- Trigger condition 2

## Steps

1. Step one with exact commands
2. Step two
3. Verification step

## Pitfalls

- Common mistake and how to avoid it
```

## Rules

- **name**: lowercase, hyphenated, max 64 chars
- **description**: one line, max 1024 chars, explains WHEN to use it
- **skill-maintenance**: always `auto` — it is what lets a later agent patch this skill when it drifts
  (omitting it on a brand-new `.pi/skills/<name>/SKILL.md` is auto-adopted on write; existing unmarked
  loaded skills — project, user-global, or symlinked shared — can be opted in with `/adopt-skill <name>`)
- **Body**: concrete steps, exact commands, verification
- **No fluff**: skip background, motivation, history — just the procedure
- **Include pitfalls**: what goes wrong and how to avoid it
- **Include verification**: how to confirm it worked

## Where to Save

```bash
mkdir -p .pi/skills/<skill-name>
# Write SKILL.md there, with skill-maintenance: auto in the frontmatter
```

Project skills under `.pi/skills/` are automatically discovered in this project.

**Brand-new global skills are copied by the user.** New skills are created under `.pi/skills/`
(unmarked files under `~/.agents/skills/` and `~/.pi/agent/skills/` are protected until adopted
with `/adopt-skill <name>`). Write the skill in `.pi/skills/` and hand the user the copy:

```bash
mkdir -p ~/.agents/skills/<skill-name> && cp -r .pi/skills/<skill-name>/. ~/.agents/skills/<skill-name>/
```

## Good vs Bad Skills

**Good skill:** Specific procedure with exact commands

```text
## Steps
1. Run `uv run pytest tests/ -q` to get baseline
2. Check for `FAILED` in output
3. If failures, run `uv run pytest tests/test_specific.py -v` for details
```

**Bad skill:** Vague advice

```text
## Steps
1. Run tests
2. Check results
3. Fix issues
```
