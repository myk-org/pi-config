import re
import shlex
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).parents[2]
DOCKERFILE = (ROOT / "Dockerfile").read_text()
DEPLOY_SCRIPT = (ROOT / ".dev/deploy-extensions.sh").read_text()
GRAFT_INSTALL = next(
    line.strip() for line in DOCKERFILE.splitlines() if "npm install -g" in line and "@nanonets/graft" in line
)


def dockerfile_copies(source: str, destination: str) -> bool:
    for line in DOCKERFILE.replace("\\\n", " ").splitlines():
        if not line.lstrip().startswith("COPY "):
            continue
        args = [arg for arg in shlex.split(line)[1:] if not arg.startswith("--")]
        sources, target = args[:-1], PurePosixPath(args[-1])
        if source in sources:
            copied_to = target / PurePosixPath(source).name if len(sources) > 1 or args[-1].endswith("/") else target
            if copied_to == PurePosixPath(destination):
                return True
    return False


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
    assert dockerfile_copies("extensions/shared/logger-core.mjs", "/usr/local/lib/extensions/shared/logger-core.mjs")
    assert dockerfile_copies(
        "extensions/shared/install-logger.mjs", "/usr/local/lib/extensions/shared/install-logger.mjs"
    )
    command = r'npm rebuild -g @nanonets/graft --allow-scripts="\$GRAFT_ALLOW_SCRIPTS" --strict-allow-scripts'
    assert re.search(command, DOCKERFILE)


def test_deploy_extensions_copies_worker_bootstrap_modules() -> None:
    copies = [shlex.split(line) for line in DEPLOY_SCRIPT.splitlines() if line.startswith("cp ")]
    for directory in ("extensions/shared", "scripts"):
        assert any(args[1:3] == [f"$REPO_DIR/{directory}/*.mjs", f"$PI_PKG_DIR/{directory}/"] for args in copies)


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
