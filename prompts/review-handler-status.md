---
description: "Show live status of running review-handler agents — /review-handler-status"
---

## Raw Arguments

$ARGUMENTS

## Review Handler Status

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug
> while executing this command — DO NOT work around it silently. Ask the user:
> "Should I create a GitHub issue for this?" Route to `myk-org/pi-config` for prompt/extension issues,
> or to the relevant tool's repository for CLI issues.

Show the live state of running autoqodo/autorabbit review-handler agents.

### Steps

1. Run `/async-status`. Look for agents whose task contains `reviews poll`.
   If none found → "No review handler agents running — nothing to show."

2. For each running review agent, extract the PR number from the agent's task or worktree cwd.
   Run `myk-pi-tools reviews status --pr <number>` to generate the HTML report.
   Extract the path from `HTML report saved: <path>` in the output.
   - **Container** (`/.dockerenv` or `/run/.containerenv` exists): serve via file preview rule (`rules/45-file-preview.md`)
   - **Native**: show `file://<path>`
