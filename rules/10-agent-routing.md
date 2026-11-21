# Agent Routing

## Routing Table

| Domain/Tool | Agent |
|---|---|
| Python (.py) | `python-expert` |
| Go (.go) | `go-expert` |
| Frontend (JS/TS/React/Vue/Angular) | `ts-expert` |
| Java (.java) | `java-expert` |
| Shell scripts (.sh) | `bash-expert` |
| Markdown (.md) | `technical-documentation-writer` |
| Docker | `docker-expert` |
| Kubernetes/OpenShift | `kubernetes-expert` |
| Jenkins/CI/Groovy | `jenkins-expert` |
| Git operations (local) | `git-expert` |
| Git merge/rebase/cherry-pick conflicts | `conflict-resolver` (`git-expert` is blocked from resolving them) |
| GitHub (PRs, issues, releases, workflows) | `github-expert` |
| Running existing tests / analyzing failures | `test-runner` |
| Creating or modifying tests / test strategy | `test-automator` |
| Debugging | `debugger` |
| API docs | `api-documenter` |
| External repo security audit | `security-auditor` |
| External library/framework docs (React, FastAPI, Django, etc.) | `docs-fetcher` |

## Routing by Intent, Not Tool

Route by intent, not just tool:

- Running tests / analyzing failures (incl. Python) → `test-runner`; changing Python tests → `test-automator`; editing Python production code (even via sed/awk) →
  `python-expert`.
- Creating a PR → `github-expert` (not `git-expert`).
- Unmerged paths from merge/rebase/cherry-pick → `conflict-resolver` (`git-expert` is mechanically blocked).
- **External library/framework docs (MANDATORY):** never fetch directly — delegate to `docs-fetcher` (uses `llms.txt` first). Skip for stdlib-only or docs already fetched
  in this conversation.

## Internal Agents & Fallback

- **Dispatched by rules/prompts only:** `code-reviewer-{quality,guidelines,security,docs,spec}` (`rules/20-code-review-loop.md`),
  `issue-reviewer-{spec,feasibility,scope}` (`prompts/issue-review.md`), `reviewer` (prompt templates).
- **Fallback:** no specialist? → `worker` agent.

## Model Override

When asked to run an agent with a specific model: call `list_models` to discover `provider/model-id` pairs, then pass `subagent(model="provider/model-id")` (or bare
`model-id` to inherit provider). In `tasks` arrays, per-task `model` overrides top-level fallback; chain steps share the top-level `model`. Explicit `model` overrides
`agent_overrides`, frontmatter, and settings.
