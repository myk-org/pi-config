"""Project memory module.

Persistent per-repo memory stored as a plain markdown file.
File location: <git-root>/.pi/memory/memory.md

Usage:
    from myk_pi_tools.memory import MemoryFile
    mem = MemoryFile()
    mem.add_pinned(category="lesson", summary="Always use uv run, never python directly")
"""

from myk_pi_tools.memory.store import MemoryFile

__all__ = ["MemoryFile"]
