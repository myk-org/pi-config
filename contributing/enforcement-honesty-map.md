# Enforcement Honesty Map

Declares what is actually code-enforced versus prompt-only. A tier is about
**checkability**, not importance — prose rules can still be load-bearing.

| Tier | Meaning | Mechanism |
|------|---------|-----------|
| `code` | Runtime hooks act without relying on LLM compliance | `enforcement-rules.ts`, remote-exec helpers in `enforcement-helpers.ts` |
| `injected` | Present in situation report / rules markdown; LLM compliance only | Topic memories, package/user/project `rules/*.md` |
| `aspirational` | Documented guidance with no injection or hook guarantee | Rare edge docs, stale comments |

## Code tier (mechanical)

- Memory entries with `trigger` + `action` (and optional `verifier`) in `.pi/memory/memory-scores.jsonl`
- Topic marker `*(enforced)*` (display only; scores hold the binding)
- Trigger types: `bash_contains`, `bash_regex`, `tool_name`, `file_modified`
- Actions: `block`, `warn`, `run_after <cmd>`
- Verifiers: `tool_called <tool> before <command>` at `turn_end`
- Remote script exec blocks: `curl \| bash`, nested `$(bash -c "$(curl)")`, etc. (`checkRemoteExecBlock`)
- `comment_signature`: injects `Assisted-by: PI (<model>)` into `gh pr|issue create|comment|edit` `--body` / heredoc (`injectGhBodySignature`)
- Conflict handoff: in `git-expert`, `git add` / `git restore` / `git rm` / `git update-index` / `git reset` /
  `git checkout --ours|--theirs` and the `--continue` / `--skip` / `--quit` flags of
  `merge|rebase|cherry-pick|revert|am` are blocked while `git ls-files --unmerged` is non-empty, and a
  command that starts one of those sequencers and then stages in the same line is refused before the
  index is even read (`createsAndResolvesConflict`). Reads and `--abort` stay allowed. The refusal carries a
  message pointing at the `conflict-resolver` agent (`isConflictResolutionCommand`, `listUnmergedFiles`);
  `resolveEffectiveCwd` resolves quoting before boundaries and applies chained `cd`s in shell order, with
  `git -C` overriding both; conflict enforcement asks `conflictCandidateDirs` for every directory git could
  run in — per-subshell directory stacks, chained `-C` values, conditional `cd`s — and blocks when any is
  conflicted, refusing outright when a Git env var selects the index

- Review-learning address distillation: a `tool_result` watcher in `review-learning.ts` fires on non-error bash
  results matching `myk-pi-tools reviews address` (`isReviewsAddressCommand`) and distills the addressed findings
  from `.pi/data/reviews.db` into `lesson` memories with finding-id provenance
  (`derivedFrom="reviews.db:<id>;<owner>/<repo>"` — re-fires reinforce instead of duplicating, capped at 5 per fire).
  The **trigger** is code-tier; the **lesson content** is deterministic and model-free (finding-title extraction).
  Gated by the `review_learning` setting; graceful no-op on missing DB or unparsable remote (log.warn, never
  throws into the agent loop). Assumes `reviews address` runs in main-session bash — both review-handler modes run
  Phases 2–8 there; if address ever moves into a poll worker, this goes blind — move the distillation trigger with it

- Review-lesson write-time injection: `before_agent_start` appends a `review_lessons` system-prompt section
  (`review-learning.ts`) — path extraction is mechanical (prompt path regex + `git diff --name-only main...HEAD`),
  queries are sync with timeouts, no model calls. Omitted entirely when the query is empty (zero tokens on
  unaffected runs); gated by `review_learning`; never throws (other `before_agent_start` handlers must not stall)

- Review-lesson first-write hint + subagent task rewrite: in `review-learning.ts`, a `tool_result` handler appends
  the findings block to the first write/edit of a path not covered by prompt extraction (once per path per session,
  one-liners after the first full block), and a `tool_call` handler mutates the subagent `task` argument in place to
  carry the block to specialists (who receive no memory injection). Both omit-when-empty and gated by
  `review_learning`

Inventory a project’s code-tier memories:

```bash
# Human-readable inventory (code-tier + injected counts + open promotions)
uv run myk-pi-tools memory status

# Or raw scores:
# Preferred: use the CLI
uv run myk-pi-tools memory status

# Or raw scores (JSONL — last valid line):
jq -r '.entries | to_entries[] | select(.value.trigger and .value.action or .value.verifier) | .key' .pi/memory/memory-scores.jsonl
```

## Injected tier (LLM)

- Situation report sections (preferences, lessons, mistakes, …)
- Vector / session-history auto-injection
- Package rules `rules/00-69`, user `~/.pi/agent/rules/70-89`, project `.pi/rules/90-99`
- Promotion candidates section (open items in `.pi/memory/promotions.md`)

## Aspirational / propose-only

- `project_rule` promotions — never auto-written into `rules/` or `.pi/rules/`
- Dream skill suggestions that were not written under `.pi/skills/`
- Docs that describe desired behavior without a matching hook

## Promotion path into code tier

1. Live agent adds enforcement via `memory_add(trigger=…, action=…)` when mechanical
2. Or evidence accumulates → `memory-promotion.ts` auto-applies high-confidence `block`/`warn`
3. Ambiguous mechanical lessons stay `proposed` in `promotions.md` until filled in

See also: `docs/memory-architecture.md` Layer 5–6, `rules/35-memory.md`.
