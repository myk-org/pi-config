#!/usr/bin/env python3
"""
pi-config TUI Installer
========================
Interactive wizard for installing pi-config and related tooling.

Usage:
    uvx --with textual python scripts/install.py
    uv run --with textual scripts/install.py

Options:
    --all     Install everything non-interactively (no TUI)
    --help    Show help message
"""

from __future__ import annotations

import argparse
import glob
import os
import platform
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import Screen
from textual.widgets import Button, Checkbox, Footer, Header, ProgressBar, RichLog, Rule, Static

# ── Platform ───────────────────────────────────────────────────────────────

SYSTEM = platform.system()
ARCH = platform.machine()
ARCH_DL = {"x86_64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(ARCH, ARCH)
OS_LOWER = SYSTEM.lower()
HOME = Path.home()
TOTAL_STEPS = 7
IS_LINUX_USER = SYSTEM == "Linux" and os.geteuid() != 0


# ── Data Models ────────────────────────────────────────────────────────────


@dataclass
class Tool:
    name: str
    description: str
    install_cmd: str
    installed: bool = False
    disabled: bool = False
    disabled_reason: str = ""
    has_update: bool = False
    needs_sudo: bool = False
    selected: bool = True


@dataclass
class StepDef:
    number: int
    icon: str
    title: str
    description: str
    tools: list[Tool] = field(default_factory=list)


@dataclass
class Prereq:
    name: str
    present: bool
    install_hint: str
    version: str = ""


# ── Prerequisite Checks ───────────────────────────────────────────────────


def _run_quiet(cmd: list[str]) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return ""


def check_prereqs() -> dict[str, Prereq]:
    prereqs: dict[str, Prereq] = {}

    # Node.js ≥22
    if shutil.which("node"):
        ver = _run_quiet(["node", "--version"]).lstrip("v")
        try:
            if int(ver.split(".")[0]) >= 22:
                prereqs["node"] = Prereq("Node.js ≥22", True, "", f"v{ver}")
            else:
                prereqs["node"] = Prereq("Node.js ≥22", False, f"Current: v{ver}. Upgrade: nvm install 22", f"v{ver}")
        except ValueError:
            prereqs["node"] = Prereq("Node.js ≥22", False, "nvm install 22")
    else:
        prereqs["node"] = Prereq("Node.js ≥22", False, "nvm install 22  or  https://nodejs.org/")

    # git
    if shutil.which("git"):
        prereqs["git"] = Prereq("git", True, "", _run_quiet(["git", "--version"]))
    else:
        prereqs["git"] = Prereq("git", False, "apt install git  /  brew install git")

    # pi
    prereqs["pi"] = (
        Prereq("pi", True, "")
        if shutil.which("pi")
        else Prereq("pi", False, "npm install -g @earendil-works/pi-coding-agent")
    )

    # uv
    prereqs["uv"] = (
        Prereq("uv", True, "")
        if shutil.which("uv")
        else Prereq("uv", False, "curl -LsSf https://astral.sh/uv/install.sh | sh")
    )

    return prereqs


# ── Install Command Helpers ───────────────────────────────────────────────


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


def _gitignore_path() -> str:
    path = ""
    if shutil.which("git"):
        path = _run_quiet(["git", "config", "--global", "core.excludesfile"])
    if not path:
        path = str(HOME / ".config/git/ignore")
    return path.replace("~", str(HOME))


# ── Step Definitions ──────────────────────────────────────────────────────


def build_steps(prereqs: dict[str, Prereq]) -> list[StepDef]:
    has = {k: v.present for k, v in prereqs.items()}
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

    step1 = StepDef(
        1,
        "📦",
        "Pi Packages",
        "Core pi extensions — orchestrator, agents, and model providers",
        [
            Tool(
                "pi-config",
                "Orchestrator + 24 agents + prompts",
                f"pi {'update' if pi_cfg else 'install'} git:github.com/myk-org/pi-config",
                installed=pi_cfg,
                disabled=bool(pi_dis),
                disabled_reason=pi_dis,
                has_update=True,
            ),
            Tool(
                "pi-vertex-claude",
                "Claude via Google Cloud Vertex AI",
                f"pi {'update' if pi_vtx else 'install'} git:github.com/myk-org/pi-vertex-claude",
                installed=pi_vtx,
                disabled=bool(pi_dis),
                disabled_reason=pi_dis,
                has_update=True,
            ),
            Tool(
                "pi-web-access",
                "Web search · fetch · librarian skills",
                "pi install npm:pi-web-access",
                installed=pi_web,
                disabled=bool(pi_dis),
                disabled_reason=pi_dis,
            ),
        ],
    )

    # ── Step 2: Python Tools ─────────────────────────────────────────────
    uv_dis = "" if has["uv"] else "requires uv"
    step2 = StepDef(
        2,
        "🐍",
        "Python Tools",
        "CLI utilities used by pi-config workflows",
        [
            Tool(
                "myk-pi-tools",
                "PR reviews · releases · memory management",
                'uv tool install myk-pi-tools --from "myk-pi-tools @ git+https://github.com/myk-org/pi-config.git"',
                installed=bool(shutil.which("myk-pi-tools")),
                disabled=bool(uv_dis),
                disabled_reason=uv_dis,
            ),
            Tool(
                "mcp-launchpad (mcpl)",
                "MCP server discovery and tool execution",
                "uv tool install mcp-launchpad --from "
                '"mcp-launchpad @ git+https://github.com/kenneth-liao/mcp-launchpad.git"',
                installed=bool(shutil.which("mcpl")),
                disabled=bool(uv_dis),
                disabled_reason=uv_dis,
            ),
            Tool(
                "prek",
                "Kubernetes/OpenShift resource explorer",
                "uv tool install prek",
                installed=bool(shutil.which("prek")),
                disabled=bool(uv_dis),
                disabled_reason=uv_dis,
            ),
        ],
    )

    # ── Step 3: npm Packages ─────────────────────────────────────────────
    nd = "" if has["node"] else "requires Node.js"
    step3 = StepDef(
        3,
        "📦",
        "npm Packages",
        "Node.js tools for agent capabilities",
        [
            Tool(
                "acpx",
                "External AI agent proxy (Cursor/Codex/Copilot)",
                "npm install -g acpx",
                installed=bool(shutil.which("acpx")),
                disabled=bool(nd),
                disabled_reason=nd,
            ),
            Tool(
                "agent-browser",
                "Browser automation for web testing",
                "npm install -g agent-browser",
                installed=bool(shutil.which("agent-browser")),
                disabled=bool(nd),
                disabled_reason=nd,
            ),
        ],
    )

    # ── Step 4: CLI Tools ────────────────────────────────────────────────
    step4 = StepDef(
        4,
        "🔧",
        "CLI Tools",
        "Developer CLIs used by specialist agents",
        [
            Tool(
                "gh",
                "GitHub CLI — PRs · issues · releases",
                _gh_install_cmd(),
                installed=bool(shutil.which("gh")),
                needs_sudo=IS_LINUX_USER,
            ),
            Tool(
                "glab",
                "GitLab CLI — MRs and pipelines",
                _glab_install_cmd(),
                installed=bool(shutil.which("glab")),
                needs_sudo=IS_LINUX_USER,
            ),
            Tool(
                "bun",
                "JavaScript runtime — coms-net server",
                "curl -fsSL https://bun.sh/install | bash",
                installed=bool(shutil.which("bun")),
            ),
            Tool(
                "coderabbit",
                "Local AI code reviews",
                'CI=true bash -c "$(curl -fsSL https://cli.coderabbit.ai/install.sh)"',
                installed=bool(shutil.which("cr")),
            ),
        ],
    )

    # ── Step 5: Browser Automation ───────────────────────────────────────
    pw_inst = bool(glob.glob(str(HOME / ".cache/ms-playwright/chromium-*")))
    step5 = StepDef(
        5,
        "🌐",
        "Browser Automation",
        "Headless browser for agent-browser web automation",
        [
            Tool(
                "playwright + chromium",
                "Headless Chromium browser engine",
                "npx playwright install --with-deps chromium",
                installed=pw_inst,
                disabled=bool(nd),
                disabled_reason=nd,
            ),
        ],
    )

    # ── Step 6: Infrastructure ───────────────────────────────────────────
    oc_arch = "aarch64" if ARCH in ("arm64", "aarch64") else ARCH
    oc_os = "mac" if SYSTEM == "Darwin" else "linux"
    oc_suf = "-arm64" if ARCH in ("aarch64", "arm64") else ""

    step6 = StepDef(
        6,
        "🏗️",
        "Infrastructure",
        "Optional tools for infrastructure specialist agents",
        [
            Tool(
                "kubectl",
                "Kubernetes CLI — kubernetes-expert agent",
                f"kube_ver=$(curl -fsSL https://dl.k8s.io/release/stable.txt) && "
                f'tmpdir=$(mktemp -d) && curl -fsSL -o "$tmpdir/kubectl" '
                f'"https://dl.k8s.io/release/${{kube_ver}}/bin/{OS_LOWER}/{ARCH_DL}/kubectl" && '
                f'chmod +x "$tmpdir/kubectl" && '
                f'{sudo}install -m 0755 "$tmpdir/kubectl" /usr/local/bin/kubectl && '
                f'rm -rf "$tmpdir"',
                installed=bool(shutil.which("kubectl")),
                needs_sudo=IS_LINUX_USER,
            ),
            Tool(
                "oc",
                "OpenShift CLI — kubernetes-expert agent",
                f"tmpdir=$(mktemp -d) && "
                f'curl -fsSL "https://mirror.openshift.com/pub/openshift-v4/{oc_arch}/clients/ocp/'
                f'stable/openshift-client-{oc_os}{oc_suf}.tar.gz" | tar xz -C "$tmpdir" oc && '
                f'{sudo}install -m 0755 "$tmpdir/oc" /usr/local/bin/oc && rm -rf "$tmpdir"',
                installed=bool(shutil.which("oc")),
                needs_sudo=IS_LINUX_USER,
            ),
            Tool(
                "Go",
                "Go compiler — go-expert agent",
                f'go_ver=$(curl -fsSL "https://go.dev/VERSION?m=text" | head -1) && '
                f"{sudo}rm -rf /usr/local/go && "
                f'curl -fsSL "https://go.dev/dl/${{go_ver}}.{OS_LOWER}-{ARCH_DL}.tar.gz" '
                f"| {sudo}tar xz -C /usr/local",
                installed=bool(shutil.which("go")),
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
    step7 = StepDef(
        7,
        "⚙️",
        "Environment Setup",
        "Git configuration for pi-config",
        [
            Tool(
                ".pi/memory/ in gitignore",
                "Prevent memory files from being committed",
                f'{mk_gi} && echo ".pi/memory/" >> "{gi}"',
                installed=mem_inst,
                disabled=bool(gd),
                disabled_reason=gd,
            ),
            Tool(
                ".worktrees/ in gitignore",
                "Prevent git worktree dirs from being committed",
                f'{mk_gi} && echo ".worktrees/" >> "{gi}"',
                installed=wt_inst,
                disabled=bool(gd),
                disabled_reason=gd,
            ),
        ],
    )

    return [step1, step2, step3, step4, step5, step6, step7]


# ── TUI Screens ───────────────────────────────────────────────────────────


class PrereqScreen(Screen):
    """Prerequisites check screen."""

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with VerticalScroll(id="content"):
            yield Static("[bold cyan]🔍 Prerequisites Check[/]")
            yield Static("")
            prereqs: dict[str, Prereq] = self.app.prereqs
            for p in prereqs.values():
                if p.present:
                    ver = f"  [dim]({p.version})[/]" if p.version else ""
                    yield Static(f"  [green]✓[/] {p.name}{ver}")
                else:
                    yield Static(f"  [red]✗[/] {p.name}")
                    yield Static(f"    [dim]Install: {p.install_hint}[/]")
            yield Static("")
            yield Rule()
            yield Static("")
            all_ok = all(p.present for p in prereqs.values())
            with Horizontal(classes="buttons"):
                if all_ok:
                    yield Button("Continue", variant="primary", id="btn-continue")
                else:
                    yield Button("Continue with limited features", variant="warning", id="btn-continue")
                yield Button("Quit", variant="error", id="btn-quit")
        yield Footer()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-quit":
            self.app.exit()
        elif event.button.id == "btn-continue":
            self.app.switch_screen(StepScreen(0))


class StepScreen(Screen):
    """Wizard step screen with checkboxes for tool selection."""

    def __init__(self, step_idx: int) -> None:
        super().__init__()
        self.step_idx = step_idx

    @property
    def step(self) -> StepDef:
        return self.app.steps[self.step_idx]

    def compose(self) -> ComposeResult:
        step = self.step
        yield Header(show_clock=False)
        with VerticalScroll(id="content"):
            yield Static(f"[bold cyan]Step {step.number} of {TOTAL_STEPS} — {step.icon} {step.title}[/]")
            yield Static(f"[dim]{step.description}[/]")
            yield Static("")
            for i, tool in enumerate(step.tools):
                if tool.disabled:
                    yield Checkbox(
                        f"{tool.name} — {tool.description}  ({tool.disabled_reason})",
                        value=False,
                        disabled=True,
                        id=f"tool-{i}",
                    )
                elif tool.installed and not tool.has_update:
                    yield Checkbox(
                        f"{tool.name} — {tool.description}  ✓ installed",
                        value=True,
                        disabled=True,
                        id=f"tool-{i}",
                    )
                else:
                    label = f"{tool.name} — {tool.description}"
                    if tool.installed and tool.has_update:
                        label += "  (update available)"
                    yield Checkbox(label, value=tool.selected, id=f"tool-{i}")
            yield Static("")
            yield Rule()
            yield Static("")
            with Horizontal(classes="buttons"):
                yield Button("Next", variant="primary", id="btn-next")
                yield Button("Skip", variant="default", id="btn-skip")
                yield Button("Quit", variant="error", id="btn-quit")
        yield Footer()

    def on_checkbox_changed(self, event: Checkbox.Changed) -> None:
        if event.checkbox.id and event.checkbox.id.startswith("tool-"):
            idx = int(event.checkbox.id.split("-")[1])
            self.step.tools[idx].selected = event.value

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-quit":
            self.app.exit()
        elif event.button.id == "btn-skip":
            for tool in self.step.tools:
                tool.selected = False
            self._advance()
        elif event.button.id == "btn-next":
            self._advance()

    def _advance(self) -> None:
        next_idx = self.step_idx + 1
        if next_idx >= TOTAL_STEPS:
            self.app.switch_screen(PlanScreen())
        else:
            self.app.switch_screen(StepScreen(next_idx))


class PlanScreen(Screen):
    """Summary screen showing what will be installed."""

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        selected = self.app.get_selected_tools()
        with VerticalScroll(id="content"):
            yield Static("[bold cyan]📋 Installation Plan[/]")
            yield Static("")
            if not selected:
                yield Static("[dim]Nothing to install — all tools are present or none selected.[/]")
                yield Static("")
                with Horizontal(classes="buttons"):
                    yield Button("Exit", variant="primary", id="btn-exit")
            else:
                for step_num, tools in selected.items():
                    step_def = self.app.steps[step_num - 1]
                    yield Static(f"  [bold]{step_def.icon} {step_def.title}[/]")
                    for tool in tools:
                        action = "update" if tool.installed else "install"
                        yield Static(f"    • {tool.name}  [dim]({action})[/]")
                    yield Static("")
                total = sum(len(t) for t in selected.values())
                yield Static(f"  [dim]Total: {total} tool(s) to process[/]")
                yield Static("")
                yield Rule()
                yield Static("")
                with Horizontal(classes="buttons"):
                    yield Button("Confirm", variant="success", id="btn-confirm")
                    yield Button("Back", variant="default", id="btn-back")
                    yield Button("Quit", variant="error", id="btn-quit")
        yield Footer()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id in ("btn-quit", "btn-exit"):
            self.app.exit()
        elif event.button.id == "btn-back":
            self.app.switch_screen(StepScreen(TOTAL_STEPS - 1))
        elif event.button.id == "btn-confirm":
            self.app.switch_screen(InstallScreen())


class InstallScreen(Screen):
    """Installation progress screen."""

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Vertical(id="install-content"):
            yield Static("[bold cyan]⚡ Installing...[/]", id="install-title")
            yield Static("")
            yield RichLog(id="log", markup=True, highlight=False)
            yield ProgressBar(id="progress", show_eta=False)
            yield Static("", id="status")
        yield Footer()

    def on_mount(self) -> None:
        self._run_installs()

    @work(thread=True)
    def _run_installs(self) -> None:
        selected = self.app.get_selected_tools()
        all_tools = [(s, t) for s, tools in selected.items() for t in tools]
        total = len(all_tools)

        def write(text: str) -> None:
            try:
                self.app.call_from_thread(self.query_one("#log", RichLog).write, text)
            except Exception:
                pass

        def set_status(text: str) -> None:
            try:
                self.app.call_from_thread(self.query_one("#status", Static).update, text)
            except Exception:
                pass

        def advance_bar() -> None:
            try:
                self.app.call_from_thread(self.query_one("#progress", ProgressBar).advance, 1)
            except Exception:
                pass

        if total == 0:
            write("[dim]Nothing to install.[/]")
            set_status("[green]Done! Press q to exit.[/]")
            return

        # Set progress bar total
        try:
            bar = self.query_one("#progress", ProgressBar)
            self.app.call_from_thread(setattr, bar, "total", total)
        except Exception:
            pass

        installed = updated = failed = 0
        current_step: int | None = None

        for _i, (step_num, tool) in enumerate(all_tools):
            step_def = self.app.steps[step_num - 1]
            if step_num != current_step:
                if current_step is not None:
                    write("")
                current_step = step_num
                write(f"[bold]{step_def.icon} {step_def.title}[/]")

            action = "Updating" if tool.installed else "Installing"
            set_status(f"[yellow]{action} {tool.name}...[/]")

            try:
                result = subprocess.run(
                    tool.install_cmd,
                    shell=True,
                    capture_output=True,
                    text=True,
                    timeout=300,
                )
                if result.returncode == 0:
                    if tool.installed:
                        write(f"  [green]✓[/] {tool.name} [dim](updated)[/]")
                        updated += 1
                    else:
                        write(f"  [green]✓[/] {tool.name}")
                        installed += 1
                else:
                    write(f"  [red]✗[/] {tool.name} — install failed")
                    if result.stderr:
                        for line in result.stderr.strip().splitlines()[-3:]:
                            write(f"    [dim]{line}[/]")
                    failed += 1
            except subprocess.TimeoutExpired:
                write(f"  [red]✗[/] {tool.name} — timed out (5m)")
                failed += 1
            except Exception as exc:
                write(f"  [red]✗[/] {tool.name} — {exc}")
                failed += 1

            advance_bar()

        write("")
        write("━" * 44)
        write("[bold green]Install Complete[/]")
        write(f"  ✓ Installed: {installed}")
        write(f"  ↻ Updated:   {updated}")
        write(f"  ✗ Failed:    {failed}")
        write("")
        write("  Run [bold]pi[/] to start a session!")
        set_status("[green]Done! Press q to exit.[/]")


# ── App ────────────────────────────────────────────────────────────────────


class InstallerApp(App):
    """pi-config interactive installer."""

    TITLE = "pi-config Installer"
    BINDINGS = [
        Binding("q", "quit", "Quit"),
        Binding("escape", "quit", "Quit"),
    ]

    CSS = """
    #content {
        margin: 0 2;
        padding: 1 2;
    }
    #install-content {
        margin: 0 2;
        padding: 1 2;
    }
    Checkbox {
        margin-left: 2;
        height: auto;
    }
    .buttons {
        height: auto;
        margin: 0 0;
    }
    .buttons Button {
        margin: 0 1 0 0;
    }
    #log {
        height: 1fr;
        min-height: 10;
        margin: 1 0;
    }
    #progress {
        margin: 1 0 0 0;
    }
    #status {
        margin: 0 0 1 0;
    }
    """

    def __init__(self) -> None:
        super().__init__()
        self.prereqs: dict[str, Prereq] = {}
        self.steps: list[StepDef] = []

    def on_mount(self) -> None:
        self.prereqs = check_prereqs()
        self.steps = build_steps(self.prereqs)
        self.push_screen(PrereqScreen())

    def get_selected_tools(self) -> dict[int, list[Tool]]:
        """Return tools selected for install/update, grouped by step number."""
        result: dict[int, list[Tool]] = {}
        for step in self.steps:
            selected = [t for t in step.tools if t.selected and not t.disabled and (not t.installed or t.has_update)]
            if selected:
                result[step.number] = selected
        return result


# ── Non-Interactive Mode ──────────────────────────────────────────────────


def run_all_mode() -> None:
    """Install everything without TUI — plain text progress."""
    print("pi-config installer (--all mode)")
    print("=" * 44)

    prereqs = check_prereqs()
    print("\n🔍 Prerequisites:")
    for p in prereqs.values():
        if p.present:
            ver = f" ({p.version})" if p.version else ""
            print(f"  ✓ {p.name}{ver}")
        else:
            print(f"  ✗ {p.name} — {p.install_hint}")

    if not all(p.present for p in prereqs.values()):
        print("\n⚠  Some prerequisites missing. Dependent tools will be skipped.")

    steps = build_steps(prereqs)
    installed = updated = failed = 0

    for step in steps:
        to_install = [t for t in step.tools if not t.disabled and (not t.installed or t.has_update)]
        if not to_install:
            continue

        print(f"\n{step.icon} {step.title}")
        for tool in to_install:
            action = "Updating" if tool.installed else "Installing"
            print(f"  {action} {tool.name}...", end=" ", flush=True)
            try:
                result = subprocess.run(
                    tool.install_cmd,
                    shell=True,
                    capture_output=True,
                    text=True,
                    timeout=300,
                )
                if result.returncode == 0:
                    print("✓")
                    if tool.installed:
                        updated += 1
                    else:
                        installed += 1
                else:
                    print("✗")
                    if result.stderr:
                        for line in result.stderr.strip().splitlines()[-2:]:
                            print(f"    {line}")
                    failed += 1
            except subprocess.TimeoutExpired:
                print("✗ (timed out)")
                failed += 1
            except Exception as exc:
                print(f"✗ ({exc})")
                failed += 1

    print(f"\n{'=' * 44}")
    print(f"  ✓ Installed: {installed}")
    print(f"  ↻ Updated:   {updated}")
    print(f"  ✗ Failed:    {failed}")
    print("\n  Run 'pi' to start a session!")


# ── Entry Point ───────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(
        description="pi-config TUI Installer — interactive wizard for pi-config and related tooling",
    )
    parser.add_argument("--all", action="store_true", help="Install everything non-interactively (no TUI)")
    args = parser.parse_args()

    if args.all:
        run_all_mode()
    else:
        app = InstallerApp()
        app.run()


if __name__ == "__main__":
    main()
