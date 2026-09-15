import re
from pathlib import Path

ROOT = Path(__file__).parents[2]
DOCKERFILE = (ROOT / "Dockerfile").read_text()
GRAFT_INSTALL = next(
    line.strip() for line in DOCKERFILE.splitlines() if "npm install -g" in line and "@nanonets/graft" in line
)
# Complete native install-script package list required by @nanonets/graft 0.18.0.
REQUIRED_ALLOW_SCRIPTS = {
    "@nanonets/graft",
    "tree-sitter",
    "tree-sitter-cli",
    "tree-sitter-go",
    "tree-sitter-java",
    "tree-sitter-javascript",
    "tree-sitter-kotlin",
    "tree-sitter-php",
    "tree-sitter-python",
    "@davisvaughan/tree-sitter-r",
    "tree-sitter-swift",
    "tree-sitter-typescript",
}


def test_graft_install_retains_latest_and_smoke_check() -> None:
    assert "@nanonets/graft@latest" in GRAFT_INSTALL
    assert re.search(r"@nanonets/graft@latest [^\n]+ && \\\n\s+graft --version", DOCKERFILE)


def test_node_gyp_prerequisites_are_installed_before_graft() -> None:
    base_install = DOCKERFILE[: DOCKERFILE.index("# Install GitHub CLI")]
    for package in ("python3", "make", "g++"):
        assert re.search(rf"^  {re.escape(package)} \\$", base_install, re.MULTILINE)
    assert DOCKERFILE.index("apt-get install -y") < DOCKERFILE.index("@nanonets/graft@latest")


def test_graft_install_strictly_allows_only_required_native_packages() -> None:
    match = re.search(r"--allow-scripts=([^ ]+)", GRAFT_INSTALL)
    assert match
    assert set(match.group(1).split(",")) == REQUIRED_ALLOW_SCRIPTS
    assert "--strict-allow-scripts" in GRAFT_INSTALL


def test_install_script_approval_is_command_scoped() -> None:
    forbidden = (
        "--allow-scripts=*",
        "--dangerously-allow-all-scripts",
        "--ignore-scripts=false",
        "npm config set allow-scripts",
        "NPM_CONFIG_ALLOW_SCRIPTS",
    )
    assert not any(value in DOCKERFILE for value in forbidden)
    assert DOCKERFILE.count("--allow-scripts=") == 1
