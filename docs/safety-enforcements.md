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

> **Tip:** Keep regexes short and targeted. This matcher is for command guards, not full shell parsing. Patterns longer than 200 characters are ignored, an invalid pattern is skipped silently, and only the first 4000 characters of a command are tested.

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

> **Note:** This checks ordering inside a single turn: `ask_user` must happen before the merge command. The second half is a plain substring matched against `bash` command strings only, and verifiers are evaluated at turn end — they report a violation rather than blocking the call.

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
memory_add(
  text="Show the Dockerfile diff after every edit",
  category="pattern",
  trigger="file_modified Dockerfile",
  action="run_after git diff -- Dockerfile"
)
```

This runs `git diff -- Dockerfile` immediately after a matching `write` or `edit` succeeds. Use this for short, deterministic checks that you want attached to a specific kind of edit.

Unlike `block` and `warn`, `run_after` actually executes a shell command, so it is gated. Without configuration the command runs as written. To restrict it, set the `enforcement_allowed_commands` allowlist — this is the only allowlist in the enforcement path:

```bash
# In your shell before starting pi
export PI_ENFORCEMENT_ALLOWED_COMMANDS="git diff -- Dockerfile:git status --short"
```

Or set `enforcement_allowed_commands` in `pi-config-settings.json`. Once the setting is non-empty, a `run_after` command not in the allowlist is refused with `Blocked: command not in enforcement_allowed_commands allowlist` and does not execute.

> **Warning:** Allowlist entries are colon-separated and matched exactly, character for character, after trimming — no prefix matching, so `git diff` in the list does not permit `git diff -- Dockerfile`. An empty allowlist (the default) allows everything.

- Independently of the allowlist, `run_after` still refuses commands matching `curl`/`wget` piped into a shell, `rm -rf /`-style paths, `sudo`, and world-writable `chmod`
- Each command runs with a 60s timeout; keep follow-up commands fast so they do not slow down normal edits

### Recursive rm must use absolute paths

A persistent approval stores the **statement text**. A relative-path recursive
rm like `rm -rf build` would therefore approve the identical text in ANY
directory — the next `rm -rf build` anywhere on the machine would match the
allowlist and run silently against whatever folder has that name there (#963).

For that reason the gate **blocks** (never prompts) recursive rm whose targets
are not full paths (`/…` or `~/…` — relative paths, variables, and globs all
block) and tells the agent to rewrite with the absolute path. `find -delete`
and `xargs rm` are exempt — their targets come from find output or stdin, not
from the statement text. Once the command spells out the full path, it flows
through the normal gates: an "always allow" then binds to exactly one folder
you know. Absolute `rm -rf <project>/.pi/tmp/…` and `/tmp/<sub>` targets keep
their silent exemption.

## Pre-approve a recurring dangerous command

The dangerous-command gate (background shells, `sudo`, recursive `rm`, …) asks
for confirmation every time it sees a matching command. For commands you run
over and over — a debug skill that starts `nohup bash -c … | nc 127.0.0.1 4444`,
for example — the prompt offers persistent approvals per statement:

```text
⚠️ Dangerous statements (of the full command):

  sudo zsh
    ↳ sudo
  bash .dev/deploy-all.sh
    ↳ bare shell invocation

Allow?

  → Yes — run once
    Always allow (this project): sudo zsh
    Always allow (everywhere): sudo zsh
    Always allow (this project): bash .dev/deploy-all.sh
    Always allow (everywhere): bash .dev/deploy-all.sh
    Always allow all of the above (this project)
    Always allow all of the above (everywhere)
    No
```

You choose the SCOPE of a persistent approval explicitly: **this project**
stores it in the project's settings file, **everywhere** stores it in your
global settings (`~/.pi/pi-config-settings.json`) — machine-wide. When the
project settings file is not trustable (git-tracked or reached through a
symlink — a cloned repo must not be able to ship approvals), the "this
project" options are omitted and the prompt says so: global is then the only
persistent choice, never a silent fallback.

**"Always allow: \<statement\>"** appends that statement (trailing I/O
redirections like `2>&1` and `> /dev/null` stripped — they are plumbing,
not danger; redirects to any other target stay part of the statement) to the
`dangerous_command_allowlist` setting in the chosen scope's settings file,
then re-prompts for any remaining dangerous statements. Later commands whose
dangerous statements are all allowlisted pass silently — but never invisibly:
every allowlisted hit logs a `dangerous_command_allowlisted` warning naming
the rule that matched.

Because the entries are a regular setting, you can review, edit, and extend
them — via `/pi-config-settings` (Enforcement category, with a list editor)
or by editing the file directly:

```json
{
  "dangerous_command_allowlist": [
    "nohup bash -c \"exec tail -f $FIFO | exec nc 127.0.0.1 4444\" &",
    "sudo systemctl restart myservice"
  ]
}
```

### Wildcards

Entries are glob patterns matched against a **single dangerous statement**
(anchored, case-sensitive) — the statement the gate split out of your command,
with benign plumbing tails (`2>&1`, `> /dev/null`) stripped:

- `*` — any run of characters within that statement
- `?` — exactly one character
- `\` — escapes a literal `*`, `?`, or `\`

Because matching is per statement, an entry containing `|`, `;`, `&`, or a
newline can never match anything — those are the separators the gate splits
on. Keep entries to one statement.

For example, the gate splits `nohup bash -c "tail -f /fifo | nc 127.0.0.1
4444" &` at the pipe (inside quotes — splitting is deliberately
quote-unaware), so the dangerous statement is the leading fragment
`nohup bash -c "tail -f /fifo`, and the entry `nohup bash -c "tail -f *`
covers it for any FIFO name.

⚠️ **Scope wildcards tightly.** `*` matches everything between its anchors —
including quotes and redirections *inside the statement*. Keep wildcards
inside a quoted, fixed-shape region (`"… * …"`) and never bridge across a
spot where another redirect or argument could be injected.

⚠️ **Stdin-fed shells are never persistently approvable.** A bare `bash`,
`sh`, `zsh` (optionally with flags or `sudo`/`nohup`/`env`/`timeout`
wrappers) carries none of the script it will run — `gen.sh | bash`,
`bash <<EOF`, and `base64 -d | bash` all reduce to the same statement. The
prompt offers **run-once only** for those, every time, and a hand-added
entry can never approve them.

⚠️ **Redirects (other than `2>&1` / `/dev/null`) are part of the statement.**
Approving `sudo cat image` does not cover `sudo cat image > /dev/sda` —
benign plumbing is stripped, destructive redirects are not.

Entries added via the prompt option are stored with metachars **escaped** — an
approval covers exactly the statement you approved, and any change (one
character, a different port, an extra redirect) re-prompts. Widening an entry
to a wildcard family is a deliberate human edit.

### Properties, by design

- **Project or global.** The project file wins; global
  `~/.pi/pi-config-settings.json` is consulted when the project has no
  matching entry. Entries never cross projects unless you put them in the
  global file yourself.
- **Cloned repos cannot pre-approve.** A project settings file that is
  *tracked by git* is not trusted for the allowlist — a repository shipping
  `"*"` cannot disable your dangerous-command gate. Only your own untracked
  project file (or the global file on your machine) approves commands.
- **Prompt-only writes.** Agents cannot add entries through the normal
  paths: edit/write tool calls targeting the settings files are blocked, as
  are bash redirects into them (`>`, `>>`, `>|`, `tee`, `sponge`) — the
  allowlist flows only through the interactive prompt (or your own editor).
  A rogue agent can't self-approve `rm -rf` with the obvious one-liners;
  note that no text-based guard can stop a *determined* same-user agent, so
  the warn logging and tracked-file checks below are the audit trail.
- **Works headless.** The check needs no UI, so a pre-approved command stops
  hard-blocking `-p`/RPC sessions; unapproved ones still block.
- **Auditable.** Allowlisted hits log the matched pattern and an entry hash
  prefix — command text (which may contain credentials) stays out of global
  log files.

To revoke an approval, delete the entry (or the whole setting). The next run
of that command prompts again.

## Related Pages

- [Curating Project Memory](curating-project-memory.html)
- [Memory Architecture](memory-architecture.html)
- [Configuration & Settings](configuration.html)
- [Automating Code Reviews](automating-code-reviews.html)
- [Managing Custom Agents](managing-custom-agents.html)
