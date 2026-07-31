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
   - the reviewer approves the PR
   - you explicitly stop the loop

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

   After Pi fixes comments and pushes a follow-up commit, it polls for new reviewer output again. For Qodo, that includes follow-up responses on sticky findings; for CodeRabbit, it includes re-triggered review cycles after cooldowns or pauses.

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

Use this flow when you need custom wrappers, CI experiments, or one-off tooling. See [myk_pi_tools CLI Reference](cli-reference.html) for details.

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

If you need to automate reviews for more than one PR at the same time, use separate worktrees instead of switching branches in place:

```bash
git worktree add .worktrees/pr-42 origin/fix/issue-42
git worktree add .worktrees/pr-43 origin/feat/issue-43
```

Then run `/review-handler` from each worktree independently. This avoids cross-contaminating parallel review sessions.

### Understand cycle limits in auto mode

Automated review flows use a shared review-cycle budget controlled by `review_loop_max_cycles`. Auto mode also runs in two stages: spec first, then code quality, with both stages drawing from the same cycle cap.

If the cycle cap is reached before approval, Pi stops re-dispatching reviewers and reports the remaining state instead of pretending the PR is clean. See [Configuration & Settings](configuration.html) for details.

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

- **Commits are blocked even after fixes:** your review loop may still be failing tests or waiting on reviewer approval. See [Configuration & Settings](configuration.html) for the cycle cap settings, and see [Implementing Command Guards](safety-enforcements.html) for commit enforcement details.

- **You want a simpler first pass:** start with `/review-handler --autorabbit` or `/review-handler --autoqodo`, then enable both once the PR is stable.

## Related Pages

- [myk_pi_tools CLI Reference](cli-reference.html)
- [Built-in Workflow Commands](built-in-workflows.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
- [Using the Web Dashboard](using-the-web-dashboard.html)
- [Curating Project Memory](curating-project-memory.html)
