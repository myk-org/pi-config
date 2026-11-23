"""Review database storage module.

This package exposes :class:`ReviewDB` and shared SQLite helpers lazily so
importing ``myk_pi_tools.cli`` does not load ``sqlite3`` until a database
subcommand is invoked.

Usage:
    from myk_pi_tools.db import ReviewDB
    db = ReviewDB()
    dismissed = db.get_dismissed_comments("myk-org", "pi-config")
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from myk_pi_tools.db.sqlite_helpers import (
        apply_migrations,
        connect_ro,
        connect_rw,
        ensure_db_directory,
        has_all_migrations,
        open_migrated_ro,
        resolve_db_path,
    )
    from myk_pi_tools.db.storage import (
        SCHEMA,
        ReviewDB,
        ReviewDBError,
        _body_similarity,
        _format_table,
        _get_git_root,
        resolve_reviews_db_path,
    )

_STORAGE_EXPORTS = frozenset({
    "SCHEMA",
    "ReviewDB",
    "ReviewDBError",
    "_body_similarity",
    "_format_table",
    "_get_git_root",
    "resolve_reviews_db_path",
})

_HELPER_EXPORTS = frozenset({
    "apply_migrations",
    "connect_ro",
    "connect_rw",
    "ensure_db_directory",
    "has_all_migrations",
    "open_migrated_ro",
    "resolve_db_path",
})

__all__ = [
    "SCHEMA",
    "ReviewDB",
    "ReviewDBError",
    "_body_similarity",
    "_format_table",
    "_get_git_root",
    "apply_migrations",
    "connect_ro",
    "connect_rw",
    "ensure_db_directory",
    "has_all_migrations",
    "open_migrated_ro",
    "resolve_db_path",
    "resolve_reviews_db_path",
]


def __getattr__(name: str) -> Any:
    if name in _STORAGE_EXPORTS:
        from myk_pi_tools.db import storage

        return getattr(storage, name)
    if name in _HELPER_EXPORTS:
        from myk_pi_tools.db import sqlite_helpers

        return getattr(sqlite_helpers, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
