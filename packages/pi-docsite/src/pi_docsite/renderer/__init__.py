"""Markdown -> HTML rendering for pi-docsite.

Re-exports the renderer's public surface so callers can use
``from pi_docsite import renderer`` without reaching into the module.
"""

from pi_docsite.renderer.renderer import (
    _FAILURE_STUB_RE,
    STATIC_DIR,
    TEMPLATES_DIR,
    _build_llms_full_txt,
    _build_llms_txt,
    _build_search_index,
    render_index,
    render_page,
)

__all__ = [
    "STATIC_DIR",
    "TEMPLATES_DIR",
    "render_index",
    "render_page",
    "_build_llms_txt",
    "_build_llms_full_txt",
    "_build_search_index",
    "_FAILURE_STUB_RE",
]
