# pi-docsite

Deterministic static documentation site generator for Markdown projects.

Renders a directory of `*.md` into a static HTML site with sidebar navigation,
full-text search, `llms.txt` / `llms-full.txt` for LLM consumption, and a search
index. No configuration file, no build config, no framework.

Vendored from `myk-org/pi-config`, where it generates that project's own docs.

## Use

No install needed — `uvx` runs it in an ephemeral environment:

```bash
uvx pi-docsite --docs-dir docs --tagline "One line describing this project"
```

From a checkout of this repository:

```bash
uv run --package pi-docsite pi-docsite --docs-dir docs
```

Or add it to a project that depends on it:

```bash
uv add pi-docsite      # then: uv run pi-docsite --docs-dir docs
```

Everything is a flag with a derived default, so the same command works in any repo:

| Flag | Default |
|---|---|
| `--docs-dir` | `docs/` next to the script |
| `--project-name` | the git remote's repo name |
| `--repo-url` | git remote `origin` |
| `--tagline` | empty |
| `--badge-label` | `pi-docsite` |

Identity follows `--docs-dir` rather than the script's own location, so pointing it at
another project's docs directory renders that project's site.

`--badge-label` is the header badge text. It names the generator, not the project being
documented, so a vendored site never shows this repo's branding. The suffix after the first
`-` keeps the accent styling; a label without a `-` renders unaccented.

## Adding a page

**Write the `.md` file, add one line to `docs/nav.json`, rebuild.** That is the entire
process — the generator discovers pages from the filesystem, so a new page can never be
invisible.

Each page needs exactly one H1, which becomes its title and its sidebar entry.
Headings inside fenced code blocks do not count.

### `docs/nav.json`

The sidebar layout lives in one reviewable file. Array order is display order, for
groups and for pages within a group:

```json
{
  "groups": [
    { "name": "Getting Started", "pages": ["quickstart", "configuration"] },
    { "name": "Reference", "pages": ["cli-reference", "safety-enforcements"] }
  ]
}
```

- **Reorder by reordering the array.** Do not rename files to reorder — that churns
  git history and breaks links to the old path.
- A slug in `nav.json` with no `.md` behind it is a **build error**. Fix the JSON.
- A `.md` not listed in `nav.json` is still built, placed under a fallback group, and
  reported in the generator's output. Add it to `nav.json` when you see that note.

Optional frontmatter overrides it for a single page:

```markdown
---
nav_group: Reference
nav_order: 30
---

# My Page Title
```

Precedence, highest first: frontmatter, then `nav.json`, then the fallback group.

## Ask your LLM

A ready-made skill ships with the package at `skill/SKILL.md`.

**The generator tells you when it is missing.** Every build prints one extra line while no
agent has it installed:

```text
pi-docsite: generator skill not installed for any agent. To expose pi-docsite guidance to
your LLM, copy .../pi_docsite/skill/SKILL.md into your agent's skills directory (for
example ~/.pi/agent/skills/pi-docsite/SKILL.md).
```

That line is why an LLM driving a rebuild can offer the install instead of silently working
from guesswork. `pip` has no post-install hook, so this build-output notice is the only
channel that reaches whoever is actually running the tool. It disappears once `SKILL.md`
exists under `~/.pi/agent/skills/`, `~/.claude/skills/`, `~/.cursor/skills/`, or
`~/.gemini/skills/`.

To install it yourself:

```bash
uv run python -c "
import pi_docsite, pathlib, shutil
src = pathlib.Path(pi_docsite.__file__).parent / 'skill' / 'SKILL.md'
dst = pathlib.Path.home() / '.pi/agent/skills/pi-docsite'
dst.mkdir(parents=True, exist_ok=True)
shutil.copy(src, dst / 'SKILL.md')
print('installed to', dst)
"
```

Or point your agent at it in the repo you are working in. It documents the commands,
the frontmatter contract, what gets generated, and how to debug a failure.

## Output

| File | Purpose |
|---|---|
| `<slug>.html` | one per `.md` |
| `index.html` | landing page with grouped navigation |
| `search-index.json` | full page text for search, fetched once by every page |
| `llms.txt` | short page index for LLM consumption |
| `llms-full.txt` | full page text for LLM consumption |
| `assets/` | CSS and JS |

Stale `<slug>.html` files with no matching `.md` are removed. Sources (`*.md`) and
`.nojekyll` are never modified.

## Determinism

The same Markdown always produces the same bytes. Rendering twice and diffing should
be empty, which makes a docs change reviewable and makes unrelated churn a reliable
signal that something actually changed.

## Search works offline

The search index is written once and **fetched** by every page rather than inlined,
which keeps each page small. Browsers block `fetch()` of a local file over `file://`, so
**serve the site over HTTP** for search to work; opening the generated HTML directly from
disk will report that the index is unavailable.

## Requirements

Python 3.14+. Runtime dependencies: `markdown`, `jinja2`, `pygments`.

## Development

```bash
cd packages/pi-docsite
uv run --extra dev pytest tests/ -q
```

## License

Apache-2.0
