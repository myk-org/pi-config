"""Behavioural assertions on the Dockerfile's Qodo CLI installation.

#840 replaced a SHA-256-pinned get.qodo.ai bundle with the npm package
`@qodo/command`. These tests pin the two properties that make the install
verifiable rather than merely present: the release is pinned, and the build
check cannot pass on a Qodo failure it does not expect.

The exit-status tests EXECUTE the RUN block's own shell logic against a stub
`qodo` instead of grepping the Dockerfile for a literal fragment. Asserting on
text like `|| qodo_status=$?` couples the test to one spelling of the check, so
an equivalent rewrite breaks a test that should have kept passing. Running the
logic means any implementation with the same behaviour passes, and any
implementation that loses the behaviour fails.
"""

import os
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).parents[2]
DOCKERFILE = (ROOT / "Dockerfile").read_text()

# The Qodo RUN block, with line continuations folded into one logical line.
QODO_BLOCK = next(
    block.replace("\\\n", " ") for block in re.split(r"\n(?=RUN |# )", DOCKERFILE) if "@qodo/command" in block
)
QODO_VERSION = re.search(r"ARG QODO_VERSION=(\S+)", DOCKERFILE)


def _qodo_version() -> str:
    """The pinned version, narrowed to str for mypy at every use site."""
    assert QODO_VERSION is not None, "QODO_VERSION ARG must be declared"
    return QODO_VERSION.group(1)


def test_qodo_version_arg_is_declared_and_concrete() -> None:
    """A pin must exist and must be a real version, not @latest or a range."""
    assert QODO_VERSION is not None, "QODO_VERSION ARG must be declared"
    version = _qodo_version()
    assert re.fullmatch(r"\d+\.\d+\.\d+", version), f"expected an exact version, got {version!r}"
    assert "@qodo/command@${QODO_VERSION}" in QODO_BLOCK, "install must use the pinned version"


def _run_qodo_check(tmp_path: Path, *, stdout: str, exit_code: int) -> subprocess.CompletedProcess:
    """Run the Dockerfile's Qodo version check against a stub `qodo`.

    Returns the completed process; callers assert on `returncode`.
    """
    version = _qodo_version()

    # Neutralise the parts of the RUN block that need a real container: the npm
    # install (stubbed binary instead) and the temp file path (sandboxed).
    body = QODO_BLOCK
    body = re.sub(r"^RUN\s+--mount=\S+\s+", "", body)
    body = re.sub(r"npm install -g @qodo/command@\$\{QODO_VERSION\}", ":", body)
    body = re.sub(r"/tmp/qodo-version\.txt", str(tmp_path / "qodo-version.txt"), body)

    tmp_path.mkdir(parents=True, exist_ok=True)
    stub_dir = tmp_path / "bin"
    stub_dir.mkdir()
    stub = stub_dir / "qodo"
    stub.write_text(f"#!/bin/sh\ncat <<'EOF'\n{stdout}\nEOF\nexit {exit_code}\n")
    stub.chmod(0o755)

    env = {
        "PATH": f"{stub_dir}:{os.environ['PATH']}",
        "QODO_VERSION": version,
    }
    return subprocess.run(
        ["/bin/sh", "-c", body],
        capture_output=True,
        text=True,
        env=env,
    )


def test_qodo_check_accepts_a_working_install(tmp_path: Path) -> None:
    """A logged-in `qodo --version` printing the pinned version must pass."""
    version = _qodo_version()
    result = _run_qodo_check(tmp_path, stdout=f"Client: {version}", exit_code=0)
    assert result.returncode == 0, f"expected success, got {result.returncode}: {result.stderr}"


def test_qodo_check_tolerates_only_the_logged_out_failure(tmp_path: Path) -> None:
    """The missing-API-key result may fail; every other failure must fail the build.

    This is the regression the literal-fragment test could not express: with
    `qodo --version | grep -q ...` the pipeline returns grep's status, so a Qodo
    failure unrelated to the documented one still printed its Client: line and
    passed. Here the stub exits 3 with no API-key message and the check must
    reject it.
    """
    version = _qodo_version()

    tolerated = _run_qodo_check(
        tmp_path / "tolerated", stdout=f"Qodo API key not found\nClient: {version}", exit_code=1
    )
    assert tolerated.returncode == 0, (
        f"the documented logged-out result must be tolerated, got {tolerated.returncode}: {tolerated.stderr}"
    )

    unexpected = _run_qodo_check(tmp_path / "unexpected", stdout=f"Client: {version}\ninternal error", exit_code=3)
    assert unexpected.returncode != 0, (
        "an unexpected non-zero qodo exit must fail the build, even when it prints the expected Client: line"
    )


def test_qodo_check_rejects_a_version_mismatch(tmp_path: Path) -> None:
    """The check must verify the pinned version, not merely that some version printed."""
    result = _run_qodo_check(tmp_path, stdout="Client: 0.0.0-does-not-match", exit_code=0)
    assert result.returncode != 0, "printing an unexpected version must fail the build"


def test_qodo_binary_is_still_resolved() -> None:
    """The executable must exist on PATH outside HOME, not just be installed."""
    assert "command -v qodo" in QODO_BLOCK
