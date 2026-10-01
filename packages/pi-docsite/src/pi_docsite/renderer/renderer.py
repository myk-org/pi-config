"""Static markdown -> HTML renderer for the documentation site.

Vendored verbatim (modulo the adaptations below) from ``myk-org/docsfy``
(``src/docsfy/renderer.py``) so this repo can rebuild ``docs/`` on its own,
without depending on the external docsfy clone at runtime. Only the
deterministic rendering half was taken: no AI generation, no network, no
``docsfy`` package imports. The docsfy images pipeline (``copy_images_to_site``)
is not vendored because this repo ships no ``docsfy-images/`` source.

Upstream behaviour is preserved except for the branding badge: it is driven by
this package's ``--badge-label`` (``BADGE_HEAD``/``BADGE_ACCENT``, linked through
``badge_url``) instead of upstream's fixed "Generated with docsfy" text, so a
site built here never names the upstream project.

It is a vendored copy, so local modifications are expected. The local
deviations are ``_indent_fenced_blocks`` (see its docstring, ``llms-full.txt``
only) and the parser-based ``_sanitize_html`` allowlist (upstream ships a
regex stripper that had four separate bypasses); everything else is
byte-identical to upstream.
"""

from __future__ import annotations

import hashlib
import html as _html_mod
import logging
import re
import urllib.parse
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

import markdown
from jinja2 import Environment, FileSystemLoader, select_autoescape

logger = logging.getLogger(__name__)

# Fallback link for the header badge when no repo URL is known. Not a
# hardcoded project: it was pinned to one repo's URL, which leaked that repo's
# name into every other project that vendored this package.
DEFAULT_BADGE_URL = "https://example.invalid"
DEFAULT_BADGE_LABEL = "pi-docsite"

# Vendored from docsfy.generator. Deliberately NOT re.DOTALL, and the title is
# restricted to a single line ([^\n]+ rather than .+). Without these
# constraints, "." matches newlines, so a real multi-paragraph document that
# happens to *end* with this exact phrase would have its entire body greedily
# swallowed as part of the "title" and get misclassified as a stub.
_FAILURE_STUB_RE = re.compile(r"^#[ \t]+[^\n]+\n\n\*Documentation generation failed\.(?: Please re-run\.)?\*\s*$")


TEMPLATES_DIR = Path(__file__).parent / "templates"
STATIC_DIR = Path(__file__).parent / "static"
_jinja_env: Environment | None = None


def _get_jinja_env() -> Environment:
    global _jinja_env
    if _jinja_env is None:
        _jinja_env = Environment(
            loader=FileSystemLoader(str(TEMPLATES_DIR)),
            autoescape=select_autoescape(["html"]),
        )
    return _jinja_env


# Sanitizer allowlist. Anything not listed is dropped. Upstream docsfy strips
# dangerous tags with regexes, which four separate bypasses walked straight through
# (``<base href=...>``, ``<script src=...></script >``, an unclosed
# ``<iframe srcdoc="&lt;script&gt;...">``, and a ``<script>`` body surviving as
# visible text). Patching regexes does not converge, so the mechanism is a real
# tokenizer: parse, then re-serialise only what is allowed.
_ALLOWED_TAGS = frozenset(
    """
    p br hr h1 h2 h3 h4 h5 h6 ul ol li a code pre blockquote strong em b i del
    ins table thead tbody tfoot tr th td img span div details summary kbd sub
    sup dl dt dd
    """.split()
)

# Void elements have no closing tag, so a dropped one drops only the tag itself
# (``<base>``, ``<embed>``) rather than swallowing the rest of the document.
_VOID_TAGS = frozenset("area base br col embed hr img input link meta param source track wbr".split())

# Known active or navigational void elements. Dropped outright instead of being
# escaped, because they are attack surface, never documentation placeholders:
# ``<base href>`` re-points every relative link on the page, ``<meta
# http-equiv=refresh>`` and ``<link>`` navigate, ``<embed>``/``<input>``/``<source>``
# load active content. Printing them as literal text in a published page would
# serve no reader - it just puts a meta-refresh or an embed tag in front of them
# as prose. Anything else unknown stays escaped, see ``_DROP_CONTENT_TAGS``.
_DROP_TAGS = frozenset("area base col embed input link meta param source track".split())

# Only these drop their CONTENTS along with the tag. Every one of them holds
# code, markup or a nested document rather than prose, so keeping the contents
# would either leak a script body as visible text or re-emit foreign markup.
#
# Everything else that is not on the allowlist and is not in ``_DROP_TAGS``
# keeps its text and has its tag re-emitted as escaped, inert text. That matters
# because python-markdown
# passes raw HTML through, and prose like ``No <name> configured for this
# repository`` is an unrecognised start tag: dropping an unknown tag outright
# deleted the placeholder, and dropping its contents swallowed the rest of the
# sentence and every following element until the next tag, deleting real
# documentation (a whole table on ``run-pull-request-commands``).
_DROP_CONTENT_TAGS = frozenset(
    """
    script style iframe object form noscript template svg math applet
    frameset
    """.split()
)

# Allowed on any allowed element: Pygments emits ``<span class="k">`` inside
# ``<pre><code>`` and python-markdown's toc extension emits heading ``id``s, so
# ``class`` and ``id`` are load-bearing, not decoration. Deny-by-default
# covers the ``on*`` handlers plus ``style``/``srcdoc``/``formaction`` without
# listing them.
_ALLOWED_ATTRS = frozenset("id class colspan rowspan title start type open".split())
_TAG_ATTRS: dict[str, frozenset[str]] = {
    "a": frozenset({"href"}),
    "img": frozenset({"src", "alt"}),
}

# Browsers ignore TAB/LF/CR and NULs inside a URL before resolving its scheme,
# so "java\tscript:" is a live javascript: URL. Strip them before checking.
_URL_NOISE_RE = re.compile(r"[\s\x00-\x20\x7f]")


def _is_safe_url(url: str) -> bool:
    """Return True if ``url`` is safe to keep in an href/src.

    Allows http/https/mailto, fragments, absolute paths, and scheme-less
    relative paths (the docs pages link each other as ``quick-start.html`` and
    reference repo files as ``../README.md``). Everything else - javascript:,
    data:, vbscript:, and protocol-relative ``//host`` - is rejected.

    Normalisation order matters and is deliberately fixed: HTML-entity
    unescape first (so ``&sol;&sol;host`` and ``&#47;&#47;host`` are judged as
    the ``//host`` they are), then noise stripping (so ``java\\tscript:`` and
    ``//\\x00host`` are judged as the scheme they are), then backslash
    folding, and only then the policy checks. Doing it in any other order lets
    a value change what it looks like *after* the check that should have
    rejected it.
    """
    decoded = _html_mod.unescape(url).strip()
    decoded = _URL_NOISE_RE.sub("", decoded)
    # Browsers fold "\" to "/" while parsing an authority, so "\\host",
    # "/\host" and "/\/host" navigate exactly like "//host" - off-site. Fold
    # before the checks so the protocol-relative rule covers all of them.
    decoded = decoded.replace("\\", "/")
    lowered = decoded.lower()
    if lowered.startswith(("http://", "https://", "mailto:")):
        return True
    if decoded.startswith("#"):
        return True
    if decoded.startswith("//"):
        return False  # protocol-relative: re-points the request at another host
    if decoded.startswith("/"):
        return True
    # No scheme = relative URL, which can only ever resolve against this site.
    # urlsplit raises ValueError on a malformed IPv6 authority ("x://["), which
    # would take the whole docs build down; treat it as unsafe instead.
    try:
        return not urllib.parse.urlsplit(decoded).scheme
    except ValueError:
        return False


class _HTMLAllowlistSanitizer(HTMLParser):
    """Re-serialise HTML, emitting only allowlisted tags and attributes.

    Text is escaped on the way out, so nothing that failed to parse as markup -
    a bare ``&``, a stray ``<``, an unterminated tag - can leak through
    unescaped. Never raises on unbalanced or malformed input.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._out: list[str] = []
        self._open: list[str] = []
        # While dropping, ``_drop_tag``/``_drop_depth`` track the nesting so an
        # inner ``</script>`` cannot end the drop early.
        self._drop_tag: str | None = None
        self._drop_depth = 0

    def _attrs(self, tag: str, attrs: list[tuple[str, str | None]]) -> str:
        allowed = _ALLOWED_ATTRS | _TAG_ATTRS.get(tag, frozenset())
        parts: list[str] = []
        for name, value in attrs:
            name = name.lower()
            if name not in allowed:
                continue
            if value is None:
                parts.append(f" {name}")
                continue
            if name in ("href", "src") and not _is_safe_url(value):
                value = "#"
            parts.append(f' {name}="{_html_mod.escape(value, quote=True)}"')
        return "".join(parts)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if self._drop_tag is not None:
            if tag == self._drop_tag:
                self._drop_depth += 1
            return
        if tag not in _ALLOWED_TAGS:
            # Void tags never open a subtree, so only the real
            # code-or-markup carriers can swallow a drop region.
            if tag in _DROP_CONTENT_TAGS and tag not in _VOID_TAGS:
                self._drop_tag, self._drop_depth = tag, 1
                return
            # Known dangerous void elements are dropped silently: there are no
            # contents to keep and printing them as literal text helps nobody.
            if tag in _DROP_TAGS:
                return
            # Unknown markup in prose is almost always a placeholder or a typo
            # the author meant to display (``No <name> configured``), so re-emit
            # the original tag source as escaped text instead of deleting it.
            # Re-emitting verbatim keeps attributes and spacing exactly; the
            # text stays as bare text, so nothing here can become live markup.
            self._out.append(_html_mod.escape(self.get_starttag_text() or f"<{tag}>", quote=False))
            return
        rendered = f"<{tag}{self._attrs(tag, attrs)}>"
        self._out.append(rendered)
        if tag not in _VOID_TAGS:
            self._open.append(tag)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        # HTMLParser routes ``<x/>`` here; treat it as a start tag. Void elements
        # emit no closing tag, and ``<div/>`` is emitted unclosed, which HTML5
        # parsing tolerates. Never matching this by regex was bypass #3.
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self._drop_tag is not None:
            if tag == self._drop_tag:
                self._drop_depth -= 1
                if self._drop_depth == 0:
                    self._drop_tag = None
            return
        if tag in _VOID_TAGS or tag not in self._open:
            return
        # Close anything the input left dangling inside, so output stays balanced.
        while self._open:
            open_tag = self._open.pop()
            self._out.append(f"</{open_tag}>")
            if open_tag == tag:
                break

    def handle_data(self, data: str) -> None:
        if self._drop_tag is not None:
            return
        self._out.append(_html_mod.escape(data, quote=False))

    # Comments, CDATA, doctypes and processing instructions carry no content.
    def handle_comment(self, data: str) -> None:
        pass

    def handle_decl(self, decl: str) -> None:
        pass

    def handle_pi(self, data: str) -> None:
        pass

    def unknown_decl(self, data: str) -> None:
        pass

    def result(self) -> str:
        self.close()
        while self._open:
            self._out.append(f"</{self._open.pop()}>")
        return "".join(self._out)


def _sanitize_html(html: str) -> str:
    """Reduce HTML to an allowlist of safe elements, attributes and URL schemes."""
    parser = _HTMLAllowlistSanitizer()
    parser.feed(html)
    return parser.result()


# A fence opens with 3+ backticks or 3+ tildes; the two never close each other.
_FENCE_RE = re.compile(r"^(`{3,}|~{3,})(.*)$")

_CODE_FENCE_ANNOTATION_RE = re.compile(r"^(`{3,}|~{3,})\d+:\d+:(.+)$", re.MULTILINE)
_CODE_FENCE_FILEPATH_RE = re.compile(r"^(`{3,}|~{3,})((?:\S+/)+\S+)\s*$", re.MULTILINE)
_CODE_FENCE_BARE_FILE_RE = re.compile(
    r"^(`{3,}|~{3,})([A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)\s*$",
    re.MULTILINE,
)


def _fence_marker(line: str) -> tuple[str, str] | None:
    """Return ``(fence_run, rest)`` if ``line`` is a fence marker, else ``None``.

    ``fence_run`` is the run of backticks or tildes, ``rest`` the remainder of
    the line stripped (info string / language, empty for a closing fence).
    """
    match = _FENCE_RE.match(line.lstrip())
    if match is None:
        return None
    return match.group(1), match.group(2).strip()


_EXT_TO_LANG: dict[str, str] = {
    ".py": "python",
    ".js": "javascript",
    ".ts": "typescript",
    ".go": "go",
    ".java": "java",
    ".rb": "ruby",
    ".rs": "rust",
    ".sh": "bash",
    ".bash": "bash",
    ".zsh": "bash",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".json": "json",
    ".toml": "toml",
    ".html": "html",
    ".css": "css",
    ".sql": "sql",
    ".md": "markdown",
    ".xml": "xml",
    ".ini": "ini",
    ".cfg": "ini",
    ".dockerfile": "dockerfile",
    ".groovy": "groovy",
    ".kt": "kotlin",
    ".swift": "swift",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "c",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".r": "r",
    ".pl": "perl",
    ".lua": "lua",
    ".ex": "elixir",
    ".exs": "elixir",
    ".tf": "hcl",
    ".proto": "protobuf",
    ".graphql": "graphql",
    ".scss": "scss",
    ".less": "less",
}


_FILENAME_TO_LANG: dict[str, str] = {
    "Dockerfile": "dockerfile",
    "Makefile": "makefile",
    "Jenkinsfile": "groovy",
    "Vagrantfile": "ruby",
    "Gemfile": "ruby",
    "Rakefile": "ruby",
    "Procfile": "",
    "Brewfile": "ruby",
}


def _lang_from_filepath(filepath: str) -> str:
    """Extract a language identifier from a file path's extension or filename."""
    filepath = filepath.strip()
    basename = filepath.rsplit("/", 1)[-1] if "/" in filepath else filepath
    if "." not in basename:
        return _FILENAME_TO_LANG.get(basename, "")
    ext = "." + basename.rsplit(".", 1)[-1].lower()
    return _EXT_TO_LANG.get(ext, "")


def _clean_code_fence_annotations(md_text: str) -> str:
    """Strip file reference annotations from code fence opening lines.

    AI-generated code blocks sometimes use formats like:
        ```135:150:src/file.py
        ```src/utils/helper.js
        ```config.yaml
    which the markdown library cannot parse. Convert them to:
        ```python
        ```javascript
        ```yaml

    Only applies replacements at the outermost fence level (depth 0) so that
    inner fences inside nested code blocks (e.g. documentation examples) are
    left untouched.
    """

    def _replace_annotated_fence(match: re.Match[str]) -> str:
        fence = match.group(1)
        filepath = match.group(2).strip()
        lang = _lang_from_filepath(filepath)
        return f"{fence}{lang}"

    def _replace_filepath_fence(match: re.Match[str]) -> str:
        fence = match.group(1)
        filepath = match.group(2)
        lang = _lang_from_filepath(filepath)
        return f"{fence}{lang}"

    def _replace_bare_file_fence(match: re.Match[str]) -> str:
        fence = match.group(1)
        filename = match.group(2)
        lang = _lang_from_filepath(filename)
        return f"{fence}{lang}"

    lines = md_text.split("\n")
    result: list[str] = []
    fence_depth = 0
    opening_fence = ""
    opening_fence_len = 0

    for line in lines:
        stripped = line.lstrip()
        marker = _fence_marker(stripped)

        if marker is not None:
            original_line = line
            fence_run, rest = marker

            if fence_depth == 0:
                # Outermost fence opening: apply annotation cleaning
                line = _CODE_FENCE_ANNOTATION_RE.sub(_replace_annotated_fence, line)
                line = _CODE_FENCE_FILEPATH_RE.sub(_replace_filepath_fence, line)
                line = _CODE_FENCE_BARE_FILE_RE.sub(_replace_bare_file_fence, line)
                if line == original_line and rest in _FILENAME_TO_LANG:
                    indent = line[: len(line) - len(stripped)]
                    line = f"{indent}{fence_run}{_FILENAME_TO_LANG[rest]}"
                fence_depth = 1
                opening_fence = fence_run
                opening_fence_len = len(fence_run)
            elif fence_run[0] == opening_fence[0] and len(fence_run) >= opening_fence_len and not rest:
                # Closing the outermost fence (matching character only)
                fence_depth = 0
                opening_fence = ""
                opening_fence_len = 0
            # else: inner fence marker, ignore

        result.append(line)

    return "\n".join(result)


def _ensure_blank_lines(md_text: str) -> str:
    """Ensure blank lines before markdown block elements.

    The Python markdown library requires blank lines before lists,
    blockquotes, and code fences. AI-generated content often omits these.

    Blank lines are never inserted inside fenced code blocks (``` or ~~~).
    """
    lines = md_text.split("\n")
    result: list[str] = []
    fence_depth = 0
    opening_fence = ""
    opening_fence_len = 0
    for i, line in enumerate(lines):
        stripped = line.lstrip()
        indent = len(line) - len(stripped)

        # Track fence state using fence-length matching so that
        # inner fences inside an outer block don't toggle the state.
        # A ~~~ fence is only closed by ~~~ (and vice versa).
        was_in_fence = fence_depth > 0
        marker = _fence_marker(stripped)
        if marker is not None:
            fence_run, rest = marker
            if fence_depth == 0:
                # Opening a new fence
                fence_depth = 1
                opening_fence = fence_run
                opening_fence_len = len(fence_run)
            elif fence_run[0] == opening_fence[0] and len(fence_run) >= opening_fence_len and not rest:
                # Closing the current fence (same or more fence chars, nothing after)
                fence_depth = 0
                opening_fence = ""
                opening_fence_len = 0
            # else: inner fence marker inside outer block, ignore

        # Only insert blank lines outside fenced code blocks.
        # Use was_in_fence so that closing fences (which just toggled
        # in_fence to False) are still considered "inside" the block.
        if not was_in_fence and indent == 0 and i > 0 and result and result[-1].strip() != "":
            # Check if this line starts a block element
            needs_blank = False
            prev_stripped = result[-1].lstrip()

            # List item not preceded by another list item
            if (
                (stripped.startswith(("- ", "* ")) and not prev_stripped.startswith(("- ", "* ")))
                or re.match(r"^\d+\. ", stripped)
                and not re.match(r"^\d+\. ", prev_stripped)
                or stripped.startswith("> ")
                and not prev_stripped.startswith("> ")
                or _FENCE_RE.match(stripped) is not None
                and _FENCE_RE.match(prev_stripped) is None
            ):
                needs_blank = True

            if needs_blank:
                result.append("")

        result.append(line)

    return "\n".join(result)


def _wrap_tables(content_html: str) -> str:
    """Wrap each table in a horizontally scrollable div.

    A wide table (the six-column settings reference is ~1045px) otherwise pushes
    the whole page wider than the viewport, which puts a horizontal scrollbar on
    the document and shifts every other element. Scrolling the table alone keeps
    the page width fixed and is what most documentation sites do.
    """
    return re.sub(
        r"(<table\b[^>]*>.*?</table>)",
        r'<div class="table-wrap">\1</div>',
        content_html,
        flags=re.DOTALL,
    )


def _md_to_html(md_text: str) -> tuple[str, str]:
    """Convert markdown to HTML. Returns (content_html, toc_html)."""
    md = markdown.Markdown(
        extensions=["fenced_code", "codehilite", "tables", "toc"],
        extension_configs={
            "codehilite": {"css_class": "highlight", "guess_lang": False},
            "toc": {"toc_depth": "2-3"},
        },
    )
    md_text = _clean_code_fence_annotations(md_text)
    md_text = _ensure_blank_lines(md_text)
    content_html = _sanitize_html(md.convert(md_text))
    content_html = _wrap_tables(content_html)
    # The TOC is separately generated and reaches the page through ``|safe``,
    # so it needs the same allowlist as the body. Its ``<a href="#id">`` links
    # and the body heading ``id``s they point at both survive the allowlist.
    toc_html = _sanitize_html(getattr(md, "toc", ""))
    return content_html, toc_html


def _asset_version() -> str:
    """Short content hash of the static assets, for cache-busting URLs.

    Without this the asset URLs never change, so a browser that cached
    assets/copy.js keeps the old one across a rebuild and renders stale
    behaviour. Derived from file contents, so it is stable for an unchanged
    tree and only moves when an asset actually changes.
    """
    digest = hashlib.sha256()
    for path in sorted(STATIC_DIR.iterdir()):
        if path.is_file():
            digest.update(path.name.encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()[:10]


def render_page(
    markdown_content: str,
    page_title: str,
    project_name: str,
    tagline: str,
    navigation: list[dict[str, Any]],
    current_slug: str,
    prev_page: dict[str, str] | None = None,
    next_page: dict[str, str] | None = None,
    repo_url: str = "",
    version: str | None = None,
    search_index: str | None = None,
    badge_label: str = DEFAULT_BADGE_LABEL,
) -> str:
    env = _get_jinja_env()
    template = env.get_template("page.html")
    content_html, toc_html = _md_to_html(markdown_content)
    BADGE_HEAD, BADGE_ACCENT = _badge_parts(badge_label)
    return template.render(
        title=page_title,
        project_name=project_name,
        tagline=tagline,
        content=content_html,
        toc=toc_html,
        navigation=navigation,
        current_slug=current_slug,
        prev_page=prev_page,
        next_page=next_page,
        repo_url=repo_url,
        badge_url=_safe_badge_url(repo_url),
        BADGE_HEAD=BADGE_HEAD,
        BADGE_ACCENT=BADGE_ACCENT,
        search_index=search_index,
        asset_version=_asset_version(),
        version=version,
    )


def render_index(
    project_name: str,
    tagline: str,
    navigation: list[dict[str, Any]],
    repo_url: str = "",
    version: str | None = None,
    search_index: str | None = None,
    badge_label: str = DEFAULT_BADGE_LABEL,
) -> str:
    env = _get_jinja_env()
    template = env.get_template("index.html")
    BADGE_HEAD, BADGE_ACCENT = _badge_parts(badge_label)
    return template.render(
        title=project_name,
        project_name=project_name,
        tagline=tagline,
        navigation=navigation,
        repo_url=repo_url,
        current_slug="",
        badge_url=_safe_badge_url(repo_url),
        BADGE_HEAD=BADGE_HEAD,
        BADGE_ACCENT=BADGE_ACCENT,
        asset_version=_asset_version(),
        search_index=search_index,
        version=version,
    )


def _badge_parts(label: str) -> tuple[str, str]:
    """Split the badge label on its first '-' so the suffix keeps the accent styling.

    Returns ``(head, accent)``; ``accent`` is empty when the label has no '-'.
    """
    head, sep, tail = (label or DEFAULT_BADGE_LABEL).partition("-")
    parts = (head, f"{sep}{tail}") if sep else (head, "")
    logger.debug("badge_parts: label=%s head=%s accent=%s", label, parts[0], parts[1])
    return parts


def _safe_badge_url(repo_url: str) -> str:
    """Badge href, scheme-checked.

    The badge is a clickable link, so an unchecked ``--repo-url javascript:...``
    became an executable link on every generated page. Reuse the same guard the
    repository link already uses, and fall back rather than emitting an empty or
    dangerous href.
    """
    return repo_url if repo_url and _is_safe_url(repo_url) else DEFAULT_BADGE_URL


def _build_search_index(pages: dict[str, str], plan: dict[str, Any]) -> list[dict[str, str]]:
    index: list[dict[str, str]] = []
    title_map: dict[str, str] = {}
    for group in plan.get("navigation", []):
        for page in group.get("pages", []):
            title_map[page.get("slug", "")] = page.get("title", "")
    for slug, content in pages.items():
        index.append({
            "slug": slug,
            "title": title_map.get(slug, slug),
            # Full page text: search-index.json is fetched once and shared by every
            # page, so there is no reason to cap what is searchable. An earlier
            # 2000-char cap meant anything past that point in a long page was
            # unsearchable -- searching a term in the "Determinism" section of a
            # 6 KB page returned nothing.
            "content": content,
        })
    return index


def _build_llms_txt(
    plan: dict[str, Any],
    navigation: list[dict[str, Any]] | None = None,
) -> str:
    """Build llms.txt index file.

    Args:
        plan: The documentation plan dict.
        navigation: Optional filtered navigation list. When provided, this is
            used instead of ``plan["navigation"]`` so that only pages present
            in ``valid_pages`` are included.
    """
    project_name = plan.get("project_name", "Documentation")
    tagline = plan.get("tagline", "")
    nav = navigation if navigation is not None else plan.get("navigation", [])
    lines = [f"# {project_name}", ""]
    if tagline:
        lines.extend([f"> {tagline}", ""])
    for group in nav:
        lines.extend([f"## {group.get('group', '')}", ""])
        for page in group.get("pages", []):
            desc = page.get("description", "")
            page_title = page.get("title", "")
            page_slug = page.get("slug", "")
            if desc:
                lines.append(f"- [{page_title}]({page_slug}.md): {desc}")
            else:
                lines.append(f"- [{page_title}]({page_slug}.md)")
        lines.append("")
    return "\n".join(lines)


def _indent_fenced_blocks(text: str) -> str:
    """Indent the body of every fenced code block by 4 spaces, fences unchanged.

    LOCAL, INTENTIONAL DIVERGENCE from upstream ``myk-org/docsfy``, which emits
    the fences' contents at column 0. ``llms-full.txt`` is read as plain text by
    an LLM, where a line such as ``# config.yaml`` inside a YAML fence looks
    exactly like a top-level markdown heading and pollutes the document outline.
    Indenting the block body by 4 spaces (a valid markdown list/code indent) keeps
    the block delimited by its unindented ``` fences while making the comments
    read as quoted code rather than headings.

    Only lines between an opening fence (``` or ~~~) and its matching closing
    fence are touched; blank lines inside a fence are left truly empty to avoid
    trailing whitespace.
    """
    out: list[str] = []
    in_fence = False
    fence_char = ""
    for line in text.split("\n"):
        match = _FENCE_RE.match(line)
        char = match.group(1)[0] if match is not None else ""
        if char and (not in_fence or char == fence_char):
            # Toggle, but only a matching character closes an open fence.
            in_fence = not in_fence
            fence_char = char if in_fence else ""
        elif in_fence and line.strip():
            out.append(f"    {line}")
            continue
        out.append(line)
    return "\n".join(out)


def _build_llms_full_txt(
    plan: dict[str, Any],
    pages: dict[str, str],
    navigation: list[dict[str, Any]] | None = None,
) -> str:
    """Build llms-full.txt with all content concatenated.

    Args:
        plan: The documentation plan dict.
        pages: Mapping of slug to markdown content.
        navigation: Optional filtered navigation list. When provided, this is
            used instead of ``plan["navigation"]`` so that only pages present
            in ``valid_pages`` are included.
    """
    project_name = plan.get("project_name", "Documentation")
    tagline = plan.get("tagline", "")
    nav = navigation if navigation is not None else plan.get("navigation", [])
    lines = [f"# {project_name}", ""]
    if tagline:
        lines.extend([f"> {tagline}", ""])
    lines.extend(["---", ""])
    for group in nav:
        for page in group.get("pages", []):
            slug = page.get("slug", "")
            content = _indent_fenced_blocks(pages.get(slug, ""))
            lines.extend([
                f"Source: {slug}.md",
                "",
                content,
                "",
                "---",
                "",
            ])
    return "\n".join(lines)
