"""Tests URL-anchor selection in reviews.fetch.run (issue #802)."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from myk_pi_tools.reviews import fetch


def _run_fetch(url: str, output_dir: Path) -> dict[str, Any] | int:
    with (
        patch.object(fetch, "check_dependencies"),
        patch.object(fetch, "get_pr_info", return_value=("owner", "repo", "123")),
        patch.object(fetch, "run_gh_api", return_value={}),
        patch.object(fetch, "fetch_review_threads", return_value=[]),
        patch.object(fetch, "fetch_coderabbit_body_comments", return_value=[]),
        patch.object(fetch, "fetch_qodo_sticky_findings", return_value=[]),
        patch.object(fetch, "fetch_qodo_reply_comments", return_value=[]),
        patch.object(fetch, "process_and_categorize", return_value={"human": [], "qodo": [], "coderabbit": []}),
        patch.object(fetch, "auto_skip_replied_findings"),
    ):
        return fetch.run(url, output_dir=str(output_dir))


def test_bare_pr_url_does_not_warn_about_an_unrecognized_fragment(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    result = _run_fetch("https://github.com/owner/repo/pull/123", tmp_path)

    assert isinstance(result, dict)
    assert "Unrecognized URL fragment" not in capsys.readouterr().err


def test_unknown_explicit_pr_url_fragment_warns(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    result = _run_fetch("https://github.com/owner/repo/pull/123#unknown-anchor", tmp_path)

    assert isinstance(result, dict)
    assert "Warning: Unrecognized URL fragment" in capsys.readouterr().err


def test_malformed_review_url_warns(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    result = _run_fetch("not-a-pull-request-url", tmp_path)

    assert isinstance(result, dict)
    assert "Warning: Unrecognized URL fragment in: not-a-pull-request-url" in capsys.readouterr().err
