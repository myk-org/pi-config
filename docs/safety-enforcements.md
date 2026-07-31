# Implementing Command Guards

Use these recipes to create code-enforced memories with `memory_add(...)`. For how memories are stored and managed over time, see [Curating Project Memory](curating-project-memory.html). For automated review-loop commit blocking, see [Automating Code Reviews](automating-code-reviews.html).

> **Note:** These recipes document project-specific guards you add yourself. For the full settings reference, see [Configuration & Settings](configuration.html).

## Block a destructive cleanup command

Use this when you want Pi to reject a specific bash command before it runs.

```text
memory_add(
  text="Never prune Docker images or containers from this repo",
  category="lesson",
  trigger="bash_contains docker system prune",
  action="block"
)
```

This creates a hard block on any `bash` tool call containing `docker system prune`. Use `bash_contains` when the command is easy to match with a plain substring and you do not need regex flexibility.

- Good fits: `terraform destroy`, `kubectl delete namespace`, `aws s3 rm --recursive`
- Keep one rule per dangerous command so the reason stays obvious

## Block force-pushes with a regex

Use this when a command has multiple spellings and you need one rule to catch all of them.

```text
memory_add(
  text="Never force-push from this repo",
  category="lesson",
  trigger="bash_regex git\\s+push\\s+--force(?:-with-lease)?\\b",
  action="block"
)
```

This blocks both `git push --force` and `git push --force-with-lease`. Use `bash_regex` when a simple substring is too broad or would miss important variants.

> **Tip:** Keep regexes short and targeted. This matcher is for command guards, not full shell parsing.

## Warn when editing secret files

Use this when a file should stay editable, but every edit deserves an extra reminder.

```text
memory_add(
  text="Check for secrets before saving .env files",
  category="pattern",
  trigger="file_modified *.env",
  action="warn"
)
```

This appends a warning when Pi uses `write` or `edit` on a matching file path. Use `warn` for sensitive files that sometimes need changes but should never be edited casually.

- `file_modified *.py` matches by extension
- `file_modified Dockerfile` matches by path substring

## Require approval before merging a PR

Use this when a command is allowed only after another tool has run in the same turn.

```text
memory_add(
  text="Always get explicit approval before merging a pull request",
  category="pattern",
  verifier="tool_called ask_user before gh pr merge"
)
```

This adds a semantic verifier instead of a trigger/action pair. If Pi runs `gh pr merge` without calling `ask_user` first, the turn is flagged as a violation.

> **Note:** This checks ordering inside a single turn: `ask_user` must happen before the merge command.

## Make the repo read-only for direct edits

Use this when you want Pi to inspect and plan, but never modify files directly.

```text
memory_add(
  text="Do not write files directly in this repo",
  category="preference",
  trigger="tool_name write",
  action="block"
)

memory_add(
  text="Do not edit files directly in this repo",
  category="preference",
  trigger="tool_name edit",
  action="block"
)
```

These rules block tool calls by exact tool name rather than by shell text. Use `tool_name` when the risky behavior is the tool itself, not a particular bash command.

- Common targets: `write`, `edit`, or other project-specific tools
- For agent-level workflow controls, see [Managing Custom Agents](managing-custom-agents.html)

## Run one safe follow-up command after a file edit

Use this when you want Pi to perform a tightly controlled check right after a successful change.

```text
# In your shell before starting pi
export PI_ENFORCEMENT_ALLOWED_COMMANDS="git diff -- Dockerfile"

# In pi chat
memory_add(
  text="Show the Dockerfile diff after every edit",
  category="pattern",
  trigger="file_modified Dockerfile",
  action="run_after git diff -- Dockerfile"
)
```

This runs `git diff -- Dockerfile` immediately after a matching `write` or `edit` succeeds, and only because the command is allowlisted exactly. Use this for short, deterministic checks that you want attached to a specific kind of edit.

> **Warning:** Allowlist entries must match exactly, character for character.

- To allow more than one follow-up command, use a colon-separated list:
  `export PI_ENFORCEMENT_ALLOWED_COMMANDS="git diff -- Dockerfile:git status --short"`
- Keep follow-up commands fast so they do not slow down normal edits

## Related Pages

- [Curating Project Memory](curating-project-memory.html)
- [Memory Architecture](memory-architecture.html)
- [Configuration & Settings](configuration.html)
- [Automating Code Reviews](automating-code-reviews.html)
- [Managing Custom Agents](managing-custom-agents.html)
