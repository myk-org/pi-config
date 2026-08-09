#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["questionary"]
# ///
"""
pi-config Installer
====================
Interactive CLI installer for pi-config and related tooling.

Usage:
    uv run scripts/install.py
    uvx scripts/install.py

Options:
    --all     Install everything non-interactively (no prompts)
    --help    Show help message
"""

from __future__ import annotations

import argparse
import glob
import os
import platform
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import questionary
from questionary import Choice

# ── Constants ──────────────────────────────────────────────────────────────

SYSTEM = platform.system()
ARCH = platform.machine()
ARCH_DL = {"x86_64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(ARCH, ARCH)
OS_LOWER = SYSTEM.lower()
HOME = Path.home()
TOTAL_STEPS = 5


GREEN = "\033[32m"
RED = "\033[31m"
DIM = "\033[90m"
BOLD = "\033[1m"
CYAN = "\033[36m"
RESET = "\033[0m"

ALL_MODE = False


# ── Data Models ────────────────────────────────────────────────────────────


@dataclass
class Tool:
    name: str
    description: str
    installed: bool
    disabled: str  # "" if enabled, "requires X" if disabled
    install_cmd: str = ""
    install_fn: Any = None  # optional callable, used instead of install_cmd
    installed_label: str = "installed"


@dataclass
class Step:
    icon: str
    title: str
    description: str
    tools: list[Tool] = field(default_factory=list)


# ── Helpers ────────────────────────────────────────────────────────────────


def _run_quiet(cmd: list[str]) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return ""


def _gitignore_path() -> str:
    path = ""
    if shutil.which("git"):
        path = _run_quiet(["git", "config", "--global", "core.excludesfile"])
    if not path:
        path = str(HOME / ".config/git/ignore")
    return path.replace("~", str(HOME))


# ── Install Command Builders ──────────────────────────────────────────────


# ── Prerequisites ──────────────────────────────────────────────────────────


def check_prereqs() -> dict[str, bool]:
    prereqs: dict[str, bool] = {}

    # Node.js >= 22
    node_path = shutil.which("node")
    if node_path:
        ver = _run_quiet(["node", "--version"]).lstrip("v")
        try:
            prereqs["node"] = int(ver.split(".")[0]) >= 22
        except ValueError:
            prereqs["node"] = False
    else:
        prereqs["node"] = False

    prereqs["git"] = shutil.which("git") is not None
    prereqs["pi"] = shutil.which("pi") is not None
    prereqs["uv"] = shutil.which("uv") is not None

    # Display results
    print()
    print("  Prerequisites:")

    hints = {
        "node": "Install: https://nodejs.org or nvm install 22",
        "git": "Install: apt install git / brew install git",
        "pi": "Install: npm install -g @earendil-works/pi-coding-agent",
        "uv": "Install: curl -LsSf https://astral.sh/uv/install.sh | sh",
    }

    for name, present in prereqs.items():
        icon = "✓" if present else "✗"
        color = GREEN if present else RED
        hint = f"  ({hints[name]})" if not present else ""
        print(f"  {color}  {icon}{RESET} {name}{hint}")

    # pi is the only hard requirement — nothing works without it
    if not prereqs["pi"]:
        print()
        print(f"  {RED}{BOLD}Cannot continue without pi.{RESET}")
        print("  Install: npm install -g @earendil-works/pi-coding-agent")
        sys.exit(1)

    # node, uv, git are soft — warn and continue with limited features
    if not all(prereqs.values()):
        print()
        answer = questionary.confirm("Some prerequisites missing. Continue with limited features?").ask()
        if answer is None or not answer:
            sys.exit(1)

    return prereqs


# ── Step Definitions ───────────────────────────────────────────────────────


def build_steps(prereqs: dict[str, bool]) -> list[Step]:
    has = prereqs

    # ── Step 1: Pi Packages ──────────────────────────────────────────────
    pi_dis = "" if has["pi"] else "requires pi"
    pi_cfg = (HOME / ".pi/agent/git/github.com/myk-org/pi-config").exists()
    pi_vtx = (HOME / ".pi/agent/git/github.com/myk-org/pi-vertex-claude").exists()

    def _is_pi_pkg_installed(name: str) -> bool:
        try:
            return name in (HOME / ".pi/agent/settings.json").read_text()
        except (FileNotFoundError, OSError, UnicodeDecodeError, ValueError):
            return False

    pi_web = _is_pi_pkg_installed("pi-web-access")

    step1 = Step(
        "📦",
        "Pi Packages",
        "Core pi extensions — orchestrator, agents, and model providers",
        [
            Tool(
                "pi-config",
                "Orchestrator + 24 agents + prompts",
                installed=pi_cfg,
                disabled=pi_dis,
                install_cmd=f"pi {'update' if pi_cfg else 'install'} git:github.com/myk-org/pi-config",
            ),
            Tool(
                "pi-vertex-claude",
                "Claude via Google Cloud Vertex AI",
                installed=pi_vtx,
                disabled=pi_dis,
                install_cmd=f"pi {'update' if pi_vtx else 'install'} git:github.com/myk-org/pi-vertex-claude",
            ),
            Tool(
                "pi-web-access",
                "Web search · fetch · librarian skills",
                installed=pi_web,
                disabled=pi_dis,
                install_cmd="pi install npm:pi-web-access",
            ),
            Tool(
                "myk-pi-tools",
                "CLI utilities for pi-config (reviews, releases, memory)",
                installed=bool(shutil.which("myk-pi-tools")),
                disabled="requires uv" if not has["uv"] else pi_dis,
                install_cmd='uv tool install myk-pi-tools --from "myk-pi-tools @ git+https://github.com/myk-org/pi-config.git"',
            ),
        ],
    )

    # ── Step 2: Python Tools ─────────────────────────────────────────────
    uv_dis = "" if has["uv"] else "requires uv"
    step2 = Step(
        "🐍",
        "Python Tools",
        "CLI utilities used by pi-config workflows",
        [
            Tool(
                "mcp-launchpad (mcpl)",
                "MCP server discovery and tool execution",
                installed=bool(shutil.which("mcpl")),
                disabled=uv_dis,
                install_cmd='uv tool install mcp-launchpad --from "mcp-launchpad @ git+https://github.com/kenneth-liao/mcp-launchpad.git"',
            ),
            Tool(
                "prek",
                "Fast Git hook manager (pre-commit alternative)",
                installed=bool(shutil.which("prek")),
                disabled=uv_dis,
                install_cmd="uv tool install prek",
            ),
        ],
    )

    # ── Step 3: npm Packages ─────────────────────────────────────────────
    nd = "" if has["node"] else "requires Node.js"
    step3 = Step(
        "📦",
        "npm Packages",
        "Node.js tools for agent capabilities",
        [
            Tool(
                "acpx",
                "Headless CLI client for Agent Client Protocol (ACP)",
                installed=bool(shutil.which("acpx")),
                disabled=nd,
                install_cmd="npm install -g acpx",
            ),
            Tool(
                "agent-browser",
                "Browser automation for web testing",
                installed=bool(shutil.which("agent-browser")),
                disabled=nd,
                install_cmd="npm install -g agent-browser",
            ),
        ],
    )

    # ── Step 4: Browser Automation ───────────────────────────────────────
    pw_inst = bool(glob.glob(str(HOME / ".cache/ms-playwright/chromium-*")))
    step4 = Step(
        "🌐",
        "Browser Automation",
        "Headless browser for agent-browser web automation",
        [
            Tool(
                "playwright + chromium",
                "Headless Chromium browser engine",
                installed=pw_inst,
                disabled=nd,
                install_cmd="npx playwright install --with-deps chromium",
            ),
        ],
    )

    # ── Step 6: Environment Setup ────────────────────────────────────────
    gd = "" if has["git"] else "requires git"
    gi = _gitignore_path()
    pi_inst = wt_inst = False
    try:
        content = Path(gi).read_text()
        # Exact line match — ".pi/memory/" should not count as ".pi/" being present
        lines = content.splitlines()
        pi_inst = ".pi/" in lines
        wt_inst = ".worktrees/" in lines
    except Exception:
        pass

    def _add_to_gitignore(entry: str) -> None:
        """Add an entry to the global gitignore using Python (no shell)."""
        gi_path = Path(gi)
        gi_path.parent.mkdir(parents=True, exist_ok=True)
        gi_path.touch(exist_ok=True)
        subprocess.run(
            ["git", "config", "--global", "core.excludesfile", str(gi_path)],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        content = gi_path.read_text()
        if entry not in content:
            with gi_path.open("a") as f:
                f.write(f"{entry}\n")

    step5 = Step(
        "⚙️",
        "Environment Setup",
        "Git configuration for pi-config",
        [
            Tool(
                ".pi/ in gitignore",
                "Prevent pi data files from being committed",
                installed=pi_inst,
                disabled=gd,
                install_fn=lambda: _add_to_gitignore(".pi/"),
                installed_label="configured",
            ),
            Tool(
                ".worktrees/ in gitignore",
                "Prevent git worktree dirs from being committed",
                installed=wt_inst,
                disabled=gd,
                install_fn=lambda: _add_to_gitignore(".worktrees/"),
                installed_label="configured",
            ),
        ],
    )

    return [step1, step2, step3, step4, step5]


# ── Step UI ────────────────────────────────────────────────────────────────


def print_step_header(num: int, icon: str, title: str, description: str) -> None:
    os.system("clear" if os.name != "nt" else "cls")
    print()
    print("  ╭─────────────────────────────────────────╮")
    print(f"  │  Step {num} of {TOTAL_STEPS} — {icon} {title:<25s}  │")
    print("  ╰─────────────────────────────────────────╯")
    print(f"  {description}")
    print()


def run_step(step_idx: int, step: Step) -> list[Tool]:
    """Run one interactive step, return list of selected tools to install."""
    print_step_header(step_idx + 1, step.icon, step.title, step.description)

    choices: list[Choice] = []
    for tool in step.tools:
        label = f"{tool.name} — {tool.description}"

        if tool.disabled:
            choices.append(Choice(label, checked=False, disabled=tool.disabled))
        elif tool.installed:
            choices.append(Choice(label, checked=True, disabled=tool.installed_label))
        else:
            choices.append(Choice(label, checked=True))

    # If all choices are disabled (all installed/disabled), skip the prompt
    has_selectable = any(not tool.installed and not tool.disabled for tool in step.tools)
    if not has_selectable:
        # Just show status, no prompt needed
        for tool in step.tools:
            if tool.installed:
                print(f"  {GREEN}✓{RESET} {tool.name} — {tool.description} {DIM}({tool.installed_label}){RESET}")
            elif tool.disabled:
                print(f"  {DIM}⊘ {tool.name} — {tool.description} ({tool.disabled}){RESET}")
        print()
        return []

    result = questionary.checkbox(
        "Select tools:",
        choices=choices,
        style=questionary.Style([
            ("highlighted", "noinherit"),
            ("selected", "noinherit"),
            ("pointer", "noinherit bold"),
            ("answer", "noinherit"),
        ]),
    ).ask()

    if result is None:
        # Ctrl+C or Escape
        print()
        print(f"  {DIM}Cancelled.{RESET}")
        sys.exit(1)

    # Map selected labels back to Tool objects (skip already installed/disabled)
    selected: list[Tool] = []
    for tool in step.tools:
        if tool.installed or tool.disabled:
            continue
        label = f"{tool.name} — {tool.description}"

        if label in result:
            selected.append(tool)

    return selected


def auto_select_all(steps: list[Step]) -> list[Tool]:
    """Auto-select everything not installed and not disabled."""
    selected: list[Tool] = []
    for step in steps:
        for tool in step.tools:
            if not tool.disabled and not tool.installed:
                selected.append(tool)
    return selected


# ── Plan ───────────────────────────────────────────────────────────────────


def show_plan(selections: list[Tool]) -> None:
    print()
    print("  ╭─────────────────────────────────────────╮")
    print("  │         Installation Plan                │")
    print("  ╰─────────────────────────────────────────╯")
    print()
    for tool in selections:
        print(f"    • {tool.name} — {tool.description}")
    print()
    print(f"  Total: {len(selections)} tool(s)")
    print()


# ── Installation ───────────────────────────────────────────────────────────


def install_all(selections: list[Tool]) -> tuple[int, int, list[Tool]]:
    print()
    print("  Installing...")
    print()

    installed = 0
    failed = 0
    failed_tools: list[Tool] = []

    for tool in selections:
        print(f"  ⏳ {tool.name}...", end="", flush=True)
        try:
            if tool.install_fn:
                tool.install_fn()
                print(f"\r\033[2K  {GREEN}✓{RESET} {tool.name}")
                installed += 1
                continue
            result = subprocess.run(
                tool.install_cmd,
                shell=True,
                capture_output=True,
                text=True,
                timeout=300,
            )
            if result.returncode == 0:
                print(f"\r\033[2K  {GREEN}✓{RESET} {tool.name}")
                installed += 1
            else:
                print(f"\r\033[2K  {RED}✗{RESET} {tool.name} — failed")
                if result.stderr:
                    for line in result.stderr.strip().splitlines()[-2:]:
                        print(f"    {DIM}{line}{RESET}")
                failed += 1
                failed_tools.append(tool)
        except subprocess.TimeoutExpired:
            print(f"\r\033[2K  {RED}✗{RESET} {tool.name} — timed out (5m)")
            failed += 1
            failed_tools.append(tool)
        except Exception as exc:
            print(f"\r\033[2K  {RED}✗{RESET} {tool.name} — {exc}")
            failed += 1
            failed_tools.append(tool)

    return installed, failed, failed_tools


# ── Update ─────────────────────────────────────────────────────────────────


def update_pi(prereqs: dict[str, bool]) -> None:
    """Run pi update to update pi itself and all installed packages."""
    if not prereqs.get("pi"):
        return

    print()
    print("  ⏳ Updating pi and packages...", end="", flush=True)
    try:
        result = subprocess.run(
            "pi update",
            shell=True,
            capture_output=True,
            text=True,
            timeout=300,
        )
        if result.returncode == 0:
            print(f"\r\033[2K  {GREEN}✓{RESET} pi and packages updated")
        else:
            print(f"\r\033[2K  {RED}✗{RESET} pi update failed")
            if result.stderr:
                for line in result.stderr.strip().splitlines()[-2:]:
                    print(f"    {DIM}{line}{RESET}")
    except subprocess.TimeoutExpired:
        print(f"\r\033[2K  {RED}✗{RESET} pi update timed out (5m)")
    except Exception as exc:
        print(f"\r\033[2K  {RED}✗{RESET} pi update — {exc}")


# ── Summary ────────────────────────────────────────────────────────────────


def show_summary(installed: int, failed: int, skipped: int, failed_tools: list[Tool] | None = None) -> None:
    print()
    print("  ╭─────────────────────────────────────────╮")
    print("  │           Install Complete               │")
    print("  ╰─────────────────────────────────────────╯")
    print()
    print(f"  {GREEN}✓{RESET} Installed: {installed}")
    print(f"  {DIM}—{RESET} Skipped:   {skipped}")
    if failed:
        print(f"  {RED}✗{RESET} Failed:    {failed}")
    if failed_tools:
        print()
        print(f"  {BOLD}To install failed tools manually:{RESET}")
        for tool in failed_tools:
            print(f"    {DIM}${RESET} {tool.install_cmd}")
    print()
    print("  Run 'pi' to start a session!")
    print()


# ── Main ───────────────────────────────────────────────────────────────────


def main() -> None:
    global ALL_MODE

    parser = argparse.ArgumentParser(
        description="pi-config Installer — interactive CLI for pi-config and related tooling",
    )
    parser.add_argument("--all", action="store_true", help="Install everything non-interactively (no prompts)")
    args = parser.parse_args()
    ALL_MODE = args.all

    print()
    print(f"  {BOLD}{CYAN}pi-config Installer{RESET}")
    print(f"  {DIM}{'─' * 37}{RESET}")

    # Prerequisites
    if ALL_MODE:
        prereqs = check_prereqs_quiet()
    else:
        prereqs = check_prereqs()

    # Build steps
    steps = build_steps(prereqs)

    # Collect selections
    selections: list[Tool] = []
    if ALL_MODE:
        selections = auto_select_all(steps)
        print()
        print(f"  {DIM}--all mode: auto-selecting {len(selections)} tool(s){RESET}")
    else:
        for i, step in enumerate(steps):
            selected = run_step(i, step)
            selections.extend(selected)

    if not selections:
        print()
        print("  Nothing to install.")
        # Still update pi and existing packages
        update_pi(prereqs)
        print()
        return

    # Show plan
    show_plan(selections)

    # Confirm
    if not ALL_MODE:
        answer = questionary.confirm("Proceed with installation?").ask()
        if answer is None or not answer:
            print()
            print(f"  {DIM}Cancelled.{RESET}")
            sys.exit(1)

    # Install
    total_tools = sum(len(step.tools) for step in steps)
    installed, failed, failed_tools = install_all(selections)

    # Update pi and all packages
    update_pi(prereqs)

    # Adjust skipped to account for failures
    skipped = total_tools - installed - failed

    # Summary
    show_summary(installed, failed, skipped, failed_tools)


def check_prereqs_quiet() -> dict[str, bool]:
    """Check prerequisites without interactive prompts (for --all mode)."""
    prereqs: dict[str, bool] = {}

    node_path = shutil.which("node")
    if node_path:
        ver = _run_quiet(["node", "--version"]).lstrip("v")
        try:
            prereqs["node"] = int(ver.split(".")[0]) >= 22
        except ValueError:
            prereqs["node"] = False
    else:
        prereqs["node"] = False

    prereqs["git"] = shutil.which("git") is not None
    prereqs["pi"] = shutil.which("pi") is not None
    prereqs["uv"] = shutil.which("uv") is not None

    hints = {
        "node": "Install: https://nodejs.org or nvm install 22",
        "git": "Install: apt install git / brew install git",
        "pi": "Install: npm install -g @earendil-works/pi-coding-agent",
        "uv": "Install: curl -LsSf https://astral.sh/uv/install.sh | sh",
    }

    print()
    print("  Prerequisites:")
    for name, present in prereqs.items():
        icon = "✓" if present else "✗"
        color = GREEN if present else RED
        hint = f"  ({hints[name]})" if not present else ""
        print(f"  {color}  {icon}{RESET} {name}{hint}")

    if not all(prereqs.values()):
        print()
        print(f"  {DIM}⚠  Some prerequisites missing. Dependent tools will be skipped.{RESET}")

    return prereqs


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n  Aborted.")
        sys.exit(130)
