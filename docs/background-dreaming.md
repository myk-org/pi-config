# Background Memory Consolidation (Dreaming)

Dreaming is Pi’s background memory-maintenance system. It periodically reads recent session history, extracts durable project knowledge, and refreshes the files that power long-term memory, skills, and enforcement metadata.

You should care because it changes what the agent remembers without requiring constant manual cleanup. Over time, recurring decisions, conventions, and corrections become easier for Pi to reuse, while stale or low-value memory is less likely to keep polluting future sessions.

## The Big Picture

### What Runs

| Component | What it does | User-visible effect |
|---|---|---|
| Dream worker | Runs a background `worker` agent that reads recent session transcripts and updates memory topic files. | New lessons, preferences, decisions, and completions appear without manual entry. |
| Rebuild pass | Re-scores and re-organizes memory topic files after dreaming and on a periodic timer. | Memory stays sorted, deduplicated, and ready for prompt injection. |
| Provenance merge | Merges pending provenance metadata into scored memory records. | Stored memories can keep a link back to their source session. |
| Promotion pass | Evaluates mature memories for enforcement metadata or queueing into the promotion file. | Repeated patterns can turn into stronger guardrails or skill candidates. |

### Trigger Points

| Trigger | Source | Default behavior |
|---|---|---|
| Automatic timer | Dreaming extension | Runs periodically while auto-dreaming is enabled. |
| Manual run | `/dream` | Starts a background pass immediately. |
| Session quit | Session shutdown hook | May queue one final pass when the session exits normally. |
| Rebuild timer | Rebuild worker | Re-scores topic files every 30 minutes. |

### End-to-End Flow

1. Pi decides whether a dream pass can run in the current session.
2. A background `worker` agent is launched with a task focused on memory maintenance.
3. The worker reads existing topic files under `.pi/memory/topics/`.
4. The worker scans recent session transcripts and extracts durable knowledge.
5. The worker may update topic files, create project skill files, and write promotion/provenance sidecars.
6. When the background job completes, Pi runs follow-up maintenance:
   - `rebuildAndOrganize(...)`
   - `mergeProvenancePending(...)`
   - `runPromotionPass(...)`

> **Note:** Dreaming runs only in the top-level orchestrator session, not inside spawned subagents.

## Key Concepts

### Topic Files

Dreaming treats the topic files in `.pi/memory/topics/` as the source of truth for project memory.

Current categories map to these files:

| Category | Topic file |
|---|---|
| `preference` | `preferences.md` |
| `lesson` | `lessons.md` |
| `pattern` | `patterns.md` |
| `decision` | `decisions.md` |
| `done` | `completions.md` |
| `mistake` | `mistakes.md` |

Each entry is a single markdown bullet such as:

```md
- [lesson] Use uv run for Python commands
- [preference] Keep commit messages short *(pinned)*
```

User-visible effect:

- Future sessions can reuse these entries through the memory system.
- Topic files stay readable and editable by humans.
- Pinned entries survive normal cleanup.

### Quality Gate

Dreaming does not blindly ingest every chat. The worker is instructed to prefer sessions with actual decisions, corrections, or completed work, and to skip trivial material.

Examples of high-signal material:

- A user correcting how commands should be run
- A repeated workflow that keeps showing up across sessions
- A completed feature or merged task worth remembering

Examples of low-signal material:

- Greetings
- Short one-off questions
- Sessions with little substantive work

User-visible effect:

- Memory quality improves more slowly, but with less noise.
- Pi is less likely to “remember” throwaway chatter as a project rule.

### Watermark Tracking

Dreaming uses a watermark file at `.pi/memory/.dream-watermark` to avoid reprocessing the same recent session history over and over.

It also limits how many historical sessions are processed in one pass.

User-visible effect:

- Automatic runs stay incremental instead of rescanning everything.
- Dreaming is less likely to monopolize background capacity after a long gap.

### Rebuild and Re-Scoring

After dreaming writes topic content, Pi runs `rebuildAndOrganize(...)` to rescore entries from the current topic files.

This keeps the scored memory state aligned with the human-readable files.

User-visible effect:

- New entries start influencing future prompts more quickly.
- Duplicate or weak entries are less likely to accumulate indefinitely.
- Topic ordering can shift as some memories become “hotter” than others.

### Provenance Sidecar

Dreaming can write pending provenance data to `.pi/memory/provenance-pending.json`.

That sidecar can include fields such as:

- `sourceSession`
- `derivedFrom`
- `informs`

After the dream job finishes, Pi merges that sidecar into scored memory records.

User-visible effect:

- Some memories can retain a trace back to where they came from.
- Provenance helps later tooling explain why a memory exists.

### Promotion Queue

Dreaming and related memory logic can append candidates to `.pi/memory/promotions.md`.

Promotion destinations currently include:

| Destination | Meaning |
|---|---|
| `memory` | Keep as regular memory |
| `skill` | Candidate for a project skill |
| `enforcement` | Candidate for code-enforced behavior |
| `project_rule` | Proposed rule only |
| `discard` | Not worth keeping |

Important promotion thresholds in the current code:

| Promotion type | Evidence threshold |
|---|---|
| Enforcement | `3` |
| Skill | `3` |
| Project rule | `5` |

User-visible effect:

- Repeated, strong patterns can graduate into stricter behavior.
- Not everything is auto-applied: project rules remain proposals until a human handles them.

> **Warning:** `project_rule` candidates are not auto-written into rule files. They stay proposed in the promotion queue.

### Skill Auto-Creation

The dream worker may create project-level skill files under `.pi/skills/<name>/SKILL.md` when it sees a recurring multi-step workflow.

This is separate from normal topic memory. It is meant for procedures, not just facts.

User-visible effect:

- Repeated workflows can become reusable agent skills.
- Future sessions may benefit from a structured checklist instead of a loose memory entry.

### Pinned and Enforced Entries

Dreaming is instructed to preserve entries marked with `*(pinned)*` and not rewrite entries marked `*(enforced)*`.

Why that matters to users:

- Pinned entries represent intentionally protected memory.
- Enforced entries are tied to enforcement metadata and should remain stable.

User-visible effect:

- Explicitly protected memory is safer from cleanup.
- Code-enforced guardrails are less likely to break during reorganization.

## How It Affects the User

### What You Will Notice

| Behavior | What it means |
|---|---|
| A moon icon appears in the status bar | A dream pass is currently running. |
| Pi starts following a repeated convention without being told again | Dreaming likely turned a repeated correction into stored memory. |
| New topic entries show up under `.pi/memory/topics/` | The worker extracted durable knowledge from recent sessions. |
| Promotion candidates appear in `.pi/memory/promotions.md` | A memory has crossed a threshold for stronger handling. |
| A project skill appears under `.pi/skills/` | Dreaming recognized a repeatable multi-step workflow. |

### Controls You Can Use

| Control | Effect |
|---|---|
| `/dream` | Starts a manual background pass. |
| `/dream-auto on` | Enables periodic dreaming for the current project. |
| `/dream-auto off` | Disables the automatic timer for the current project. |
| `dream_interval_hours` | Adjusts the automatic interval in project or global settings. |
| `PI_DREAM_INTERVAL_HOURS` | Environment-variable override for the interval. |

### When Dreaming Skips Work

Dreaming depends on an async-capable LLM path. In ACPX-based sessions, that usually means configuring both:

- `async_llm_provider`
- `async_llm_model`

If that path is unavailable, Pi skips the run and surfaces a warning in the UI.

User-visible effect:

- Manual `/dream` may appear to do nothing except show a warning.
- Auto-dreaming may remain enabled, but individual runs can be skipped until async LLM settings are valid.

> **Tip:** See [Configuration & Settings](configuration.html) for the exact settings used to control the dream interval and async LLM fallback.

## Related Pages

- See [Curating Project Memory](curating-project-memory.html) for details on manual memory entry and inspection.
- See [Memory Architecture](memory-architecture.html) for how scores, topic hotness, and prompt injection work.
- See [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) for the background execution model used by dreaming.
- See [Implementing Command Guards](safety-enforcements.html) for how promoted memory can affect enforcement behavior.
- See [Configuration & Settings](configuration.html) for the settings that control dream frequency and async LLM routing.

## Related Pages

- [Curating Project Memory](curating-project-memory.html)
- [Memory Architecture](memory-architecture.html)
- [Configuration & Settings](configuration.html)
- [Implementing Command Guards](safety-enforcements.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
