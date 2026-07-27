# Automating Code Reviews

Configure automated pipelines to gather and apply code review feedback from AI agents like Qodo and CodeRabbit. By setting up continuous pull request feedback, you can automatically ingest comments, apply code fixes, and push updates without manual intervention.

## Prerequisites

* A GitHub Pull Request active on your current branch.
* CodeRabbit and/or Qodo installed as GitHub apps on your repository.

## Quick Example

To automatically poll, fix, and resolve all pending AI code review comments in a continuous loop:

```bash
/review-handler --autorabbit --autoqodo
```

## Step-by-Step

Follow these steps to fully automate the review loop for your Pull Requests.

1. **Trigger the review loop**
   Start the automated review processor on your active branch. This fetches all pending comments, categorizes them by source, and attempts to write the necessary code fixes.
   ```bash
   /review-handler --autoqodo
   ```

2. **Handle AI pushback**
   If an AI reviewer disagrees with a fix, it generates a "sticky finding" with a pushback response. The automation loop automatically surfaces this new feedback and attempts a different approach on the next iteration.

3. **Resolve threads automatically**
   Once you push new commits, the handler waits for the AI reviewer to re-evaluate. If the bot confirms the fix, the threads are automatically marked as skipped and will not appear in future iterations.

## Advanced Usage

### Review Loop Cycles and Limits

When using `--autorabbit` or `--autoqodo` in `/review-handler`, the automation loop is subject to the `review_loop_max_cycles` configuration (default: 3).

> **Note:** Staged mode shares one total `review_loop_max_cycles` budget across both its Spec Compliance and Code Quality stages — it is not a separate cap per stage.

Hitting the cycle cap stops re-dispatching reviewers, but any remaining unresolved findings or failing tests will still block commits if `review_loop_enforcement` is enabled. You can adjust this limit (1-10) in your `pi-config-settings.json`.

### Handling CodeRabbit Rate Limits

CodeRabbit rate limits can temporarily pause your automated workflows. You can manually handle rate limits and force a re-trigger on your current branch's PR:

```bash
/coderabbit-rate-limit
```

To target a specific pull request number:

```bash
/coderabbit-rate-limit 123
```

### Isolating Specific Review Sources

If you prefer to integrate the review loop into custom scripts instead of using the interactive handler, you can poll specific sources using the CLI:

```bash
myk-pi-tools reviews poll --output-dir /tmp/reviews --source coderabbit
```

You can set `--source` to `qodo`, `coderabbit`, or `human` to process specific subsets of feedback. See [myk_pi_tools CLI Reference](cli-reference.html) for more details.

### Customizing CodeRabbit Rules

To adjust how assertive CodeRabbit is or to disable automatic review pausing, create or update `.coderabbit.yaml` in your project root:

```yaml
# .coderabbit.yaml
reviews:
  profile: assertive
  request_changes_workflow: false
```

## Troubleshooting

* **CodeRabbit pauses reviews:** If CodeRabbit replies with "reviews paused by coderabbit.ai", add `request_changes_workflow: false` to your `.coderabbit.yaml` to prevent it from halting automation.
* **Stuck Qodo findings:** If Qodo findings appear "stuck" (you pushed a fix but the AI hasn't resolved the thread), the review loop will automatically attempt to post a cleanup request to force re-evaluation.

For additional agent customization and setup, see [Configuration & Settings](configuration.html).

## Related Pages

- [Managing Custom Agents](managing-custom-agents.html)
- [External AI Agents & CLI](external-ai-agents.html)
- [Inter-Agent Communication Network](inter-agent-communication.html)
