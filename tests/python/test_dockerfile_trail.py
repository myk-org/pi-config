import re
import shlex
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).parents[2]
DOCKERFILE = (ROOT / "Dockerfile").read_text()
TRAIL_INSTALL = next(
    line.strip() for line in DOCKERFILE.splitlines() if "npm install -g" in line and "@trailhq/trail-code" in line
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


def test_trail_install_retains_latest() -> None:
    assert "@trailhq/trail-code@latest" in TRAIL_INSTALL


def test_trail_install_runs_smoke_check_after_installation() -> None:
    install = 'npm install -g --prefix "$TRAIL_STAGE" @trailhq/trail-code@latest'
    smoke_check = '"$TRAIL_STAGE/bin/trail" --version'
    assert DOCKERFILE.index(install) < DOCKERFILE.index(smoke_check)


def test_trail_stage_permissions_are_normalized_before_verification() -> None:
    strict_install = '--allow-scripts="$TRAIL_ALLOW_SCRIPTS" --strict-allow-scripts'
    normalize = 'chmod -R a+rX "$TRAIL_STAGE"'
    smoke_check = '"$TRAIL_STAGE/bin/trail" --version'
    publication = 'mv "$TRAIL_STAGE" "$TRAIL_PREFIX"'
    assert (
        DOCKERFILE.index(strict_install)
        < DOCKERFILE.index(normalize)
        < DOCKERFILE.index(smoke_check)
        < DOCKERFILE.index(publication)
    )


def test_published_trail_runs_as_first_node_user() -> None:
    first_node = re.search(r"^USER node$", DOCKERFILE, re.MULTILINE)
    assert first_node
    smoke_check = DOCKERFILE.index("RUN /usr/local/bin/trail --version", first_node.end())
    later_user = re.search(r"^USER ", DOCKERFILE[first_node.end() :], re.MULTILINE)
    assert later_user is None or smoke_check < first_node.end() + later_user.start()


def test_trail_uses_two_fresh_isolated_installs() -> None:
    assert 'TRAIL_AUDIT="$(mktemp -d)"' in DOCKERFILE
    assert 'npm install -g --prefix "$TRAIL_AUDIT" @trailhq/trail-code@latest --ignore-scripts' in DOCKERFILE
    assert 'rm -rf "$TRAIL_AUDIT"' in DOCKERFILE
    stage = 'TRAIL_STAGE="$(mktemp -d "$(npm prefix -g)/lib/.trail-prefix.XXXXXX")"'
    prepare = 'mkdir -p "$TRAIL_STAGE/lib"'
    strict_install = (
        'npm install -g --prefix "$TRAIL_STAGE" @trailhq/trail-code@latest '
        '--allow-scripts="$TRAIL_ALLOW_SCRIPTS" --strict-allow-scripts'
    )
    assert stage in DOCKERFILE
    assert prepare in DOCKERFILE
    assert strict_install in DOCKERFILE
    assert DOCKERFILE.index(stage) < DOCKERFILE.index(prepare) < DOCKERFILE.index(strict_install)
    assert "npm rebuild" not in DOCKERFILE


def test_trail_completed_prefix_and_bin_are_published_safely() -> None:
    assert 'TRAIL_PREFIX="$(npm prefix -g)/lib/trail-prefix"' in DOCKERFILE
    assert 'mv "$TRAIL_STAGE" "$TRAIL_PREFIX"' in DOCKERFILE
    assert 'ln -s ../lib/trail-prefix/bin/trail "$TRAIL_LINK"' in DOCKERFILE
    assert 'mv -Tf "$TRAIL_LINK" "$(npm prefix -g)/bin/trail"' in DOCKERFILE
    assert "trap 'rm -rf" in DOCKERFILE


def test_node_gyp_prerequisites_are_installed_before_trail() -> None:
    base_install = DOCKERFILE[: DOCKERFILE.index("# Install GitHub CLI")]
    for package in ("python3", "make", "g++"):
        assert re.search(rf"^  {re.escape(package)} \\$", base_install, re.MULTILINE)
    assert DOCKERFILE.index("apt-get install -y") < DOCKERFILE.index("@trailhq/trail-code@latest")


def test_trail_install_derives_strict_script_approval_from_installed_tree() -> None:
    assert "--ignore-scripts" in TRAIL_INSTALL
    assert "scripts/trail-allow-scripts.mjs /usr/local/lib/scripts/trail-allow-scripts.mjs" in DOCKERFILE
    assert dockerfile_copies("extensions/shared/logger-core.mjs", "/usr/local/lib/extensions/shared/logger-core.mjs")
    assert dockerfile_copies(
        "extensions/shared/install-logger.mjs", "/usr/local/lib/extensions/shared/install-logger.mjs"
    )
    command = (
        r'npm install -g --prefix "\$TRAIL_STAGE" @trailhq/trail-code@latest '
        r'--allow-scripts="\$TRAIL_ALLOW_SCRIPTS" --strict-allow-scripts'
    )
    assert re.search(command, DOCKERFILE)


def test_trail_allowlist_script_copied_by_dockerfile_exists() -> None:
    assert (ROOT / "scripts/trail-allow-scripts.mjs").is_file()


def test_trail_audit_reads_only_the_installed_package_tree() -> None:
    assert (
        'TRAIL_ALLOW_SCRIPTS="$(node /usr/local/lib/scripts/trail-allow-scripts.mjs '
        '"$TRAIL_AUDIT/lib/node_modules/@trailhq/trail-code" "$TRAIL_AUDIT/lib/node_modules")"'
    ) in DOCKERFILE
    assert 'test -n "$TRAIL_ALLOW_SCRIPTS"' in DOCKERFILE


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
