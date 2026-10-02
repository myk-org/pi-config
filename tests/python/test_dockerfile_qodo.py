"""Static assertions on the Dockerfile's Qodo CLI installation.

#840 replaced a SHA-256-pinned get.qodo.ai bundle with the npm package
`@qodo/command`. These tests pin the two properties that make the install
verifiable rather than merely present: the release is pinned, and the build
check cannot pass on a Qodo failure it does not expect.
"""

import re
from pathlib import Path

ROOT = Path(__file__).parents[2]
DOCKERFILE = (ROOT / "Dockerfile").read_text()

# The Qodo RUN block, with line continuations folded into one logical line.
QODO_BLOCK = next(
    block.replace("\\\n", " ") for block in re.split(r"\n(?=RUN |# )", DOCKERFILE) if "@qodo/command" in block
)
QODO_VERSION = re.search(r"ARG QODO_VERSION=(\S+)", DOCKERFILE)


def test_qodo_version_arg_is_declared_and_concrete() -> None:
    """A pin must exist and must be a real version, not @latest or a range."""
    assert QODO_VERSION is not None, "QODO_VERSION ARG must be declared"
    version = QODO_VERSION.group(1)
    assert re.fullmatch(r"\d+\.\d+\.\d+", version), f"expected an exact version, got {version!r}"
    assert "@qodo/command@${QODO_VERSION}" in QODO_BLOCK, "install must use the pinned version"


def test_qodo_install_asserts_the_pinned_version_in_output() -> None:
    """The check must verify the pinned version, not merely that some version printed."""
    assert 'grep -q "Client: ${QODO_VERSION}"' in QODO_BLOCK


def test_qodo_check_does_not_pipe_away_the_exit_status() -> None:
    """`qodo --version | grep -q` returns grep's status and discards Qodo's.

    That made any invocation printing a Client: line pass, including a Qodo
    failure unrelated to the expected logged-out condition. The exit status must
    be captured explicitly instead.
    """
    assert "qodo --version | grep" not in QODO_BLOCK, "exit status must not be discarded through a pipe"
    assert "|| qodo_status=$?" in QODO_BLOCK, "the Qodo exit status must be captured"


def test_qodo_check_tolerates_only_the_logged_out_failure() -> None:
    """Non-zero is tolerated only for the documented missing-API-key result."""
    assert "qodo_status" in QODO_BLOCK
    assert "Qodo API key not found" in QODO_BLOCK, "the tolerated failure must name the documented condition"
    assert "exit 1" in QODO_BLOCK, "any other failure must fail the build"


def test_qodo_binary_is_still_resolved() -> None:
    """The executable must exist on PATH outside HOME, not just be installed."""
    assert "command -v qodo" in QODO_BLOCK
