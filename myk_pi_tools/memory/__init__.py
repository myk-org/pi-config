"""Project memory module.

Persistent per-repo memory for lessons learned, decisions, mistakes, and patterns.
Database location: <git-root>/.pi/memory/memories.db

Usage:
    from myk_pi_tools.memory import MemoryDB
    db = MemoryDB()
    db.add(category="lesson", summary="buildah chown -R skips target dir with cache mounts", tags="docker,buildah")
"""

from myk_pi_tools.memory.store import MemoryDB

__all__ = ["MemoryDB"]
