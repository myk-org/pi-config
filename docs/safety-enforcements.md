# Implementing Command Guards

Add enforcement rules to intercept and block destructive bash commands or sensitive git operations.

## Block a Destructive Command Pattern
Stop the agent from executing specific, potentially destructive commands using memory enforcement triggers.

```json
{
  "text": "Never prune docker images",
  "category": "pattern",
  "trigger": "bash_contains docker system prune",
  "action": "block"
}
```
Ask the agent to run the `memory_add` tool with these parameters to block commands matching the trigger. The agent evaluates the trigger against `bash` tool invocations and immediately rejects matching requests.

> **Tip:** You can also use the `bash_regex` trigger for more complex matches, or `tool_name` to block specific tools entirely.

## Trigger an Automatic Post-Command Script
Automatically run a deployment or cleanup script immediately after a specific command finishes.

```json
{
  "text": "Sync database after schema changes",
  "category": "pattern",
  "trigger": "bash_contains prisma db push",
  "action": "run_after ./scripts/sync-db.sh"
}
```
Ask the agent to run the `memory_add` tool with the `run_after` action. When the trigger matches a bash command, the enforcement engine will automatically execute the trailing script in the background.

## Restrict Allowed Automatic Scripts
Limit which scripts can be executed automatically by enforcement rules to prevent malicious chaining.

```bash
export PI_ENFORCEMENT_ALLOWED_COMMANDS="./scripts/sync-db.sh:make format:npm run build"
```
Set this environment variable in your terminal or container environment. When defined, any `run_after` actions must exactly match an entry in this colon-separated allowlist.

> **Warning:** Exact matches are required. Prefix matching is disabled to prevent shell chaining bypasses.

## Warn the Agent on Sensitive File Modifications
Inject a contextual warning directly into the agent's context whenever specific files are modified.

```json
{
  "text": "Ensure CI workflows are tested locally before pushing",
  "category": "pattern",
  "trigger": "file_modified .github/workflows/*.yml",
  "action": "warn"
}
```
Ask the agent to run the `memory_add` tool using a `file_modified` trigger and the `warn` action. When the agent uses file-writing tools (like `write` or `edit`) on matching paths, the memory text is automatically appended as a warning in the tool results.

## Require a Prerequisite Tool Call
Prevent the execution of a specific command unless another tool was invoked earlier in the same turn.

```json
{
  "text": "Always ask user before merging PRs",
  "category": "pattern",
  "verifier": "tool_called ask_user before gh pr merge"
}
```
Ask the agent to run the `memory_add` tool with this semantic verifier. The orchestrator checks the active turn's tool history at `turn_end` and logs a violation if the specified command (`gh pr merge`) was executed without the required tool (`ask_user`) preceding it.

## Enable the Automated Code Review Loop
Block agents from committing code until all automated reviewers report zero findings.

```json
{
  "review_loop_enforcement": true,
  "review_loop_max_cycles": 3
}
```
Set these values in your project's `.pi/pi-config-settings.json` file. When enabled, the orchestrator intercepts `git commit` commands and checks the review state machine, enforcing that tests pass and subagent reviewers approve. Hitting the cycle cap stops the loop but does NOT bypass the commit block.

See [Automating Code Reviews](automating-code-reviews.html) for details.

## Related Pages

- [Creating Slash Commands](custom-slash-commands.html)
- [myk_pi_tools CLI Reference](cli-reference.html)
