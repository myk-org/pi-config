# Agent Reference

Pi ships 30 specialist agents in `agents/`. Each one is a markdown file with YAML frontmatter (`name`, `description`, `tools`) followed by a system prompt. This page lists every bundled agent, what its description says, and how the orchestrator decides which one to use.

Specialists are meant to be **delegated to, not imitated**. The orchestrator reads the routing rules, spawns the matching specialist through the `subagent` tool, and merges the result — it does not do the specialist's job inline.

> **Note:** None of the bundled agents pin a `model` or `provider` in their frontmatter. Every agent runs on whatever model the session resolves to, unless you override it per call or through `agent_overrides` in settings.

## How routing works

Routing is defined in `rules/10-agent-routing.md`, not by the model guessing from agent names. Three layers:

1. **Domain-to-agent table.** File types and tools map to a named agent — `.py` → `python-expert`, `.go` → `go-expert`, JS/TS/React/Vue/Angular → `ts-expert`, `.java` → `java-expert`, `.sh` → `bash-expert`, `.md` → `technical-documentation-writer`, Docker → `docker-expert`, Kubernetes/OpenShift → `kubernetes-expert`, Jenkins/CI/Groovy → `jenkins-expert`, local git → `git-expert`, GitHub (PRs, issues, releases, workflows) → `github-expert`, unresolved merge/rebase conflicts → `conflict-resolver`, external library docs → `docs-fetcher`, running or analyzing tests → `test-runner`, writing tests → `test-automator`, debugging → `debugger`, API docs → `api-documenter`, external-repo security audit → `security-auditor`.

2. **Intent overrides the tool.** The same file type routes differently by goal: running existing Python tests → `test-runner`; fixing Python production code after failures → `python-expert`; creating or changing Python tests → `test-automator`; editing Python production files → `python-expert` even via `sed`/`awk`; creating a PR → `github-expert`, never `git-expert`.

3. **Fallback.** If no specialist matches, the orchestrator uses `worker`, which has full tool access.

Two hard rules live in the same file:

- **Documentation is delegated, never fetched inline.** The orchestrator must not fetch external library or framework docs itself — it spawns `docs-fetcher`, which tries `llms.txt` first and extracts only the relevant sections. Skip it when the task is standard-library only, or when the docs were already fetched earlier in the conversation.
- **Model overrides are explicit.** When you ask for a specific model, the orchestrator calls `list_models` to discover valid `provider/model-id` pairs and passes `model` to `subagent`. An explicit `model` argument beats `agent_overrides`, agent frontmatter, and settings. In parallel task arrays, a per-task `model` wins over the top-level fallback; chain steps share the top-level `model`.

A few agents are deliberately **not** in the chat routing table. The five `code-reviewer-*` agents and `test-runner` are dispatched by the review loop in `rules/20-code-review-loop.md` — all six run in parallel after every code change, and the first review is never skipped. The three `issue-reviewer-*` agents are dispatched together by the `/issue-review` prompt template. Use chat routing rules, prompt templates, or slash commands deliberately; see [Managing Custom Agents](managing-custom-agents.html) for how the two styles differ.

## Language specialists

Full `read, write, edit, bash` — they implement, not just advise.

| Agent | Description | Tools |
| :--- | :--- | :--- |
| [`python-expert`](#python-expert) | Python code creation, modification, refactoring, and fixes. Specializes in idiomatic Python, async/await, testing, and modern Python development. | `read, write, edit, bash` |
| [`go-expert`](#go-expert) | Go code creation, modification, refactoring, and fixes. Specializes in goroutines, channels, modules, testing, and high-performance Go. | `read, write, edit, bash` |
| [`ts-expert`](#ts-expert) | TypeScript, JavaScript, and frontend framework development (React/Vue/Angular/CSS). UI design, component creation, and modern web technologies. | `read, write, edit, bash` |
| [`java-expert`](#java-expert) | Java code creation, modification, refactoring, and fixes. Specializes in Spring Boot, Maven, Gradle, JUnit testing, and enterprise applications. | `read, write, edit, bash` |
| [`bash-expert`](#bash-expert) | Bash and shell scripting creation, modification, refactoring, and fixes. Specializes in Bash, Zsh, POSIX shell, automation scripts, and system administration. | `read, write, edit, bash` |

## Infrastructure and CI

| Agent | Description | Tools |
| :--- | :--- | :--- |
| [`docker-expert`](#docker-expert) | Docker and container-related tasks including Dockerfile creation, container orchestration, image optimization, and containerization workflows. | `read, write, edit, bash` |
| [`kubernetes-expert`](#kubernetes-expert) | Kubernetes-related tasks including cluster management, workload deployment, service mesh, and cloud-native orchestration. Specializes in K8s, OpenShift, Helm, and GitOps. | `read, write, edit, bash` |
| [`jenkins-expert`](#jenkins-expert) | Jenkins-related code including CI/CD pipelines, Jenkinsfiles, Groovy scripts, and build automation. | `read, write, edit, bash` |

## Version control and forges

These two are split deliberately: `git-expert` is local repository work, `github-expert` is everything that talks to the GitHub API through `gh`. `conflict-resolver` is split out of `git-expert` because it is the one git task that needs real judgment: `git-expert` is commonly pinned to a small model, so when a merge, rebase, or cherry-pick leaves unmerged paths, `git-expert` is blocked from writing a resolution (`git add`, `git restore`, `git checkout --ours/--theirs`, `merge|rebase --continue`) and hands off to `conflict-resolver`.

| Agent | Description | Tools |
| :--- | :--- | :--- |
| [`git-expert`](#git-expert) | Local git operations including commits, branching, merging, rebasing, stash, and resolving git issues. Never uses --no-verify. For GitHub platform operations (PRs, issues, releases), use github-expert instead. | `read, bash` |
| [`conflict-resolver`](#conflict-resolver) | Resolve git merge/rebase/cherry-pick conflicts by reading commit intent on both sides. git-expert hands off here; it is blocked from resolving them. | `read, bash, edit, write` |
| [`github-expert`](#github-expert) | GitHub platform operations including PRs, issues, releases, repos, and workflows. Uses the gh CLI for all GitHub API interactions. | `read, bash` |

Both `git-expert` and `github-expert` are read-only on the file system, but `bash` is enough to mutate branches and open PRs. `conflict-resolver` writes, because resolving a conflict means editing the conflicted files.

## Testing

Running tests and writing tests are separate agents. `test-runner` is analysis-only; a completed `test-runner` or `test-automator` subagent does not prove the test command passed — the exit status does.

| Agent | Description | Tools |
| :--- | :--- | :--- |
| [`test-runner`](#test-runner) | Run tests and analyze failures. Returns detailed failure analysis without making fixes. | `bash, read` |
| [`test-automator`](#test-automator) | Create comprehensive test suites with unit, integration, and e2e tests. Sets up CI pipelines, mocking strategies, and test data. | `read, write, edit, bash` |

## Documentation

| Agent | Description | Tools |
| :--- | :--- | :--- |
| [`api-documenter`](#api-documenter) | Create OpenAPI/Swagger specs, generate SDKs, and write developer documentation. Handles versioning, examples, and interactive docs. | `read, write, edit, bash` |
| [`docs-fetcher`](#docs-fetcher) | Fetches current documentation for external libraries and frameworks. Prioritizes llms.txt when available, falls back to web parsing. | `read, bash` |
| [`technical-documentation-writer`](#technical-documentation-writer) | Comprehensive, user-focused technical documentation for projects, features, or systems. | `read, write, edit, bash` |

`docs-fetcher` is the mandatory delegate for external docs. The other two write docs into your project.

## Security

| Agent | Description | Tools |
| :--- | :--- | :--- |
| [`security-auditor`](#security-auditor) | Audits external repositories for security risks before adoption — checks for malicious code, data exfiltration, supply chain risks, and trust signals. | `read, bash` |

Scoped to third-party repositories you are considering adopting, not to auditing your own code — that is `code-reviewer-security`'s job.

## Code review

The five `code-reviewer-*` agents are dispatched by the review loop, not by chat routing. After any code change, all five plus `test-runner` run in parallel as async subagents, and the loop repeats until the state is clean (capped by `review_loop_max_cycles`). `reviewer` is the general-purpose single-agent review.

| Agent | Description | Tools |
| :--- | :--- | :--- |
| [`code-reviewer-quality`](#code-reviewer-quality) | Code review focused on general code quality and maintainability. Reviews for clean code, proper abstractions, DRY, and readability. | `read, bash` |
| [`code-reviewer-guidelines`](#code-reviewer-guidelines) | Code review focused on project guidelines and style adherence. Reviews for AGENTS.md compliance, naming conventions, and project patterns. | `read, bash` |
| [`code-reviewer-security`](#code-reviewer-security) | Code review focused on bugs, logic errors, and security vulnerabilities. Reviews for correctness, edge cases, and potential exploits. | `read, bash` |
| [`code-reviewer-docs`](#code-reviewer-docs) | Code review focused on documentation quality, completeness, accuracy, missing docs, stale content, AGENTS.md best practices, and cross-file consistency. | `read, bash` |
| [`code-reviewer-spec`](#code-reviewer-spec) | Code review focused on alignment between code changes, PR description, and issue deliverables. | `read, bash` |
| [`reviewer`](#reviewer) | General code review agent. Reviews code changes for quality, correctness, and style. | `read, bash` |

All six reviewers are read-only. Spec findings are never deduplicated against non-spec findings.

## Issue review

Spawned together by `/issue-review`, all read-only, all returning JSON findings that the template merges and deduplicates.

| Agent | Description | Tools |
| :--- | :--- | :--- |
| [`issue-reviewer-spec`](#issue-reviewer-spec) | Issue review focused on spec completeness — problem statement, Done checklist, acceptance criteria, reproducibility, labels. | `read, bash` |
| [`issue-reviewer-feasibility`](#issue-reviewer-feasibility) | Issue review focused on codebase feasibility — verifying referenced files/functions exist, approach viability, and identifying blockers. | `read, bash` |
| [`issue-reviewer-scope`](#issue-reviewer-scope) | Issue review focused on scope hygiene — single concern, no scope creep, duplicate detection against open issues. | `read, bash` |

## Orchestration and general work

`scout` → `planner` → `worker` is the chain behind `/implement`; `/scout-and-plan` stops after the first two. `worker` is also the routing-table fallback for anything with no specialist.

| Agent | Description | Tools |
| :--- | :--- | :--- |
| [`scout`](#scout) | Fast codebase reconnaissance. Finds relevant files, functions, and dependencies for a given task. | `read, bash` |
| [`planner`](#planner) | Creates detailed implementation plans from codebase context. Does not write code. | `read, bash` |
| [`worker`](#worker) | General-purpose agent for tasks that don't match any specialist. Full capabilities. | `read, write, edit, bash` |
| [`debugger`](#debugger) | Debugging specialist for errors, test failures, and unexpected behavior. Diagnoses only — does not modify files. | `read, bash` |

`planner` and `debugger` deliberately cannot write. `worker` is the only one in this group that can.

## Tool access at a glance

- **Full access** (`read, write, edit, bash`) — 13 agents: the five language specialists, `docker-expert`, `kubernetes-expert`, `jenkins-expert`, `api-documenter`, `technical-documentation-writer`, `test-automator`, `conflict-resolver`, `worker`.
- **Read-only** (`read, bash`) — the other 17: every reviewer, every issue reviewer, `git-expert`, `github-expert`, `test-runner`, `debugger`, `planner`, `scout`, `docs-fetcher`, `security-auditor`.

Restricting `tools:` is the first lever when a bundled specialist has more authority than you want; see [Managing Custom Agents](managing-custom-agents.html).

## Related Pages

- [Managing Custom Agents](managing-custom-agents.html)
- [Built-in Workflow Commands](built-in-workflows.html)
- [Automating Code Reviews](automating-code-reviews.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
- [Inter-Agent Communication](inter-agent-communication.html)
- [Configuration & Settings](configuration.html)
