import re
import shlex
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).parents[2]
DOCKERFILE = (ROOT / "Dockerfile").read_text()
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


def test_graft_install_runs_smoke_check_after_installation() -> None:
    install = 'npm install -g --prefix "$GRAFT_STAGE" @nanonets/graft@latest'
    smoke_check = '"$GRAFT_STAGE/bin/graft" --version'
    assert DOCKERFILE.index(install) < DOCKERFILE.index(smoke_check)


def test_graft_stage_permissions_are_normalized_before_verification() -> None:
    strict_install = '--allow-scripts="$GRAFT_ALLOW_SCRIPTS" --strict-allow-scripts'
    normalize = 'chmod -R a+rX "$GRAFT_STAGE"'
    smoke_check = '"$GRAFT_STAGE/bin/graft" --version'
    publication = 'mv "$GRAFT_STAGE" "$GRAFT_PREFIX"'
    assert (
        DOCKERFILE.index(strict_install)
        < DOCKERFILE.index(normalize)
        < DOCKERFILE.index(smoke_check)
        < DOCKERFILE.index(publication)
    )


def test_published_graft_runs_as_first_node_user() -> None:
    first_node = re.search(r"^USER node$", DOCKERFILE, re.MULTILINE)
    assert first_node
    smoke_check = DOCKERFILE.index("RUN /usr/local/bin/graft --version", first_node.end())
    later_user = re.search(r"^USER ", DOCKERFILE[first_node.end() :], re.MULTILINE)
    assert later_user
    assert smoke_check < first_node.end() + later_user.start()


def test_graft_uses_two_fresh_isolated_installs() -> None:
    assert 'GRAFT_AUDIT="$(mktemp -d)"' in DOCKERFILE
    assert 'npm install -g --prefix "$GRAFT_AUDIT" @nanonets/graft@latest --ignore-scripts' in DOCKERFILE
    assert 'rm -rf "$GRAFT_AUDIT"' in DOCKERFILE
    stage = 'GRAFT_STAGE="$(mktemp -d "$(npm prefix -g)/lib/.graft-prefix.XXXXXX")"'
    prepare = 'mkdir -p "$GRAFT_STAGE/lib"'
    strict_install = (
        'npm install -g --prefix "$GRAFT_STAGE" @nanonets/graft@latest '
        '--allow-scripts="$GRAFT_ALLOW_SCRIPTS" --strict-allow-scripts'
    )
    assert stage in DOCKERFILE
    assert prepare in DOCKERFILE
    assert strict_install in DOCKERFILE
    assert DOCKERFILE.index(stage) < DOCKERFILE.index(prepare) < DOCKERFILE.index(strict_install)
    assert "npm rebuild" not in DOCKERFILE


def test_graft_completed_prefix_and_bin_are_published_safely() -> None:
    assert 'GRAFT_PREFIX="$(npm prefix -g)/lib/graft-prefix"' in DOCKERFILE
    assert 'mv "$GRAFT_STAGE" "$GRAFT_PREFIX"' in DOCKERFILE
    assert 'ln -s ../lib/graft-prefix/bin/graft "$GRAFT_LINK"' in DOCKERFILE
    assert 'mv -Tf "$GRAFT_LINK" "$(npm prefix -g)/bin/graft"' in DOCKERFILE
    assert "trap 'rm -rf" in DOCKERFILE


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
    command = (
        r'npm install -g --prefix "\$GRAFT_STAGE" @nanonets/graft@latest '
        r'--allow-scripts="\$GRAFT_ALLOW_SCRIPTS" --strict-allow-scripts'
    )
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
