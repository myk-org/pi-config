# Documentation Updates (MANDATORY)

After ANY code is added, changed, or removed, check if documentation needs updating:

| Change | Check these files |
|--------|-------------------|
| New feature/command/tool | `README.md` (feature table, usage examples) |
| New or modified extension module | `AGENTS.md` (repository structure) |
| New agent added/removed | `AGENTS.md` (structure), `rules/10-agent-routing.md` (routing table), `rules/50-agent-bug-reporting.md` (agent list) |
| New prompt template | `README.md` (prompt templates table) |
| Docker/container changes | `README.md` (Docker section, shell alias, mounts), `Dockerfile` |
| New CLI tool or dependency | `README.md` (tools table), `Dockerfile` |
| Dev workflow changes | `DEVELOPMENT.md` |

**Do not skip this step.** Documentation drift is a bug.
