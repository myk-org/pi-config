# Agent Routing

## Routing Table

| Domain/Tool                                                  | Agent                            |
|--------------------------------------------------------------|----------------------------------|
| **Languages (by file type)**                                 |                                  |
| Python (.py)                                                 | `python-expert`                  |
| Go (.go)                                                     | `go-expert`                      |
| Frontend (JS/TS/React/Vue/Angular)                           | `frontend-expert`                |
| Java (.java)                                                 | `java-expert`                    |
| Shell scripts (.sh)                                          | `bash-expert`                    |
| Markdown (.md)                                               | `technical-documentation-writer` |
| **Infrastructure**                                           |                                  |
| Docker                                                       | `docker-expert`                  |
| Kubernetes/OpenShift                                         | `kubernetes-expert`              |
| Jenkins/CI/Groovy                                            | `jenkins-expert`                 |
| **Development**                                              |                                  |
| Git operations (local)                                       | `git-expert`                     |
| GitHub (PRs, issues, releases, workflows)                    | `github-expert`                  |
| Tests                                                        | `test-automator`                 |
| Debugging                                                    | `debugger`                       |
| API docs                                                     | `api-documenter`                 |
| External repo security audit                                 | `security-auditor`                     |
| External AI agents (cursor, codex, gemini, claude, copilot, etc.) | `/acpx-prompt`               |
| External library/framework docs (React, FastAPI, Django, etc.) | `docs-fetcher`                 |

## Routing by Intent, Not Tool

**Important:** Route based on the task intent, not just the tool being used.

Examples:

- Running Python tests? → `python-expert` (not bash-expert)
- Editing Python files? → `python-expert` (even with sed/awk)
- Shell script creation? → `bash-expert`
- Creating a PR? → `github-expert` (not git-expert)
- Committing changes? → `git-expert` (local git)
- Viewing GitHub issue? → `github-expert`
- React documentation? → `docs-fetcher`
- FastAPI documentation? → `docs-fetcher`

## Documentation Routing (MANDATORY)

### docs-fetcher (External Docs)

**Use for ALL external library/framework documentation:**

- React, Vue, Angular, FastAPI, Django, etc.
- Third-party tools (Oh My Posh, Starship, etc.)
- Any external documentation

### Rule: NEVER Fetch Docs Directly

**The orchestrator MUST NEVER fetch documentation directly.**

❌ **FORBIDDEN** - Orchestrator using fetch_content for external docs:

```text
fetch_content(https://react.dev/...)
fetch_content(https://fastapi.tiangolo.com/...)
fetch_content(https://ohmyposh.dev/...)
```

✅ **REQUIRED** - Delegate to the appropriate agent:

```text
# For external library docs:
subagent(agent="docs-fetcher", task="Fetch Oh My Posh configuration docs...")

# For React docs:
subagent(agent="docs-fetcher", task="Fetch React hooks documentation...")
```

### Why This Matters

- `docs-fetcher` tries `llms.txt` first (optimized for LLMs)
- `docs-fetcher` extracts only relevant sections
- Direct fetch_content wastes tokens on full HTML pages

### When to Spawn docs-fetcher

**Use `docs-fetcher` when:**

- Fetching library/framework documentation (React, FastAPI, Django, etc.)
- Looking up configuration guides for external tools
- Getting API references for third-party services
- User asks about external tool documentation

**Exceptions - Skip when:**

- Standard library only (no external dependencies)
- User explicitly says "skip docs" or "I know the API"
- Simple operations with obvious patterns
- Already fetched docs in current conversation

### Workflow

```text
Need documentation?
       ↓
  Is it an external library/framework/tool?
       │
   ┌───┴───┐
  YES      NO
   │        │
   ↓        ↓
┌──────────────────┐  ┌──────────────────┐
│   docs-fetcher   │  │  No agent needed │
│  (web fetching)  │  │  (standard lib)  │
└──────────────────┘  └──────────────────┘
       │                      │
       └──────────┬───────────┘
                  ↓
       Use context for implementation
```

## Fallback

**Fallback:** No specialist? → `worker` agent
