#!/usr/bin/env python3
"""Regenerate the static documentation site in ``docs/`` from ``docs/*.md``.

Usage:
    uv run python scripts/generate_docs.py

Renders deterministically (markdown -> HTML via the vendored renderer),
so repeated runs produce byte-identical output. The markdown sources are the
single source of truth: this script only ever writes HTML, ``llms*.txt``,
``search-index.json`` and ``docs/assets/``; it never touches a ``.md`` file.
"""

from __future__ import annotations

import fnmatch
import json
import logging
import os
import re
import shutil
import subprocess
import tomllib
from argparse import ArgumentParser
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from pi_docsite import renderer

# Package-relative. Deliberately NOT used as the default docs location: in a
# checkout this is src/, and when installed it is site-packages/, so a
# package-relative default would write the site into the package itself.
REPO_ROOT = Path(__file__).resolve().parent.parent
# The default follows the caller's working directory -- the invoking project's
# docs/ -- not the installed package location.
DOCS_DIR = Path.cwd() / "docs"

# Defaults are derived, not hardcoded to a repo: project name falls back to the
# git remote's repo name, then the docs directory's parent. Override anything with
# the flags in main(), so this generator can be vendored into another repo without
# editing it.
PROJECT_NAME = ""
REPO_URL = ""
TAGLINE = ""
# The badge identifies the generator, not the consuming project. It used to be the
# literal "pi-config", so every vendored site rendered a badge naming this repo and
# linking to its own — the same class of leak DEFAULT_BADGE_URL exists to stop.
# Immutable: it is the --badge-label default, so it must never be rebound per build.
DEFAULT_BADGE_LABEL = "pi-docsite"

log = logging.getLogger("pi_docsite.generate")
# Named, not an index into the detection list: the notice must render even when
# that list changes shape.
EXAMPLE_SKILL_DEST = Path.home() / ".pi" / "agent" / "skills" / "pi-docsite"

# The review config this generator knows how to check. Scoped to Qodo Merge /
# PR-Agent because its `[ignore] glob` key is the one the notice can both read
# (tomllib) and verify.
REVIEW_CONFIG = ".pr_agent.toml"


def _agent_skill_dirs(home: Path) -> tuple[Path, ...]:
    """Home-directory skill locations, resolved per call so `home` is injectable.

    Detection only -- the copy step stays manual.
    """
    return (
        home / ".agents" / "skills" / "pi-docsite",
        home / ".pi" / "agent" / "skills" / "pi-docsite",
        home / ".claude" / "skills" / "pi-docsite",
        home / ".cursor" / "skills" / "pi-docsite",
        home / ".gemini" / "skills" / "pi-docsite",
    )


def _skill_notice(docs_dir: Path, home: Path | None = None) -> str | None:
    """One line advertising the shipped skill, or None once it is installed.

    pip has no post-install hook, so nothing can announce the packaged
    ``skill/SKILL.md`` at install time. This generator prints the pointer
    instead: whoever (or whatever agent) is reading the build output sees it,
    and the LLM driving the build can offer to install it.

    Project-local ``<project>/.pi/skills/`` counts too, not just the home
    directories -- the skill directory next to the docs being built is a
    documented install target.
    """
    base = home if home is not None else Path.home()
    candidates = (*_agent_skill_dirs(base), docs_dir.parent / ".pi" / "skills" / "pi-docsite")
    installed = [str(d) for d in candidates if (d / "SKILL.md").is_file()]
    # %s placeholders, not a dict as the format argument: a dict leaves the
    # formatted message with none of these values, so a surprising notice cannot
    # be explained from the debug log.
    log.debug("skill_notice: candidates=%d installed=%s", len(candidates), installed)
    if installed:
        return None
    return (
        f"pi-docsite: generator skill not installed for any agent. To expose pi-docsite "
        f"guidance to your LLM, copy {Path(__file__).parent / 'skill' / 'SKILL.md'} "
        f"into your agent's skills directory (for example "
        f"{EXAMPLE_SKILL_DEST / 'SKILL.md'})."
    )


def _find_review_config(docs_dir: Path) -> Path | None:
    """Nearest ``.pr_agent.toml`` at or above ``docs_dir``, or None.

    Searched on the path main() hands it (see :func:`_lexical_docs_dir`), not on
    the raw argument: a docs dir nested deeper (``website/docs``) needs more than
    one level of walking, a symlinked ``docs/`` must not walk out of the repo, and
    a ``..`` that crosses a symlink has to follow the build. The review tool reads
    the config at the repo root, so the nearest config at or above the docs dir is
    the one that governs this build.
    """
    for candidate in (docs_dir, *docs_dir.parents):
        config = candidate / REVIEW_CONFIG
        if config.is_file():
            log.debug("review_notice: config=%s", config)
            return config
    log.debug("review_notice: no %s at or above %s", REVIEW_CONFIG, docs_dir)
    return None


def _lexical_docs_dir(docs_dir: Path, on_disk: Path | None = None) -> Path:
    """``docs_dir`` made absolute, ``..`` collapsed, symlinks normally left intact.

    Absolute because a relative --docs-dir makes every path below it relative
    too, and the printed review globs have to be repo-relative; ``..`` collapsed
    because those globs must be the files' real repo-relative paths rather than
    ``subdir/../docs/...``; not resolved because resolving is exactly what loses
    the repo when docs/ is a symlink.

    One exception: ``os.path.normpath`` collapses ``..`` *textually*, so with a
    symlink before it (``--docs-dir docs/..`` where docs -> elsewhere) it names a
    different directory than the one the build writes into. When the filesystem
    disagrees, the directory the files land in wins -- config discovery and the
    written site must not be two different places.
    """
    start = docs_dir if docs_dir.is_absolute() else Path.cwd() / docs_dir
    normalized = Path(os.path.normpath(start))
    target = on_disk if on_disk is not None else start.resolve()
    crossed = normalized != start and target != normalized
    log.debug(
        "review_notice: docs_dir=%s normalized=%s on_disk=%s symlink_crossed=%s",
        docs_dir,
        normalized,
        target,
        crossed,
    )
    return target if crossed else normalized


def _ignore_globs(ignore: object) -> list[str]:
    """The ``[ignore].glob`` patterns, dropping anything that is not a string.

    TOML happily holds ``glob = "docs/*.html"`` (a bare string) or ``glob = [1]``.
    Passing those to fnmatch either raises -- which would abort the build after
    the site is already written -- or matches character by character and mutes
    the notice. Neither shape is reviewable config, so neither is honoured.
    """
    raw = ignore.get("glob") if isinstance(ignore, dict) else None
    if not isinstance(raw, list):
        if raw is not None:
            log.debug("review_notice: ignoring non-list [ignore].glob: %r", raw)
        return []
    globs = [entry for entry in raw if isinstance(entry, str)]
    if len(globs) != len(raw):
        log.debug("review_notice: ignoring non-string [ignore].glob entries: %r", raw)
    return globs


GLOB_META = "*?[]"


def _glob_literal(text: str) -> str:
    """`text` as a pattern that matches itself and nothing else.

    A page may legitimately be called ``guide[1].html``. Unescaped, the brackets
    are a character class, so the suggested pattern stops matching the file it
    was meant to exclude and the notice returns on the next build. fnmatch
    matches a literal character through a one-character class.
    """
    return "".join(f"[{char}]" if char in GLOB_META else char for char in text)


def _repo_path(prefix: str, name: str) -> str:
    """Repo-relative path of a generated file, with no ``./`` and no empty part.

    Unescaped: this is the literal string the review tool matches, and what its
    globs have to be tested against. Escaping here would compare a pattern
    against its own escaped spelling, and the notice would never go quiet.
    """
    return f"{prefix}/{name}" if prefix else name


def _glob_path(prefix: str, name: str) -> str:
    """The same path as a pattern that matches it literally and nothing else."""
    return _glob_literal(_repo_path(prefix, name))


def _review_patterns(on_disk: Path, generated: Sequence[str], glob_prefix: str) -> list[str]:
    """Repo-relative review-exclusion patterns covering exactly what was generated.

    One pattern per generated file, except HTML: ``docs/*.html`` is the compact
    form and is only safe while every HTML file in the directory belongs to this
    generator. A repo may keep a hand-written ``404.html`` or a verification
    page -- the generator deliberately preserves those -- and a blanket pattern
    would hide the repo's own file from review along with the generated ones.
    Assets are always named one by one for the same reason: docs/assets/ is a
    shared directory a repo may add its own files to.

    Every literal component goes through :func:`_glob_literal`, because a page
    may legitimately be called ``guide[1].html`` and unescaped brackets are a
    character class that matches something else.
    """
    html = [name for name in generated if name.endswith(".html")]
    owned = {Path(name).name for name in html}
    preserved = [path.name for path in sorted(on_disk.glob("*.html")) if path.name not in owned]
    patterns: list[str] = (
        [f"{glob_prefix}/*.html" if glob_prefix else "*.html"]
        if not preserved
        else [_glob_path(glob_prefix, name) for name in html]
    )
    patterns += [_glob_path(glob_prefix, name) for name in generated if not name.endswith(".html")]
    return patterns


def _review_notice(docs_dir: Path, generated: Sequence[str], config: Path, on_disk: Path | None = None) -> str | None:
    """One pointer at the review config when the generated site is still in scope.

    A consuming repo commits the generated site, so an AI reviewer comments on
    thousands of lines of machine-written HTML. Those findings are not the
    consuming repo's to fix -- the source is this generator -- so the notice
    names the ignore list, and returns None (silence) once the config already
    covers every generated file. A notice that nags after the user complied is
    worse than no notice.

    ``generated`` is what *this build* wrote, not everything matching a pattern:
    the generator preserves HTML it did not write, and that difference decides
    whether a blanket pattern is safe to recommend.

    ``docs_dir`` is the lexical docs path, because the printed paths are relative
    to the repo root -- with ``docs/`` symlinked out of the repo, the resolved
    path yields absolute suggestions the review tool will never match.
    ``on_disk`` is where the files actually are, for the preserved-HTML check.
    """
    root = config.parent
    try:
        with config.open("rb") as handle:
            parsed = tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        # Unreadable config: say nothing rather than guess. The build output is
        # already on screen, and a wrong suggestion about a config this
        # generator cannot parse is noise.
        log.debug("review_notice: could not read %s: %s", config, exc)
        return None
    ignore = parsed.get("ignore")
    globs = _ignore_globs(ignore)

    # Empty when the docs dir IS the config's directory: `docs/./index.html` is
    # not what the review tool matches against, `index.html` is. Literal parts:
    # these are the paths themselves, and only the printed patterns escape them.
    try:
        parts = docs_dir.relative_to(root).parts
    except ValueError:
        parts = (docs_dir.as_posix(),)
    prefix = "/".join(parts)
    # Repo-relative paths -- the same strings the review tool matches globs
    # against, so a user's own patterns cover them exactly as they would here.
    targets = [_repo_path(prefix, name) for name in generated]
    missing = [path for path in targets if not any(fnmatch.fnmatch(path, glob) for glob in globs)]
    log.debug("review_notice: config=%s generated=%d missing=%s", config, len(targets), missing)
    if not missing:
        return None
    # json.dumps renders a TOML-compatible array of basic strings, so the line
    # can be pasted into the config as it is. Escaping happens once, inside
    # _review_patterns: escaping the prefix here too would double it, and a
    # docs directory named docs[1] would stop matching its own files.
    suggestion = json.dumps(_review_patterns(on_disk or docs_dir, generated, prefix))
    where = f"{prefix}/" if prefix else "the docs root"
    head = (
        f"pi-docsite: {len(missing)} generated file(s) under {where} are not excluded from AI review, "
        f"and the reviewer will report findings in output this generator owns. "
    )
    if isinstance(ignore, dict):
        # A second [ignore] table makes the TOML invalid, and the parse-failure
        # branch above would then silence this notice for good.
        return (
            f"{head}Add these patterns to the existing [ignore].glob list in {REVIEW_CONFIG} "
            f"(keep the .md and nav.json sources in scope):\n\n# inside [ignore].glob:\n{suggestion}\n"
        )
    return (
        f"{head}Add to {REVIEW_CONFIG} (keep the .md and nav.json sources in scope):\n\n[ignore]\nglob = {suggestion}\n"
    )


def _discover_repo_url(docs_dir: Path) -> str:
    """Best-effort remote URL for the repo owning docs_dir. Empty is fine --
    it only drives the header links."""
    try:
        out = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=docs_dir,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return out.stdout.strip() if out.returncode == 0 else ""


def _web_url(remote: str) -> str:
    """Turn a git remote into a URL a browser can open.

    Most remotes are SSH -- ``git@github.com:owner/repo.git`` -- which is not a
    web URL. It also passed the renderer's scheme-less allowance, so the badge
    rendered ``href="git@github.com:owner/repo.git"`` and the repository link
    with it. Convert to https; return "" for anything unrecognised so the caller
    falls back rather than emitting something broken.
    """
    remote = remote.strip()
    if not remote:
        return ""
    scp = re.match(r"^(?:[\w.-]+@)?([\w.-]+):(?!\d)(.+)$", remote)
    if scp and "://" not in remote:
        host, path = scp.group(1), scp.group(2)
        return f"https://{host}/{path.removesuffix('.git')}"
    if "://" in remote:
        scheme, rest = remote.split("://", 1)
        if scheme in {"http", "https", "git", "ssh"}:
            # Drop any userinfo (git@) and force https: a browser cannot use
            # git:// or ssh://, and neither is a web URL.
            rest = rest.rsplit("@", 1)[-1]
            return f"https://{rest.removesuffix('.git')}"
    return ""


def _project_name_from_url(url: str, docs_dir: Path) -> str:
    if url:
        name = url.rstrip("/").removesuffix(".git").rsplit("/", 1)[-1]
        if name:
            return name
    return docs_dir.parent.name or "Documentation"


_H1_RE = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)
_FENCE_RE = re.compile(r"^(`{3,}|~{3,})(.*)$")


def _h1(markdown_text: str, slug: str) -> str:
    """Return the page's H1 title, ignoring ``#`` lines inside code fences.

    YAML samples legitimately contain top-level keys, so a plain ``^# ``
    search finds several hits; only headings outside fences are real.
    """
    titles: list[str] = []
    fence: str | None = None
    for line in markdown_text.splitlines():
        stripped = line.lstrip()
        fence_match = _FENCE_RE.match(stripped)
        if fence_match:
            marker = fence_match.group(1)
            if fence is None:
                fence = marker
            elif marker[0] == fence[0] and len(marker) >= len(fence) and not fence_match.group(2).strip():
                fence = None
            continue
        if fence is None:
            match = _H1_RE.match(line)
            if match:
                titles.append(match.group(1))
    if len(titles) != 1:
        raise ValueError(f"docs/{slug}.md has {len(titles)} H1 headings, expected 1")
    return titles[0]


def _is_generation_failure_stub(markdown_text: str) -> bool:
    """Return True when a page's body is the generation-failure notice.

    Upstream keeps such pages out of the AI-readable indexes so a failed
    generation is never published as if it were real documentation; that filter
    was lost when the renderer and generator were vendored. The pattern lives in
    the renderer, which already declares it, so reuse it here rather than
    keeping a second copy that can drift.
    """
    return renderer._FAILURE_STUB_RE.match(markdown_text) is not None  # noqa: SLF001


# Sidebar layout comes from data, never from a list in this file.
#
#   1. docs/nav.json   -- the curated layout: ordered groups, ordered pages.
#   2. page frontmatter -- nav_group / nav_order, overriding nav.json per page.
#   3. fallback         -- any page listed in neither still appears, under
#                         UNGROUPED, alphabetically.
#
# Adding or removing a docs/*.md page must never require editing this script,
# and a page must never be invisible. A .md missing from nav.json is placed
# automatically and reported in the run summary so the gap is visible.
#
# If nav.json lists a slug with no .md behind it, that is an error: it is a
# renamed or deleted page, and silently ignoring it would leave a dead link.
UNGROUPED = "More"
DEFAULT_NAV_ORDER = 900
NAV_FILENAME = "nav.json"
# Stamped into every page so a later run only ever deletes its own output.
GENERATED_MARKER = "generated by pi-docsite"


def _frontmatter(markdown_text: str) -> dict[str, str]:
    """Parse the optional flat key: value frontmatter block.

    Deliberately not YAML: the only keys are scalars, and a full parser would add
    a dependency to the docs group for no benefit. Unknown keys are ignored.
    """
    if not markdown_text.startswith("---"):
        return {}
    end = markdown_text.find("\n---", 3)
    if end == -1:
        return {}
    meta: dict[str, str] = {}
    for line in markdown_text[3:end].splitlines():
        key, sep, value = line.partition(":")
        if sep and key.strip():
            meta[key.strip()] = value.strip().strip("'\"")
    return meta


def _strip_frontmatter(markdown_text: str) -> str:
    """Remove the leading --- block.

    The generator reads nav_group / nav_order from it, but the same raw text was
    passed to the renderer, the search index and llms-full.txt, so those keys
    appeared as visible body text, in the TOC, in search results and in the
    LLM-facing dump.
    """
    if not markdown_text.startswith("---"):
        return markdown_text
    end = markdown_text.find("\n---", 3)
    if end == -1:
        return markdown_text
    return markdown_text[end + 4 :].lstrip("\n")


def _load_layout(docs_dir: Path) -> list[tuple[str, list[str]]]:
    """Read docs/nav.json: the curated sidebar layout. Empty when absent.

    Shape: {"groups": [{"name": "...", "pages": ["slug", ...]}, ...]}
    Array order is the display order, for groups and for pages within a group.
    """
    nav_path = docs_dir / NAV_FILENAME
    if not nav_path.is_file():
        return []
    data = json.loads(nav_path.read_text(encoding="utf-8"))
    return [(str(g["name"]), [str(s) for s in g.get("pages", [])]) for g in data.get("groups", [])]


def _build_navigation(pages: dict[str, str], layout: list[tuple[str, list[str]]] | None = None) -> list[dict[str, Any]]:
    """Build the sidebar from nav.json + per-page frontmatter.

    Precedence, highest first: frontmatter nav_group/nav_order, the nav.json
    layout, then the fallback group. Every page lands somewhere, so nothing can
    be silently dropped.
    """
    layout = layout or []
    listed: set[str] = set()
    groups: dict[str, list[tuple[int, str, str]]] = {}
    group_rank: dict[str, int] = {}

    # nav.json first: its array order is authoritative unless a page overrides it.
    for rank, (group, slugs) in enumerate(layout):
        for position, slug in enumerate(slugs):
            if slug not in pages:
                raise SystemExit(
                    f"{NAV_FILENAME} lists '{slug}' but docs/{slug}.md does not exist. "
                    "Rename or remove it, or the sidebar would link to a dead page."
                )
            if slug in listed:
                raise SystemExit(
                    f"{NAV_FILENAME} lists '{slug}' more than once. Each page must appear "
                    "once or the sidebar renders it twice and its prev/next links can "
                    "point back at itself."
                )
            listed.add(slug)
            meta = _frontmatter(pages[slug])
            # Bind per page. Assigning to `group` here leaked the override into
            # the next iteration, so an un-overridden page inherited its
            # predecessor's group.
            page_group = meta.get("nav_group") or group
            order = _nav_order(meta, position)
            group_rank.setdefault(page_group, rank)
            groups.setdefault(page_group, []).append((order, slug, _h1(pages[slug], slug)))

    # Anything nav.json does not mention still appears.
    for slug in sorted(set(pages) - listed):
        meta = _frontmatter(pages[slug])
        group = meta.get("nav_group") or UNGROUPED
        order = _nav_order(meta, DEFAULT_NAV_ORDER)
        group_rank.setdefault(group, len(layout))
        groups.setdefault(group, []).append((order, slug, _h1(pages[slug], slug)))

    def _rank(group: str) -> tuple[int, str]:
        return (group_rank.get(group, len(layout)), group)

    return [
        {
            "group": group,
            "title": group,
            "pages": [{"slug": slug, "title": title} for _, slug, title in sorted(entries)],
        }
        for group, entries in sorted(groups.items(), key=lambda kv: _rank(kv[0]))
    ]


def _nav_order(meta: dict[str, str], fallback: int) -> int:
    try:
        return int(meta.get("nav_order", fallback))
    except ValueError:
        return fallback


def main(argv: list[str] | None = None) -> int:
    """Render the static docs site from docs/*.md.

    Usage:
        uv run python scripts/generate_docs.py [--docs-dir DIR] [--project-name NAME]
                                                 [--repo-url URL] [--tagline TEXT]

    Every value is a flag with a derived default, so this script and docs_render/
    can be vendored into another repo as-is.
    """
    global DOCS_DIR, PROJECT_NAME, REPO_URL, TAGLINE
    parser = ArgumentParser(description="Render the static documentation site from docs/*.md.")
    parser.add_argument(
        "--docs-dir", type=Path, default=DOCS_DIR, help="directory holding the *.md sources (default: %(default)s)"
    )
    parser.add_argument("--project-name", default=None, help="display name; defaults to the git remote's repo name")
    parser.add_argument(
        "--repo-url", default=None, help="repository URL for header links; defaults to git remote origin"
    )
    parser.add_argument("--tagline", default="", help="one-line description shown on the index")
    parser.add_argument(
        "--badge-label",
        default=DEFAULT_BADGE_LABEL,
        help="text of the header badge; identifies the generator, not the project (default: %(default)s)",
    )
    args = parser.parse_args(argv)

    DOCS_DIR = args.docs_dir.resolve()
    if not DOCS_DIR.is_dir():
        raise SystemExit(f"No docs directory at {DOCS_DIR}")
    # Identity follows --docs-dir, not the script's own location: when vendored,
    # or when docs live outside the repo, the docs directory is the truth.
    REPO_URL = args.repo_url if args.repo_url is not None else _web_url(_discover_repo_url(DOCS_DIR))
    PROJECT_NAME = args.project_name or _project_name_from_url(REPO_URL, DOCS_DIR)
    TAGLINE = args.tagline
    # Local, not a global rebound as the parser default: a custom label must not
    # become the default for a later in-process main() call.
    badge_label = args.badge_label.strip() or DEFAULT_BADGE_LABEL

    pages: dict[str, str] = {}
    for md_file in sorted(DOCS_DIR.glob("*.md")):
        pages[md_file.stem] = md_file.read_text(encoding="utf-8")

    layout = _load_layout(DOCS_DIR)
    navigation = _build_navigation(pages, layout)
    unlisted = sorted(set(pages) - {p["slug"] for g in navigation for p in g["pages"] if g["title"] != UNGROUPED})
    if unlisted:
        print(f"note: {len(unlisted)} page(s) not in {NAV_FILENAME}, placed under '{UNGROUPED}': {', '.join(unlisted)}")
    plan = {
        "project_name": PROJECT_NAME,
        "tagline": TAGLINE,
        "repo_url": REPO_URL,
        "navigation": navigation,
    }

    assets_dir = DOCS_DIR / "assets"
    assets_dir.mkdir(exist_ok=True)
    copied_assets: list[str] = []
    for static_file in sorted(renderer.STATIC_DIR.iterdir()):
        if static_file.is_file():
            shutil.copy2(static_file, assets_dir / static_file.name)
            # Tracked by name, not globbed later: docs/assets/ is shared with
            # whatever else a repo keeps there, and only these files are ours.
            copied_assets.append(f"assets/{static_file.name}")

    written: list[tuple[str, int]] = []

    def _is_generated(html_file: Path) -> bool:
        """True only for a page pi-docsite previously wrote."""
        try:
            return GENERATED_MARKER in html_file.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return False

    def _write(name: str, text: str) -> None:
        # The committed site is hook-clean (no trailing whitespace, exactly one
        # final newline), so normalise here instead of letting the pre-commit
        # fixers rewrite generated files on every run.
        text = "\n".join(line.rstrip() for line in text.split("\n")).rstrip("\n") + "\n"
        if name.endswith(".html") and GENERATED_MARKER not in text:
            text = text.replace("</body>", f"<!-- {GENERATED_MARKER} -->\n</body>", 1)
        (DOCS_DIR / name).write_text(text, encoding="utf-8")
        written.append((name, len(text.encode("utf-8"))))

    order = [page for group in navigation for page in group["pages"]]
    search_pages = {page["slug"]: _strip_frontmatter(pages[page["slug"]]) for page in order}
    search_index = renderer._build_search_index(search_pages, plan)  # noqa: SLF001
    # Written once and fetched by every page rather than inlined, so pages stay
    # small and there is a single copy to cache. Serving the site over HTTP is what
    # makes that fetch work; browsers block it on file:// via CORS.
    _write(
        "index.html",
        renderer.render_index(PROJECT_NAME, TAGLINE, navigation, repo_url=REPO_URL, badge_label=badge_label),
    )

    for idx, page in enumerate(order):
        slug = page["slug"]
        _write(
            f"{slug}.html",
            renderer.render_page(
                markdown_content=_strip_frontmatter(pages[slug]),
                page_title=page["title"],
                project_name=PROJECT_NAME,
                tagline=TAGLINE,
                navigation=navigation,
                current_slug=slug,
                prev_page=order[idx - 1] if idx > 0 else None,
                next_page=order[idx + 1] if idx < len(order) - 1 else None,
                repo_url=REPO_URL,
                badge_label=badge_label,
            ),
        )
    _write(
        "search-index.json",
        json.dumps(search_index),
    )
    # Both AI-readable indexes drop generation-failure stubs. The rendered HTML
    # and search-index.json keep every page: a stub still has a link to follow.
    ai_navigation = [
        {**group, "pages": [p for p in group["pages"] if not _is_generation_failure_stub(pages[p["slug"]])]}
        for group in navigation
    ]
    _write("llms.txt", renderer._build_llms_txt(plan, ai_navigation))  # noqa: SLF001
    _write("llms-full.txt", renderer._build_llms_full_txt(plan, pages, ai_navigation))  # noqa: SLF001

    # Drop HTML for pages that are no longer in the navigation (renamed or
    # removed markdown). glob() is non-recursive, so docs/assets/ is untouched,
    # and only *.html is considered -- .md sources and .nojekyll are safe.
    nav_slugs = {page["slug"] for page in order}
    stale: list[str] = []
    for html_file in sorted(DOCS_DIR.glob("*.html")):
        if html_file.stem in nav_slugs or html_file.stem == "index":
            continue
        # Only ever remove a file this generator wrote. A repo adopting the
        # package may keep a hand-written 404.html or a search-engine
        # verification page, and deleting those on the first run is
        # unrecoverable. Generated pages carry the marker below.
        if not _is_generated(html_file):
            print(f"  keeping  {html_file.name} (not generated by pi-docsite)")
            continue
        html_file.unlink()
        stale.append(html_file.name)

    for name, size in written:
        print(f"{size:>8} B  {name}")
    for name in stale:
        print(f"   removed  {name}")
    print(f"{len(order)} pages, {len(written)} files, {sum(s for _, s in written)} B total")
    # args.docs_dir, not DOCS_DIR: the resolved path walks out of the repo when
    # docs/ is a symlink, and the review config sits beside the symlink.
    review_config = _find_review_config(_lexical_docs_dir(args.docs_dir, DOCS_DIR))
    review_notice = (
        _review_notice(
            _lexical_docs_dir(args.docs_dir, DOCS_DIR),
            [name for name, _ in written] + copied_assets,
            review_config,
            on_disk=DOCS_DIR,
        )
        if review_config
        else None
    )
    notices = [notice for notice in (_skill_notice(DOCS_DIR), review_notice) if notice]
    log.debug("main: printed %d notice(s)", len(notices))
    for notice in notices:
        print(notice)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
