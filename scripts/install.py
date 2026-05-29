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

import questionary
from questionary import Choice

# ── Constants ──────────────────────────────────────────────────────────────

SYSTEM = platform.system()
ARCH = platform.machine()
ARCH_DL = {"x86_64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(ARCH, ARCH)
OS_LOWER = SYSTEM.lower()
HOME = Path.home()
TOTAL_STEPS = 7
IS_LINUX_USER = SYSTEM == "Linux" and os.geteuid() != 0

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
    install_cmd: str
    needs_sudo: bool = False
    has_update: bool = False


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


def _gh_install_cmd() -> str:
    if SYSTEM == "Darwin":
        return "brew install gh"
    if shutil.which("apt-get"):
        return (
            "sudo mkdir -p -m 755 /etc/apt/keyrings && "
            "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg "
            "| sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null && "
            "sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && "
            'echo "deb [arch=$(dpkg --print-architecture) '
            "signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] "
            'https://cli.github.com/packages stable main" '
            "| sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null && "
            "sudo apt-get update -qq && sudo apt-get install -y -qq gh"
        )
    return (
        "gh_ver=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest "
        """| grep -o '"tag_name":"v[^"]*"' | head -1 | cut -d'"' -f4 | sed 's/^v//') && """
        f'tmpdir=$(mktemp -d) && curl -fsSL -o "$tmpdir/gh.rpm" '
        f'"https://github.com/cli/cli/releases/download/v${{gh_ver}}/gh_${{gh_ver}}_linux_{ARCH_DL}.rpm" && '
        'sudo rpm -ivh "$tmpdir/gh.rpm" && rm -rf "$tmpdir"'
    )


def _glab_install_cmd() -> str:
    if SYSTEM == "Darwin":
        return "brew install glab"
    api = (
        "glab_ver=$(curl -fsSL 'https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases' "
        """| grep -o '"tag_name":"v[^"]*"' | head -1 | cut -d'"' -f4 | sed 's/^v//') && """
    )
    if shutil.which("dpkg"):
        return (
            api + 'tmpdir=$(mktemp -d) && curl -fsSL -o "$tmpdir/glab.deb" '
            f'"https://gitlab.com/gitlab-org/cli/-/releases/v${{glab_ver}}/downloads/'
            f'glab_${{glab_ver}}_linux_{ARCH_DL}.deb" && '
            'sudo dpkg -i "$tmpdir/glab.deb" && rm -rf "$tmpdir"'
        )
    return (
        api + 'tmpdir=$(mktemp -d) && curl -fsSL -o "$tmpdir/glab.rpm" '
        f'"https://gitlab.com/gitlab-org/cli/-/releases/v${{glab_ver}}/downloads/'
        f'glab_${{glab_ver}}_linux_{ARCH_DL}.rpm" && '
        '(sudo dnf install -y "$tmpdir/glab.rpm" || sudo rpm -ivh "$tmpdir/glab.rpm") && '
        'rm -rf "$tmpdir"'
    )


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

    if not all(prereqs.values()):
        print()
        answer = questionary.confirm("Some prerequisites missing. Continue with limited features?").ask()
        if answer is None or not answer:
            sys.exit(1)

    return prereqs


# ── Step Definitions ───────────────────────────────────────────────────────


def build_steps(prereqs: dict[str, bool]) -> list[Step]:
    has = prereqs
    sudo = "sudo " if IS_LINUX_USER else ""

    # ── Step 1: Pi Packages ──────────────────────────────────────────────
    pi_dis = "" if has["pi"] else "requires pi"
    pi_cfg = (HOME / ".pi/agent/git/github.com/myk-org/pi-config").exists()
    pi_vtx = (HOME / ".pi/agent/git/github.com/myk-org/pi-vertex-claude").exists()
    pi_web = False
    try:
        pi_web = "pi-web-access" in (HOME / ".pi/agent/settings.json").read_text()
    except Exception:
        pass

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
                has_update=True,
            ),
            Tool(
                "pi-vertex-claude",
                "Claude via Google Cloud Vertex AI",
                installed=pi_vtx,
                disabled=pi_dis,
                install_cmd=f"pi {'update' if pi_vtx else 'install'} git:github.com/myk-org/pi-vertex-claude",
                has_update=True,
            ),
            Tool(
                "pi-web-access",
                "Web search · fetch · librarian skills",
                installed=pi_web,
                disabled=pi_dis,
                install_cmd="pi install npm:pi-web-access",
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
                "myk-pi-tools",
                "PR reviews · releases · memory management",
                installed=bool(shutil.which("myk-pi-tools")),
                disabled=uv_dis,
                install_cmd='uv tool install myk-pi-tools --from "myk-pi-tools @ git+https://github.com/myk-org/pi-config.git"',
            ),
            Tool(
                "mcp-launchpad (mcpl)",
                "MCP server discovery and tool execution",
                installed=bool(shutil.which("mcpl")),
                disabled=uv_dis,
                install_cmd='uv tool install mcp-launchpad --from "mcp-launchpad @ git+https://github.com/kenneth-liao/mcp-launchpad.git"',
            ),
            Tool(
                "prek",
                "Kubernetes/OpenShift resource explorer",
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
                "External AI agent proxy (Cursor/Codex/Copilot)",
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

    # ── Step 4: CLI Tools ────────────────────────────────────────────────
    step4 = Step(
        "🔧",
        "CLI Tools",
        "Developer CLIs used by specialist agents",
        [
            Tool(
                "gh",
                "GitHub CLI — PRs · issues · releases",
                installed=bool(shutil.which("gh")),
                disabled="",
                install_cmd=_gh_install_cmd(),
                needs_sudo=IS_LINUX_USER,
            ),
            Tool(
                "glab",
                "GitLab CLI — MRs and pipelines",
                installed=bool(shutil.which("glab")),
                disabled="",
                install_cmd=_glab_install_cmd(),
                needs_sudo=IS_LINUX_USER,
            ),
            Tool(
                "bun",
                "JavaScript runtime — coms-net server",
                installed=bool(shutil.which("bun")),
                disabled="",
                install_cmd="curl -fsSL https://bun.sh/install | bash",
            ),
            Tool(
                "coderabbit",
                "Local AI code reviews",
                installed=bool(shutil.which("cr")),
                disabled="",
                install_cmd='CI=true bash -c "$(curl -fsSL https://cli.coderabbit.ai/install.sh)"',
            ),
        ],
    )

    # ── Step 5: Browser Automation ───────────────────────────────────────
    pw_inst = bool(glob.glob(str(HOME / ".cache/ms-playwright/chromium-*")))
    step5 = Step(
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

    # ── Step 6: Infrastructure ───────────────────────────────────────────
    oc_arch = "aarch64" if ARCH in ("arm64", "aarch64") else ARCH
    oc_os = "mac" if SYSTEM == "Darwin" else "linux"
    oc_suf = "-arm64" if ARCH in ("aarch64", "arm64") else ""

    step6 = Step(
        "🏗️",
        "Infrastructure",
        "Optional tools for infrastructure specialist agents",
        [
            Tool(
                "kubectl",
                "Kubernetes CLI — kubernetes-expert agent",
                installed=bool(shutil.which("kubectl")),
                disabled="",
                install_cmd=(
                    f"kube_ver=$(curl -fsSL https://dl.k8s.io/release/stable.txt) && "
                    f'tmpdir=$(mktemp -d) && curl -fsSL -o "$tmpdir/kubectl" '
                    f'"https://dl.k8s.io/release/${{kube_ver}}/bin/{OS_LOWER}/{ARCH_DL}/kubectl" && '
                    f'chmod +x "$tmpdir/kubectl" && '
                    f'{sudo}install -m 0755 "$tmpdir/kubectl" /usr/local/bin/kubectl && '
                    f'rm -rf "$tmpdir"'
                ),
                needs_sudo=IS_LINUX_USER,
            ),
            Tool(
                "oc",
                "OpenShift CLI — kubernetes-expert agent",
                installed=bool(shutil.which("oc")),
                disabled="",
                install_cmd=(
                    f"tmpdir=$(mktemp -d) && "
                    f'curl -fsSL "https://mirror.openshift.com/pub/openshift-v4/{oc_arch}/clients/ocp/'
                    f'stable/openshift-client-{oc_os}{oc_suf}.tar.gz" | tar xz -C "$tmpdir" oc && '
                    f'{sudo}install -m 0755 "$tmpdir/oc" /usr/local/bin/oc && rm -rf "$tmpdir"'
                ),
                needs_sudo=IS_LINUX_USER,
            ),
            Tool(
                "Go",
                "Go compiler — go-expert agent",
                installed=bool(shutil.which("go")),
                disabled="",
                install_cmd=(
                    f'go_ver=$(curl -fsSL "https://go.dev/VERSION?m=text" | head -1) && '
                    f"{sudo}rm -rf /usr/local/go && "
                    f'curl -fsSL "https://go.dev/dl/${{go_ver}}.{OS_LOWER}-{ARCH_DL}.tar.gz" '
                    f"| {sudo}tar xz -C /usr/local"
                ),
                needs_sudo=IS_LINUX_USER,
            ),
        ],
    )

    # ── Step 7: Environment Setup ────────────────────────────────────────
    gd = "" if has["git"] else "requires git"
    gi = _gitignore_path()
    gi_dir = str(Path(gi).parent)
    mem_inst = wt_inst = False
    try:
        content = Path(gi).read_text()
        mem_inst = ".pi/memory/" in content
        wt_inst = ".worktrees/" in content
    except Exception:
        pass

    mk_gi = f'mkdir -p "{gi_dir}" && touch "{gi}" && git config --global core.excludesfile "{gi}"'
    step7 = Step(
        "⚙️",
        "Environment Setup",
        "Git configuration for pi-config",
        [
            Tool(
                ".pi/memory/ in gitignore",
                "Prevent memory files from being committed",
                installed=mem_inst,
                disabled=gd,
                install_cmd=f'{mk_gi} && echo ".pi/memory/" >> "{gi}"',
            ),
            Tool(
                ".worktrees/ in gitignore",
                "Prevent git worktree dirs from being committed",
                installed=wt_inst,
                disabled=gd,
                install_cmd=f'{mk_gi} && echo ".worktrees/" >> "{gi}"',
            ),
        ],
    )

    return [step1, step2, step3, step4, step5, step6, step7]


# ── Step UI ────────────────────────────────────────────────────────────────


def print_step_header(num: int, icon: str, title: str, description: str) -> None:
    print()
    print("  ╭─────────────────────────────────────────╮")
    print(f"  │  Step {num} of {TOTAL_STEPS} — {icon} {title:<25}  │")
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
        elif tool.installed and not tool.has_update:
            choices.append(Choice(label, checked=True, disabled="installed"))
        else:
            if tool.installed and tool.has_update:
                label += " (update available)"
            choices.append(Choice(label, checked=True))

    result = questionary.checkbox(
        "Select tools:",
        choices=choices,
    ).ask()

    if result is None:
        # Ctrl+C or Escape
        print()
        print(f"  {DIM}Cancelled.{RESET}")
        sys.exit(1)

    # Map selected labels back to Tool objects
    selected: list[Tool] = []
    for tool in step.tools:
        label = f"{tool.name} — {tool.description}"
        if tool.installed and tool.has_update:
            label += " (update available)"

        if label in result:
            selected.append(tool)

    return selected


def auto_select_all(steps: list[Step]) -> list[Tool]:
    """Auto-select everything not installed and not disabled."""
    selected: list[Tool] = []
    for step in steps:
        for tool in step.tools:
            if not tool.disabled and (not tool.installed or tool.has_update):
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


def install_all(selections: list[Tool]) -> tuple[int, int]:
    print()
    print("  Installing...")
    print()

    installed = 0
    failed = 0

    for tool in selections:
        print(f"  ⏳ {tool.name}...", end="", flush=True)
        try:
            result = subprocess.run(
                tool.install_cmd,
                shell=True,
                capture_output=True,
                text=True,
                timeout=300,
            )
            if result.returncode == 0:
                print(f"\r  {GREEN}✓{RESET} {tool.name}")
                installed += 1
            else:
                print(f"\r  {RED}✗{RESET} {tool.name} — failed")
                if result.stderr:
                    for line in result.stderr.strip().splitlines()[-2:]:
                        print(f"    {DIM}{line}{RESET}")
                failed += 1
        except subprocess.TimeoutExpired:
            print(f"\r  {RED}✗{RESET} {tool.name} — timed out (5m)")
            failed += 1
        except Exception as exc:
            print(f"\r  {RED}✗{RESET} {tool.name} — {exc}")
            failed += 1

    return installed, failed


# ── Summary ────────────────────────────────────────────────────────────────


def show_summary(installed: int, failed: int, skipped: int) -> None:
    print()
    print("  ╭─────────────────────────────────────────╮")
    print("  │           Install Complete               │")
    print("  ╰─────────────────────────────────────────╯")
    print()
    print(f"  {GREEN}✓{RESET} Installed: {installed}")
    print(f"  {DIM}—{RESET} Skipped:   {skipped}")
    if failed:
        print(f"  {RED}✗{RESET} Failed:    {failed}")
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

    # Count skipped (installed+disabled that weren't selected)
    total_tools = sum(len(step.tools) for step in steps)
    skipped = total_tools - len(selections)

    # Install
    installed, failed = install_all(selections)

    # Adjust skipped to account for failures
    skipped = total_tools - installed - failed

    # Summary
    show_summary(installed, failed, skipped)


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
    main()
