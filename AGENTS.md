# Pi Config — Repo Contributor Rules

Rules specific to working on this repository. Product rules (orchestrator,
delegation, code review, branch protection, Python/MCP/web access, etc.)
are injected via the extension and apply to all users automatically.

## Docker / Dockerfile

This repo includes a `Dockerfile` for running pi in a sandboxed container.
The image is published at `ghcr.io/myk-org/pi-config:latest`.

**When adding a new feature that requires a new CLI tool or system dependency:**

- ✅ Update the `Dockerfile` to install the new tool
- ✅ Update the README Docker section if new mounts or env vars are needed
- ❌ Never assume a tool exists in the container — check the Dockerfile
