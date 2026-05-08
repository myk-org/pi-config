# Specialist Agent Catalog

The orchestrator delegates tasks to 24 specialist agents via the `subagent` tool. Each agent runs in an isolated context with its own tool permissions, system prompt, and optional model override. See [Orchestrator Architecture](architecture.html) for how the orchestrator discovers, routes, and manages agents.

> **Note:** Agents are defined as Markdown files with YAML frontmatter in the `agents/` directory. Users can override or extend agents from `~/.pi/agent/agents/` (user scope) or `.pi/agents/` (project scope). See Custom Agent Development for details on creating your own agents.

## Quick Reference

| Agent | Domain | Tools | Model |
|-------|--------|-------|-------|
| `api-documenter` | API documentation and specs | read, write, edit, bash | default |
| `bash-expert` | Shell scripting and automation | read, write, edit, bash | default |
| `code-reviewer-guidelines` | Project standards compliance | read, bash | default |
| `code-reviewer-quality` | Code quality and maintainability | read, bash | default |
| `code-reviewer-security` | Bugs, logic errors, security | read, bash | default |
| `debugger` | Error diagnosis and root cause analysis | read, bash | default |
| `docker-expert` | Containers and Docker workflows | read, write, edit, bash | default |
| `docs-fetcher` | External documentation retrieval | read, bash | default |
| `frontend-expert` | Frontend development (JS/TS/CSS) | read, write, edit, bash | default |
| `git-expert` | Local git operations | read, bash | default |
| `github-expert` | GitHub platform operations | read, bash | default |
| `go-expert` | Go programming | read, write, edit, bash | default |
| `java-expert` | Java programming | read, write, edit, bash | default |
| `jenkins-expert` | Jenkins CI/CD pipelines | read, write, edit, bash | default |
| `kubernetes-expert` | Kubernetes and cloud-native | read, write, edit, bash | default |
| `planner` | Implementation planning | read, bash | default |
| `python-expert` | Python programming | read, write, edit, bash | default |
| `reviewer` | General code review | read, bash | default |
| `scout` | Fast codebase reconnaissance | read, bash | `claude-haiku-4-5` |
| `security-auditor` | External repo security audit | read, bash | default |
| `technical-documentation-writer` | Technical documentation | read, write, edit, bash | default |
| `test-automator` | Test suite creation and CI setup | read, write, edit, bash | default |
| `test-runner` | Test execution and failure analysis | bash, read | default |
| `worker` | General-purpose fallback | read, write, edit, bash | default |

## Routing Table

The orchestrator routes tasks by **intent**, not by the tool being used. See [Orchestrator Architecture](architecture.html) for the full routing logic.

| Domain | Routed To | Examples |
|--------|-----------|---------|
| Python (.py) | `python-expert` | Writing, testing, or refactoring Python code |
| Go (.go) | `go-expert` | Writing or modifying Go code |
| Frontend (JS/TS/React/Vue/Angular) | `frontend-expert` | Component creation, CSS, frontend testing |
| Java (.java) | `java-expert` | Spring Boot, Maven, Gradle, JUnit |
| Shell scripts (.sh) | `bash-expert` | Script creation, system automation |
| Markdown (.md) | `technical-documentation-writer` | Documentation authoring |
| Docker | `docker-expert` | Dockerfile, Compose, image optimization |
| Kubernetes/OpenShift | `kubernetes-expert` | Manifests, Helm charts, GitOps |
| Jenkins/CI/Groovy | `jenkins-expert` | Jenkinsfile, pipeline configuration |
| Git operations (local) | `git-expert` | Commits, branches, merges, rebasing |
| GitHub (PRs, issues, releases, workflows) | `github-expert` | `gh` CLI operations |
| Tests | `test-automator` | Creating test suites and CI pipelines |
| Debugging | `debugger` | Error diagnosis and root cause analysis |
| API docs | `api-documenter` | OpenAPI specs, SDK generation |
| External repo security audit | `security-auditor` | Pre-adoption security review |
| External library/framework docs | `docs-fetcher` | Fetching React, FastAPI, Django docs |
| No specialist match | `worker` | General-purpose fallback |

> **Tip:** Running Python tests routes to `python-expert`, not `bash-expert`. Creating a PR routes to `github-expert`, not `git-expert`. Always think about the *intent* of the task.

---

## Language Specialists

### api-documenter

Create OpenAPI/Swagger specs, generate SDKs, and write developer documentation. Handles versioning, examples, and interactive docs.

| Property | Value |
|----------|-------|
| **Name** | `api-documenter` |
| **Tools** | read, write, edit, bash |
| **Model** | default |

**Capabilities:**
- OpenAPI/Swagger specification generation
- SDK generation
- Interactive documentation (Postman, Insomnia)
- API versioning
- Multi-language code examples
- Authentication and error documentation

**Invocation example:**

```
subagent(agent="api-documenter", task="Generate OpenAPI 3.0 spec for the user API in src/api/users.py", cwd="/path/to/project", estimatedSeconds=30)
```

---

### bash-expert

Bash and shell scripting creation, modification, refactoring, and fixes. Specializes in Bash, Zsh, POSIX shell, automation scripts, and system administration.

| Property | Value |
|----------|-------|
| **Name** | `bash-expert` |
| **Tools** | read, write, edit, bash |
| **Model** | default |

**Capabilities:**
- Bash, Zsh, POSIX sh scripting
- Text processing with grep, sed, awk, jq, yq
- systemd and cron configuration
- Deployment automation

**Enforced patterns:**
- Defensive scripting with `set -euo pipefail`
- Proper variable quoting (`"$var"`)
- POSIX compatibility when possible
- Shellcheck compliance
- Proper shebangs and cleanup traps

**Invocation example:**

```
subagent(agent="bash-expert", task="Create a deployment script that builds the Docker image, runs migrations, and restarts the service", cwd="/path/to/project", estimatedSeconds=20)
```

---

### frontend-expert

Frontend development (JS/TS/React/Vue/Angular/CSS). UI design, component creation, and modern web technologies.

| Property | Value |
|----------|-------|
| **Name** | `frontend-expert` |
| **Tools** | read, write, edit, bash |
| **Model** | default |

**Capabilities:**
- JavaScript and TypeScript
- Component frameworks: React, Vue, Angular
- CSS, Tailwind, styled-components
- Frontend testing: Jest, Vitest, Cypress, Playwright
- Build tools: Vite, Webpack, esbuild
- UI/UX patterns

**Invocation example:**

```
subagent(agent="frontend-expert", task="Add dark mode toggle to the header component using Tailwind CSS", cwd="/path/to/project", estimatedSeconds=25)
```

---

### go-expert

Go code creation, modification, refactoring, and fixes. Specializes in goroutines, channels, modules, testing, and high-performance Go.

| Property | Value |
|----------|-------|
| **Name** | `go-expert` |
| **Tools** | read, write, edit, bash |
| **Model** | default |

**Capabilities:**
- Idiomatic Go with goroutines and channels
- Web frameworks: Gin, Echo, Fiber, Chi, net/http
- CLI tools: Cobra, Viper
- Testing: table-driven tests, testify, gomock
- Tooling: golangci-lint, delve, pprof

**Quality checklist applied:**
- `golangci-lint` passes
- Tests pass with `-race` flag
- Context propagated through call chains
- Errors wrapped with `fmt.Errorf`
- Code formatted with gofmt/goimports

**Invocation example:**

```
subagent(agent="go-expert", task="Implement the UserService with CRUD operations and table-driven tests", cwd="/path/to/project", estimatedSeconds=30)
```

---

### java-expert

Java code creation, modification, refactoring, and fixes. Specializes in Spring Boot, Maven, Gradle, JUnit testing, and enterprise applications.

| Property | Value |
|----------|-------|
| **Name** | `java-expert` |
| **Tools** | read, write, edit, bash |
| **Model** | default |

**Capabilities:**
- Modern Java 17+ (records, sealed classes, pattern matching)
- Spring Boot, Spring MVC, Spring Data, Spring Security, WebFlux
- Build tools: Maven, Gradle
- Testing: JUnit 5, Mockito, TestContainers
- Reactive programming: Project Reactor, WebFlux

**Quality checklist applied:**
- Java 17+ target version
- Tests pass (unit + integration)
- Proper exception handling
- SLF4J logging
- JavaDoc on public APIs

**Invocation example:**

```
subagent(agent="java-expert", task="Add pagination support to the OrderRepository using Spring Data JPA", cwd="/path/to/project", estimatedSeconds=20)
```

---

### python-expert

Python code creation, modification, refactoring, and fixes. Specializes in idiomatic Python, async/await, testing, and modern Python development.

| Property | Value |
|----------|-------|
| **Name** | `python-expert` |
| **Tools** | read, write, edit, bash |
| **Model** | default |

**Capabilities:**
- Modern Python: type hints, dataclasses, async/await
- Web frameworks: FastAPI, Django, Flask
- Testing: pytest, mocking, fixtures
- Tooling: ruff, mypy, black
- Async: asyncio, aiohttp, anyio

> **Warning:** This agent **never** uses `python`, `python3`, `pip`, or `pip3` directly. All Python execution uses `uv`:
> - `uv run <script.py>` instead of `python script.py`
> - `uv run pytest` instead of `pytest`
> - `uvx <tool>` instead of `pip install <tool> && <tool>`
> - `uv add <package>` instead of `pip install <package>`

**Quality checklist applied:**
- Type hints on public functions
- Tests with pytest (>90% coverage target)
- Formatted with ruff/black
- Linted with ruff
- Docstrings on public APIs

**Invocation example:**

```
subagent(agent="python-expert", task="Add rate limiting middleware to the FastAPI app using slowapi", cwd="/path/to/project", estimatedSeconds=25)
```

---

## Infrastructure Specialists

### docker-expert

Docker and container-related tasks including Dockerfile creation, container orchestration, image optimization, and containerization workflows.

| Property | Value |
|----------|-------|
| **Name** | `docker-expert` |
| **Tools** | read, write, edit, bash |
| **Model** | default |

**Capabilities:**
- Docker Engine, BuildKit, Buildx
- Multi-stage builds
- Docker Compose and Docker Swarm
- Podman compatibility
- Registries: Docker Hub, Harbor, ECR, GCR, ACR
- Image scanning: Trivy
- Rootless containers

**Enforced patterns:**
- Security first: non-root users, minimal base images
- Layer optimization with multi-stage builds and cache mounts
- Small images: Alpine, distroless, scratch when possible
- Reproducibility: pinned versions, locked dependencies
- `.dockerignore`, health checks, vulnerability scanning

**Invocation example:**

```
subagent(agent="docker-expert", task="Optimize the Dockerfile for production with multi-stage build and non-root user", cwd="/path/to/project", estimatedSeconds=20)
```

---

### jenkins-expert

Jenkins-related code including CI/CD pipelines, Jenkinsfiles, Groovy scripts, and build automation.

| Property | Value |
|----------|-------|
| **Name** | `jenkins-expert` |
| **Tools** | read, write, edit, bash |
| **Model** | default |

**Capabilities:**
- Declarative and scripted pipelines
- Groovy shared libraries
- Gradle and Maven integration
- Plugins: Pipeline, Docker, Kubernetes, Credentials
- Jenkins Configuration as Code (JCasC)

> **Warning:** This agent enforces strict credential handling:
> - **NEVER** hardcodes credentials — uses `withCredentials` exclusively
> - **NEVER** skips validation with workarounds
> - Uses `@NonCPS` for non-serializable code
> - Cleans workspace after builds

**Quality checklist applied:**
- Validated pipeline syntax
- Secured credentials via `withCredentials`
- Configured timeouts
- Post actions defined
- Parallel stages where applicable
- Shared libraries used for reuse

**Invocation example:**

```
subagent(agent="jenkins-expert", task="Create a declarative pipeline with parallel test stages and Docker build", cwd="/path/to/project", estimatedSeconds=25)
```

---

### kubernetes-expert

Kubernetes-related tasks including cluster management, workload deployment, service mesh, and cloud-native orchestration. Specializes in K8s, OpenShift, Helm, and GitOps.

| Property | Value |
|----------|-------|
| **Name** | `kubernetes-expert` |
| **Tools** | read, write, edit, bash |
| **Model** | default |

**Capabilities:**
- Core K8s: Pods, Deployments, Services, ConfigMaps, Secrets, Ingress
- Workloads: StatefulSets, DaemonSets, Jobs, CronJobs
- Package management: Helm, Kustomize
- GitOps: ArgoCD, Flux
- Service mesh: Istio, Linkerd
- Platforms: OpenShift, EKS, GKE, AKS, k3s

**Enforced patterns:**
- Declarative/GitOps over imperative commands
- RBAC and Network Policies
- Observable: Prometheus, Grafana, proper logging
- Resilient: health checks, PDBs, resource limits

**Quality checklist applied:**
- Resource requests and limits set
- Liveness and readiness probes defined
- Security context configured
- Network policies in place
- RBAC configured
- No hardcoded secrets
- Manifests validated

**Invocation example:**

```
subagent(agent="kubernetes-expert", task="Create Helm chart for the microservice with HPA, PDB, and network policies", cwd="/path/to/project", estimatedSeconds=30)
```

---

## Version Control Specialists

### git-expert

Local git operations including commits, branching, merging, rebasing, stash, and resolving git issues. For GitHub platform operations (PRs, issues, releases), use `github-expert` instead.

| Property | Value |
|----------|-------|
| **Name** | `git-expert` |
| **Tools** | read, bash |
| **Model** | default |

**Capabilities:**
- Commits, branching, merging, rebasing
- Stash, cherry-pick, log, diff, status, config
- Conflict resolution
- Commit message formatting via `-F -` (stdin)

**Protection rules:**

| Rule | Description |
|------|-------------|
| No main/master commits | NEVER commits or pushes to `main` or `master` |
| No merged-branch commits | NEVER commits to already-merged branches |
| No `--no-verify` | NEVER uses the `--no-verify` flag |
| Branch prefixes | Uses `feature/`, `fix/`, `hotfix/`, `refactor/` |
| No AI attribution | No Claude/AI signatures in commit messages |
| No code fixes | Reports pre-commit hook failures; does not fix code |
| No test execution | Asks orchestrator to verify tests before pushing |

**Invocation example:**

```
subagent(agent="git-expert", task="Create a feature branch from main and commit the staged changes with message 'Add user authentication'", cwd="/path/to/project", estimatedSeconds=10)
```

---

### github-expert

GitHub platform operations including PRs, issues, releases, repos, and workflows. Uses the `gh` CLI for all GitHub API interactions.

| Property | Value |
|----------|-------|
| **Name** | `github-expert` |
| **Tools** | read, bash |
| **Model** | default |

**Operations:**

| Category | Commands |
|----------|----------|
| Pull Requests | `gh pr create`, `gh pr view`, `gh pr list`, `gh pr merge`, `gh pr close`, `gh pr checkout`, `gh pr diff`, `gh pr checks` |
| Issues | `gh issue create`, `gh issue view`, `gh issue list`, `gh issue close`, `gh issue comment`, `gh issue edit` |
| Releases | `gh release create`, `gh release view`, `gh release list` |
| Workflows | `gh workflow list`, `gh workflow run`, `gh run list`, `gh run view` |

**Constraints:**
- NEVER uses `ask_user` — specialist agents do not interact with users directly
- NEVER pushes to `main`/`master`
- NEVER commits to merged branches
- Does NOT run tests; asks orchestrator to verify before creating PRs
- Issue title format: `<type>: <brief description>`

**Invocation example:**

```
subagent(agent="github-expert", task="Create a PR from feature/auth to main with title 'Add OAuth2 login' and a summary of changes", cwd="/path/to/project", estimatedSeconds=15)
```

---

## Code Review Specialists

Four agents handle code review, each covering a different dimension. See [Orchestrator Architecture](architecture.html) for how they are typically combined in parallel review tasks.

### code-reviewer-guidelines

Code review focused on project guidelines and style adherence. Reviews for AGENTS.md compliance, naming conventions, and project patterns.

| Property | Value |
|----------|-------|
| **Name** | `code-reviewer-guidelines` |
| **Tools** | read, bash (read-only — no modifications) |
| **Model** | default |

**Review focus:**
- AGENTS.md compliance (reads AGENTS.md first)
- Documentation updates — missing doc updates are flagged as `[CRITICAL]`
- Naming conventions
- File and folder structure
- Commit messages and branch naming
- Import ordering
- Consistency with existing codebase patterns

**Output format:** `[SEVERITY] file:line` — severities: `CRITICAL`, `WARNING`, `SUGGESTION`

**Invocation example:**

```
subagent(agent="code-reviewer-guidelines", task="Review the changes on the current branch for project guideline compliance", cwd="/path/to/project", estimatedSeconds=20)
```

---

### code-reviewer-quality

Code review focused on general code quality and maintainability. Reviews for clean code, proper abstractions, DRY, and readability.

| Property | Value |
|----------|-------|
| **Name** | `code-reviewer-quality` |
| **Tools** | read, bash (read-only — no modifications) |
| **Model** | default |

**Review focus:**
- Readability and naming
- Abstractions and DRY violations
- Complexity
- Error handling and observability

**Critical anti-patterns detected:**
- Silent error swallowing (empty catch blocks)
- Missing operation logging
- Poor error context
- Opaque async/background code without logging

**Output format:** `[SEVERITY] file:line`

**Invocation example:**

```
subagent(agent="code-reviewer-quality", task="Review src/services/ for code quality issues", cwd="/path/to/project", estimatedSeconds=20)
```

---

### code-reviewer-security

Code review focused on bugs, logic errors, and security vulnerabilities. Reviews for correctness, edge cases, and potential exploits.

| Property | Value |
|----------|-------|
| **Name** | `code-reviewer-security` |
| **Tools** | read, bash (read-only — no modifications) |
| **Model** | default |

**Review focus:**

| Category | Checks |
|----------|--------|
| Logic | Off-by-one errors, null/undefined risks, race conditions |
| Input | SQL injection, XSS, CSRF, input validation |
| Secrets | Hardcoded credentials, insecure cryptography |
| Filesystem | Path traversal, resource leaks |
| General | Error handling gaps, edge cases, implicit assumptions |

**Approach:** Traces data flow, identifies trust boundaries, checks error paths, verifies input validation.

**Output format:** `[SEVERITY] file:line` with Risk and Suggestion

**Invocation example:**

```
subagent(agent="code-reviewer-security", task="Security review of the authentication module in src/auth/", cwd="/path/to/project", estimatedSeconds=25)
```

---

### reviewer

General code review agent. Reviews code changes for quality, correctness, and style.

| Property | Value |
|----------|-------|
| **Name** | `reviewer` |
| **Tools** | read, bash (read-only — no modifications) |
| **Model** | default |

**Review areas:**
- **Correctness** — logic errors, edge cases, off-by-one bugs
- **Security** — input validation, injection, secrets exposure
- **Quality** — readability, naming, DRY, proper abstractions
- **Performance** — unnecessary allocations, N+1 queries, blocking calls
- **Style** — project conventions, consistent formatting

**Output format:** `[SEVERITY] file:line` — outputs `"No issues found. Code approved. ✅"` when clean.

**Invocation example:**

```
subagent(agent="reviewer", task="Review the diff on the current branch", cwd="/path/to/project", estimatedSeconds=20)
```

---

## Analysis and Planning Specialists

### debugger

Debugging specialist for errors, test failures, and unexpected behavior. Diagnoses only — does not modify files.

| Property | Value |
|----------|-------|
| **Name** | `debugger` |
| **Tools** | read, bash (read-only — no modifications) |
| **Model** | default |

**Capabilities:**
- Error analysis and stack trace interpretation
- Test failure investigation
- Performance issue identification
- Root cause analysis

> **Note:** The debugger **diagnoses only**. It does not modify files. The orchestrator delegates the actual fix to the appropriate language specialist based on the debugger's report.

**Deliverables per issue:**
- Root cause explanation
- Evidence supporting the diagnosis
- Recommended fix description
- File paths and line numbers to modify
- Testing approach to verify the fix

**Invocation example:**

```
subagent(agent="debugger", task="Investigate why test_user_creation is failing with 'IntegrityError: duplicate key'", cwd="/path/to/project", estimatedSeconds=20)
```

---

### planner

Creates detailed implementation plans from codebase context. Does not write code.

| Property | Value |
|----------|-------|
| **Name** | `planner` |
| **Tools** | read, bash (analysis only) |
| **Model** | default |

**Output structure:**
- Overview of the change
- Per-file changes with What, Why, Details, and Lines
- Edge cases to handle
- Testing strategy
- Risks and mitigations

> **Note:** Plans must be detailed enough for worker agents to implement without ambiguity. Includes specific file paths, function names, and line numbers.

**Invocation example:**

```
subagent(agent="planner", task="Plan the implementation of role-based access control for the API", cwd="/path/to/project", estimatedSeconds=30)
```

---

### scout

Fast codebase reconnaissance. Finds relevant files, functions, and dependencies for a given task.

| Property | Value |
|----------|-------|
| **Name** | `scout` |
| **Tools** | read, bash (exploration only) |
| **Model** | `claude-haiku-4-5` |

> **Note:** This is the only agent that uses a non-default model. It runs on `claude-haiku-4-5` for cost optimization, since reconnaissance tasks are high-volume and don't require the most capable model.

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

**Invocation example:**

```
subagent(agent="scout", task="Find all files related to payment processing and map their dependencies", cwd="/path/to/project", estimatedSeconds=15)
```

---

## Testing Specialists

### test-automator

Create comprehensive test suites with unit, integration, and e2e tests. Sets up CI pipelines, mocking strategies, and test data.

| Property | Value |
|----------|-------|
| **Name** | `test-automator` |
| **Tools** | read, write, edit, bash |
| **Model** | default |

**Capabilities:**
- Unit test design with mocking and fixtures
- Integration tests with test containers
- E2E tests with Playwright and Cypress
- CI/CD pipeline configuration
- Test data factories
- Coverage analysis

**Enforced patterns:**
- Test pyramid: many unit, fewer integration, minimal E2E
- Arrange-Act-Assert pattern
- Behavior-focused tests (not implementation-focused)
- Deterministic tests — no flakiness
- Parallel execution where possible

**Invocation example:**

```
subagent(agent="test-automator", task="Create unit and integration tests for the OrderService with >90% coverage", cwd="/path/to/project", estimatedSeconds=30)
```

---

### test-runner

Run tests and analyze failures. Returns detailed failure analysis without making fixes.

| Property | Value |
|----------|-------|
| **Name** | `test-runner` |
| **Tools** | bash, read (read-only — no modifications) |
| **Model** | default |

**Workflow:** Run → Parse → Analyze failures → Report

> **Note:** This agent **never modifies files**. It runs exactly the test command specified, analyzes failures, and returns control promptly.

**Output per failure:**
- Test name and location
- Expected vs. actual result
- Most likely fix location
- One-line fix suggestion

**Invocation example:**

```
subagent(agent="test-runner", task="Run 'uv run pytest tests/test_orders.py -v' and analyze any failures", cwd="/path/to/project", estimatedSeconds=15)
```

---

## Documentation Specialists

### docs-fetcher

Fetches current documentation for external libraries and frameworks. Prioritizes `llms.txt` when available, falls back to web parsing.

| Property | Value |
|----------|-------|
| **Name** | `docs-fetcher` |
| **Tools** | read, bash |
| **Model** | default |

**Retrieval strategy (in order):**
1. Try `llms-full.txt` at the library's domain
2. Try `llms.txt`
3. Fall back to HTML parsing

**Output includes:**
- Source URL
- Type: `llms-full`, `llms`, or `web-parsed`
- Extracted sections relevant to the query
- Key points
- Related links

> **Warning:** The orchestrator **must never** fetch external documentation directly using `fetch_content`. All external doc requests **must** be delegated to `docs-fetcher`, which optimizes for LLM-friendly formats and token efficiency.

**When to use:**
- Fetching library/framework documentation (React, FastAPI, Django, etc.)
- Looking up configuration guides for external tools
- Getting API references for third-party services

**When to skip:**
- Standard library only (no external dependencies)
- User explicitly says "skip docs" or "I know the API"
- Simple operations with obvious patterns
- Docs already fetched in current conversation

**Invocation example:**

```
subagent(agent="docs-fetcher", task="Fetch FastAPI dependency injection documentation", cwd="/path/to/project", estimatedSeconds=15)
```

---

### technical-documentation-writer

Comprehensive, user-focused technical documentation for projects, features, or systems.

| Property | Value |
|----------|-------|
| **Name** | `technical-documentation-writer` |
| **Tools** | read, write, edit, bash |
| **Model** | default |

**Capabilities:**
- Markdown, MkDocs, Docusaurus, Sphinx
- Diagrams: Mermaid, PlantUML
- WCAG accessibility
- SEO structure

**Enforced patterns:**
- User-first writing (write for the reader, not the developer)
- Progressive disclosure (overview → details)
- Actionable step-by-step with expected outcomes
- Tested: all code examples verified

**Quality checklist applied:**
- Target audience identified
- Prerequisites stated
- Examples verified
- Links verified
- Consistent terminology
- Scannable structure

**Invocation example:**

```
subagent(agent="technical-documentation-writer", task="Write setup and usage docs for the authentication module", cwd="/path/to/project", estimatedSeconds=30)
```

---

## Security Specialist

### security-auditor

Audits external repositories for security risks before adoption — checks for malicious code, data exfiltration, supply chain risks, and trust signals.

| Property | Value |
|----------|-------|
| **Name** | `security-auditor` |
| **Tools** | read, bash |
| **Model** | default |

**Audit categories:**

| Category | What It Checks |
|----------|---------------|
| Malicious Code | `eval`/`exec`, obfuscation, time bombs, hidden functionality |
| Data Exfiltration | Network calls, env vars, credentials, DNS exfiltration |
| Supply Chain Risk | Dependency count, CVEs, suspicious packages, install hooks, pinning, freshness |
| Filesystem & System | Read/write scope, sensitive paths, self-updating code, subprocess usage |
| Network & Permissions | Listening ports, TLS bypass, proxying |
| Trust Signals | Contributors, stars, forks, maintenance activity |
| License Compatibility | Permissive vs. copyleft, compatibility checks |
| Build & Release Integrity | Source/binary matching, signing, CI transparency |

**Approach:**
- Clones repos to `/tmp/pi-work/` with `--depth 1`
- Reads **every** source file (not just entry points)
- Lists **all** network endpoints contacted
- Never redacts findings — shows exact file paths and line numbers

**Output:** Structured report with findings tables, risk levels, and a final verdict of `SAFE`, `CAUTION`, or `UNSAFE`.

**Invocation example:**

```
subagent(agent="security-auditor", task="Audit the repository at https://github.com/example/lib for security risks", cwd="/tmp/pi-work", estimatedSeconds=45)
```

---

## General-Purpose Agent

### worker

General-purpose agent for tasks that don't match any specialist. Full capabilities.

| Property | Value |
|----------|-------|
| **Name** | `worker` |
| **Tools** | read, write, edit, bash |
| **Model** | default |

**Capabilities:**
- Read, analyze, and modify any file type
- Run shell commands
- General code writing and refactoring
- File system operations
- Research and analysis

> **Note:** If the worker identifies that a task would be better handled by a specialist, it reports this and hands off. The worker is the orchestrator's fallback when no specialist matches the task domain.

**Invocation example:**

```
subagent(agent="worker", task="Rename all occurrences of 'oldConfig' to 'appConfig' across the project", cwd="/path/to/project", estimatedSeconds=15)
```

---

## Agent Configuration Reference

Each agent is defined as a Markdown file with YAML frontmatter. See Custom Agent Development for how to create and override agents.

### Frontmatter Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | yes | — | Unique agent identifier used in routing and `subagent` calls |
| `description` | string | yes | — | One-line capability summary shown in agent listings |
| `tools` | string | no | all tools | Comma-separated list of allowed tools (e.g., `read, write, edit, bash`) |
| `model` | string | no | inherits from parent | Model override (e.g., `claude-haiku-4-5`) |

### Agent Scopes

| Scope | Source Directories | Priority |
|-------|-------------------|----------|
| `package` | Bundled `agents/` directory | Lowest (base) |
| `user` | `~/.pi/agent/agents/` | Overrides package |
| `project` | `.pi/agents/` in project root | Highest (overrides user and package) |

Later sources override earlier ones by agent name. See Custom Agent Development for details on the override mechanism.

### Agent Capabilities by Tool Access

| Tool Combination | Can Modify Files | Can Execute Commands | Agents |
|-----------------|------------------|---------------------|--------|
| read, bash | No | Yes (read-only intent) | code-reviewer-guidelines, code-reviewer-quality, code-reviewer-security, debugger, docs-fetcher, git-expert, github-expert, planner, reviewer, scout, security-auditor |
| bash, read | No | Yes (read-only intent) | test-runner |
| read, write, edit, bash | Yes | Yes | api-documenter, bash-expert, docker-expert, frontend-expert, go-expert, java-expert, jenkins-expert, kubernetes-expert, python-expert, technical-documentation-writer, test-automator, worker |

> **Note:** Agents with `read, bash` tools are analysis-only — they can read code and run commands for inspection but cannot modify files. This is a safety constraint for review, debugging, and audit agents.
