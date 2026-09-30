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

import re
import tomllib
from pathlib import Path

import pytest

PKG = Path(__file__).resolve().parents[2] / "packages" / "pi-docsite"
ATTR = "pi_docsite.__version__"


def _declared_version() -> str:
    """Read `__version__` out of the package source.

    Deliberately not an import: the standard test command installs the `tests`
    group, which does not depend on this package, so importing it here fails in
    CI with ModuleNotFoundError before any contract is checked. The build
    backend reads the same source file, so this is the same value.
    """
    source = (PKG / "src" / "pi_docsite" / "__init__.py").read_text(encoding="utf-8")
    match = re.search(r'^__version__\s*=\s*["\']([^"\']+)["\']', source, re.MULTILINE)
    assert match, "no __version__ assignment in pi_docsite/__init__.py"
    return match.group(1)


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
    """The source the manifest reads has to actually exist, and be semver."""
    version = _declared_version()

    assert version.count(".") == 2, f"expected a semver, got {version!r}"


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
    # Note: a nonzero build status below is a failure, not a skip. Skipping there
    # would mean a broken wheel build passes the suite, which is the packaging
    # break this test exists to catch.

    with tempfile.TemporaryDirectory() as tmp:
        result = subprocess.run(
            ["uv", "build", "--project", str(PKG), "--wheel", "--out-dir", tmp],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, f"wheel build failed:\n{result.stderr[-800:]}"
        wheels = list(Path(tmp).glob("*.whl"))
        assert wheels, "no wheel produced"
        with zipfile.ZipFile(wheels[0]) as zf:
            metadata = next(n for n in zf.namelist() if n.endswith("METADATA"))
            version = next(
                line.split(": ", 1)[1]
                for line in zf.read(metadata).decode().splitlines()
                if line.startswith("Version:")
            )

    declared = _declared_version()

    assert version == declared, (
        f"wheel says {version} but the package says {declared} -- the two must not be able to drift"
    )
