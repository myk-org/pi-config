"""Shared SQLite connection, path resolution, and schema migration helpers.

Used by both ``myk_pi_tools.db.storage`` (``reviews.db``) and
``myk_pi_tools.pr.pr_review_store`` (``pr-reviews.db``) so both databases
share one worktree-aware path resolver, one read-only URI connector, and one
idempotent schema-migration engine.
"""

from __future__ import annotations

import re
import sqlite3
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any
from urllib.parse import quote

from myk_pi_tools.logger import create_logger
from myk_pi_tools.utils import find_git_root

log = create_logger(__name__)

# (table_name, column_name, alter_sql)
ColumnMigration = tuple[str, str, str]
# (index_name, table_name, required_columns, create_index_sql)
IndexMigration = tuple[str, str, tuple[str, ...], str]

_SAFE_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _validate_identifier(name: str) -> str:
    """Validate a SQLite table identifier before PRAGMA interpolation."""
    if not _SAFE_IDENT_RE.match(name):
        raise ValueError(f"Invalid SQLite identifier: {name!r}")
    return name


def resolve_db_path(db_name: str, *, project_root: Path | None = None) -> Path:
    """Resolve ``<main-git-root>/.pi/data/<db_name>`` (worktree-aware)."""
    root = project_root if project_root is not None else find_git_root()
    return root / ".pi" / "data" / db_name


def ensure_db_directory(db_path: Path) -> None:
    """Create the database parent directory with ``0700`` permissions if needed."""
    db_dir = db_path.parent
    if not db_dir.exists():
        log.info("Creating database directory: %s", db_dir)
        db_dir.mkdir(parents=True, mode=0o700)
    else:
        try:
            db_dir.chmod(0o700)
        except OSError as exc:
            log.debug("Could not chmod %s: %s", db_dir, exc)


def connect_ro(db_path: Path) -> sqlite3.Connection:
    """Open ``db_path`` read-only via SQLite URI with ``sqlite3.Row`` factory."""
    resolved = db_path.resolve()
    db_uri = f"file:{quote(resolved.as_posix(), safe='/:')}?mode=ro"
    conn = sqlite3.connect(db_uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def connect_rw(
    db_path: Path,
    *,
    ensure_dir: bool = False,
    foreign_keys: bool = True,
    row_factory: Any = sqlite3.Row,
) -> sqlite3.Connection:
    """Open ``db_path`` read-write, optionally creating its directory and enabling FKs."""
    if ensure_dir:
        ensure_db_directory(db_path)
    conn = sqlite3.connect(str(db_path))
    if row_factory is not None:
        conn.row_factory = row_factory
    if foreign_keys:
        conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _table_columns(conn: sqlite3.Connection, table: str, cache: dict[str, set[str]]) -> set[str]:
    """Return the set of column names on ``table``, cached per connection pass."""
    if table not in cache:
        safe_table = _validate_identifier(table)
        cursor = conn.execute(f"PRAGMA table_info({safe_table})")
        cache[table] = {row[1] for row in cursor.fetchall()}
    return cache[table]


def has_all_migrations(
    conn: sqlite3.Connection,
    migrations: Sequence[ColumnMigration],
    *,
    required_tables: Sequence[str] = (),
    required_indexes: Sequence[IndexMigration] = (),
    extra_check: Callable[[sqlite3.Connection], bool] | None = None,
) -> bool:
    """Return True when all required tables, migrated columns, indexes, and extra checks pass."""
    if required_tables:
        existing_tables = {
            row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
        }
        if not set(required_tables).issubset(existing_tables):
            return False

    table_cols: dict[str, set[str]] = {}
    for table, col_name, _sql in migrations:
        if col_name not in _table_columns(conn, table, table_cols):
            return False

    if required_indexes:
        existing_indexes = {
            row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index'").fetchall()
        }
        for idx_name, table, req_cols, _sql in required_indexes:
            cols = _table_columns(conn, table, table_cols)
            # Only require an index when the table actually carries its target columns
            # (keeps synthetic minimal test tables working without failing on missing columns).
            if all(col in cols for col in req_cols) and idx_name not in existing_indexes:
                return False

    if extra_check is not None and not extra_check(conn):
        return False

    return True


def apply_migrations(
    conn: sqlite3.Connection,
    migrations: Sequence[ColumnMigration],
    *,
    table_ddls: Sequence[str] = (),
    index_migrations: Sequence[IndexMigration] = (),
) -> set[tuple[str, str]]:
    """Create missing tables, apply missing column migrations, and create missing indexes.

    Returns the set of ``(table, column_name)`` pairs added via ``ALTER TABLE``.
    """
    for ddl in table_ddls:
        conn.execute(ddl)

    table_cols: dict[str, set[str]] = {}
    added: set[tuple[str, str]] = set()
    for table, col_name, sql in migrations:
        cols = _table_columns(conn, table, table_cols)
        if col_name not in cols:
            try:
                conn.execute(sql)
                cols.add(col_name)
                added.add((table, col_name))
                log.info("Schema migration: added '%s' column to %s", col_name, table)
            except sqlite3.OperationalError as exc:
                if "duplicate column" not in str(exc).lower():
                    raise

    for _idx_name, table, req_cols, sql in index_migrations:
        cols = _table_columns(conn, table, table_cols)
        if all(col in cols for col in req_cols):
            conn.execute(sql)

    return added


def open_migrated_ro_with_status(
    db_path: Path,
    migrations: Sequence[ColumnMigration],
    *,
    table_ddls: Sequence[str] = (),
    index_migrations: Sequence[IndexMigration] = (),
    required_tables: Sequence[str] = (),
    extra_check: Callable[[sqlite3.Connection], bool] | None = None,
    post_migrate: Callable[[sqlite3.Connection], None] | None = None,
    swallow_migration_errors: bool = False,
) -> tuple[sqlite3.Connection, bool]:
    """Open ``db_path`` read-only, upgrading schema on RW only when migrations lag.

    Returns ``(connection, schema_current)``. ``schema_current`` is ``True`` when
    the database was already current or the upgrade succeeded, and ``False`` when
    ``swallow_migration_errors=True`` caught a transient probe/upgrade failure.
    """
    conn = connect_ro(db_path)
    try:
        up_to_date = has_all_migrations(
            conn,
            migrations,
            required_tables=required_tables,
            required_indexes=index_migrations,
            extra_check=extra_check,
        )
    except sqlite3.Error as exc:
        if swallow_migration_errors:
            log.warning("Schema probe warning for %s: %s", db_path, exc)
            return conn, False
        conn.close()
        raise
    except Exception:
        conn.close()
        raise

    if up_to_date:
        return conn, True

    conn.close()
    log.debug("Migrating legacy database before read: %s", db_path)
    rw_conn: sqlite3.Connection | None = None
    migrated_ok = True
    try:
        rw_conn = connect_rw(db_path, foreign_keys=False)
        apply_migrations(
            rw_conn,
            migrations,
            table_ddls=table_ddls,
            index_migrations=index_migrations,
        )
        if post_migrate is not None:
            post_migrate(rw_conn)
        rw_conn.commit()
    except sqlite3.Error as exc:
        migrated_ok = False
        if rw_conn is not None:
            try:
                rw_conn.rollback()
            except sqlite3.Error:
                pass
        if not swallow_migration_errors:
            raise
        log.warning("Schema migration warning for %s: %s", db_path, exc)
    finally:
        if rw_conn is not None:
            rw_conn.close()

    return connect_ro(db_path), migrated_ok


def open_migrated_ro(
    db_path: Path,
    migrations: Sequence[ColumnMigration],
    *,
    table_ddls: Sequence[str] = (),
    index_migrations: Sequence[IndexMigration] = (),
    required_tables: Sequence[str] = (),
    extra_check: Callable[[sqlite3.Connection], bool] | None = None,
    post_migrate: Callable[[sqlite3.Connection], None] | None = None,
    swallow_migration_errors: bool = False,
) -> sqlite3.Connection:
    """Open ``db_path`` read-only, upgrading schema on RW only when migrations lag.

    Up-to-date databases take a single read-only open with zero write locks.
    Out-of-date databases upgrade once on a short-lived RW connection and
    reopen read-only.
    """
    conn, _schema_current = open_migrated_ro_with_status(
        db_path,
        migrations,
        table_ddls=table_ddls,
        index_migrations=index_migrations,
        required_tables=required_tables,
        extra_check=extra_check,
        post_migrate=post_migrate,
        swallow_migration_errors=swallow_migration_errors,
    )
    return conn
