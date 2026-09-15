import re
from pathlib import Path

ROOT = Path(__file__).parents[2]
DOCKERFILE = (ROOT / "Dockerfile").read_text()
GRAFT_INSTALL = next(
    line.strip() for line in DOCKERFILE.splitlines() if "npm install -g" in line and "@nanonets/graft" in line
)


def test_graft_install_retains_latest() -> None:
    assert "@nanonets/graft@latest" in GRAFT_INSTALL


def test_graft_install_runs_smoke_check() -> None:
    assert re.search(r"npm rebuild -g @nanonets/graft [^\n]+ && \\\n\s+graft --version", DOCKERFILE)


def test_node_gyp_prerequisites_are_installed_before_graft() -> None:
    base_install = DOCKERFILE[: DOCKERFILE.index("# Install GitHub CLI")]
    for package in ("python3", "make", "g++"):
        assert re.search(rf"^  {re.escape(package)} \\$", base_install, re.MULTILINE)
    assert DOCKERFILE.index("apt-get install -y") < DOCKERFILE.index("@nanonets/graft@latest")


def test_graft_install_derives_strict_script_approval_from_installed_tree() -> None:
    assert "--ignore-scripts" in GRAFT_INSTALL
    assert "scripts/graft-allow-scripts.mjs /usr/local/lib/scripts/graft-allow-scripts.mjs" in DOCKERFILE
    assert "extensions/shared/install-logger.mjs /usr/local/lib/extensions/shared/install-logger.mjs" in DOCKERFILE
    command = r'npm rebuild -g @nanonets/graft --allow-scripts="\$GRAFT_ALLOW_SCRIPTS" --strict-allow-scripts'
    assert re.search(command, DOCKERFILE)


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
    assert "tree-sitter-python" not in DOCKERFILE
