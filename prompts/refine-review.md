---
description: "Refine pending PR review comments before submitting — /refine-review <PR_URL>"
---

Execute this workflow step by step. Run bash commands directly.

## Prerequisites Check (MANDATORY)

### Step 0: Check uv

```bash
uv --version
```

If not found, stop — install from <https://docs.astral.sh/uv/getting-started/installation/>

### Step 1: Check myk-pi-tools

```bash
myk-pi-tools --version
```

If not found, ask user: "myk-pi-tools is required. Install with: `uv tool install myk-pi-tools`. Install now?"

## Phase 1: Fetch Pending Review

Parse `{{args}}` as the PR URL. If empty, abort with: "PR URL required. Usage: `/refine-review https://github.com/owner/repo/pull/123`"

```bash
myk-pi-tools reviews pending-fetch "{{args}}"
```

The command saves the review data to a JSON file and outputs the file path to stdout.

The JSON file contains:

- `metadata`: owner, repo, pr_number, review_id, username, json_path
- `comments`: array of pending review comments with id, path, line, body, diff_hunk
- `diff`: PR diff text for context

If the command fails (exit code 1), display the error and abort.

Capture the output (json_path) for later phases.

## Phase 2: Refine Comments

For each comment in the JSON, use the PR diff context, file path, line number, and diff hunk to generate a refined version.

**Refinement goals:**

- Improve clarity and conciseness
- Make comments more actionable (suggest specific fixes when possible)
- Fix grammar and formatting
- Add code suggestions in Markdown code blocks where appropriate
- Preserve the original intent and technical accuracy
- Keep the tone professional and constructive

## Phase 3: Present Side-by-Side

Display each comment with its refinement, numbered for reference. If a comment has no line number (file-level comment), show only the path:

```text
Comment #1 (path/to/file.py:42):
  Original: <user's original comment>
  Refined:  <AI-refined version>

Comment #2 (src/main.py):
  Original: <file-level comment>
  Refined:  <AI-refined version>
```

## Phase 4: User Approval

Ask the user which refinements to accept:

Options:

- **Accept all** — Use all refined versions
- **Pick specific** — Enter comment numbers to accept (e.g., "1,3,5")
- **Keep originals** — Skip refinement, go straight to submit step
- **Cancel** — Abort without making any changes
- **Custom text** — Type a custom replacement for specific comments (e.g., "2: my custom comment text")

If "Pick specific": ask for comma-separated numbers. Validate range. Re-prompt on invalid input.

If "Custom text": user provides comment number followed by their custom text.
The custom text replaces the refined version. After applying,
re-display affected comment(s) for confirmation before proceeding.

## Phase 5: Update JSON

Update the JSON file at `json_path`:

- For each accepted refinement: set `refined_body` to the refined text and `status` to `"accepted"`
- For comments kept as original: leave `refined_body` as null and `status` as `"pending"`

**Important:** Only modify `refined_body` and `status` fields on each comment. Do NOT modify `diff`, `metadata`, or other fields.

## Phase 6: Submit Decision

Ask the user what review action to take:

Options:

- **Comment** — Submit as general feedback
- **Approve** — Approve the PR
- **Request changes** — Request changes
- **Don't submit yet** — Keep the review pending

If user chooses to submit, optionally ask for a review summary (can be empty).

Update the JSON metadata:

- Set `submit_action` to the chosen action (COMMENT/APPROVE/REQUEST_CHANGES), or omit if keeping pending
- Set `submit_summary` to the summary text

## Phase 7: Execute Updates

If user chose to submit (Phase 6), run with `--submit` flag:

```bash
myk-pi-tools reviews pending-update "<json_path>" --submit
```

If user chose "Don't submit yet", run without `--submit`:

```bash
myk-pi-tools reviews pending-update "<json_path>"
```

This updates accepted comment bodies on GitHub and submits the review when `--submit` is provided.

If the command fails:

- If 404: inform the user their pending review may have been submitted or deleted externally
- Other errors: display the error

## Phase 8: Summary

Display:

- Number of comments refined vs kept as original
- Review action taken (submitted as COMMENT/APPROVE/REQUEST_CHANGES, or kept pending)
- PR URL for reference

**CRITICAL RULES:**

- NEVER update comments or submit the review without explicit user confirmation
- Always show what will change before changing it
- The user controls which refinements are accepted
