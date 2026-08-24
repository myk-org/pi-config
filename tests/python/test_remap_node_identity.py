"""Tests for container node UID/GID remap (scripts/remap-node-identity.sh)."""

from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

import pytest

LIB = Path(__file__).resolve().parents[2] / "scripts" / "remap-node-identity.sh"
INIT = Path(__file__).resolve().parents[2] / "init-entrypoint.sh"


def _run(script: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    merged = os.environ.copy()
    if env:
        merged.update(env)
    return subprocess.run(
        ["bash", "-c", f"set -uo pipefail; . {LIB}; {script}"],
        check=False,
        capture_output=True,
        text=True,
        env=merged,
    )


def test_uint_accepts_numeric() -> None:
    r = _run("pi_is_uint 18812 && pi_is_uint 1000 && pi_is_uint 0")
    assert r.returncode == 0, r.stderr


def test_uint_rejects_empty_and_garbage() -> None:
    assert _run("pi_is_uint abc; echo $?").stdout.strip() == "1"
    assert _run("pi_is_uint 12a; echo $?").stdout.strip() == "1"
    assert _run('pi_is_uint ""; echo $?').stdout.strip() == "1"


def test_resolve_uses_explicit_env() -> None:
    r = _run("pi_resolve_host_ids", {"PI_HOST_UID": "18812", "PI_HOST_GID": "18812"})
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "18812:18812"


def test_resolve_skips_when_host_user_is_node() -> None:
    r = _run("pi_resolve_host_ids", {"PI_HOST_USER": "node"})
    assert r.returncode == 1


def test_resolve_infers_from_bind_mount_probe(tmp_path: Path) -> None:
    probe = tmp_path / ".pi"
    probe.mkdir()
    os.chmod(probe, stat.S_IRWXU)
    r = _run(
        "pi_resolve_host_ids",
        {
            "PI_HOST_USER": "myakove",
            "PI_HOST_HOME": str(tmp_path),
            "PI_HOST_UID": "",
            "PI_HOST_GID": "",
        },
    )
    assert r.returncode == 0, r.stderr
    uid, gid = r.stdout.strip().split(":")
    assert uid == str(os.getuid())
    assert gid == str(os.getgid())
    assert ".pi" in r.stderr


def test_resolve_does_not_stat_parent_dir(tmp_path: Path) -> None:
    """Parent /home/$user is docker-created as root; only probes count."""
    r = _run(
        "pi_resolve_host_ids",
        {
            "PI_HOST_USER": "myakove",
            "PI_HOST_HOME": str(tmp_path),
            "PI_HOST_UID": "",
            "PI_HOST_GID": "",
        },
    )
    assert r.returncode == 1


def test_validate_refuses_root() -> None:
    r = _run("pi_validate_host_ids 0 1000; echo $?")
    assert r.stdout.strip() == "1"
    assert "uid/gid 0" in r.stderr
    r = _run("pi_validate_host_ids 1000 0; echo $?")
    assert r.stdout.strip() == "1"


def test_validate_refuses_non_numeric() -> None:
    r = _run("pi_validate_host_ids abc 1000; echo $?")
    assert r.stdout.strip() == "1"


def test_dry_run_remap_skips_usermod() -> None:
    r = _run(
        "pi_remap_node_identity; echo rc:$?",
        {"PI_HOST_UID": "18812", "PI_HOST_GID": "18812", "PI_REMAP_DRY_RUN": "1"},
    )
    # Host may not have a `node` user — dry-run still needs id -u node.
    if r.returncode != 0 and "no such user" in (r.stderr + r.stdout).lower():
        pytest.skip("no node user on host")
    assert r.returncode == 0, r.stderr
    assert "dry-run: would remap node" in r.stderr or "already 18812:18812" in r.stderr


def test_init_entrypoint_remaps_before_home_mapping() -> None:
    text = INIT.read_text()
    remap_at = text.index("pi_remap_node_identity")
    home_at = text.index("NEW_HOME=")
    assert remap_at < home_at
    assert ". /usr/local/bin/remap-node-identity.sh" in text
    assert "PI_HOST_UID" in text
