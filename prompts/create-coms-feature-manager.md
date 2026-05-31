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

### Step 0: Check for Existing Prompt

Check if `.pi/prompts/coms-feature-manager.md` already exists in the current project.

If it **does NOT exist** → proceed to Step 1.

If it **exists** → ask the user using ask_user:

> `.pi/prompts/coms-feature-manager.md` already exists. What do you want to do?

Options:

- **Update** — Re-generate from template, preserving any manual customizations where possible
- **Overwrite** — Delete and generate fresh from template
- **Cancel** — Keep the existing prompt, do nothing

If **Update**: read the existing prompt first, then generate the new one, and merge any
custom sections the user added (sections not in the template) into the new output.

If **Overwrite**: delete the existing file and proceed from Step 1.

If **Cancel**: stop and inform the user.

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

Ask the user using ask_user:

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

If the user doesn't provide values, use `TBD` as the placeholder text (never leave `{{...}}` tokens in the output).

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
> Run `/reload` to register the new `/coms-feature-manager` command.
>
> To use it: start a coms session, then run `/coms-feature-manager` to activate the manager role.
> The manager will coordinate with a coder peer via coms to implement features.

List the key customizations made (test command, verification approach, included/excluded sections).

### Step 7: Validate the Generated Prompt (MANDATORY)

After writing the file, read it back and validate against the current project:

1. **No remaining placeholders** — search for `{{` in the output. If any `{{PLACEHOLDER}}` values
   remain unfilled, either fill them now or remove the line/section they belong to.
2. **No stale HTML comments** — search for `<!--`. All comment markers must be removed.
3. **Test command works** — run the test command from the prompt and verify it executes
   (it doesn't need to pass, just confirm the command is valid).
4. **File paths are correct** — verify any hardcoded paths in the prompt exist on disk.
5. **Sections match project** — if deploy/E2E sections are included, verify deploy commands
   are real. If removed, verify no dangling references to deployment remain in other sections
   (e.g., workflow steps, final sign-off).
6. **Workflow is coherent** — read the Workflow section end-to-end and confirm every step
   makes sense for this project. No references to features the project doesn't have.

If any issues are found, fix the generated prompt and re-write it. Report what was fixed.
