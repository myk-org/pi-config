"""
pi-docsite single-source version contract.

The package used to pin its version in two places, `pyproject.toml` and
`pi_docsite.__version__`. That is how the release bug in PR #866 went unnoticed:
the `__version__` scan found one of them, so the package looked version-tracked
while its manifest was invisible to detection, and a release would have published
a wheel labelled 4.6.5 under a 4.7.0 tag.

These tests assert the contract, so a later packaging change that reintroduces a
second version source fails here rather than at release time.
"""

import tomllib
from pathlib import Path

import pytest

PKG = Path(__file__).resolve().parents[2] / "packages" / "pi-docsite"
ATTR = "pi_docsite.__version__"


def _pyproject() -> dict:
    with (PKG / "pyproject.toml").open("rb") as fh:
        return tomllib.load(fh)


def test_pyproject_does_not_pin_a_version() -> None:
    """A static `version =` here is the second source of truth this removed."""
    project = _pyproject()["project"]

    assert "version" not in project, "version must come from the package, not the manifest"
    assert "version" in project["dynamic"]


def test_pyproject_reads_the_version_from_the_package() -> None:
    dynamic = _pyproject()["tool"]["setuptools"]["dynamic"]

    assert dynamic["version"]["attr"] == ATTR


def test_package_exposes_a_version() -> None:
    """The source the manifest reads has to actually exist."""
    from pi_docsite import __version__

    assert __version__.count(".") == 2, f"expected a semver, got {__version__!r}"


def test_wheel_metadata_matches_the_package() -> None:
    """Build the wheel and read the version off the artifact, not the manifest.

    Asserting only the pyproject contract would pass even if the build backend
    ignored `dynamic`, which is the failure that actually ships a wrong version.
    """
    import shutil
    import subprocess
    import tempfile
    import zipfile

    if shutil.which("uv") is None:
        pytest.skip("uv not available to build the wheel")

    with tempfile.TemporaryDirectory() as tmp:
        result = subprocess.run(
            ["uv", "build", "--project", str(PKG), "--wheel", "--out-dir", tmp],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            pytest.skip(f"wheel build unavailable: {result.stderr[-200:]}")
        wheels = list(Path(tmp).glob("*.whl"))
        assert wheels, "no wheel produced"
        with zipfile.ZipFile(wheels[0]) as zf:
            metadata = next(n for n in zf.namelist() if n.endswith("METADATA"))
            version = next(
                line.split(": ", 1)[1]
                for line in zf.read(metadata).decode().splitlines()
                if line.startswith("Version:")
            )

    from pi_docsite import __version__

    assert version == __version__, (
        f"wheel says {version} but the package says {__version__} -- the two must not be able to drift"
    )
