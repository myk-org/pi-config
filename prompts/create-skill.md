---
description: "Create a reusable skill from a successful workflow — /create-skill <name>"
---

## Raw Arguments

```text
$ARGUMENTS
```

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug
> while executing this command — DO NOT work around it silently. Ask the user:
> "Should I create a GitHub issue for this?" Route to:
> `myk-org/pi-config` for prompt/extension issues, or to the relevant tool's repository for CLI issues.
> Do not silently skip steps or apply manual fixes that hide the root cause.

# Create Skill

Save a successful workflow as a reusable pi skill.

## Usage

- `/create-skill <name>` — Create a skill with the given name from the current conversation
- `/create-skill` — Prompt for a name and scope

## Workflow

### Step 1: Determine Skill Name

If a name was provided in the raw arguments, use it. Otherwise, ask the user.

The name must be:

- lowercase, hyphenated (e.g., `debug-container-build`)
- max 64 characters
- descriptive of what the skill does

Validate the name:

- Must match `^[a-z][a-z0-9-]*$` (lowercase, hyphens, starts with letter)
- No spaces, underscores, or special characters
- If invalid, ask the user to provide a valid name

### Step 1.5: Determine Skill Scope

Ask the user where to create the skill:

> Where should this skill be created?
>
> - **Global** (`~/.agents/skills/`) — available in all projects
> - **Project** (`.pi/skills/`) — available only in this project

Use `ask_user` with options: `["Global (~/.agents/skills/)", "Project (.pi/skills/)"]`

Store the chosen path prefix for Step 3.

### Step 2: Extract the Workflow

Review the current conversation and identify:

- What task was accomplished
- What steps were followed
- What commands were run
- What pitfalls were encountered
- What verification was done

### Step 3: Write the SKILL.md

Create the skill file at the chosen location from Step 1.5:

- **Global:** `~/.agents/skills/<name>/SKILL.md`
- **Project:** `.pi/skills/<name>/SKILL.md`

```bash
mkdir -p <chosen-path>/<name>
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

**Security:** Before writing the SKILL.md, strip any secrets, API keys, tokens,
passwords, or credentials from the workflow steps. Replace with placeholders
like `<API_KEY>` or `$ENV_VAR`. Skills are stored in plain text.

**Rules:**

- **Be specific** — exact commands, exact file paths, exact verification steps
- **No fluff** — skip background, motivation, history — just the procedure
- **Include pitfalls** — what went wrong during this session and how it was resolved
- **Include verification** — how to confirm each step worked
- **One line description** — the description field is what pi uses to match skills to tasks

### Step 4: Confirm

Tell the user:

> ✅ Skill `<name>` created at `<chosen-path>/<name>/SKILL.md`
>
> **Global skills** are available in all projects. **Project skills** are available only in this project.
> Reload pi to use it immediately.
