---
name: pi-docsite
description: "Generate a static documentation website from Markdown files using pi-docsite. Use when the user asks to build, generate, rebuild, or fix documentation or a docs site, or to add a docs page. Produces deterministic HTML plus llms.txt and a search index."
---

# pi-docsite

Renders a directory of `*.md` into a static site: sidebar navigation, full-text
search, `llms.txt` / `llms-full.txt` for LLM consumption, and `search-index.json`.

Output is **byte-for-byte reproducible** — the same Markdown always yields the same
bytes. So if a rebuild shows churn in files you did not touch, something else changed.

## Use it

**Prefer `uvx` — it needs no install step and creates no environment drift.**

```bash
uvx pi-docsite --docs-dir docs --tagline "One line describing this project"
```

If the package is not on PyPI yet (working from a checkout of the generator repo):

```bash
uvx --from /path/to/pi-docsite pi-docsite --docs-dir docs
```

If the project already depends on it, use the project's environment rather than a
throwaway one:

```bash
uv run pi-docsite --docs-dir docs --tagline "One line describing this project"
```

Only fall back to `pip`/`python` when `uv` is genuinely unavailable, and say so if you
do — do not mix the two in one workflow.

Everything is a flag with a derived default. Run `pi-docsite --help` for the full list.

| Flag | Default |
|---|---|
| `--docs-dir` | `docs/` next to the script |
| `--project-name` | the git remote's repo name |
| `--repo-url` | git remote `origin` |
| `--tagline` | empty |

Identity follows `--docs-dir`, not the script's own location, so the same command works
from anywhere.

## Adding a page

**Write the `.md` file, add one line to `docs/nav.json`, rebuild.** That is the whole
process. Nothing in the generator needs editing, and a page can never be silently
invisible.

Each page needs exactly one H1 — that is its title and its sidebar entry. Headings
inside fenced code blocks do not count.

### docs/nav.json

The sidebar layout lives in one reviewable file. Array order is display order, for
groups and for pages within a group.

```json
{
  "groups": [
    { "name": "Getting Started", "pages": ["quickstart", "configuration"] },
    { "name": "Reference", "pages": ["cli-reference", "safety-enforcements"] }
  ]
}
```

- Reordering means reordering the array. Do **not** rename files to reorder — that
  churns git history and breaks links to the old path.
- A slug in `nav.json` with no `.md` behind it is a **build error** (renamed or
  deleted page). Fix the JSON; do not ignore it.
- A `.md` **not** listed in `nav.json` is still built and listed under `More`,
  alphabetically, and the generator prints a note naming it. If you see that note,
  add the page to `nav.json` rather than leaving it there.

### Per-page override

When a single page must live somewhere else, use frontmatter rather than restructuring
the array:

```markdown
---
nav_group: Reference
nav_order: 30
---

# My Page Title
```

Precedence, highest first: frontmatter, then `nav.json`, then the fallback group.

## What gets generated

Written into `--docs-dir` alongside the sources:

| Output | Purpose |
|---|---|
| `<slug>.html` | one page per `.md` |
| `index.html` | landing page with the grouped navigation |
| `search-index.json` | full page text for search, fetched once by every page |
| `llms.txt` | short index of pages for LLM consumption |
| `llms-full.txt` | full page text for LLM consumption |
| `assets/` | CSS, JS, images |

`*.html` with no matching `.md` is removed as stale. `*.md` and `.nojekyll` are never
touched.

## Rules

- **Edit the Markdown, never the generated HTML.** Fix the source and rebuild.
- Generated files are usually committed. Commit them together with the source change,
  or the site is out of sync.
- Search requires the site to be **served over HTTP**. The index is fetched once per
  page, and browsers block that fetch over `file://`. Opening the generated HTML
  straight from disk will report the index as unavailable.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `uvx: command not found` | `uv` is not installed. Install it from [docs.astral.sh/uv](https://docs.astral.sh/uv/), or fall back to `pip install pi-docsite` and say which you used. |
| `docs/<slug>.md has N H1 headings, expected 1` | Add exactly one real H1, or close the code fence that is swallowing it. |
| Page missing from the sidebar | It should not happen — the generator lists every `*.md`. If it does, check for a filename that does not end in `.md`. |
| Search returns nothing | Open the browser console. A `search index unavailable` message means the page was opened over `file://`. Serve the site over HTTP. |
| Rebuild shows unrelated diffs | Non-deterministic output; this is a bug in pi-docsite, not a stale build. |
