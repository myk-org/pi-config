"""Review database query module.

This module provides the ReviewDB class for querying review comments stored in SQLite.

Usage:
    from myk_pi_tools.db import ReviewDB
    db = ReviewDB()
    dismissed = db.get_dismissed_comments("myk-org", "pi-config")
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from myk_pi_tools.db.query import ReviewDB, _body_similarity, _format_table, _get_git_root

__all__ = ["ReviewDB", "_body_similarity", "_format_table", "_get_git_root"]


def __getattr__(name: str) -> Any:
    if name in __all__:
        from myk_pi_tools.db import query

        return getattr(query, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
