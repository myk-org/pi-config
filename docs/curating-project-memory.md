# Curating Project Memory

You want your AI agents to remember your project conventions, architectural decisions, and past mistakes so you don't have to repeat yourself in every session. This guide shows you how to explicitly seed context, audit what the agents have learned, and organize persistent project memory.

## Prerequisites

- A project initialized with Pi configuration.
- The `myk-pi-tools` CLI installed and available in your environment.

## Quick Example

```bash
myk-pi-tools memory add --category preference --summary "Always use uv run instead of pip" --pinned
```
The fastest way to ensure your agents remember a hard-and-fast rule is to explicitly add a pinned preference via the CLI.

## Step-by-Step

### 1. View Current Memory

```bash
myk-pi-tools memory show
```
Agents automatically store context as they work. This command dumps all active memory entries organized by topic and category (lessons, mistakes, preferences, etc.) so you can check what the system already knows before adding new rules.

### 2. Seed New Context

```bash
# Record an architectural decision
myk-pi-tools memory add -c decision -s "We use Redis for all caching instead of Memcached"

# Record a common stumbling block
myk-pi-tools memory add -c mistake -s "Buildah chown -R silently skips the target dir on this OS"
```
Use the `memory add` command to explicitly inject project context. You must select an appropriate category (`lesson`, `decision`, `mistake`, `pattern`, `done`, `preference`) and provide a short summary string.

> **Tip:** Use the `--pinned` flag for critical rules. Pinned memories are protected from the automatic decay and archiving that happens to older, less relevant context over time.

### 3. Clean Up Obsolete Context

```bash
myk-pi-tools memory forget -c decision -s "We use Redis for all caching instead of Memcached"
```
If a project's architecture changes, old memories can confuse the agents. Use the `memory forget` command with the exact category and summary text to permanently remove outdated context.

## Advanced Usage

### Automatic Preference Extraction

You don't always need to use the CLI to curate memory. During a normal chat session, the agent automatically monitors for phrases like "I prefer...", "Always use...", or "Never do X". When detected, the agent quietly extracts these rules into its memory system and reinforces them if they come up again in future sessions.

### Code Review Guidelines

When using the automated code review loop, the system maintains a separate memory track specifically for pull requests. When you skip an agent's code review finding for a generalizable reason (like "this is an intentional project pattern"), the system writes a new guideline.

All code review agents read these learned guidelines before their next pass, automatically suppressing similar findings. See [Automating Code Reviews](automating-code-reviews.html) for details.

### Auditing Enforcement and Promotions

```bash
myk-pi-tools memory status
```
Highly reinforced memories can automatically graduate into code-enforced rules that actively intercept or block destructive commands. This status command outputs an inventory of your "code-tier" (actively hooked) memory entries versus your "injected" (contextual) topics, and lists any pending memory promotions awaiting approval.

## Troubleshooting

- **Agent ignores a memory:** Verify the memory was actually stored using `myk-pi-tools memory show`. If a critical rule keeps getting ignored despite being in memory, try re-adding it with the `--pinned` flag or implementing a hard guard. See [Implementing Command Guards](safety-enforcements.html).
- **Context limit warnings:** If the agent complains about memory budgets or consolidation during a session, you have too many active memory topics. Manually drop outdated entries with `memory forget`, or simply allow the background daemon to organically decay cold topics over time.

## Related Pages

- [Memory Architecture](memory-architecture.html)
- [Background Memory Consolidation (Dreaming)](background-dreaming.html)
