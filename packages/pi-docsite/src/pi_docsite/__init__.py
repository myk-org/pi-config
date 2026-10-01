"""pi-docsite -- deterministic static documentation site generator.

Renders a directory of Markdown files into a static HTML site with a sidebar,
full-text search (inlined, so it works from file:// as well as a web server),
llms.txt / llms-full.txt for LLM consumption, and a search index.

The output is byte-for-byte reproducible: the same Markdown always produces the
same bytes, so a rebuild that shows unrelated churn means a real change.

    pi-docsite --docs-dir docs --tagline "..."

Adding or removing a page never requires editing this package -- see the
frontmatter docs in generate.py.
"""

__version__ = "4.7.2"

__all__ = ["__version__"]
