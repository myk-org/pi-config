# Rules and Layers

Rules are markdown files injected into the orchestrator's system prompt at the start of every agent turn. They are the behavioural contract: what the orchestrator is allowed to do, which specialist agent to route work to, when to run a review loop, when to write documentation.

Rules are **not** documentation for you to read. They are instructions for the model. This page explains how they load, how you add or override them, and what happens when a setting they depend on is missing.

## The three layers

The orchestrator scans three directories, in this order:

| Layer | Path | Scope |
| --- | --- | --- |
| Package | `<pi-config>/rules/` | All users, all projects (shipped with pi-config) |
| User | `~/.pi/agent/rules/` | All projects for this user |
| Project | `<project>/.pi/rules/` | The current project only |

Later layers override earlier ones. **The override is by filename, not by content.**

The loader builds a map from filename to the list of paths that provided it, walking the layers in order so the project path ends up last. For each filename it then tries candidates from last to first — project, then user, then package — and takes the first one it can read.

The consequence that matters in practice:

- If `~/.pi/agent/rules/40-critical-rules.md` and the package `rules/40-critical-rules.md` both exist, **only the user copy is loaded.** The package one is not merged in, appended, or diffed. Your file is a complete replacement.
- If the user layer has `70-my-rule.md` and the project layer has `80-my-other-rule.md`, **both are loaded**, alongside every package rule. Layering does not shadow across different filenames.

So a layer "wins" per file, and the only way to remove a package rule is to shadow its exact filename.

### Numeric prefixes

The project convention is to number files so that ordering is obvious and layers stay separate in the listing:

| Layer | Conventional range |
| --- | --- |
| Package | `00-69` |
| User | `70-89` |
| Project | `90-99` |

Two things to be clear about, because this is easy to get wrong:

1. **The ranges are a convention, not enforced behaviour.** The loader contains no numeric range check whatsoever. Nothing rejects a `05-*.md` file in the user directory or a `30-*.md` file in the project directory. The ranges appear in `README.md`, `AGENTS.md`, and `contributing/enforcement-honesty-map.md`; they are a naming discipline, not a mechanism.
2. **Ordering comes from the filename, sorted alphabetically.** After override resolution, the surviving files are sorted with `localeCompare` and joined in that order. The numeric prefixes are what make that alphabetical order match the intended reading order. This is why `00-` before `60-` works: the zero-padded numbers sort lexicographically.

### Other loading details

- Only files ending in `.md` are considered. Directories are skipped; symlinks to files are followed.
- A missing directory is ignored silently (`ENOENT`). Any other read error is logged at debug level and that layer contributes nothing.
- Files larger than **128 KB** are skipped with a debug log. Note the subtlety: an oversized file is treated as *handled*, so the loader does **not** fall back to a lower-precedence copy of the same filename. An oversized override silently shadows the package rule rather than deferring to it.
- If, after all layers, **no** rule file loads successfully, the orchestrator falls back to a single hardcoded line: `[ORCHESTRATOR RULES] You are a MANAGER. Delegate work to subagents.` This is the only guaranteed behaviour if rules are broken.
- Rules are injected only for the orchestrator. When `PI_SUBAGENT_CHILD === "1"`, the entire rules block is skipped. Several rule files open with a "if you are a specialist agent, ignore this" scope note for the same reason.

## The twelve package rules

| File | What it is for |
| --- | --- |
| `00-orchestrator-core.md` | The core contract: the delegation model (orchestrator delegates, never implements directly), the allowed direct actions, and a mandatory pre-implementation checklist. Most of the file is gated behind `orchestrator_edit_write_block`. |
| `05-issue-first-workflow.md` | The pre-implementation checklist for any code change: root-cause investigation first, then branch and issue creation, a defined issue format, and a "Done" definition. Includes the SKIP list for work that does not need the workflow, and edge cases. |
| `10-agent-routing.md` | The domain-to-agent routing table (Python, Go, TS, Java, shell, Markdown, Docker, Kubernetes, Jenkins, Git, GitHub, tests, debugging). Also covers routing by intent rather than by tool, documentation routing, which agents are dispatched internally rather than by the table, the `worker` fallback, and how to pass a model override to `subagent`. |
| `20-code-review-loop.md` | The mandatory review loop: six reviewers plus `test-runner` in parallel after any code change, the cycle definition and max-cycles budget, review agent list, finding deduplication, responding to findings, test tracking, and baseline test comparison. Entirely gated on `review_loop_enforcement`. |
| `25-documentation-updates.md` | A table mapping change types to the files that must be updated (`README.md`, `contributing/repo-structure.md`, the routing table, `Dockerfile`, `DEVELOPMENT.md`), ending with "documentation drift is a bug". |
| `30-prompt-templates.md` | What happens when a `/command` prompt template is invoked: the prompt is the authority, the orchestrator executes it, and sub-steps are delegated only when the prompt says so. |
| `35-memory.md` | The project memory system: the mandatory memory tools (`memory_search`, `memory_reinforce`, `memory_add`, `memory_remove`, `memory_topics`, `session_search`), the three auto-injection mechanisms (situation report, vector recall above 0.65 similarity, session history recall), storage layout, the scoring system, and the capacity signal. |
| `40-critical-rules.md` | Cross-cutting mandates: questions are not instructions, task focus on multi-step workflows, parallel execution, async agent and sync agent time estimates, subagent cwd, multi-PR/multi-branch work, user interaction, technical honesty, web access tooling, and the external code security audit gate. |
| `45-file-preview.md` | How to make generated HTML or frontend output viewable: save under the project dir, find a free port, launch `httpd.py`, report the URL. |
| `50-agent-bug-reporting.md` | What to do when the orchestrator finds a logic flaw in an agent defined in this repo: the workflow for filing a bug, the required issue format, and the agents it covers. |
| `55-coms-protocol.md` | Peer-to-peer inter-agent communication: activation via `/coms start`, the `coms_` tool prefix, inbound and outbound messaging, the message queue, and structured task delegation. Gated by `requires: coms_active` frontmatter, so it is absent unless coms is running. |
| `60-task-tracking.md` | Mandatory task list for workflows of 3+ steps: when to create tasks, granularity, lifecycle, side questions, and the async agent `taskId` requirement. |

Note that `25-documentation-updates.md` and `45-file-preview.md` contain little or no conditional syntax — the list of settings the rules actually branch on is much smaller than the number of rules.

## Conditional assembly

Rules are assembled per file: frontmatter gate first, then conditional blocks, then join, then placeholder substitution. Conditionals are evaluated **per file, before the join**, specifically so that an unclosed `{{IF}}` in one rule cannot match a `{{/IF}}` in another and silently strip the rules in between.

### `{{IF:}}` and `{{IFNOT:}}`

Wrap a block in markers to keep or drop it based on a setting:

```markdown
{{IF:use_worktrees}}
Worktree-based branch operations are mandatory.
{{/IF}}

{{IFNOT:review_loop_enforcement}}
Reviews are advisory in this project.
{{/IFNOT}}
```

Opening and closing markers must match kind: `{{IF}}` closes with `{{/IF}}`, `{{IFNOT}}` with `{{/IFNOT}}`.

Nesting is supported and tracked with a stack, so an inner block inside an outer block is fine.

### Comparisons

The key may be compared to a literal instead of being tested for truthiness:

```markdown
{{IF:review_loop_enforcement==true}}
{{IF:commit_trailer!=Assisted-by}}
```

Supported operators are `==` and `!=`. Supported literals are `true`, `false`, `null`, numbers, and single- or double-quoted strings. A bare, unquoted non-matching token is kept as a plain string.

Truthiness follows one helper: `false`, `null`, `undefined`, `""`, `0`, an empty array, and an empty object are falsy. Everything else — including non-empty strings like `"false"` — is truthy.

### Fail-closed behaviour

This is the part worth knowing, because it is stricter than "if in doubt, show the content".

**An unknown or malformed condition drops the block, and warns.**

`conditionHolds` checks the key against the known settings keys. If the key is not a known setting, it emits a warning and returns `false` *before* the inversion for `IFNOT` is applied. So a typo fails closed in both directions:

- `{{IF:review_loop_enforcment}}` → block removed. You lose the content you wanted.
- `{{IFNOT:review_loop_enforcment}}` → block **also** removed. The negation does not rescue it.

A malformed condition expression (empty, or not matching the key/operator/literal grammar) behaves the same way: warn, drop, no inversion.

Warnings go to the extension log at warn level under the `rule assembly:` prefix. If a rule you expected is silently absent, check the logs for that prefix before assuming the setting is off.

**Unbalanced markers are the exception.** They do not drop content. If a closer is missing, or the closer kind does not match the opener, the text from the open marker to the end is left in place verbatim, markers included, with a warning. A stray closer is also passed through with a warning. This is deliberately non-destructive, but it does mean a typo in a marker can leak literal `{{IF:...}}` text into the prompt.

**Table repair.** After conditionals run, blank lines between consecutive markdown table rows are collapsed to a single newline, so removing a conditional row does not break table adjacency. This applies within a file and across join boundaries.

### Feature predicates

Two keys are not settings but act like them, and are only available in the **truthy** form:

| Key | True when |
| --- | --- |
| `coms_active` | A coms session is active (`/coms start` has been run). |
| `external_ai_agents` | Either `acpx_agents` or `cli_agents` resolves to a non-empty list. |

Feature predicates are consulted only for a bare `{{IF:key}}`. Writing `{{IF:coms_active==true}}` falls through to the settings lookup, where `coms_active` is not a known key, and therefore fails closed with a warning — the block is dropped. Use the bare form.

### Frontmatter gate

A rule file can be excluded entirely with a frontmatter block:

```markdown
---
requires_setting: pidash_enable
---
```

`requires_setting` names a settings key; the file loads only when that setting is truthy. `requires` names a feature predicate; the file loads only when that predicate is true. If both are present, both must pass (AND). If neither is present, the file always loads.

An unknown key in `requires_setting`, or an unknown name in `requires`, warns and excludes the file.

`rules/55-coms-protocol.md` uses `requires: coms_active`, which is why the coms protocol only appears in the prompt once coms is running.

Note the frontmatter parser is deliberately simple: `key: value` lines between `---` fences, blank lines and `#` comments ignored. It is not YAML.

## Placeholders in rules

`{{REVIEW_LOOP_MAX_CYCLES}}` is replaced with the numeric value of the `review_loop_max_cycles` setting. Substitution runs **after** the conditional blocks are joined, so a placeholder inside a conditional block is only substituted if that block survived.

## `{{SETTINGS:key}}` is a different mechanism

`{{SETTINGS:key}}` looks similar and is **not** part of rule assembly.

- **Where it runs.** Agent prompt text, not rules. It is applied when a subagent prompt is dispatched (`subagent-tool.ts`) and when an async agent prompt is dispatched (`async-agents.ts`). Rules never see it — the rule assembler does not call it.
- **What it does.** It performs a straight textual substitution: `{{SETTINGS:dco,commit_trailer}}` is replaced with a JSON object of the resolved values, for example `{"dco":false,"commit_trailer":false}`. Bare `{{SETTINGS}}` resolves every known key.
- **Unknown keys are silently dropped**, not warned. A key that is not a known setting is skipped and simply absent from the resulting JSON object. This is the opposite of the conditional path, which warns and fails closed.
- **No gating.** It cannot include or exclude text. It only substitutes a value into text that is always present.

The practical distinction: rule conditionals decide *whether a section exists at all*, fail closed on unknown keys, and only work in `rules/*.md`. `{{SETTINGS:}}` decides *what value gets interpolated*, is silent on unknown keys, and only works in agent prompt text.

## Adding or overriding a rule

Create a markdown file in the appropriate directory. For a user-level rule that applies everywhere:

```bash
mkdir -p ~/.pi/agent/rules
cat > ~/.pi/agent/rules/75-my-rule.md << 'EOF'
# My Rule

Instructions for the orchestrator.
EOF
```

For a project-scoped rule:

```bash
mkdir -p /path/to/project/.pi/rules
cat > /path/to/project/.pi/rules/95-my-project-rule.md << 'EOF'
# My Project Rule

Instructions for the orchestrator in this project only.
EOF
```

To **override** a package rule, use its exact filename in the higher layer:

```bash
cp <pi-config>/rules/40-critical-rules.md ~/.pi/agent/rules/40-critical-rules.md
# edit to taste — the package copy is now ignored entirely
```

Copy the original rather than writing a stub. There is no merge: the file you place is the entire rule, and if it is too short the orchestrator loses the behaviour the original described.

A few constraints from the loader worth keeping in mind:

- Keep the file under 128 KB.
- Use a numeric prefix in the range for your layer so ordering stays sensible. The convention is not enforced, but ordering is by filename.
- If you use conditionals, spell the settings key exactly and check it against `settings-keys.json` at the repository root — a typo fails closed and the block silently disappears.
- Prefer the bare `{{IF:key}}` form for feature predicates.

### When changes take effect

Rule files are read from disk on every `before_agent_start` hook, so **editing a rule file does not require a new pi session** — the next agent start picks up the new content.

Settings are cached in memory, but the cache is invalidated by an `mtime` check on the settings files at most once every 30 seconds. So a settings change that gates a rule can take up to roughly 30 seconds to be reflected, and an immediate check may still see the old value. If a rule you just toggled on does not appear, wait and retry rather than restarting.

What genuinely does require a new session: `/reload` is not sufficient for extension *code* changes, since the extension module is loaded once at startup.
