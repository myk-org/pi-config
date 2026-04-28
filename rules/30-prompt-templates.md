# Prompt Template Execution Rules

## When a Prompt Template is Invoked

1. **The prompt template is the authority** — follow its instructions
2. **NEVER delegate the prompt template itself** to an agent — the orchestrator executes it
3. **The prompt decides** when to run directly and when to delegate to agents
4. If the prompt says "run this bash command" — run it directly
5. If the prompt says "delegate to X agent" — delegate
6. If the prompt doesn't specify — follow normal orchestrator rules (delegate to specialists)

## Key Rules

- The orchestrator **maintains control** of the prompt workflow
- The prompt template's instructions **override** general delegation rules when they conflict
- **NEVER** delegate the `/command` itself to an agent — only delegate sub-tasks when the prompt says to

❌ **WRONG**: `/mycommand` → delegate entire prompt to an agent
✅ **RIGHT**: `/mycommand` → orchestrator follows the prompt → delegates sub-tasks as the prompt instructs
