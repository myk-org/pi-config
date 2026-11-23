"""Backwards-compatible query interface re-exporting ``myk_pi_tools.db.storage``.

All ``reviews.db`` path resolution, schema definitions, migrations, read-only
and read-write connections, queries, and title upkeep live in
:mod:`myk_pi_tools.db.storage`. This module re-exports the historical public
symbols so existing imports (``from myk_pi_tools.db.query import ReviewDB``)
keep working unchanged.
"""

from __future__ import annotations

from myk_pi_tools.db.storage import (
    SCHEMA,
    ReviewDB,
    ReviewDBError,
    _body_similarity,
    _format_table,
    _get_git_root,
    _token_similarity,
    _tokenize_body,
    backfill_titles,
    create_tables,
    insert_comment,
    insert_review,
    resolve_reviews_db_path,
    run_title_backfill_once,
)

__all__ = [
    "SCHEMA",
    "ReviewDB",
    "ReviewDBError",
    "_body_similarity",
    "_format_table",
    "_get_git_root",
    "_token_similarity",
    "_tokenize_body",
    "backfill_titles",
    "create_tables",
    "insert_comment",
    "insert_review",
    "resolve_reviews_db_path",
    "run_title_backfill_once",
]
