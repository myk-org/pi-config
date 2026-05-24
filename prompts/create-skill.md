---
description: "Create a reusable skill from a successful workflow — /create-skill <name>"
---

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug
> while executing this command — DO NOT work around it silently. Ask the user:
> "Should I create a GitHub issue for this?" Route to `myk-org/pi-config` for prompt/extension issues.

## Raw Arguments

```text
$ARGUMENTS
```

# Create Skill

Save a successful workflow as a reusable pi skill.

## Usage

- `/create-skill <name>` — Create a skill with the given name from the current conversation
- `/create-skill` — Prompt for a name

## Workflow

### Step 1: Determine Skill Name

If a name was provided in the raw arguments, use it. Otherwise, ask the user.

The name must be:

- lowercase, hyphenated (e.g., `debug-container-build`)
- max 64 characters
- descriptive of what the skill does

### Step 2: Extract the Workflow

Review the current conversation and identify:

- What task was accomplished
- What steps were followed
- What commands were run
- What pitfalls were encountered
- What verification was done

### Step 3: Write the SKILL.md

Create the skill file at `~/.agents/skills/<name>/SKILL.md`:

```bash
mkdir -p ~/.agents/skills/<name>
```

The SKILL.md must follow this exact format:

```markdown
---
name: <name>
description: "<one-line description of what this skill does and when to use it — max 1024 chars>"
---

# <Skill Title>

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

**Rules:**

- **Be specific** — exact commands, exact file paths, exact verification steps
- **No fluff** — skip background, motivation, history — just the procedure
- **Include pitfalls** — what went wrong during this session and how it was resolved
- **Include verification** — how to confirm each step worked
- **One line description** — the description field is what pi uses to match skills to tasks

### Step 4: Confirm

Tell the user:

> ✅ Skill `<name>` created at `~/.agents/skills/<name>/SKILL.md`
>
> It will be available in the next pi session. Reload pi to use it immediately.
