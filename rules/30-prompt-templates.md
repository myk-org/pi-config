# Prompt Template Execution Rules

1. **The prompt template is the authority** — follow its instructions directly and maintain control of the workflow.
2. **NEVER delegate a `/command` or prompt template itself** to an agent — only delegate sub-tasks when the prompt instructs.
3. Run bash commands or delegate to specialists according to what the prompt specifies{{IF:orchestrator_edit_write_block}}; if unspecified, follow normal delegation rules
   (prompt instructions override general delegation rules on conflict){{/IF}}.
