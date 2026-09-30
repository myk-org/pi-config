# Automating Code Reviews

Use the review loop when you want Pi to fetch PR feedback, apply fixes, reply to review comments, and keep re-checking until your AI reviewers approve. This is the fastest way to turn Qodo and CodeRabbit feedback into working code without hand-copying comments between GitHub and your editor.

## Prerequisites

- A GitHub pull request already opened for your current branch
- Qodo and/or CodeRabbit enabled on that repository
- A Pi session running in the repo
- `uv`, `gh`, and `myk-pi-tools` available in your environment

## Quick Example

```bash
/review-handler --autorabbit --autoqodo
```

Run this inside Pi to start the automatic loop for the current PR. It watches both AI review sources, fixes actionable findings, posts replies, pushes follow-up commits, and keeps polling until approval or until you stop it.

## Step-by-Step

1. **Choose the review mode**

   Use the command that matches how much automation you want:

   | Goal | Command |
   |---|---|
   | Auto-fix CodeRabbit comments | `/review-handler --autorabbit` |
   | Auto-fix Qodo comments | `/review-handler --autoqodo` |
   | Auto-fix both AI reviewers | `/review-handler --autorabbit --autoqodo` |
   | Review all sources manually | `/review-handler` |

2. **Start with the simplest working flow**

   If you want a hands-off loop, start with both AI reviewers enabled:

   ```bash
   /review-handler --autorabbit --autoqodo
   ```

   In auto mode, Pi skips the manual approval table and goes straight into fetch → fix → test → commit → push → reply → poll.

3. **Let Pi process the current round of comments**

   In auto mode, the handler works from the current PR and processes:
   - CodeRabbit comments
   - Qodo findings
   - follow-up reviewer pushback on earlier fixes

   The loop keeps running until one of these happens:
   - the reviewer approves the PR (`"approved": true` from `reviews poll`)
   - you explicitly stop it (`Ctrl+C`, or `stop` / `exit` / `done` / `quit`)

   Poll workers sleep 300s between checks and can run for 30+ minutes, so do not set a timeout on them.

   > **Tip:** The loop can run for a long time while waiting for new bot comments. See [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) for details on monitoring long-running background work.

4. **Use manual mode when humans are involved**

   If you run:

   ```bash
   /review-handler
   ```

   Pi fetches human, Qodo, and CodeRabbit items and presents them for review. This is the better choice when you want to approve, skip, or explain items one by one before Pi makes changes.

5. **Handle one reviewer at a time when needed**

   If one bot is noisy or blocked, run only the other source first:

   ```bash
   /review-handler --autorabbit
   ```

   ```bash
   /review-handler --autoqodo
   ```

   This is useful when you want a smaller fix cycle before bringing both reviewers back in.

6. **Let the loop re-check after each push**

   After Pi fixes comments and pushes a follow-up commit, it re-spawns the poll for that source. With both flags on, it spawns two parallel workers and processes whichever returns first. For Qodo, that includes follow-up responses on sticky findings and a `qodo_cleanup_response` block whose items must all be addressed; for CodeRabbit, it includes re-triggered review cycles after cooldowns or pauses.

7. **Check progress without disturbing the loop**

   ```bash
   /review-handler-status
   ```

   This is a separate prompt that reports the live status of running `review-handler` agents. Use it instead of interrupting a running loop.

## Advanced Usage

### Review with the CLI instead of the slash command

Use the CLI flow when you want to script review automation outside the interactive handler:

```bash
myk-pi-tools reviews fetch --output-dir .pi/tmp/
```

```bash
myk-pi-tools reviews poll --source qodo --output-dir .pi/tmp/
```

```bash
myk-pi-tools reviews post .pi/tmp/pr-42-reviews.json
```

```bash
myk-pi-tools reviews store .pi/tmp/pr-42-reviews.json
```

Two more subcommands exist for staging review comments before they are posted:

```bash
myk-pi-tools reviews pending-fetch "https://github.com/owner/repo/pull/123" --output-dir .pi/tmp/
myk-pi-tools reviews pending-update .pi/tmp/owner-repo-123-pending-review.json --submit
```

Use this flow when you need custom wrappers, CI experiments, or one-off tooling. See [myk_pi_tools CLI Reference](cli-reference.html) for details.

> **Note:** `reviews status` requires `--output-dir`; without `--pr` it auto-detects the PR from the current branch and otherwise lists the PRs in the local reviews database.

> **Warning:** `--autorabbit` and `--autoqodo` are slash-command flags for `/review-handler`. They are not CLI flags for `myk-pi-tools reviews ...`.

### Ask Qodo follow-up questions

If Qodo keeps objecting and you need a more specific answer, ask it directly from the current PR context:

```bash
myk-pi-tools reviews ask-qodo "What edge cases are missing?"
```

This is especially useful when a finding is still actionable but the fix direction is unclear.

### Generate a review status report

To inspect the current PR’s accumulated review history and produce an HTML report:

```bash
myk-pi-tools reviews status --output-dir .pi/reports/
```

Use this when you want a durable summary across multiple review cycles instead of only the latest comment thread state.

### Run multiple PR review loops safely

If you need to automate reviews for more than one PR at the same time, use separate worktrees instead of switching branches in place. Keep the worktrees inside the repository (`.worktrees/`) so they inherit the same project settings and `.gitignore` rules:

```bash
git worktree add .worktrees/pr-42 origin/fix/issue-42
git worktree add .worktrees/pr-43 origin/feat/issue-43
```

Then run `/review-handler` from each worktree independently. This avoids cross-contaminating parallel review sessions.

### Understand what ends the auto loop

Auto mode has exactly two exit conditions, and nothing else is valid (`prompts/review-handler.md`, Phase 9c):

1. Every auto-approved reviewer returns `"approved": true` from `reviews poll`.
2. You explicitly stop it — `Ctrl+C`, or sending `stop`, `exit`, `done`, or `quit`.

A failing command, a reviewer that stays quiet, or "all comments addressed" are **not** exit conditions. The handler logs the error, waits five minutes, and retries.

> **Note:** `review_loop_max_cycles` is a different mechanism. It caps the *commit gate* in `extensions/orchestrator/pi-config-review-state.ts` (default `3`, range `1`–`10`, env `PI_REVIEW_LOOP_MAX_CYCLES`) — when the cap is reached with no reviewers pending, commits are allowed through instead of blocking. It does not bound the `/review-handler` poll loop. See [Configuration & Settings](configuration.html).

## Troubleshooting

- **CodeRabbit is rate-limited:** run:
  ```bash
  /coderabbit-rate-limit
  ```
  This waits out the cooldown and re-triggers the review on the current PR.

- **CodeRabbit pauses after too many reviewed commits:** add this to `.coderabbit.yaml`:
  ```yaml
  reviews:
    auto_review:
      auto_pause_after_reviewed_commits: 0
  ```

- **Qodo keeps resurfacing the same finding:** ask a follow-up question with `myk-pi-tools reviews ask-qodo "..."`, then either change the code or clarify the requirement before rerunning the loop.

- **Commits are blocked even after fixes:** your review loop may still be failing tests or waiting on reviewer approval. Commit blocking comes from `extensions/orchestrator/pi-config-review-state.ts` and is capped by `review_loop_max_cycles` (default `3`, env `PI_REVIEW_LOOP_MAX_CYCLES`); it is independent of the `/review-handler` poll loop. See [Configuration & Settings](configuration.html) and [Implementing Command Guards](safety-enforcements.html).

- **You want a simpler first pass:** start with `/review-handler --autorabbit` or `/review-handler --autoqodo`, then enable both once the PR is stable.

## Related Pages

- [myk_pi_tools CLI Reference](cli-reference.html)
- [Built-in Workflow Commands](built-in-workflows.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
- [Using the Web Dashboard](using-the-web-dashboard.html)
- [Curating Project Memory](curating-project-memory.html)
