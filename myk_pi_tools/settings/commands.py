"""Settings CLI commands — resolve pi-config settings like TypeScript getSetting."""

from __future__ import annotations

import json
import logging
import math
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any

import click
import commentjson

log = logging.getLogger(__name__)

SETTINGS_FILENAMES = ("pi-config-settings.json",)

# Legacy settings file, no longer read: migrated away once, then ignored (issue #1086).
LEGACY_SETTINGS_FILENAME = "pi-config-settings.jsonc"

# Suffix the legacy file is moved to — it can never shadow the `.json` again.
LEGACY_MIGRATED_SUFFIX = ".migrated"

# One warning per directory and reason: settings resolution runs on nearly every tool call, so a
# file that stays ignored/refused/corrupt must not re-log on each read. Path only, never values.
_LEGACY_WARNED: set[tuple[str, Path]] = set()


def _warn_legacy_once(reason: str, message: str, path: Path) -> None:
    key = (reason, path.parent)
    if key in _LEGACY_WARNED:
        return
    _LEGACY_WARNED.add(key)
    log.warning("%s path=%s", message, path)


def _strip_json_comments(text: str) -> str:
    """Drop `//` and `/* */` comments outside strings (matches TS strip-json-comments).

    Raises ValueError on an unterminated block comment, so a broken legacy file counts as corrupt.
    """
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == '"':
            j = i + 1
            while j < n:
                if text[j] == "\\":
                    j += 2
                elif text[j] == '"':
                    j += 1
                    break
                else:
                    j += 1
            out.append(text[i:j])
            i = j
        elif text.startswith("//", i):
            end = text.find("\n", i)
            i = n if end == -1 else end
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            if end == -1:
                raise ValueError("unterminated block comment")
            i = end + 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _read_legacy_settings(legacy: Path) -> dict[str, Any] | None:
    """Parse the legacy file; None means "nothing to migrate". Path only, values never logged."""
    try:
        raw = json.loads(_strip_json_comments(legacy.read_text(encoding="utf-8")))
    except FileNotFoundError:
        # A racing process already renamed it away: not corruption.
        return None
    except (OSError, ValueError):
        _warn_legacy_once("corrupt", "settings_legacy_jsonc_corrupt", legacy)
        return None
    if not isinstance(raw, dict):
        _warn_legacy_once("corrupt", "settings_legacy_jsonc_corrupt", legacy)
        return None
    return raw


def _legacy_tracked(directory: Path, legacy: Path) -> bool:
    """Whether git tracks the legacy file. `unknown` (git failed) counts as tracked."""
    try:
        result = subprocess.run(
            ["git", "ls-files", "--error-unmatch", "--", str(legacy)],
            cwd=str(directory),
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        log.warning("settings_legacy_jsonc_git_check_failed path=%s fallback=not migrated", legacy)
        return True
    if result.returncode == 1:
        return False
    if result.returncode == 128 and "not a git repository" in result.stderr.lower():
        return False
    if result.returncode == 0:
        return bool(result.stdout.strip())
    log.warning("settings_legacy_jsonc_git_check_failed path=%s fallback=not migrated", legacy)
    return True


def _migrate_legacy_settings(settings_dir: Path, scope: str = "project") -> None:
    """One-time migration away from the legacy `.jsonc` settings file (issue #1086).

    - `.json` exists     -> migrate nothing; the legacy file is ignored (logged once per dir).
    - `.json` missing    -> write its parsed content to `.json` (temp file, then atomic publish),
                            then move the legacy file to `*.jsonc.migrated`.
    - legacy unparseable -> refuse: nothing written, nothing renamed.
    - legacy tracked     -> refuse, PROJECT scope only: laundering a clone's tracked file into an
                            untracked `.json` would hand it the trust the project settings root
                            withholds. A dotfiles-managed global `~/.pi` still migrates.
    - legacy a symlink   -> refuse: copying through it would import a file from elsewhere.
    """
    legacy = settings_dir / LEGACY_SETTINGS_FILENAME
    if not legacy.is_symlink() and not legacy.exists():
        return
    if legacy.is_symlink():
        _warn_legacy_once("symlink", "settings_legacy_jsonc_symlink_refused", legacy)
        return
    target = settings_dir / SETTINGS_FILENAMES[0]
    if target.exists():
        _warn_legacy_once("ignored", "settings_legacy_jsonc_ignored", legacy)
        return
    # Parse BEFORE the git check: a corrupt legacy file never migrates, so it must not cost a
    # git exec on every settings resolution.
    data = _read_legacy_settings(legacy)
    if data is None:
        return
    if scope == "project" and _legacy_tracked(settings_dir, legacy):
        _warn_legacy_once("tracked", "settings_legacy_jsonc_tracked_refused", legacy)
        return

    tmp = target.with_name(f".{target.name}.{os.getpid()}.{time.monotonic_ns()}.tmp")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError:
        log.warning("settings_legacy_jsonc_migrate_failed path=%s", legacy)
        return
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(data, indent=2) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        # os.link publishes the full content atomically and never overwrites an existing target:
        # if another process won the race, keep theirs.
        try:
            os.link(tmp, target)
        except FileExistsError:
            pass
        except OSError:
            log.warning("settings_legacy_jsonc_migrate_failed path=%s", legacy)
            return
    except OSError:
        log.warning("settings_legacy_jsonc_migrate_failed path=%s", legacy)
        return
    finally:
        tmp.unlink(missing_ok=True)

    try:
        legacy.rename(legacy.with_name(LEGACY_SETTINGS_FILENAME + LEGACY_MIGRATED_SUFFIX))
    except FileNotFoundError:
        pass
    except OSError:
        # Content is safe in `.json` and the legacy name is no longer read: cosmetic only.
        log.warning("settings_legacy_jsonc_rename_failed path=%s", legacy)
        return
    log.warning("settings_legacy_jsonc_migrated path=%s", legacy)


def _find_settings_file(directory: Path, scope: str = "project") -> Path | None:
    """Find the settings file, migrating a legacy `.jsonc` away first. Scope defaults to
    `project`: only the global callers opt into the weaker tracked-file refusal."""
    _migrate_legacy_settings(directory, scope)
    for name in SETTINGS_FILENAMES:
        p = directory / name
        if p.is_file():
            log.debug("settings_file_found path=%s", p)
            return p
    log.debug("settings_file_not_found dir=%s", directory)
    return None


_KEYS_FILE = Path(__file__).resolve().parent.parent.parent / "settings-keys.json"


def _load_settings_keys() -> dict[str, Any]:
    return json.loads(_KEYS_FILE.read_text(encoding="utf-8"))


SETTINGS_KEYS: dict[str, Any] = _load_settings_keys()
SUPPORTED_KEYS = tuple(SETTINGS_KEYS.keys())
ENV_BY_KEY: dict[str, str] = {k: v["env"] for k, v in SETTINGS_KEYS.items() if isinstance(v.get("env"), str)}

SettingValue = bool | str | int | float | list[str] | dict[str, Any]

BOOL_TRUE = frozenset({"true", "1", "yes", "on"})
BOOL_FALSE = frozenset({"false", "0", "no", "off"})

REVIEW_LOOP_MAX_CYCLES_RE = re.compile(r"^(?:[1-9]|10)$")
AGENT_NAME_RE = re.compile(r"^[a-z0-9_-]+$")


def _resolve_repo_root(cwd: Path | None = None) -> Path:
    """Resolve main repo root via git-common-dir (matches TS resolveRepoRoot)."""
    work_dir = str(cwd) if cwd is not None else None
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            cwd=work_dir,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            git_dir = Path(result.stdout.strip())
            if not git_dir.is_absolute():
                base = Path(work_dir) if work_dir else Path.cwd()
                git_dir = (base / git_dir).resolve()
            return git_dir.parent
    except (OSError, subprocess.TimeoutExpired):
        pass
    return Path(work_dir) if work_dir else Path.cwd()


def _is_number(value: Any) -> bool:
    """True for int/float, excluding bool (bool is a subclass of int)."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _parse_review_loop_max_cycles(raw: Any) -> int | None:
    """Parse review_loop_max_cycles: integer 1-10 or digit string '1'-'10' only."""
    if _is_number(raw):
        if isinstance(raw, float) and not raw.is_integer():
            return None
        n = int(raw)
        return n if 1 <= n <= 10 else None
    if isinstance(raw, str):
        trimmed = raw.strip()
        if not REVIEW_LOOP_MAX_CYCLES_RE.match(trimmed):
            return None
        return int(trimmed)
    return None


_MISSING = object()


def _parse_agent_overrides(raw: Any) -> dict[str, Any] | None:
    """Parse agent_overrides nested object. Invalid → None."""
    if not isinstance(raw, dict):
        return None
    overrides: dict[str, Any] = {}
    for name, val in raw.items():
        if not isinstance(val, dict):
            continue
        entry: dict[str, str | None] = {}
        provider = val.get("provider", _MISSING)
        if provider is None:
            entry["provider"] = None
        elif isinstance(provider, str):
            trimmed = provider.strip()
            if trimmed:
                entry["provider"] = trimmed
        model = val.get("model", _MISSING)
        if model is None:
            entry["model"] = None
        elif isinstance(model, str):
            trimmed = model.strip()
            if trimmed:
                entry["model"] = trimmed
        if entry:
            overrides[str(name)] = entry
    return overrides if overrides else None


def _coerce_file_value(key: str, meta: dict[str, Any], raw: dict[str, Any]) -> Any | None:
    """Validate one settings-file value from JSON type metadata. Invalid → None."""
    if key not in raw:
        return None
    value = raw[key]
    typ = meta["type"]

    if typ in ("bool", "bool_enable"):
        return value if isinstance(value, bool) else None
    if typ == "bool_or_string":
        return value if isinstance(value, (bool, str)) else None
    if typ == "int":
        if meta.get("strict_digits"):
            return _parse_review_loop_max_cycles(value)
        if isinstance(value, int) and not isinstance(value, bool):
            min_val = meta.get("min", 0)
            max_val = meta.get("max", 2**53)
            return value if min_val <= value <= max_val else None
        return None
    if typ == "number":
        if _is_number(value) and math.isfinite(value):
            return value
        return None
    if typ == "port":
        min_port = meta.get("min", 0)
        if isinstance(value, int) and not isinstance(value, bool) and min_port <= value <= 65535:
            return value
        return None
    if typ == "string":
        if isinstance(value, str):
            return value.strip()
        return None
    if typ == "agent_list":
        return value if isinstance(value, (str, list)) else None
    if typ == "agent_overrides":
        return _parse_agent_overrides(value)
    if typ == "string_list":
        if isinstance(value, list):
            filtered = [e for e in value if isinstance(e, str) and e]
            rejected = len(value) - len(filtered)
            if rejected:
                logging.getLogger(__name__).debug(
                    "settings: dropped %d invalid string_list entrie(s) for %s", rejected, key
                )
            if filtered:
                return filtered
        return None
    return None


def _load_settings_file(path: Path) -> dict[str, Any]:
    """Load and validate a settings JSON file (matches TS parseSettingsFile). Missing/invalid → {}."""
    if not path.is_file():
        return {}
    try:
        raw = commentjson.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}

    result: dict[str, Any] = {}
    for key, meta in SETTINGS_KEYS.items():
        coerced = _coerce_file_value(key, meta, raw)
        if coerced is not None:
            result[key] = coerced
    return result


def _settings_file_has_key(path: Path, key: str) -> bool:
    """True if raw JSON object contains key (matches TS projectSettingsFileHasKey)."""
    if not path.is_file():
        return False
    try:
        raw = commentjson.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        return False
    return isinstance(raw, dict) and key in raw


def _parse_bool_env(name: str) -> bool | None:
    """Parse bool env: true/1/yes/on → True; any other set value → False; unset → None."""
    val = os.environ.get(name)
    if val is None or val == "":
        return None
    return val.lower() in BOOL_TRUE


def _parse_enable_env(name: str) -> bool | None:
    """Parse PI_*_ENABLE: false/0/no/off → False; any other set value → True; unset → None."""
    val = os.environ.get(name)
    if val is None or val == "":
        return None
    if val.lower() in BOOL_FALSE:
        return False
    return True


def _parse_commit_trailer_env(name: str = "PI_COMMIT_TRAILER") -> bool | str | None:
    """Parse commit_trailer env: bool strings → bool, else trailer name string."""
    val = os.environ.get(name)
    if val is None or val == "":
        return None
    lower = val.lower()
    if lower in BOOL_TRUE:
        return True
    if lower in BOOL_FALSE:
        return False
    return val


def _parse_num_env(name: str) -> float | None:
    """Parse float env; invalid/unset → None."""
    val = os.environ.get(name)
    if val is None or val == "":
        return None
    try:
        n = float(val)
    except ValueError:
        return None
    return n if math.isfinite(n) else None


def _parse_port_env(name: str, min_port: int = 0) -> int | None:
    """Parse port env min_port-65535; invalid/unset → None."""
    val = os.environ.get(name)
    if val is None or val == "":
        return None
    try:
        trimmed = val.strip()
        if not re.fullmatch(r"\d+", trimmed):
            return None
        port = int(trimmed, 10)
    except ValueError:
        return None
    return port if min_port <= port <= 65535 else None


def _parse_review_loop_max_cycles_env(name: str) -> int | None:
    """Parse PI_REVIEW_LOOP_MAX_CYCLES — digit string '1'-'10' only."""
    val = os.environ.get(name)
    if val is None or val == "":
        return None
    return _parse_review_loop_max_cycles(val)


def parse_agent_name_list(value: str | list[Any] | None) -> list[str]:
    """Parse agent name lists — comma-separated string or JSON array (matches TS)."""
    if value is None:
        return []
    if isinstance(value, list):
        parts = [a.strip().lower() if isinstance(a, str) else "" for a in value]
    else:
        parts = [a.strip().lower() for a in value.split(",")]
    filtered = [a for a in parts if AGENT_NAME_RE.match(a)]
    # Deduplicate preserving order
    seen: set[str] = set()
    result: list[str] = []
    for name in filtered:
        if name not in seen:
            seen.add(name)
            result.append(name)
    return result


def _resolve_agent_list(
    key: str,
    *,
    project_path: Path,
    project: dict[str, Any],
    global_settings: dict[str, Any],
    env_name: str,
) -> list[str]:
    """Resolve acpx_agents / cli_agents with per-key project presence check."""
    if _settings_file_has_key(project_path, key):
        project_value = project.get(key)
        if project_value is not None:
            return parse_agent_name_list(project_value)
    global_value = global_settings.get(key)
    if global_value is not None:
        return parse_agent_name_list(global_value)
    env = os.environ.get(env_name)
    if env is not None and env != "":
        return parse_agent_name_list(env)
    return []


def _resolve_env_or_default(meta: dict[str, Any]) -> SettingValue:
    """Resolve env → default for one key using JSON type metadata."""
    typ = meta["type"]
    default: SettingValue = meta["default"]
    env_name: str | None = meta.get("env")

    if typ == "bool_or_string":
        env_val = _parse_commit_trailer_env(env_name or "PI_COMMIT_TRAILER")
        return env_val if env_val is not None else default

    if typ == "bool_enable":
        if env_name is not None:
            enabled = _parse_enable_env(env_name)
            if enabled is not None:
                return enabled
        return default

    if typ == "bool":
        if env_name is not None:
            env_bool = _parse_bool_env(env_name)
            if env_bool is not None:
                return env_bool
        return default

    if typ == "int" and meta.get("strict_digits"):
        if env_name is not None:
            env_cycles = _parse_review_loop_max_cycles_env(env_name)
            if env_cycles is not None:
                return env_cycles
        return default

    if typ == "int":
        if env_name is not None:
            env_val = os.environ.get(env_name)
            if env_val is not None and env_val != "":
                if not re.fullmatch(r"-?\d+", env_val.strip()):
                    return default
                try:
                    n = int(env_val.strip(), 10)
                except (ValueError, TypeError):
                    return default
                min_val = meta.get("min", 0)
                max_val = meta.get("max", 2**53)
                if min_val <= n <= max_val:
                    return n
        return default

    if typ == "number":
        if env_name is not None:
            env_num = _parse_num_env(env_name)
            if env_num is not None:
                return env_num
        return default

    if typ == "port":
        if env_name is not None:
            env_port = _parse_port_env(env_name, meta.get("min", 0))
            if env_port is not None:
                return env_port
        return default

    if typ == "string":
        if env_name is not None:
            env = os.environ.get(env_name)
            if env is not None and env != "":
                return env.strip()
        return default

    if typ == "agent_overrides":
        return default if isinstance(default, dict) else {}

    return default


def get_setting(key: str, cwd: Path | None = None) -> SettingValue:
    """Resolve one setting: project → global → env → default."""
    if key not in SETTINGS_KEYS:
        raise ValueError(f"Unknown settings key: {key}")

    meta = SETTINGS_KEYS[key]
    typ = meta["type"]

    root = _resolve_repo_root(cwd)
    pi_dir = root / ".pi"
    project_path = _find_settings_file(pi_dir) or (pi_dir / SETTINGS_FILENAMES[0])
    project = _load_settings_file(project_path)
    global_path = _find_settings_file(Path.home() / ".pi", scope="global") or (
        Path.home() / ".pi" / SETTINGS_FILENAMES[0]
    )
    global_settings = _load_settings_file(global_path)
    merged = {**global_settings, **project}

    # Special-case: agent lists use per-key project presence (not simple merge)
    if typ == "agent_list" and meta.get("per_key_resolution"):
        env_name = meta.get("env", "")
        return _resolve_agent_list(
            key,
            project_path=project_path,
            project=project,
            global_settings=global_settings,
            env_name=env_name,
        )

    if key in merged:
        value = merged[key]
        if typ == "port":
            min_port = meta.get("min", 0)
            if isinstance(value, int) and not isinstance(value, bool) and min_port <= value <= 65535:
                return value
            # Invalid in merged — fall through to env/default
        elif typ == "agent_overrides":
            return value if isinstance(value, dict) else {}
        elif typ == "string":
            return value if isinstance(value, str) else ""
        else:
            return value

    return _resolve_env_or_default(meta)


def get_settings(
    keys: tuple[str, ...] | list[str],
    cwd: Path | None = None,
) -> dict[str, SettingValue]:
    """Resolve multiple settings keys into a dict. Empty keys → all SUPPORTED_KEYS."""
    selected = list(keys) if keys else list(SUPPORTED_KEYS)
    unknown = [k for k in selected if k not in SETTINGS_KEYS]
    if unknown:
        raise ValueError(f"Unknown settings key(s): {', '.join(unknown)}")
    return {key: get_setting(key, cwd=cwd) for key in selected}


@click.group()
def settings() -> None:
    """Resolve pi-config project/global settings."""


@settings.command("get")
@click.argument("keys", nargs=-1)
def settings_get(keys: tuple[str, ...]) -> None:
    """Get resolved setting values as compact JSON.

    Resolution order matches TypeScript getSetting:
    project .pi/pi-config-settings.json → ~/.pi/pi-config-settings.json → env → default.

    Examples:

        myk-pi-tools settings get

        myk-pi-tools settings get dco commit_trailer use_worktrees

        myk-pi-tools settings get acpx_agents cli_agents pidash_port
    """
    try:
        result = get_settings(keys)
    except ValueError as exc:
        raise click.UsageError(str(exc)) from exc
    click.echo(json.dumps(result))
