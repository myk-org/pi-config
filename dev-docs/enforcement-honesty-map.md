# Enforcement Honesty Map

Declares what is actually code-enforced versus prompt-only. A tier is about
**checkability**, not importance — prose rules can still be load-bearing.

| Tier | Meaning | Mechanism |
|------|---------|-----------|
| `code` | Runtime hooks act without relying on LLM compliance | `enforcement-rules.ts`, remote-exec helpers in `enforcement-helpers.ts` |
| `injected` | Present in situation report / rules markdown; LLM compliance only | Topic memories, package/user/project `rules/*.md` |
| `aspirational` | Documented guidance with no injection or hook guarantee | Rare edge docs, stale comments |

## Code tier (mechanical)

- Memory entries with `trigger` + `action` (and optional `verifier`) in `.pi/memory/memory-scores.json`
- Topic marker `*(enforced)*` (display only; scores hold the binding)
- Trigger types: `bash_contains`, `bash_regex`, `tool_name`, `file_modified`
- Actions: `block`, `warn`, `run_after <cmd>`
- Verifiers: `tool_called <tool> before <command>` at `turn_end`
- Remote script exec blocks: `curl \| bash`, nested `$(bash -c "$(curl)")`, etc. (`checkRemoteExecBlock`)

Inventory a project’s code-tier memories:

```bash
# Human-readable inventory (code-tier + injected counts + open promotions)
uv run myk-pi-tools memory status

# Or raw scores:
# Preferred: use the CLI
uv run myk-pi-tools memory status

# Or raw scores (last valid line from JSONL):
jq -r '.entries | to_entries[] | select(.value.trigger and .value.action or .value.verifier) | .key' .pi/memory/memory-scores.json
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

See also: `dev-docs/memory-architecture.md` Layer 5–6, `rules/35-memory.md`.
