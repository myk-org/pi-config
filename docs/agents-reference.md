# Specialist Agents Reference

This page documents all 24 specialist agents bundled with pi-config. Each agent is a markdown file in the `agents/` directory with YAML frontmatter defining its name, description, tools, and optional model override.

> **Note:** The orchestrator never performs code changes directly — it delegates all work to these specialist agents via the `subagent` tool. See [Understanding Agent Routing and Delegation](agent-routing.html) for how routing decisions are made.

## Agent Discovery and Loading

Agents are discovered from three directories in priority order (later overrides earlier by name):

| Priority | Source | Directory | Label |
|----------|--------|-----------|-------|
| 1 (lowest) | Package-bundled | `<pi-config>/agents/` | `package` |
| 2 | User-defined | `~/.pi/agent/agents/` | `user` |
| 3 (highest) | Project-local | `<project>/.pi/agents/` | `project` |

The `agentScope` parameter on the `subagent` tool controls which directories are searched:

| Scope | Package | User | Project |
|-------|---------|------|---------|
| `"user"` (default) | ✅ | ✅ | ❌ |
| `"project"` | ✅ | ❌ | ✅ |
| `"both"` | ✅ | ✅ | ✅ |

## Agent Frontmatter Schema

Every agent markdown file uses YAML frontmatter with these fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✅ | Unique agent identifier used in routing and `subagent` calls |
| `description` | string | ✅ | One-line description of the agent's purpose |
| `tools` | string | ❌ | Comma-separated list of tools the agent can use (e.g., `read, write, edit, bash`) |
| `model` | string | ❌ | Model override — uses this model instead of the parent session's model |
| `provider` | string | ❌ | Provider override — uses this provider instead of the parent session's provider |

```yaml
---
name: my-agent
description: What this agent does — one sentence.
tools: read, write, edit, bash
model: claude-haiku-4-5
---
```

## Async-Only Agents

Three agents are enforced to run only in async mode (`async: true`). Sync calls to these agents are automatically promoted to async by `subagent-tool.ts`. Chain mode is rejected entirely for these agents.

| Agent | Reason |
|-------|--------|
| `code-reviewer-quality` | Long-running review — would block the session |
| `code-reviewer-guidelines` | Long-running review — would block the session |
| `code-reviewer-security` | Long-running review — would block the session |

See [Running the Automated Code Review Loop](code-review-loop.html) for the full review workflow.

## Routing Table

The orchestrator routes tasks to agents based on intent, not just file type. The full routing table is defined in `rules/10-agent-routing.md`.

| Domain | Agent | Routing Trigger |
|--------|-------|-----------------|
| Python (.py) | `python-expert` | Python code creation, modification, testing |
| Go (.go) | `go-expert` | Go code creation, modification, testing |
| Frontend (JS/TS/React/Vue/Angular) | `ts-expert` | JavaScript/TypeScript/frontend work |
| Java (.java) | `java-expert` | Java code, Spring Boot, Maven/Gradle |
| Shell scripts (.sh) | `bash-expert` | Bash/Zsh/POSIX shell scripting |
| Markdown (.md) | `technical-documentation-writer` | Documentation authoring |
| Docker | `docker-expert` | Dockerfiles, containers, images |
| Kubernetes/OpenShift | `kubernetes-expert` | K8s manifests, Helm, GitOps |
| Jenkins/CI/Groovy | `jenkins-expert` | Jenkinsfiles, CI/CD pipelines |
| Git operations (local) | `git-expert` | Commits, branches, merges, rebases |
| GitHub (PRs, issues, releases) | `github-expert` | GitHub platform operations via `gh` CLI |
| Tests | `test-automator` | Test suite creation and CI configuration |
| Debugging | `debugger` | Error diagnosis and root cause analysis |
| API docs | `api-documenter` | OpenAPI specs, SDK docs |
| Security audits | `security-auditor` | External repo security evaluation |
| External library docs | `docs-fetcher` | Fetching docs for React, FastAPI, etc. |
| No specialist match | `worker` | General-purpose fallback |

> **Tip:** Routing is by *intent*, not tool. Running Python tests routes to `python-expert`, not `bash-expert`. Creating a PR routes to `github-expert`, not `git-expert`.

---

## Language Specialist Agents

### python-expert

| Property | Value |
|----------|-------|
| **Name** | `python-expert` |
| **Description** | Python code creation, modification, refactoring, and fixes. Specializes in idiomatic Python, async/await, testing, and modern Python development. |
| **Tools** | `read`, `write`, `edit`, `bash` |
| **Model Override** | None (inherits parent) |
| **Async-Only** | No |

**Key behaviors:**

- Enforces `uv`/`uvx` — never uses `python`, `pip`, or `pip3` directly
- Type hints on all public functions
- Uses `pytest` for testing with >90% coverage target
- Formats with `ruff`/`black`, lints with `ruff check`

```text
subagent(agent="python-expert", task="Add retry logic to the API client in src/client.py", cwd="/project", estimatedSeconds=15)
```

### go-expert

| Property | Value |
|----------|-------|
| **Name** | `go-expert` |
| **Description** | Go code creation, modification, refactoring, and fixes. Specializes in goroutines, channels, modules, testing, and high-performance Go. |
| **Tools** | `read`, `write`, `edit`, `bash` |
| **Model Override** | None (inherits parent) |
| **Async-Only** | No |

**Key behaviors:**

- Idiomatic Go with proper error wrapping (`fmt.Errorf("...: %w", err)`)
- Context propagation through call chains
- Table-driven tests with `-race` flag
- Linting via `golangci-lint`

```text
subagent(agent="go-expert", task="Implement the UserService with CRUD operations", cwd="/project", estimatedSeconds=20)
```

### ts-expert

| Property | Value |
|----------|-------|
| **Name** | `ts-expert` |
| **Description** | TypeScript, JavaScript, and frontend framework development (React/Vue/Angular/CSS). UI design, component creation, and modern web technologies. |
| **Tools** | `read`, `write`, `edit`, `bash` |
| **Model Override** | None (inherits parent) |
| **Async-Only** | No |

**Key behaviors:**

- Covers JavaScript, TypeScript, React, Vue, Angular, CSS
- Frontend testing with Jest, Vitest, Cypress, Playwright
- Build tooling: Vite, Webpack, esbuild

```text
subagent(agent="ts-expert", task="Create a React component for the settings panel", cwd="/project", estimatedSeconds=15)
```

### java-expert

| Property | Value |
|----------|-------|
| **Name** | `java-expert` |
| **Description** | Java code creation, modification, refactoring, and fixes. Specializes in Spring Boot, Maven, Gradle, JUnit testing, and enterprise applications. |
| **Tools** | `read`, `write`, `edit`, `bash` |
| **Model Override** | None (inherits parent) |
| **Async-Only** | No |

**Key behaviors:**

- Targets Java 17+ (records, sealed classes, pattern matching)
- Spring ecosystem: Boot, MVC, Data, Security, WebFlux
- Build tools: Maven, Gradle (Kotlin DSL)
- Testing: JUnit 5, Mockito, TestContainers
- Logging with SLF4J, JavaDoc on public APIs

```text
subagent(agent="java-expert", task="Add Spring Security OAuth2 configuration", cwd="/project", estimatedSeconds=20)
```

### bash-expert

| Property | Value |
|----------|-------|
| **Name** | `bash-expert` |
| **Description** | Bash and shell scripting creation, modification, refactoring, and fixes. Specializes in Bash, Zsh, POSIX shell, automation scripts, and system administration. |
| **Tools** | `read`, `write`, `edit`, `bash` |
| **Model Override** | None (inherits parent) |
| **Async-Only** | No |

**Key behaviors:**

- Defensive scripting: `set -euo pipefail`
- Proper quoting: always `"$var"`
- POSIX portability when possible, bash-specific when needed
- Must pass `shellcheck` with no warnings
- Includes trap for cleanup

```text
subagent(agent="bash-expert", task="Create a deployment script with rollback support", cwd="/project", estimatedSeconds=15)
```

---

## Infrastructure Agents

### docker-expert

| Property | Value |
|----------|-------|
| **Name** | `docker-expert` |
| **Description** | Docker and container-related tasks including Dockerfile creation, container orchestration, image optimization, and containerization workflows. |
| **Tools** | `read`, `write`, `edit`, `bash` |
| **Model Override** | None (inherits parent) |
| **Async-Only** | No |

**Key behaviors:**

- Multi-stage builds, BuildKit, Buildx
- Security: non-root users, minimal base images, image scanning (Trivy)
- Pinned base image versions (never `:latest`)
- Orchestration: Docker Compose, Docker Swarm
- Alternative runtimes: Podman, Buildah, Skopeo

```text
subagent(agent="docker-expert", task="Optimize the Dockerfile for smaller image size", cwd="/project", estimatedSeconds=15)
```

### kubernetes-expert

| Property | Value |
|----------|-------|
| **Name** | `kubernetes-expert` |
| **Description** | Kubernetes-related tasks including cluster management, workload deployment, service mesh, and cloud-native orchestration. Specializes in K8s, OpenShift, Helm, and GitOps. |
| **Tools** | `read`, `write`, `edit`, `bash` |
| **Model Override** | None (inherits parent) |
| **Async-Only** | No |

**Key behaviors:**

- Declarative/GitOps approach (ArgoCD, Flux)
- Security: RBAC, NetworkPolicies, Pod Security Standards
- Observability: Prometheus, Grafana
- Resource requests/limits, liveness/readiness probes
- Platforms: OpenShift, EKS, GKE, AKS, k3s
- Package management: Helm, Kustomize
- Manifests validated with kubeval/kubeconform

```text
subagent(agent="kubernetes-expert", task="Create Helm chart for the API service with HPA", cwd="/project", estimatedSeconds=20)
```

### jenkins-expert

| Property | Value |
|----------|-------|
| **Name** | `jenkins-expert` |
| **Description** | Jenkins-related code including CI/CD pipelines, Jenkinsfiles, Groovy scripts, and build automation. |
| **Tools** | `read`, `write`, `edit`, `bash` |
| **Model Override** | None (inherits parent) |
| **Async-Only** | No |

**Key behaviors:**

- Declarative and scripted pipelines
- Groovy shared libraries
- Never hardcodes credentials — uses `withCredentials`
- Uses `@NonCPS` for non-serializable code
- JCasC (Jenkins Configuration as Code)
- Parallel stages, timeouts, post-action handling

```text
subagent(agent="jenkins-expert", task="Add a parallel testing stage to the Jenkinsfile", cwd="/project", estimatedSeconds=15)
```

---

## Version Control Agents

### git-expert

| Property | Value |
|----------|-------|
| **Name** | `git-expert` |
| **Description** | Local git operations including commits, branching, merging, rebasing, stash, and resolving git issues. Never uses --no-verify. For GitHub platform operations (PRs, issues, releases), use github-expert instead. |
| **Tools** | `read`, `bash` |
| **Model Override** | None (inherits parent) |
| **Async-Only** | No |

**Key behaviors:**

- Executes git commands immediately — no confirmation needed
- Never commits or pushes to `main`/`master`
- Never uses `--no-verify`
- Never uses `git add .` — always stages specific files
- Commits via `echo -e "title\n\nbody" | git commit -F -`
- Branch prefixes: `feature/`, `fix/`, `hotfix/`, `refactor/`
- Does not run tests — asks orchestrator if tests passed before pushing
- Does not fix code — reports pre-commit hook failures

**Scope boundary:** Handles commit, branch, merge, rebase, stash, cherry-pick, log, diff, status, config. Delegates PRs, issues, releases, workflows to `github-expert`.

```text
subagent(agent="git-expert", task="Create branch fix/issue-42-null-check and commit the changes", cwd="/project", estimatedSeconds=10)
```

### github-expert

| Property | Value |
|----------|-------|
| **Name** | `github-expert` |
| **Description** | GitHub platform operations including PRs, issues, releases, repos, and workflows. Uses the gh CLI for all GitHub API interactions. |
| **Tools** | `read`, `bash` |
| **Model Override** | None (inherits parent) |
| **Async-Only** | No |

**Key behaviors:**

- Uses `gh` CLI exclusively for GitHub API interactions
- Executes commands immediately — no confirmation needed
- Never pushes to `main`/`master`, never commits to merged branches
- Does not run tests — delegates to `test-runner` first
- Returns URLs when creating PRs, issues, releases
- Uses `--json` flag for structured data

**Scope boundary:** Handles PRs, issues, releases, repos, workflows, GitHub API. Delegates commit, branch, merge, rebase to `git-expert`.

```text
subagent(agent="github-expert", task="Create a PR from fix/issue-42-null-check to main with title 'Fix null pointer in UserService'", cwd="/project", estimatedSeconds=10)
```

---

## Code Review Agents

All three code review agents run in parallel as part of the mandatory code review loop. They are all enforced as async-only. See [Running the Automated Code Review Loop](code-review-loop.html) for the full workflow.

> **Warning:** These agents only **review** code — they never modify files. The orchestrator delegates fixes to the appropriate language specialist based on review findings.

### code-reviewer-quality

| Property | Value |
|----------|-------|
| **Name** | `code-reviewer-quality` |
| **Description** | Code review focused on general code quality and maintainability. Reviews for clean code, proper abstractions, DRY, and readability. |
| **Tools** | `read`, `bash` |
| **Model Override** | None (inherits parent) |
| **Async-Only** | ✅ Yes |

**Review focus:**

- Code readability and clarity
- Proper abstractions and encapsulation
- DRY violations
- Code complexity (cognitive and cyclomatic)
- Error handling patterns
- Observability and debugging (silent error swallowing, missing logging, poor error context, opaque async code)
- Dead code and unused imports

**Reads project guidelines** (`AGENTS.md` or `CLAUDE.md`) before every review.

**Output format:**

```text
[SEVERITY] file:line — Description
  Suggestion: What to change and why
```

Severity levels: `[CRITICAL]`, `[WARNING]`, `[SUGGESTION]`

Approval output: `"No quality issues found. Code approved."`

### code-reviewer-guidelines

| Property | Value |
|----------|-------|
| **Name** | `code-reviewer-guidelines` |
| **Description** | Code review focused on project guidelines and style adherence. Reviews for AGENTS.md compliance, naming conventions, and project patterns. |
| **Tools** | `read`, `bash` |
| **Model Override** | None (inherits parent) |
| **Async-Only** | ✅ Yes |

**Review focus:**

- AGENTS.md / CLAUDE.md compliance
- **Documentation updates** — flags missing AGENTS.md/README.md updates as `[CRITICAL]`
- Project-specific coding standards
- Naming conventions, file/folder structure consistency
- Commit message and branch naming conventions
- Import ordering and grouping
- Configuration file formats

**Reads project guidelines** (`AGENTS.md` or `CLAUDE.md`) before every review.

**Output format:**

```text
[SEVERITY] file:line — Description
  Rule: Which guideline is violated
  Suggestion: How to fix
```

Approval output: `"Code follows all project guidelines. Approved."`

### code-reviewer-security

| Property | Value |
|----------|-------|
| **Name** | `code-reviewer-security` |
| **Description** | Code review focused on bugs, logic errors, and security vulnerabilities. Reviews for correctness, edge cases, and potential exploits. |
| **Tools** | `read`, `bash` |
| **Model Override** | None (inherits parent) |
| **Async-Only** | ✅ Yes |

**Review focus:**

- Logic errors and off-by-one bugs
- Null/undefined reference risks
- Race conditions and concurrency issues
- Input validation and sanitization
- SQL injection, XSS, CSRF vulnerabilities
- Hardcoded secrets or credentials
- Path traversal and file access
- Resource leaks (unclosed connections/files)
- Edge cases and boundary conditions

**Reads project guidelines** (`AGENTS.md` or `CLAUDE.md`) before every review.

**Output format:**

```text
[SEVERITY] file:line — Description
  Risk: What could go wrong
  Suggestion: How to fix
```

Approval output: `"No bugs or security issues found. Code approved."`

---

## Testing Agents

### test-automator

| Property | Value |
|----------|-------|
| **Name** | `test-automator` |
| **Description** | Create comprehensive test suites with unit, integration, and e2e tests. Sets up CI pipelines, mocking strategies, and test data. |
| **Tools** | `read`, `write`, `edit`, `bash` |
| **Model Override** | None (inherits parent) |
| **Async-Only** | No |

**Key behaviors:**

- Follows test pyramid: many unit, fewer integration, minimal E2E
- Arrange-Act-Assert pattern
- Tests behavior, not implementation
- Deterministic tests — no flakiness
- Follows mandatory TDD discipline (RED-GREEN-REFACTOR cycle)
- Supports Jest, pytest, and framework-appropriate tools

```text
subagent(agent="test-automator", task="Write unit tests for the UserService class in src/services/user.py", cwd="/project", estimatedSeconds=20)
```

### test-runner

| Property | Value |
|----------|-------|
| **Name** | `test-runner` |
| **Description** | Run tests and analyze failures. Returns detailed failure analysis without making fixes. |
| **Tools** | `bash`, `read` |
| **Model Override** | None (inherits parent) |
| **Async-Only** | No |

**Key behaviors:**

- Runs exactly the test command specified
- Never modifies files — analysis and reporting only
- Provides concise failure analysis with actionable fix suggestions
- Returns control promptly after analysis

**Output format:**

```text
✅ Passing: X tests
❌ Failing: Y tests

Failed Test 1: test_name (file:line)
Expected: [brief description]
Actual: [brief description]
Fix location: path/to/file.rb:line
Suggested approach: [one line]

Returning control for fixes.
```

```text
subagent(agent="test-runner", task="Run 'uv run pytest tests/ -v' and analyze any failures", cwd="/project", estimatedSeconds=15)
```

---

## Analysis and Planning Agents

### scout

| Property | Value |
|----------|-------|
| **Name** | `scout` |
| **Description** | Fast codebase reconnaissance. Finds relevant files, functions, and dependencies for a given task. |
| **Tools** | `read`, `bash` |
| **Model Override** | `claude-haiku-4-5` |
| **Async-Only** | No |

> **Note:** This is the only bundled agent with a model override. It uses `claude-haiku-4-5` for fast, low-cost codebase scanning.

**Key behaviors:**

- Uses `grep`, `find`, and `read` for rapid exploration
- Maps file dependencies and imports
- Identifies key functions, classes, and interfaces
- Notes relevant tests and configuration

**Output format:**

```text
## Relevant Files
- path/to/file.py — Description of what it contains

## Key Functions/Classes
- ClassName.method() in file.py:42 — What it does

## Dependencies
- file.py imports from other.py
- external: requests, fastapi

## Tests
- tests/test_file.py — Covers ClassName

## Notes
- Important observations about the codebase structure
```

```text
subagent(agent="scout", task="Find all files related to user authentication", cwd="/project", estimatedSeconds=10)
```

### planner

| Property | Value |
|----------|-------|
| **Name** | `planner` |
| **Description** | Creates detailed implementation plans from codebase context. Does not write code. |
| **Tools** | `read`, `bash` |
| **Model Override** | None (inherits parent) |
| **Async-Only** | No |

**Key behaviors:**

- Creates plans detailed enough for a worker agent to implement without ambiguity
- Specifies file paths, function names, and line numbers
- Covers edge cases, testing scenarios, and risks
- Read-only — never modifies files

**Output format:**

```text
## Implementation Plan

### Overview
Brief description of what will be changed and why.

### Changes
#### 1. path/to/file.py
- **What:** Description of changes
- **Why:** Rationale
- **Details:** Specific functions/classes to modify
- **Lines:** Approximate line ranges affected

### Edge Cases
1. Edge case → How to handle

### Testing
1. Test scenario — Expected behavior

### Risks
- Potential issue → Mitigation
```

```text
subagent(agent="planner", task="Plan the implementation of rate limiting for the API", cwd="/project", estimatedSeconds=15)
```

### debugger

| Property | Value |
|----------|-------|
| **Name** | `debugger` |
| **Description** | Debugging specialist for errors, test failures, and unexpected behavior. Diagnoses only — does not modify files. |
| **Tools** | `read`, `bash` |
| **Model Override** | None (inherits parent) |
| **Async-Only** | No |

**Key behaviors:**

- Root cause analysis only — never modifies files
- Follows systematic debugging: investigate → pattern analysis → hypothesis → implementation
- **Rule of Three:** After 3 failed fix attempts, stops and questions the architecture
- Provides fix recommendations with specific file/line references
- The orchestrator delegates actual fixes to the appropriate language specialist

```text
subagent(agent="debugger", task="Diagnose why test_create_user fails with ConnectionRefusedError", cwd="/project", estimatedSeconds=15)
```

---

## Documentation Agents

### technical-documentation-writer

| Property | Value |
|----------|-------|
| **Name** | `technical-documentation-writer` |
| **Description** | Comprehensive, user-focused technical documentation for projects, features, or systems. |
| **Tools** | `read`, `write`, `edit`, `bash` |
| **Model Override** | None (inherits parent) |
| **Async-Only** | No |

**Key behaviors:**

- User-first writing — for readers, not developers
- Progressive disclosure: overview → details
- Supports Markdown, MkDocs, Docusaurus, Sphinx
- All code examples verified
- WCAG accessibility, SEO-friendly structure

```text
subagent(agent="technical-documentation-writer", task="Write getting started guide for the CLI tool", cwd="/project", estimatedSeconds=20)
```

### api-documenter

| Property | Value |
|----------|-------|
| **Name** | `api-documenter` |
| **Description** | Create OpenAPI/Swagger specs, generate SDKs, and write developer documentation. Handles versioning, examples, and interactive docs. |
| **Tools** | `read`, `write`, `edit`, `bash` |
| **Model Override** | None (inherits parent) |
| **Async-Only** | No |

**Key behaviors:**

- OpenAPI 3.0/Swagger specification writing
- SDK generation and client library documentation
- Interactive documentation (Postman/Insomnia)
- Code examples in multiple languages
- Authentication, error codes, and rate limiting documentation

```text
subagent(agent="api-documenter", task="Generate OpenAPI 3.0 spec for the REST API in src/routes/", cwd="/project", estimatedSeconds=20)
```

### docs-fetcher

| Property | Value |
|----------|-------|
| **Name** | `docs-fetcher` |
| **Description** | Fetches current documentation for external libraries and frameworks. Prioritizes llms.txt when available, falls back to web parsing. |
| **Tools** | `read`, `bash` |
| **Model Override** | None (inherits parent) |
| **Async-Only** | No |

**Key behaviors:**

- Tries `{base_url}/llms-full.txt` first, then `llms.txt`, then HTML parsing
- Uses official docs only — never blog posts or tutorials
- Extracts only relevant sections based on query
- Always cites source URL and content type

> **Warning:** The orchestrator must **never** fetch external documentation directly. All documentation fetching must be delegated to `docs-fetcher`. See [Understanding Agent Routing and Delegation](agent-routing.html).

**Output format:**

```text
## {Library} - {Topic}

**Source:** {url}
**Type:** llms-full.txt | llms.txt | web-parsed

### Relevant Documentation
{extracted content}

### Key Points
- {actionable takeaway}

### Related Links
- [{section name}]({url})
```

```text
subagent(agent="docs-fetcher", task="Fetch React hooks documentation for useEffect cleanup patterns", cwd="/project", estimatedSeconds=10)
```

---

## Security Agent

### security-auditor

| Property | Value |
|----------|-------|
| **Name** | `security-auditor` |
| **Description** | Audits external repositories for security risks before adoption — checks for malicious code, data exfiltration, supply chain risks, and trust signals. |
| **Tools** | `read`, `bash` |
| **Model Override** | None (inherits parent) |
| **Async-Only** | No |

**Key behaviors:**

- Evaluates **external** third-party repos — not your own code
- Clones target repo to `${PROJECT_TMP_DIR}/` with `--depth 1`
- 8 audit categories: malicious code, data exfiltration, supply chain, filesystem access, network/permissions, trust signals, license compatibility, build integrity
- Reads actual source code — does not guess from file names
- Lists all network endpoints contacted
- Produces structured report with per-category risk levels and a final verdict: `✅ SAFE`, `⚠️ CAUTION`, or `❌ UNSAFE`

```text
subagent(agent="security-auditor", task="Audit https://github.com/example/some-library for security risks before we adopt it", cwd="/project", estimatedSeconds=25)
```

---

## General-Purpose Agents

### reviewer

| Property | Value |
|----------|-------|
| **Name** | `reviewer` |
| **Description** | General code review agent. Reviews code changes for quality, correctness, and style. |
| **Tools** | `read`, `bash` |
| **Model Override** | None (inherits parent) |
| **Async-Only** | No |

**Key behaviors:**

- General-purpose reviewer covering correctness, security, quality, performance, and style
- Less specialized than the three dedicated code reviewers
- Useful for quick, single-pass reviews outside the formal review loop

**Output format:**

```text
[SEVERITY] file:line — Description
  Suggestion: How to fix
```

Approval output: `"No issues found. Code approved. ✅"`

```text
subagent(agent="reviewer", task="Quick review of the changes in src/utils.py", cwd="/project", estimatedSeconds=10)
```

### worker

| Property | Value |
|----------|-------|
| **Name** | `worker` |
| **Description** | General-purpose agent for tasks that don't match any specialist. Full capabilities. |
| **Tools** | `read`, `write`, `edit`, `bash` |
| **Model Override** | None (inherits parent) |
| **Async-Only** | No |

**Key behaviors:**

- Fallback agent when no specialist matches the task
- Full read/write/edit/bash capabilities
- Handles any file type, shell commands, general refactoring
- Reports tasks that would be better handled by a specialist

```text
subagent(agent="worker", task="Rename all occurrences of 'oldName' to 'newName' across the codebase", cwd="/project", estimatedSeconds=15)
```

---

## Agent Capabilities Summary

| Agent | `read` | `write` | `edit` | `bash` | Modifies Files | Model Override |
|-------|--------|---------|--------|--------|-----------------|----------------|
| `api-documenter` | ✅ | ✅ | ✅ | ✅ | Yes | — |
| `bash-expert` | ✅ | ✅ | ✅ | ✅ | Yes | — |
| `code-reviewer-guidelines` | ✅ | ❌ | ❌ | ✅ | No | — |
| `code-reviewer-quality` | ✅ | ❌ | ❌ | ✅ | No | — |
| `code-reviewer-security` | ✅ | ❌ | ❌ | ✅ | No | — |
| `debugger` | ✅ | ❌ | ❌ | ✅ | No | — |
| `docker-expert` | ✅ | ✅ | ✅ | ✅ | Yes | — |
| `docs-fetcher` | ✅ | ❌ | ❌ | ✅ | No | — |
| `git-expert` | ✅ | ❌ | ❌ | ✅ | No (git ops only) | — |
| `github-expert` | ✅ | ❌ | ❌ | ✅ | No (gh ops only) | — |
| `go-expert` | ✅ | ✅ | ✅ | ✅ | Yes | — |
| `java-expert` | ✅ | ✅ | ✅ | ✅ | Yes | — |
| `jenkins-expert` | ✅ | ✅ | ✅ | ✅ | Yes | — |
| `kubernetes-expert` | ✅ | ✅ | ✅ | ✅ | Yes | — |
| `planner` | ✅ | ❌ | ❌ | ✅ | No | — |
| `python-expert` | ✅ | ✅ | ✅ | ✅ | Yes | — |
| `reviewer` | ✅ | ❌ | ❌ | ✅ | No | — |
| `scout` | ✅ | ❌ | ❌ | ✅ | No | `claude-haiku-4-5` |
| `security-auditor` | ✅ | ❌ | ❌ | ✅ | No | — |
| `technical-documentation-writer` | ✅ | ✅ | ✅ | ✅ | Yes | — |
| `test-automator` | ✅ | ✅ | ✅ | ✅ | Yes | — |
| `test-runner` | ✅ | ❌ | ❌ | ✅ | No | — |
| `ts-expert` | ✅ | ✅ | ✅ | ✅ | Yes | — |
| `worker` | ✅ | ✅ | ✅ | ✅ | Yes | — |

---

## Adding, Removing, and Overriding Agents

See [Customization and Extension Recipes](customization-recipes.html) for step-by-step instructions on creating custom agents.

### Adding an Agent

1. Create a `.md` file in `agents/` with the required frontmatter (`name`, `description`)
2. Add a routing entry in `rules/10-agent-routing.md`
3. Add the agent name to the list in `rules/50-agent-bug-reporting.md`

### Removing an Agent

1. Delete the agent file from `agents/`
2. Remove the routing entry from `rules/10-agent-routing.md`
3. Remove the agent from `rules/50-agent-bug-reporting.md`

### Overriding a Bundled Agent

Place a `.md` file with the same `name` in the higher-priority directory:

- `~/.pi/agent/agents/` overrides package-bundled agents for all projects
- `<project>/.pi/agents/` overrides both package and user agents for that project

The override completely replaces the original agent definition, including tools, model, and system prompt.

### Adding an Agent to the Async-Only List

Edit the `ASYNC_ONLY_AGENTS` set in `extensions/orchestrator/subagent-tool.ts`:

```typescript
const ASYNC_ONLY_AGENTS = new Set([
  "code-reviewer-quality",
  "code-reviewer-guidelines",
  "code-reviewer-security",
  "your-new-agent",  // add here
]);
```

---

## Related Pages

- [Understanding Agent Routing and Delegation](agent-routing.html) — How the orchestrator decides which agent to invoke
- [Running the Automated Code Review Loop](code-review-loop.html) — The 3-reviewer parallel review workflow
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) — Async agent execution and monitoring
- [Extension Architecture and Lifecycle Hooks](extension-architecture.html) — How `subagent-tool.ts` and `agents.ts` work internally
- [Orchestrator Rules Reference](rules-reference.html) — Full reference for routing rules and orchestrator behavior
- [Command Safety Guards and Enforcement](command-enforcement.html) — Safety restrictions that apply to all agents

## Related Pages

- [Understanding Agent Routing and Delegation](agent-routing.html)
- [Running the Automated Code Review Loop](code-review-loop.html)
- [Customization and Extension Recipes](customization-recipes.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
- [Command Safety Guards and Enforcement](command-enforcement.html)
