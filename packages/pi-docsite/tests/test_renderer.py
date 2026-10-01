"""Self-checks for the vendored renderer: llms-full indenting and HTML sanitizing."""

from __future__ import annotations

import logging

import pytest
from pi_docsite.renderer.renderer import (
    DEFAULT_BADGE_LABEL,
    _badge_parts,
    _clean_code_fence_annotations,
    _ensure_blank_lines,
    _indent_fenced_blocks,
    _md_to_html,
    _sanitize_html,
    render_index,
    render_page,
)


def test_indents_fence_body_only() -> None:
    src = "# Title\n\nprose\n\n```yaml\n# config.yaml\nkey: value\n\n  # indented comment\n```\n\nafter\n"
    expected = (
        "# Title\n\nprose\n\n```yaml\n    # config.yaml\n    key: value\n\n      # indented comment\n```\n\nafter\n"
    )
    assert _indent_fenced_blocks(src) == expected


def test_fences_still_toggle_and_pass_through() -> None:
    src = "```\nplain\n```\n```sh\necho '# not a heading'\n```\n"
    assert sum(1 for line in _indent_fenced_blocks(src).split("\n") if line.startswith("```")) == 4
    assert "    echo '# not a heading'" in _indent_fenced_blocks(src)


@pytest.mark.parametrize("tag", ["iframe", "object", "embed", "form"])
def test_cleans_unclosed_dangerous_tag_with_encoded_srcdoc(tag: str) -> None:
    html = f'<{tag} srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;">'
    cleaned = _sanitize_html(html)
    assert f"<{tag}" not in cleaned
    assert "srcdoc" not in cleaned


# --- Bypass #1: <base href> re-points every relative link on the page. -------
def test_base_href_is_not_a_live_element_and_body_after_it_does() -> None:
    cleaned = _sanitize_html('<base href="https://evil.example">\n<p>body</p>')
    # Dropped silently, so no URL is ever resolved against it and no literal
    # <base> tag is printed into the page either.
    assert "<base" not in cleaned
    assert "&lt;base" not in cleaned
    assert "evil.example" not in cleaned
    assert "<p>body</p>" in cleaned


# --- Known dangerous VOID tags are dropped, not escaped ---------------------
@pytest.mark.parametrize(
    "html",
    [
        '<embed srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;">',
        '<base href="https://evil.example">',
        '<meta http-equiv="refresh" content="0;url=https://evil.example">',
        '<link rel="stylesheet" href="https://evil.example/x.css">',
        '<input type="image" src="https://evil.example/pwn.png" onerror="alert(1)">',
        '<source srcset="https://evil.example/x.png">',
        '<track src="https://evil.example/x.vtt">',
        '<param name="movie" value="https://evil.example/x.swf">',
        '<area href="https://evil.example">',
        '<col span="2">',
    ],
)
def test_known_dangerous_void_tags_leave_no_trace_at_all(html: str) -> None:
    cleaned = _sanitize_html(f"<p>before {html} after</p>")
    assert cleaned == "<p>before  after</p>"
    assert "evil.example" not in cleaned


# --- Bypass #2: whitespace before ">" hid the tag from the old regex. -------
def test_script_tag_with_space_before_closing_angle_bracket_is_dropped() -> None:
    cleaned = _sanitize_html('<script src="https://evil.example/x.js"></script >\n<p>body</p>')
    assert "<script" not in cleaned
    assert "evil.example" not in cleaned
    assert "<p>body</p>" in cleaned


# --- Bypass #3: unclosed container with encoded payload inside an attribute. -
def test_unclosed_iframe_with_encoded_srcdoc_is_dropped_entirely() -> None:
    cleaned = _sanitize_html('<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;">')
    assert cleaned == ""


# --- Bypass #4: the script BODY survived as visible text. -------------------
def test_script_body_does_not_survive_as_visible_text() -> None:
    marker = "window.__pwned_marker__"
    cleaned = _sanitize_html(f"<p>ok</p><script>{marker}</script><p>after</p>")
    assert marker not in cleaned
    assert cleaned == "<p>ok</p><p>after</p>"


# --- THE REGRESSION: prose with an unknown inline tag lost whole sections ----
def test_unknown_inline_tag_renders_visibly_and_keeps_the_prose_around_it() -> None:
    # python-markdown passes raw HTML through, so `No <name> configured ...`
    # reaches the parser as an unrecognised start tag. The placeholder must
    # stay readable, not vanish into a blank.
    cleaned = _sanitize_html("<p>No <name> configured for this repository</p><p>next</p>")
    assert "&lt;name&gt;" in cleaned
    assert cleaned == "<p>No &lt;name&gt; configured for this repository</p><p>next</p>"


def test_unknown_tag_does_not_swallow_the_elements_that_follow_it() -> None:
    cleaned = _sanitize_html("<p>Unknown <thing> here</p><ul><li>kept</li></ul>")
    assert cleaned == "<p>Unknown &lt;thing&gt; here</p><ul><li>kept</li></ul>"


# --- Unknown tags are escaped, not dropped; dangerous ones still drop --------
def test_unknown_tag_inner_text_is_still_preserved() -> None:
    cleaned = _sanitize_html("<p><thing>inner text</thing> tail</p>")
    assert "inner text" in cleaned
    assert "tail" in cleaned
    assert "<thing>" not in cleaned


def test_unknown_tag_source_is_re_emitted_verbatim_but_escaped() -> None:
    cleaned = _sanitize_html('<p><thing id="a b" data-x=1>text</p>')
    assert cleaned == '<p>&lt;thing id="a b" data-x=1&gt;text</p>'


def test_unknown_void_tags_are_escaped_rather_than_dropped() -> None:
    # The docs placeholder `No <name> configured ...` is an unknown VOID tag in
    # prose, so escaping - not the `_DROP_TAGS` silent drop - is what saves it.
    assert _sanitize_html("<p>No <name> configured for this repository</p>") == (
        "<p>No &lt;name&gt; configured for this repository</p>"
    )
    assert _sanitize_html("<p>a <xyz> b</p>") == "<p>a &lt;xyz&gt; b</p>"
    assert _sanitize_html('<p>a <foo bar="1"/> b</p>') == '<p>a &lt;foo bar="1"/&gt; b</p>'


def test_script_body_does_not_survive_next_to_escaped_unknown_tags() -> None:
    cleaned = _sanitize_html("<p>No <name> here</p><script>alert(1)</script><p>after</p>")
    assert cleaned == "<p>No &lt;name&gt; here</p><p>after</p>"


def test_script_with_src_is_still_dropped_entirely() -> None:
    cleaned = _sanitize_html('<p>keep</p><script src="x">alert(1)</script >')
    assert "<script" not in cleaned
    assert "alert(1)" not in cleaned
    assert "keep" in cleaned


def test_iframe_srcdoc_is_still_dropped_next_to_an_unknown_tag() -> None:
    cleaned = _sanitize_html('<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe><p>after</p>')
    assert cleaned == "<p>after</p>"


def test_markdown_table_after_prose_with_an_unknown_tag_survives() -> None:
    md = (
        'Unknown names get a *"No <name> configured for this repository"* comment.\n\n'
        "Supported names depend on the repository configuration:\n\n"
        "| Test name | Runs |\n| --- | --- |\n"
        "| `tox` | The Python test suite |\n"
        "| `pre-commit` | Runs pre-commit hooks and checks |\n"
    )
    content_html, _toc_html = _md_to_html(md)
    for expected in (
        "<table>",
        "<thead>",
        "<th>Test name</th>",
        "<th>Runs</th>",
        "<tr>",
        "<td><code>tox</code></td>",
        "<td>The Python test suite</td>",
        "<td><code>pre-commit</code></td>",
        "<td>Runs pre-commit hooks and checks</td>",
        "</table>",
    ):
        assert expected in content_html
    assert "configured for this repository" in content_html


@pytest.mark.parametrize(
    "tag",
    ["script", "style", "iframe", "object", "form", "noscript", "template", "svg", "math", "frameset"],
)
def test_code_or_markup_carrying_tags_still_drop_their_contents(tag: str) -> None:
    cleaned = _sanitize_html(f"<{tag}>SECRET-PAYLOAD</{tag}><p>after</p>")
    assert "SECRET-PAYLOAD" not in cleaned
    assert f"<{tag}" not in cleaned
    assert cleaned == "<p>after</p>"


def test_void_disallowed_tag_drops_only_itself() -> None:
    # `<embed>` has no end tag, so it must not open a drop region.
    cleaned = _sanitize_html("<p>before <embed src=x> after</p>")
    assert cleaned == "<p>before  after</p>"


def test_script_body_does_not_survive_inside_prose_either() -> None:
    cleaned = _sanitize_html("<p>before <script>alert(1)</script> after</p>")
    assert "alert(1)" not in cleaned
    assert "<script" not in cleaned
    assert "before" in cleaned and "after" in cleaned


def test_iframe_srcdoc_and_object_data_are_still_dropped_entirely() -> None:
    cleaned = _sanitize_html(
        '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe><object data="evil.html"></object>'
    )
    assert cleaned == ""


def test_unclosed_iframe_srcdoc_is_still_fully_dropped() -> None:
    assert _sanitize_html('<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;">') == ""


def test_nested_disallowed_element_drops_its_whole_subtree() -> None:
    cleaned = _sanitize_html("<form><p>inner</p></form><p>after</p>")
    assert cleaned == "<p>after</p>"


def test_closing_tag_inside_dropped_element_does_not_end_the_drop_early() -> None:
    # An inner </div> must not release the <form> drop and leak the rest.
    cleaned = _sanitize_html("<form><div>hidden</div>still hidden</form><p>visible</p>")
    assert cleaned == "<p>visible</p>"


# --- Allowlist: elements ----------------------------------------------------
def test_allowed_elements_survive_with_their_allowed_attributes() -> None:
    html = (
        '<p class="lead" id="intro">text</p>'
        "<ul><li><strong>bold</strong> <em>it</em></li></ul>"
        '<table><tr><th colspan="2" title="H">H</th></tr></table>'
    )
    assert _sanitize_html(html) == html


def test_disallowed_element_is_dropped_entirely() -> None:
    cleaned = _sanitize_html("<div><iframe src='x'>hidden</iframe>visible</div>")
    assert cleaned == "<div>visible</div>"


def test_event_handler_and_style_attributes_are_dropped_by_default() -> None:
    cleaned = _sanitize_html('<p class="x" id="y" onclick="evil()" style="color:red">t</p>')
    assert cleaned == '<p class="x" id="y">t</p>'
    assert "onclick" not in cleaned
    assert "style" not in cleaned


# --- Allowlist: URLs --------------------------------------------------------
def test_dangerous_url_schemes_are_replaced_with_fragment() -> None:
    cleaned = _sanitize_html(
        '<a href="javascript:alert(1)">j</a>'
        '<a href="vbscript:msgbox">v</a>'
        '<a href="//evil.example">pr</a>'
        '<img src="data:text/html;base64,PHNjcmlwdD4=">'
    )
    assert cleaned == '<a href="#">j</a><a href="#">v</a><a href="#">pr</a><img src="#">'
    for bad in ("javascript:", "vbscript:", "data:", "evil.example"):
        assert bad not in cleaned


def test_tab_obfuscated_javascript_url_is_neutralised() -> None:
    # Browsers drop TAB/LF/CR before resolving the scheme, so this is live JS.
    assert _sanitize_html('<a href="java\tscript:alert(1)">x</a>') == '<a href="#">x</a>'


# --- Backslash authority: browsers fold "\" to "/", so "\host" navigates -----
_BACKSLASH_AUTHORITY_URLS = [
    "\\\\evil.example",  # \\evil.example
    "/\\evil.example",  # /\evil.example
    "\\/evil.example",  # \/evil.example
    "/\\/evil.example",  # /\evil.example
    "\\\\\\evil.example",  # \\\evil.example
    "\\\\evil.example/p",  # \\evil.example/p
    "\\\\evil.example\\p",  # \\evil.example\p
]


@pytest.mark.parametrize("url", _BACKSLASH_AUTHORITY_URLS)
def test_backslash_authority_is_rejected_in_href(url: str) -> None:
    assert _sanitize_html(f'<a href="{url}">x</a>') == '<a href="#">x</a>'


@pytest.mark.parametrize("url", _BACKSLASH_AUTHORITY_URLS)
def test_backslash_authority_is_rejected_in_src(url: str) -> None:
    assert _sanitize_html(f'<img src="{url}">') == '<img src="#">'


@pytest.mark.parametrize("url", _BACKSLASH_AUTHORITY_URLS)
def test_backslash_authority_stays_rejected_behind_html_entities(url: str) -> None:
    # &bsol; is a real HTML5 named ref for "\" and &#47; for "/", so entity
    # encoding must not be a way around the fold.
    encoded = url.replace("\\", "&bsol;").replace("/", "&#47;")
    assert _sanitize_html(f'<a href="{encoded}">x</a>') == '<a href="#">x</a>'
    assert _sanitize_html(f'<img src="{encoded}">') == '<img src="#">'


@pytest.mark.parametrize("url", _BACKSLASH_AUTHORITY_URLS)
def test_backslash_authority_stays_rejected_behind_noise(url: str) -> None:
    # TAB/LF/CR/NUL are dropped by the browser before the authority is parsed.
    assert _sanitize_html(f'<a href=" \t{url}\n ">x</a>') == '<a href="#">x</a>'


def test_legitimate_relative_links_are_unaffected_by_the_fold() -> None:
    # The docs link each other and the repo, so these must keep resolving.
    html = (
        '<a href="quick-start.html">next</a>'
        '<a href="../README.md">readme</a>'
        '<a href="/assets/x.css">css</a>'
        '<a href="assets/style.css">rel</a>'
        '<a href="guide/webhooks.html#events">deep</a>'
    )
    assert _sanitize_html(html) == html


def test_legitimate_relative_links_survive_markdown_rendering() -> None:
    content_html, _toc_html = _md_to_html("See [next](quick-start.html) and [repo](../README.md).\n")
    assert 'href="quick-start.html"' in content_html
    assert 'href="../README.md"' in content_html


@pytest.mark.parametrize(
    "url",
    ["http://example.com/x", "https://example.com/x", "mailto:someone@example.com", "#section", "#"],
)
def test_allowed_url_shapes_still_pass(url: str) -> None:
    assert _sanitize_html(f'<a href="{url}">x</a>') == f'<a href="{url}">x</a>'


@pytest.mark.parametrize("url", ["javascript:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", "vbscript:msgbox"])
def test_dangerous_schemes_are_still_rejected(url: str) -> None:
    assert _sanitize_html(f'<a href="{url}">x</a>') == '<a href="#">x</a>'
    assert _sanitize_html(f'<img src="{url}">') == '<img src="#">'


def test_malformed_ipv6_authority_does_not_break_the_render() -> None:
    # urlsplit() raises ValueError on "x://["; the sanitizer must not take the
    # whole docs build down over it.
    assert _sanitize_html('<a href="x://[">x</a><p>after</p>') == '<a href="#">x</a><p>after</p>'


# --- THE REGRESSION: Pygments + TOC markup must survive ----------------------
def test_pygments_span_classes_inside_pre_code_survive() -> None:
    html = '<pre><code><span class="k">def</span> <span class="nf">f</span><span class="p">():</span></code></pre>'
    assert _sanitize_html(html) == html
    assert '<span class="k">def</span>' in _sanitize_html(html)
    assert '<span class="nf">f</span>' in _sanitize_html(html)
    assert '<span class="p">():</span>' in _sanitize_html(html)


def test_heading_ids_survive_so_table_of_contents_links_keep_working() -> None:
    assert _sanitize_html('<h2 id="install">Install</h2>') == '<h2 id="install">Install</h2>'


# --- Malformed input --------------------------------------------------------
@pytest.mark.parametrize(
    "malformed",
    [
        "<div><p>unclosed",
        "<p>stray < lt and > gt</p>",
        '<a href="unbalanced>text</a>',
        '<p>unterminated tag <span class="x',
        "<p>a</div></span></p>stray closers",
        "<!-- unterminated comment <p>x</p>",
        "<![CDATA[<script>alert(1)</script>]]>",
    ],
)
def test_malformed_input_does_not_raise_and_leaks_no_raw_markup(malformed: str) -> None:
    try:
        cleaned = _sanitize_html(malformed)
    except Exception as exc:  # noqa: BLE001 - the guarantee under test is "never raises"
        pytest.fail(f"_sanitize_html({malformed!r}) raised {exc!r}")
    assert "<script" not in cleaned
    assert "alert(1)" not in cleaned


def test_unclosed_containers_are_balanced_on_output() -> None:
    assert _sanitize_html("<div><p>unclosed") == "<div><p>unclosed</p></div>"


def test_mismatched_closing_tags_produce_balanced_output() -> None:
    assert _sanitize_html("<div><span>inner</div></span>") == "<div><span>inner</span></div>"


# --- Text escaping ----------------------------------------------------------
def test_bare_ampersand_and_angle_brackets_in_text_are_escaped() -> None:
    assert _sanitize_html("bare & ampersand < less > more") == "bare &amp; ampersand &lt; less &gt; more"


def test_escaped_entities_in_text_are_not_double_decoded() -> None:
    assert _sanitize_html("<p>a &amp; b &lt; c</p>") == "<p>a &amp; b &lt; c</p>"


def test_uses_plain_stdlib_logger() -> None:
    """The renderer takes no project config, so it uses the stdlib logger directly."""
    from pi_docsite.renderer import renderer as renderer_module

    assert renderer_module.logger is logging.getLogger(renderer_module.__name__)


def test_safe_urls_survive() -> None:
    html = (
        '<a href="https://example.com/docs">docs</a>'
        '<a href="mailto:someone@example.com">mail</a>'
        '<a href="#section">anchor</a>'
        '<a href="/absolute/page">abs</a>'
        '<a href="relative.html">rel</a>'
        '<img src="assets/style.css">'
    )
    assert _sanitize_html(html) == html


def test_self_closing_base_tag_is_dropped_not_emitted() -> None:
    cleaned = _sanitize_html('<base href="https://attacker.example/" />')
    assert cleaned == ""


def test_base_tag_inside_markdown_snippet_is_never_live() -> None:
    # What the renderer actually sees: python-markdown passes raw HTML through.
    html = '<h1 id="t">Title</h1>\n<base href="https://attacker.example/">\n<p>text</p>'
    cleaned = _sanitize_html(html)
    assert "<base" not in cleaned
    assert "&lt;base" not in cleaned
    assert "<p>text</p>" in cleaned


def test_toc_script_in_heading_is_neutralised() -> None:
    _content_html, toc_html = _md_to_html("# Title <script>alert(1)</script>\n\n## Sub <img src=x onerror=alert(2)>\n")
    assert "<script" not in toc_html
    assert "alert(1)" not in toc_html
    assert "onerror" not in toc_html
    assert "alert(2)" not in toc_html


def test_toc_fragment_links_survive_sanitising() -> None:
    # toc_depth is 2-3, so h1 never reaches the TOC and cannot be asserted on.
    _content_html, toc_html = _md_to_html("## First Heading\n\ntext\n\n### Second Heading\n")
    assert 'href="#first-heading"' in toc_html
    assert 'href="#second-heading"' in toc_html


def test_body_heading_ids_survive_sanitising() -> None:
    content_html, toc_html = _md_to_html("## First Heading\n\ntext\n\n### Second Heading\n")
    for anchor in ("first-heading", "second-heading"):
        assert f'id="{anchor}"' in content_html
        assert f'href="#{anchor}"' in toc_html


def test_cleans_annotations_only_on_outermost_code_fence() -> None:
    markdown = "```135:150:src/example.py\nprint('outer')\n```\n\n````markdown\n```config.yaml\nkey: value\n```\n````\n"
    cleaned = _clean_code_fence_annotations(markdown)
    assert "```python" in cleaned
    assert "```config.yaml" in cleaned


def test_inserts_blank_lines_before_blocks_not_inside_fences() -> None:
    markdown = "intro\n- item\n> quote\n```python\n- code\n> code\n```\nafter"
    lines = _ensure_blank_lines(markdown).splitlines()

    for marker in ("- item", "> quote", "```python"):
        index = lines.index(marker)
        assert lines[index - 1] == ""

    assert "```python\n- code\n> code\n```" in "\n".join(lines)


def test_still_inserts_blank_lines_in_prose() -> None:
    markdown = "intro\n- item\n> quote\nafter"
    assert _ensure_blank_lines(markdown) == "intro\n\n- item\n\n> quote\nafter"


def test_no_blank_line_inserted_inside_tilde_fence() -> None:
    markdown = "intro\n~~~\n- item\n> quote\n~~~\nafter"
    # Blank before the opening fence only; the body stays untouched.
    assert _ensure_blank_lines(markdown) == "intro\n\n~~~\n- item\n> quote\n~~~\nafter"


def test_tilde_fence_not_closed_by_backticks() -> None:
    # The ``` lines inside the ~~~ block are content, not closers.
    markdown = "intro\n~~~\n```\n- item\n```\n~~~\n- item\nafter"
    assert _ensure_blank_lines(markdown) == "intro\n\n~~~\n```\n- item\n```\n~~~\n\n- item\nafter"


def test_indents_tilde_fence_body_only() -> None:
    src = "~~~\n# config.yaml\nkey: value\n\n~~~\nafter\n"
    expected = "~~~\n    # config.yaml\n    key: value\n\n~~~\nafter\n"
    assert _indent_fenced_blocks(src) == expected


def test_indent_does_not_close_tilde_fence_on_backticks_and_vice_versa() -> None:
    src = "~~~\n```\n# still inside\n```\n~~~\n"
    assert _indent_fenced_blocks(src) == "~~~\n    ```\n    # still inside\n    ```\n~~~\n"

    src = "```\n~~~\n# still inside\n~~~\n```\n"
    assert _indent_fenced_blocks(src) == "```\n    ~~~\n    # still inside\n    ~~~\n```\n"


def test_badge_parts_splits_on_first_dash() -> None:
    assert _badge_parts("pi-docsite") == ("pi", "-docsite")
    assert _badge_parts("docs") == ("docs", "")
    assert _badge_parts("") == ("pi", "-docsite")  # empty falls back to the default


def test_render_page_badge_is_not_hardcoded_to_pi_config() -> None:
    # The label used to be the literal "pi-config", so every vendored site rendered
    # a badge naming this repo while linking to the consumer's own repository.
    default_html = render_page(
        markdown_content="# T",
        page_title="T",
        project_name="p",
        tagline="",
        navigation=[],
        current_slug="t",
    )
    assert DEFAULT_BADGE_LABEL in default_html
    assert 'brand-accent">-config<' not in default_html
    assert 'brand-accent">-docsite<' in default_html


def test_render_page_badge_renders_a_dashless_label_unaccented() -> None:
    custom = render_page(
        markdown_content="# T",
        page_title="T",
        project_name="p",
        tagline="",
        navigation=[],
        current_slug="t",
        badge_label="webhook",
    )
    assert "⚡ webhook" in custom
    assert "brand-accent" not in custom.split("docsite-badge")[1].split("</a>")[0]


def test_render_index_badge_honors_the_label_flag() -> None:
    html = render_index("p", "", [], badge_label="my-docs")
    assert '⚡ my<span class="brand-accent">-docs</span>' in html
