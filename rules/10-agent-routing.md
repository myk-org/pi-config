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

- `code-reviewer-quality`, `code-reviewer-guidelines`, `code-reviewer-security`, `code-reviewer-docs` — dispatched via `rules/20-code-review-loop.md`
- `reviewer` — dispatched via prompt templates

## Fallback

**Fallback:** No specialist? → `worker` agent
