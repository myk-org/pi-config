"""Shared utilities for myk_pi_tools."""

from __future__ import annotations

import json
from typing import Any


def merge_paginated_json(text: str) -> list[Any]:
    """Merge concatenated JSON arrays from gh api --paginate output.

    gh --paginate returns concatenated JSON arrays like ``[...][...]``.
    We use ``json.JSONDecoder.raw_decode`` to parse each array boundary
    correctly without corrupting bracket sequences inside string values.
    """
    merged: list[Any] = []
    decoder = json.JSONDecoder()
    idx = 0
    text = text.strip()
    while idx < len(text):
        obj, end = decoder.raw_decode(text, idx)
        if isinstance(obj, list):
            merged.extend(obj)
        else:
            merged.append(obj)
        # Skip whitespace between arrays
        idx = end
        while idx < len(text) and text[idx] in " \t\n\r":
            idx += 1
    return merged
