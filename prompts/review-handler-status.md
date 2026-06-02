---
description: "Show live status of running review-handler agents — /review-handler-status"
---

## Raw Arguments

$ARGUMENTS

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug
> while executing this command — DO NOT work around it silently. Ask the user:
> "Should I create a GitHub issue for this?" Route to `myk-org/pi-config` for prompt/extension issues,
> or to the relevant tool's repository for CLI issues.

## Review Handler Status

Show the live state of running autoqodo/autorabbit review-handler agents.

### Steps

1. **Check if any review-handler agents are running:**
   Run the `/async-status` command. Look at the output for agents whose task contains `reviews poll`.
   If none found, tell the user:
   "No review handler agents running — nothing to show." **STOP HERE.**
   Extract the PR number from the agent's task or worktree cwd.

2. **If agents ARE running**, for each PR being handled:
   - Run `myk-pi-tools reviews status --pr <number>` to generate the HTML report
   - Extract the HTML report path from the CLI output line `HTML report saved: <path>`
   - **Container** (check `/.dockerenv` or `/run/.containerenv`): serve via file preview rule (`rules/45-file-preview.md`)
   - **Native** (not in container): show `file://<path>` as a clickable link
