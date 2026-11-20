# Agent Bug Reporting

Applies ONLY to agents bundled in `agents/` (not built-in pi agents or external sources) when you find flawed logic, incorrect results, contradictory behavior, or systematic errors
in their instructions (not runtime failures, user code bugs, or expected behavior).

## Agents Covered by This Rule

`api-documenter`, `bash-expert`, `code-reviewer-docs`, `code-reviewer-guidelines`, `code-reviewer-quality`, `code-reviewer-security`, `code-reviewer-spec`,
`conflict-resolver`, `debugger`, `docker-expert`, `docs-fetcher`, `git-expert`, `github-expert`, `go-expert`, `issue-reviewer-feasibility`, `issue-reviewer-scope`,
`issue-reviewer-spec`, `java-expert`, `jenkins-expert`, `kubernetes-expert`, `planner`, `python-expert`, `reviewer`, `scout`, `security-auditor`,
`technical-documentation-writer`, `test-automator`, `test-runner`, `ts-expert`, `worker`. (Keep in sync whenever an agent is added, renamed, or removed under `agents/`.)

## Workflow

1. **Ask first (`ask_user`):** `"I found a logic bug in [agent]. Do you want me to create a GitHub issue for this?"` — never auto-create.
2. **If yes:** delegate to `github-expert` (never run `gh` directly) to file in `myk-org/pi-config` titled `bug(agents): [agent-name] - brief description` with sections:
   `Agent`, `Bug Description`, `Expected Behavior`, `Actual Behavior`, `Suggested Fix`, `Impact`, `Context`.
3. **Continue** the original task (fix or workaround) regardless of the answer.
