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
2. **Write the SKILL.md** — save to `~/.agents/skills/<name>/SKILL.md`
3. **Keep it specific and actionable** — steps, commands, verification

## SKILL.md Format

```markdown
---
name: skill-name
description: "One-line description of what this skill does and when to use it."
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
- **Body**: concrete steps, exact commands, verification
- **No fluff**: skip background, motivation, history — just the procedure
- **Include pitfalls**: what goes wrong and how to avoid it
- **Include verification**: how to confirm it worked

## Where to Save

```bash
mkdir -p ~/.agents/skills/<skill-name>
# Write SKILL.md there
```

Skills in `~/.agents/skills/` are user-local and automatically discovered by pi.

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
