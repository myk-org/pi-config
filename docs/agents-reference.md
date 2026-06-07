# Specialist Agents Reference

This page documents all 24 specialist agents bundled with pi-config. Each agent is defined as a Markdown file with YAML frontmatter in the `agents/` directory and is automatically discovered at session start.

For how the orchestrator selects agents, see [Understanding Agent Routing and Delegation](agent-routing.html). For the code review loop that uses the three reviewer agents, see [Running the Automated Code Review Loop](code-review-loop.html). For adding or removing agents, see [Customization and Extension Recipes](customization-recipes.html).

## Agent Discovery

Agents are loaded from three sources, in priority order (later overrides earlier by name):

1. **Package agents** — bundled in `agents/` (this repository)
2. **User agents** — `~/.pi/agent/agents/`
3. **Project agents** — `.pi/agents/` in the current directory or nearest parent

## Agent Summary Table

| Agent | Tools | Model | Async-Only | Category |
|-------|-------|-------|------------|----------|
| `api-documenter` | read, write, edit, bash | default | No | Documentation |
| `bash-expert` | read, write, edit, bash | default | No | Language |
| `code-reviewer-guidelines` | read, bash | default | **Yes** | Code Review |
| `code-reviewer-quality` | read, bash | default | **Yes** | Code Review |
| `code-reviewer-security` | read, bash | default | **Yes** | Code Review |
| `debugger` | read, bash | default | No | Development |
| `docker-expert` | read, write, edit, bash | default | No | Infrastructure |
| `docs-fetcher` | read, bash | default | No | Documentation |
| `git-expert` | read, bash | default | No | Version Control |
| `github-expert` | read, bash | default | No | Version Control |
| `go-expert` | read, write, edit, bash | default | No | Language |
| `java-expert` | read, write, edit, bash | default | No | Language |
| `jenkins-expert` | read, write, edit, bash | default | No | Infrastructure |
| `kubernetes-expert` | read, write, edit, bash | default | No | Infrastructure |
| `planner` | read, bash | default | No | Development |
| `python-expert` | read, write, edit, bash | default | No | Language |
| `reviewer` | read, bash | default | No | Code Review |
| `scout` | read, bash | `claude-haiku-4-5` | No | Development |
| `security-auditor` | read, bash | default | No | Security |
| `technical-documentation-writer` | read, write, edit, bash | default | No | Documentation |
| `test-automator` | read, write, edit, bash | default | No | Testing |
| `test-runner` | bash, read | default | No | Testing |
| `ts-expert` | read, write, edit, bash | default | No | Language |
| `worker` | read, write, edit, bash | default | No | General |

> **Note:** Async-only agents are automatically promoted to `async: true` by the subagent tool. They cannot be used in chain mode. See [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) for details.

---

## Language Specialist Agents

### `python-expert`

Python code creation, modification, refactoring, and fixes. Specializes in idiomatic Python, async/await, testing, and modern Python development.

| Property | Value |
|----------|-------|
| **File** | `agents/python-expert.md` |
| **Tools** | `read`, `write`, `edit`, `bash` |
| **Model** | default |
| **Modifies files** | Yes |

**Routing triggers:** Python files (`.py`), Python-related tasks, running Python tests.

**Key behaviors:**

- Enforces `uv`/`uvx` exclusively — never uses `python`, `python3`, `pip`, or `pip3` directly
- Uses type hints on public functions
- Targets pytest with >90% coverage
- Formats with ruff/black

**Example delegation:**

```text
subagent(agent="python-expert", task="Add retry logic to the API client in src/client.py")
```

---

### `ts-expert`

TypeScript, JavaScript, and frontend framework development (React/Vue/Angular/CSS). UI design, component creation, and modern web technologies.

| Property | Value |
|----------|-------|
| **File** | `agents/ts-expert.md` |
| **Tools** | `read`, `write`, `edit`, `bash` |
| **Model** | default |
| **Modifies files** | Yes |

**Routing triggers:** Frontend files (JS/TS/React/Vue/Angular), CSS/styling work, frontend testing.

**Key behaviors:**

- Covers JavaScript, TypeScript, React, Vue, Angular, and CSS
- Frontend testing with Jest, Vitest, Cypress, Playwright
- Build tooling: Vite, Webpack, esbuild

**Example delegation:**

```text
subagent(agent="ts-expert", task="Create a React component for the user settings page")
```

---

### `go-expert`

Go code creation, modification, refactoring, and fixes. Specializes in goroutines, channels, modules, testing, and high-performance Go.

| Property | Value |
|----------|-------|
| **File** | `agents/go-expert.md` |
| **Tools** | `read`, `write`, `edit`, `bash` |
| **Model** | default |
| **Modifies files** | Yes |

**Routing triggers:** Go files (`.go`), Go-related tasks.

**Key behaviors:**

- Concurrency patterns: goroutines, channels, sync primitives
- Table-driven tests with `-race` flag
- Error wrapping with `fmt.Errorf("...: %w", err)`
- Context propagation through call chains
- Linting with golangci-lint, formatting with gofmt/goimports

**Example delegation:**

```text
subagent(agent="go-expert", task="Implement a worker pool with graceful shutdown in pkg/workers/")
```

---

### `java-expert`

Java code creation, modification, refactoring, and fixes. Specializes in Spring Boot, Maven, Gradle, JUnit testing, and enterprise applications.

| Property | Value |
|----------|-------|
| **File** | `agents/java-expert.md` |
| **Tools** | `read`, `write`, `edit`, `bash` |
| **Model** | default |
| **Modifies files** | Yes |

**Routing triggers:** Java files (`.java`), Spring/Maven/Gradle tasks.

**Key behaviors:**

- Targets Java 17+ (records, sealed classes, pattern matching)
- Spring ecosystem: Boot, MVC, Data, Security, WebFlux
- Testing with JUnit 5, Mockito, TestContainers
- Logging with SLF4J, JavaDoc on public APIs

**Example delegation:**

```text
subagent(agent="java-expert", task="Add a REST endpoint for user profiles using Spring Boot")
```

---

### `bash-expert`

Bash and shell scripting creation, modification, refactoring, and fixes. Specializes in Bash, Zsh, POSIX shell, automation scripts, and system administration.

| Property | Value |
|----------|-------|
| **File** | `agents/bash-expert.md` |
| **Tools** | `read`, `write`, `edit`, `bash` |
| **Model** | default |
| **Modifies files** | Yes |

**Routing triggers:** Shell scripts (`.sh`), shell scripting tasks, system administration automation.

**Key behaviors:**

- Defensive scripting with `set -euo pipefail`
- All variables quoted (`"$var"`)
- Trap for cleanup on exit
- Shebang: `#!/usr/bin/env bash`
- Must pass shellcheck with no warnings
- Prefers POSIX when possible, bash-specific when needed

**Example delegation:**

```text
subagent(agent="bash-expert", task="Write a deployment script that rotates log files and restarts the service")
```

---

## Code Review Agents

> **Note:** All three code review agents (`code-reviewer-quality`, `code-reviewer-guidelines`, `code-reviewer-security`) are **async-only**. They are always dispatched in parallel during the code review loop. See [Running the Automated Code Review Loop](code-review-loop.html) for the full workflow.

### `code-reviewer-quality`

Code review focused on general code quality and maintainability. Reviews for clean code, proper abstractions, DRY, and readability.

| Property | Value |
|----------|-------|
| **File** | `agents/code-reviewer-quality.md` |
| **Tools** | `read`, `bash` |
| **Model** | default |
| **Modifies files** | No |
| **Async-only** | Yes |

**Review focus areas:**

- Code readability and clarity
- Proper abstractions and encapsulation
- DRY violations
- Code complexity (cognitive and cyclomatic)
- Error handling patterns
- Observability and debugging (silent error swallowing, missing logging, poor error context, opaque async code)
- Dead code and unused imports

**Output format:**

```text
[SEVERITY] file:line — Description
  Suggestion: What to change and why
```

Severity levels: `[CRITICAL]`, `[WARNING]`, `[SUGGESTION]`

Approval output: `"No quality issues found. Code approved."`

---

### `code-reviewer-guidelines`

Code review focused on project guidelines and style adherence. Reviews for AGENTS.md compliance, naming conventions, and project patterns.

| Property | Value |
|----------|-------|
| **File** | `agents/code-reviewer-guidelines.md` |
| **Tools** | `read`, `bash` |
| **Model** | default |
| **Modifies files** | No |
| **Async-only** | Yes |

**Review focus areas:**

- AGENTS.md compliance (reads the project's AGENTS.md first)
- Documentation updates — flags missing AGENTS.md/README.md updates as `[CRITICAL]`
- Project-specific coding standards
- Naming conventions matching existing codebase
- File/folder structure consistency
- Commit message and branch naming compliance
- Import ordering and grouping

**Output format:**

```text
[SEVERITY] file:line — Description
  Rule: Which guideline is violated
  Suggestion: How to fix
```

Severity levels: `[CRITICAL]`, `[WARNING]`, `[SUGGESTION]`

Approval output: `"Code follows all project guidelines. Approved."`

---

### `code-reviewer-security`

Code review focused on bugs, logic errors, and security vulnerabilities. Reviews for correctness, edge cases, and potential exploits.

| Property | Value |
|----------|-------|
| **File** | `agents/code-reviewer-security.md` |
| **Tools** | `read`, `bash` |
| **Model** | default |
| **Modifies files** | No |
| **Async-only** | Yes |

**Review focus areas:**

- Logic errors and off-by-one bugs
- Null/undefined reference risks
- Race conditions and concurrency issues
- Input validation and sanitization
- SQL injection, XSS, CSRF vulnerabilities
- Hardcoded secrets or credentials
- Insecure cryptographic usage
- Path traversal and file access
- Resource leaks (unclosed connections/files)
- Edge cases and boundary conditions

**Output format:**

```text
[SEVERITY] file:line — Description
  Risk: What could go wrong
  Suggestion: How to fix
```

Severity levels: `[CRITICAL]`, `[WARNING]`, `[SUGGESTION]`

Approval output: `"No bugs or security issues found. Code approved."`

---

### `reviewer`

General code review agent. Reviews code changes for quality, correctness, and style.

| Property | Value |
|----------|-------|
| **File** | `agents/reviewer.md` |
| **Tools** | `read`, `bash` |
| **Model** | default |
| **Modifies files** | No |

**Review areas:** Correctness, security, quality, performance, style.

**Output format:**

```text
[SEVERITY] file:line — Description
  Suggestion: How to fix
```

Approval output: `"No issues found. Code approved. ✅"`

> **Tip:** The three specialized review agents (`code-reviewer-quality`, `code-reviewer-guidelines`, `code-reviewer-security`) are preferred for the automated code review loop. The `reviewer` agent serves as a general-purpose reviewer for simpler reviews.

---

## Version Control Agents

### `git-expert`

Local git operations including commits, branching, merging, rebasing, stash, and resolving git issues. For GitHub platform operations, use `github-expert`.

| Property | Value |
|----------|-------|
| **File** | `agents/git-expert.md` |
| **Tools** | `read`, `bash` |
| **Model** | default |
| **Modifies files** | No (modifies git state only) |

**Routing triggers:** commit, branch, merge, rebase, stash, cherry-pick, log, diff, status, config.

**Protection rules:**

- Never commits or pushes to main/master
- Never commits to already-merged branches
- Never uses `--no-verify`
- Branch prefixes: `feature/`, `fix/`, `hotfix/`, `refactor/`

**Commit message format:** Uses `-F -` to read from stdin:

```bash
echo -e "Your commit title\n\nYour commit body" | git commit -F -
```

**Separation of concerns:**

- Does NOT run tests — asks the orchestrator to confirm tests passed before pushing
- Does NOT fix code — reports pre-commit hook failures to orchestrator

**Delegates to:** `github-expert` for PRs, issues, releases, workflows.

**Example delegation:**

```text
subagent(agent="git-expert", task="Create a feature branch and commit the changes in src/")
```

---

### `github-expert`

GitHub platform operations including PRs, issues, releases, repos, and workflows. Uses the `gh` CLI for all GitHub API interactions.

| Property | Value |
|----------|-------|
| **File** | `agents/github-expert.md` |
| **Tools** | `read`, `bash` |
| **Model** | default |
| **Modifies files** | No |

**Routing triggers:** PRs, issues, releases, repos, workflows, GitHub API operations.

**Core operations:**

| Operation | Commands |
|-----------|----------|
| Pull Requests | `gh pr create`, `gh pr view`, `gh pr list`, `gh pr merge`, `gh pr close`, `gh pr checkout`, `gh pr diff`, `gh pr checks` |
| Issues | `gh issue create`, `gh issue view`, `gh issue list`, `gh issue close`, `gh issue comment`, `gh issue edit` |
| Releases | `gh release create`, `gh release view`, `gh release list` |
| Workflows | `gh workflow list`, `gh workflow run`, `gh run list`, `gh run view` |

**Protection rules:**

- Never pushes to main/master
- Never commits to merged branches
- Does NOT run tests — asks orchestrator to delegate to `test-runner` first

**Delegates to:** `git-expert` for commit, branch, merge, rebase.

**Example delegation:**

```text
subagent(agent="github-expert", task="Create a PR from feature/add-retry-logic to main with a description of the changes")
```

---

## Infrastructure Agents

### `docker-expert`

Docker and container-related tasks including Dockerfile creation, container orchestration, image optimization, and containerization workflows.

| Property | Value |
|----------|-------|
| **File** | `agents/docker-expert.md` |
| **Tools** | `read`, `write`, `edit`, `bash` |
| **Model** | default |
| **Modifies files** | Yes |

**Routing triggers:** Docker, Dockerfile, container orchestration tasks.

**Key behaviors:**

- Security first: non-root users, minimal base images
- Multi-stage builds, cache mounts
- Small images: Alpine, distroless, scratch
- Reproducible builds: pinned versions, locked dependencies
- Covers Docker Engine, BuildKit, Buildx, Docker Compose, Docker Swarm, Podman, Buildah

**Example delegation:**

```text
subagent(agent="docker-expert", task="Optimize the Dockerfile to use multi-stage builds and reduce image size")
```

---

### `kubernetes-expert`

Kubernetes-related tasks including cluster management, workload deployment, service mesh, and cloud-native orchestration.

| Property | Value |
|----------|-------|
| **File** | `agents/kubernetes-expert.md` |
| **Tools** | `read`, `write`, `edit`, `bash` |
| **Model** | default |
| **Modifies files** | Yes |

**Routing triggers:** Kubernetes, OpenShift, Helm, K8s manifest tasks.

**Key behaviors:**

- Declarative (GitOps) over imperative commands
- Security: RBAC, Network Policies, Pod Security Standards
- Observability: Prometheus, Grafana integration
- Covers: Core K8s, StatefulSets, DaemonSets, Jobs, CronJobs, Helm, Kustomize, ArgoCD, Flux, Istio, Linkerd
- Platforms: OpenShift, EKS, GKE, AKS, k3s

**Example delegation:**

```text
subagent(agent="kubernetes-expert", task="Create Helm chart for the API service with liveness/readiness probes")
```

---

### `jenkins-expert`

Jenkins-related code including CI/CD pipelines, Jenkinsfiles, Groovy scripts, and build automation.

| Property | Value |
|----------|-------|
| **File** | `agents/jenkins-expert.md` |
| **Tools** | `read`, `write`, `edit`, `bash` |
| **Model** | default |
| **Modifies files** | Yes |

**Routing triggers:** Jenkins, CI/CD, Groovy scripts, Jenkinsfile tasks.

**Critical rules:**

- Never hardcodes credentials — uses `withCredentials`
- Never skips validation with workarounds
- Uses `@NonCPS` for non-serializable code
- Cleans workspace after builds

**Key behaviors:**

- Declarative and scripted pipelines
- Shared libraries, Groovy scripting
- Jenkins Configuration as Code (JCasC)
- Plugin integration: Pipeline, Docker, Kubernetes, credentials

**Example delegation:**

```text
subagent(agent="jenkins-expert", task="Create a declarative Jenkinsfile with parallel test stages and Docker build")
```

---

## Development Agents

### `debugger`

Debugging specialist for errors, test failures, and unexpected behavior. Diagnoses only — does not modify files.

| Property | Value |
|----------|-------|
| **File** | `agents/debugger.md` |
| **Tools** | `read`, `bash` |
| **Model** | default |
| **Modifies files** | No |

**Routing triggers:** Error analysis, test failure investigation, unexpected behavior debugging, stack trace analysis.

**Key behaviors:**

- Diagnoses only — the orchestrator delegates the actual fix to the appropriate language specialist
- **Rule of Three:** After 3 failed fix attempts, stops and flags an architectural problem
- Follows a 4-phase systematic debugging approach:
  1. Root cause investigation
  2. Pattern analysis
  3. Hypothesis and testing
  4. Implementation recommendation

> **Warning:** This agent never modifies files. It produces a diagnosis with recommended fixes, file locations, and testing approaches. The orchestrator must route the fix to the appropriate specialist.

**Example delegation:**

```text
subagent(agent="debugger", task="Investigate why test_user_auth is failing with a 403 after the latest changes")
```

---

### `planner`

Creates detailed implementation plans from codebase context. Does not write code.

| Property | Value |
|----------|-------|
| **File** | `agents/planner.md` |
| **Tools** | `read`, `bash` |
| **Model** | default |
| **Modifies files** | No |

**Routing triggers:** Used by the `/scout-and-plan` prompt template and when the orchestrator needs an implementation plan before coding.

**Output structure:**

- Overview of changes and rationale
- Per-file change details with specific functions/classes and line ranges
- Edge cases and handling strategies
- Test scenarios with expected behavior
- Risks and mitigations

**Example delegation:**

```text
subagent(agent="planner", task="Create an implementation plan for adding WebSocket support to the notification service")
```

---

### `scout`

Fast codebase reconnaissance. Finds relevant files, functions, and dependencies for a given task.

| Property | Value |
|----------|-------|
| **File** | `agents/scout.md` |
| **Tools** | `read`, `bash` |
| **Model** | `claude-haiku-4-5` |
| **Modifies files** | No |

> **Note:** This is the only agent with a model override. It uses `claude-haiku-4-5` for fast, low-cost reconnaissance.

**Routing triggers:** Used by the `/scout-and-plan` prompt template for initial codebase exploration before planning.

**Output structure:**

- Relevant files with descriptions
- Key functions/classes with file paths and line numbers
- Dependency mapping (internal and external)
- Related test files
- Observations about codebase structure

**Example delegation:**

```text
subagent(agent="scout", task="Find all files related to user authentication and map their dependencies")
```

---

## Testing Agents

### `test-automator`

Creates comprehensive test suites with unit, integration, and e2e tests. Sets up CI pipelines, mocking strategies, and test data.

| Property | Value |
|----------|-------|
| **File** | `agents/test-automator.md` |
| **Tools** | `read`, `write`, `edit`, `bash` |
| **Model** | default |
| **Modifies files** | Yes |

**Routing triggers:** Test creation, test suite design, CI/CD test pipeline configuration.

**Key behaviors:**

- Follows the test pyramid: many unit, fewer integration, minimal E2E
- Arrange-Act-Assert pattern
- Tests behavior, not implementation
- Enforces TDD (RED-GREEN-REFACTOR cycle)
- Uses appropriate frameworks: Jest, pytest, JUnit, etc.

**Example delegation:**

```text
subagent(agent="test-automator", task="Write unit tests for the PaymentProcessor class with edge cases for failed transactions")
```

---

### `test-runner`

Runs tests and analyzes failures. Returns detailed failure analysis without making fixes.

| Property | Value |
|----------|-------|
| **File** | `agents/test-runner.md` |
| **Tools** | `bash`, `read` |
| **Model** | default |
| **Modifies files** | No |

**Routing triggers:** Invoked during the code review loop (step 5) and when the orchestrator needs to verify tests pass.

**Key behaviors:**

- Runs exactly the test command specified
- Never modifies files
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

**Example delegation:**

```text
subagent(agent="test-runner", task="Run pytest in tests/ and analyze any failures")
```

---

## Documentation Agents

### `technical-documentation-writer`

Comprehensive, user-focused technical documentation for projects, features, or systems.

| Property | Value |
|----------|-------|
| **File** | `agents/technical-documentation-writer.md` |
| **Tools** | `read`, `write`, `edit`, `bash` |
| **Model** | default |
| **Modifies files** | Yes |

**Routing triggers:** Markdown files (`.md`), documentation tasks.

**Key behaviors:**

- User-first writing with progressive disclosure
- Supports: Markdown, MkDocs, Docusaurus, Sphinx
- All code examples tested and verified
- WCAG accessibility and SEO-friendly structure

**Example delegation:**

```text
subagent(agent="technical-documentation-writer", task="Write a getting started guide for the new CLI tool")
```

---

### `api-documenter`

Creates OpenAPI/Swagger specs, generates SDKs, and writes developer documentation. Handles versioning, examples, and interactive docs.

| Property | Value |
|----------|-------|
| **File** | `agents/api-documenter.md` |
| **Tools** | `read`, `write`, `edit`, `bash` |
| **Model** | default |
| **Modifies files** | Yes |

**Routing triggers:** API documentation, OpenAPI specs, SDK generation tasks.

**Key behaviors:**

- OpenAPI 3.0/Swagger specification writing
- SDK generation and client libraries
- Interactive documentation (Postman/Insomnia)
- Code examples in multiple languages
- Authentication and error documentation
- Versioning strategies and migration guides

**Example delegation:**

```text
subagent(agent="api-documenter", task="Generate an OpenAPI 3.0 spec for the /users and /orders REST endpoints")
```

---

### `docs-fetcher`

Fetches current documentation for external libraries and frameworks. Prioritizes `llms.txt` when available, falls back to web parsing.

| Property | Value |
|----------|-------|
| **File** | `agents/docs-fetcher.md` |
| **Tools** | `read`, `bash` |
| **Model** | default |
| **Modifies files** | No |

**Routing triggers:** Any request for external library/framework documentation (React, FastAPI, Django, etc.).

> **Warning:** The orchestrator must never fetch external documentation directly — it must always delegate to `docs-fetcher`. See [Understanding Agent Routing and Delegation](agent-routing.html) for the mandatory routing rule.

**Retrieval priority:**

1. `{base_url}/llms-full.txt` (optimized for LLMs)
2. `{base_url}/llms.txt`
3. HTML parsing (fallback)

**Output format:**

```markdown
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

**Example delegation:**

```text
subagent(agent="docs-fetcher", task="Fetch the React hooks documentation from the official React docs")
```

---

## Security Agent

### `security-auditor`

Audits external repositories for security risks before adoption — checks for malicious code, data exfiltration, supply chain risks, and trust signals.

| Property | Value |
|----------|-------|
| **File** | `agents/security-auditor.md` |
| **Tools** | `read`, `bash` |
| **Model** | default |
| **Modifies files** | No |

**Routing triggers:** External repository security audits, third-party dependency evaluation.

**Audit categories:**

| Category | What It Checks |
|----------|----------------|
| Malicious Code | Backdoors, eval/exec, obfuscated strings, hidden functionality |
| Data Exfiltration | Outbound endpoints, telemetry, credential reading, DNS exfiltration |
| Supply Chain Risk | Dependency CVEs, install hooks, abandoned packages, floating versions |
| Filesystem & System Access | Sensitive path access, self-updating mechanisms, child process usage |
| Network & Permissions | Port listening, TLS bypass, proxy/redirect behavior |
| Trust Signals | Contributors, stars, activity, organization reputation |
| License Compatibility | MIT/Apache/BSD (✅), GPL/AGPL (⚠️), missing license (❌) |
| Build & Release Integrity | Source-release match, signed binaries, CI transparency |

**Verdict levels:** `✅ SAFE`, `⚠️ CAUTION`, `❌ UNSAFE`

**Example delegation:**

```text
subagent(agent="security-auditor", task="Audit https://github.com/example/some-library for security risks before we adopt it")
```

---

## General-Purpose Agent

### `worker`

General-purpose agent for tasks that don't match any specialist. Full capabilities.

| Property | Value |
|----------|-------|
| **File** | `agents/worker.md` |
| **Tools** | `read`, `write`, `edit`, `bash` |
| **Model** | default |
| **Modifies files** | Yes |

**Routing triggers:** Fallback — any task with no matching specialist.

**Key behaviors:**

- Handles any file type and shell commands
- General code writing and refactoring
- File system operations, research, and analysis
- Hands off to a specialist if a better match is identified

**Example delegation:**

```text
subagent(agent="worker", task="Parse the CSV export and generate a summary report")
```

---

## Agent Frontmatter Schema

Every agent file uses YAML frontmatter with the following fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique agent identifier used in routing and delegation |
| `description` | string | Yes | One-line description of the agent's purpose |
| `tools` | string | No | Comma-separated list of tool names (`read`, `write`, `edit`, `bash`) |
| `model` | string | No | LLM model override (omit to use the session default) |

**Example frontmatter:**

```yaml
---
name: python-expert
description: Python code creation, modification, refactoring, and fixes.
tools: read, write, edit, bash
---
```

**Example with model override:**

```yaml
---
name: scout
description: Fast codebase reconnaissance.
tools: read, bash
model: claude-haiku-4-5
---
```

---

## Routing Table

The orchestrator routes tasks to agents based on domain. See [Orchestrator Rules Reference](rules-reference.html) for full rule details.

| Domain | Agent |
|--------|-------|
| Python (`.py`) | `python-expert` |
| Go (`.go`) | `go-expert` |
| Frontend (JS/TS/React/Vue/Angular) | `ts-expert` |
| Java (`.java`) | `java-expert` |
| Shell scripts (`.sh`) | `bash-expert` |
| Markdown (`.md`) | `technical-documentation-writer` |
| Docker | `docker-expert` |
| Kubernetes/OpenShift | `kubernetes-expert` |
| Jenkins/CI/Groovy | `jenkins-expert` |
| Git operations (local) | `git-expert` |
| GitHub (PRs, issues, releases) | `github-expert` |
| Tests | `test-automator` |
| Debugging | `debugger` |
| API docs | `api-documenter` |
| External repo security audit | `security-auditor` |
| External library/framework docs | `docs-fetcher` |
| No specialist match | `worker` |

> **Tip:** Routing is based on task intent, not tool usage. Running Python tests routes to `python-expert`, not `bash-expert`. Creating a PR routes to `github-expert`, not `git-expert`. See [Understanding Agent Routing and Delegation](agent-routing.html) for examples.

## Related Pages

- [Understanding Agent Routing and Delegation](agent-routing.html)
- [Running the Automated Code Review Loop](code-review-loop.html)
- [Customization and Extension Recipes](customization-recipes.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
- [Orchestrator Rules Reference](rules-reference.html)
