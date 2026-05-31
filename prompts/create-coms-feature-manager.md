---
description: "Generate a coms feature-manager prompt customized for the current project"
---

## Raw Arguments

```text
$ARGUMENTS
```

# Create Coms Feature Manager Prompt

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug
> while executing this command — DO NOT work around it silently. Ask the user:
> "Should I create a GitHub issue for this?" Route to:
> `myk-org/pi-config` for plugin/command spec or `myk-pi-tools` CLI issues.
> Do not silently skip steps or apply manual fixes that hide the root cause.

Generates a project-specific **coms feature manager** prompt from the template.
The coms feature manager pattern uses pi's coms system (`coms_send`/`coms_await`/`coms_list`)
to coordinate between a manager agent (reviewer) and a coder agent (implementer).

## What This Creates

A prompt file at `.pi/prompts/coms-feature-manager.md` in the current project that defines
a Feature Manager role — an agent that:

- Reviews and directs a coder peer via coms (inter-agent communication)
- Owns feature quality end-to-end
- Gates PR creation — coder cannot push without manager approval
- Iterates: review → feedback → wait for fixes → re-review

## Workflow

### Step 1: Read the Template

Read the template file:

```text
~/.pi/agent/git/github.com/myk-org/pi-config/templates/coms-feature-manager-prompt.md
```

This is the immutable source template. NEVER modify it.

### Step 2: Analyze the Project

Examine the current project to determine:

1. **Test command**: Look for `Makefile` (test target), `tox.ini`, `pyproject.toml` (pytest config),
   `package.json` (test script), or other test runners. Determine the exact command to run all tests.

2. **Test locations**: Where are tests stored? (`tests/`, `test/`, `__tests__/`, `spec/`, etc.)

3. **Project type**: Python, Node.js, Go, Java, etc. Determine from project files.

4. **Verification approach**: Determined by user input (see Step 2.5)

5. **AGENTS.md**: Does one exist? If so, note any architecture or review conventions.

6. **Security concerns**: Does the project handle auth, secrets, sensitive data?

### Step 2.5: Ask About Live Verification

Ask the user using AskUserQuestion:

> Does this project need **live/E2E verification** (deploy to dev, verify in browser/CLI, test unhappy paths)?

Options:

- **Yes** — Include E2E Verification AND Dev Server Operations sections
- **No** — Remove both sections (tests are sufficient)

If the user chooses **Yes**, ask a follow-up for the deploy details:

> Provide deploy details (or leave empty to fill later):
>
> - Deploy command (e.g., `make deploy-dev`, `kubectl apply`, `docker compose up`)
> - Dev URL (e.g., `http://localhost:8080`)
> - Health check command (e.g., `curl -s http://localhost:8080/health`)
> - Admin user (if applicable)

The user can provide these now or leave empty — the template will have `{{PLACEHOLDER}}` values they can fill manually later.

### Step 3: Fill Placeholders

Replace ALL `{{PLACEHOLDER}}` values in the template with project-specific values:

| Placeholder | How to determine |
|-------------|------------------|
| `{{TEST_COMMAND}}` | From Makefile, tox.ini, pyproject.toml, package.json |
| `{{TEST_LOCATIONS}}` | Scan for test directories |
| `{{VERIFICATION_STEP}}` | Based on project type — deploy+verify or just tests |
| `{{VERIFICATION_SIGNOFF}}` | Matching signoff line |
| `{{ADMIN_USER}}` | From project config if applicable |
| `{{DEV_URL}}` | From project config if applicable |
| `{{DEPLOY_COMMAND}}` | From Makefile, scripts, or docs |
| `{{DEPLOY_TASK}}` | Async subagent task description |
| `{{PROJECT_DIR}}` | Current working directory |
| `{{HEALTH_CHECK_COMMAND}}` | From project config if applicable |

### Step 4: Handle Optional Sections

For each section marked `[OPTIONAL]`:

- **Include it** if the project has the relevant feature (deploy, E2E, security, CLI, etc.)
- **Remove it entirely** (including the HTML comment markers) if not applicable
- Remove the `<!-- [OPTIONAL] ... -->` comment wrappers from included sections
- Remove the `<!-- -->` guidance comments (e.g., `<!-- Examples: ... -->`)

Also remove:

- The usage block at the top (between `> **Usage:**` and `---`)
- Any remaining `<!-- ... -->` HTML comments

### Step 5: Write the Output

Create the directory if needed and write the customized prompt:

```bash
mkdir -p .pi/prompts
```

Write to `.pi/prompts/coms-feature-manager.md`

### Step 6: Report

Tell the user:

> ✅ Created `.pi/prompts/coms-feature-manager.md`
>
> To use it: start a coms session, then load this prompt as the manager agent's system prompt.
> The manager will coordinate with a coder peer via coms to implement features.

List the key customizations made (test command, verification approach, included/excluded sections).
