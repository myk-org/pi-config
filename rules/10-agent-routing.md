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
| GitHub (PRs, issues, releases, workflows) | `github-expert` |
| Tests | `test-automator` |
| Debugging | `debugger` |
| API docs | `api-documenter` |
| External repo security audit | `security-auditor` |
| External AI agents (cursor, codex, gemini, claude, copilot, etc.) | `/acpx-prompt` |
| External library/framework docs (React, FastAPI, Django, etc.) | `docs-fetcher` |

## Routing by Intent, Not Tool

Route based on the task intent, not just the tool being used.

- Running Python tests? → `python-expert` (not bash-expert)
- Editing Python files? → `python-expert` (even with sed/awk)
- Creating a PR? → `github-expert` (not git-expert)
- External library docs? → `docs-fetcher` (not direct fetch)

## Documentation Routing (MANDATORY)

The orchestrator MUST NEVER fetch external docs directly — always delegate to `docs-fetcher`, which tries `llms.txt` first and extracts only relevant sections.

**Spawn `docs-fetcher` when:**

- Fetching library/framework docs (React, FastAPI, Django, etc.)
- Looking up config guides or API references for external tools

**Skip when:**

- Standard library only (no external dependencies)
- Already fetched docs in current conversation

## Agents Not in Routing Table

Some agents are dispatched internally by rules or prompt templates, not by the routing table:

- `code-reviewer-quality`, `code-reviewer-guidelines`, `code-reviewer-security`, `code-reviewer-docs`, `code-reviewer-spec` — dispatched via `rules/20-code-review-loop.md`
- `issue-reviewer-spec`, `issue-reviewer-feasibility`, `issue-reviewer-scope` — dispatched via `prompts/issue-review.md`
- `reviewer` — dispatched via prompt templates

## Fallback

**Fallback:** No specialist? → `worker` agent

## Model Override

When the user asks to run an agent with a specific model:

1. Use `list_models` tool to discover available providers and models.
2. Pass the model to `subagent(model="provider/model-id")`.
3. Format: `provider/model-id` (e.g., `litellm/claude-opus-4-6-1m`) or just `model-id` (uses current provider).
4. For parallel tasks, set `model` per-task in the tasks array. Top-level `model` is used as fallback for tasks without their own.
5. Chain steps share the top-level `model` — no per-step override.
6. Explicit `model` param overrides agent_overrides, frontmatter, and settings.
