#!/usr/bin/env bash
set -euo pipefail

# ─── pi-config wizard installer ─────────────────────────────────────────────
# Interactive gum-based wizard for pi-config and related tooling.
# Usage: ./install.sh [--all] [--help]
# ─────────────────────────────────────────────────────────────────────────────

TMPDIR_INSTALL=""
GUM=""

cleanup() { [[ -n "${TMPDIR_INSTALL:-}" ]] && rm -rf "${TMPDIR_INSTALL:-}" 2>/dev/null || true; }
trap cleanup EXIT
trap 'echo ""; echo "  Aborted."; exit 130' INT

# gum confirm wrapper — exits on Ctrl+C (130)
gum_confirm() {
    $GUM confirm "$@" && return 0
    local rc=$?
    if [[ $rc -eq 130 ]]; then
        echo ""
        echo "  Aborted."
        exit 130
    fi
    return 1
}

# ─── gum bootstrap ──────────────────────────────────────────────────────────
ensure_gum() {
    if command -v gum &>/dev/null; then
        GUM="gum"
        return
    fi
    local tmpdir os arch
    tmpdir=$(mktemp -d)
    TMPDIR_INSTALL="$tmpdir"
    os=$(uname -s | tr '[:upper:]' '[:lower:]')
    arch=$(uname -m)
    case "$arch" in
        x86_64)  arch="amd64" ;;
        aarch64) arch="arm64" ;;
    esac
    echo "Downloading gum for interactive UI..."
    if ! curl -fsSL "https://github.com/charmbracelet/gum/releases/download/v0.16.0/gum_0.16.0_${os}_${arch}.tar.gz" \
            | tar xz -C "$tmpdir" gum 2>/dev/null; then
        echo "Failed to download gum. Install manually: https://github.com/charmbracelet/gum"
        exit 1
    fi
    chmod +x "$tmpdir/gum"
    GUM="$tmpdir/gum"
}

# ─── Globals ─────────────────────────────────────────────────────────────────
OS=$(uname -s); ARCH=$(uname -m)
OS_LOWER=$(echo "$OS" | tr '[:upper:]' '[:lower:]')
ARCH_DL="$ARCH"
[[ "$ARCH" == "x86_64" ]]  && ARCH_DL="amd64"
[[ "$ARCH" == "aarch64" ]] && ARCH_DL="arm64"

ALL_MODE=false; SUDO_ALLOWED=""
HAS_NODE=true; HAS_GIT=true; HAS_PI=true; HAS_UV=true
COUNT_INSTALLED=0; COUNT_UPDATED=0; COUNT_SKIPPED=0; COUNT_FAILED=0
TOTAL_STEPS=7

STEP_ICONS=("📦" "🐍" "📦" "🔧" "🌐" "🏗️" "⚙️")
STEP_TITLES=("Pi Packages" "Python Tools" "npm Packages" "CLI Tools" "Browser Automation" "Infrastructure" "Environment Setup")
STEP_DESCS=(
    "Core pi extensions — orchestrator, agents, and model providers"
    "CLI utilities used by pi-config workflows"
    "Node.js tools for agent capabilities"
    "Developer CLIs used by specialist agents"
    "Headless browser for agent-browser web automation"
    "Optional tools for infrastructure specialist agents"
    "Git configuration for pi-config"
)

# Per-step tool arrays (populated by define_step_N)
T_NAMES=(); T_DESCS=(); T_INSTALLED=(); T_HAS_UPDATE=()
T_NEEDS_SUDO=(); T_DISABLED=(); T_CMDS=()

# ─── Helpers ─────────────────────────────────────────────────────────────────
spin_install() {
    local title=$1 body=$2 sf
    sf=$(mktemp)
    printf '#!/usr/bin/env bash\nset -euo pipefail\n%s\n' "$body" > "$sf"
    chmod +x "$sf"
    local rc=0
    $GUM spin --spinner dot --title "$title" -- bash "$sf" || rc=$?
    rm -f "$sf"
    return $rc
}

step_header() {
    local step=$1
    local idx=$((step - 1))
    echo ""
    $GUM style --border rounded --padding "0 2" --border-foreground 6 \
        "pi-config installer — Step $step of $TOTAL_STEPS"
    echo ""
    $GUM style --bold "${STEP_ICONS[$idx]} ${STEP_TITLES[$idx]}"
    $GUM style --faint "${STEP_DESCS[$idx]}"
    echo ""
}

# ─── Prerequisites ───────────────────────────────────────────────────────────
check_prereqs() {
    local need_node=false need_git=false need_pi=false need_uv=false

    if command -v node &>/dev/null; then
        local v
        v=$(node --version | sed 's/^v//' | cut -d. -f1)
        ((v < 22)) && need_node=true
    else
        need_node=true
    fi
    command -v git &>/dev/null || need_git=true
    command -v pi &>/dev/null  || need_pi=true
    command -v uv &>/dev/null  || need_uv=true

    if [[ "$need_node" == false && "$need_git" == false && \
          "$need_pi" == false && "$need_uv" == false ]]; then
        return 0
    fi

    $GUM style --foreground 3 --bold "Missing prerequisites:"
    [[ "$need_node" == true ]] && $GUM style --foreground 1 "  ✗ Node.js ≥ 22"
    [[ "$need_git" == true ]]  && $GUM style --foreground 1 "  ✗ git"
    [[ "$need_pi" == true ]]   && $GUM style --foreground 1 "  ✗ pi (pi-coding-agent)"
    [[ "$need_uv" == true ]]   && $GUM style --foreground 1 "  ✗ uv (Python package manager)"
    echo ""

    if [[ "$need_git" == true ]]; then
        if [[ "$ALL_MODE" == true ]] || gum_confirm "Install git?"; then
            if [[ "$OS" == "Darwin" ]]; then
                xcode-select --install 2>/dev/null || true
            elif command -v apt-get &>/dev/null; then
                spin_install "Installing git..." "sudo apt-get install -y git"
            elif command -v dnf &>/dev/null; then
                spin_install "Installing git..." "sudo dnf install -y git"
            fi
        fi
    fi

    if [[ "$need_node" == true ]]; then
        if [[ "$ALL_MODE" == true ]] || gum_confirm "Install Node.js 22 (via nvm)?"; then
            # shellcheck disable=SC2016
            spin_install "Installing Node.js 22..." '
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh"
nvm install 22'
            export NVM_DIR="$HOME/.nvm"
            # shellcheck disable=SC1091
            [[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh"
        fi
    fi

    if [[ "$need_uv" == true ]]; then
        if [[ "$ALL_MODE" == true ]] || gum_confirm "Install uv?"; then
            spin_install "Installing uv..." "curl -LsSf https://astral.sh/uv/install.sh | sh"
            [[ -d "$HOME/.local/bin" ]] && export PATH="$HOME/.local/bin:$PATH"
            # shellcheck disable=SC1091
            [[ -f "$HOME/.cargo/env" ]] && . "$HOME/.cargo/env"
        fi
    fi

    if [[ "$need_pi" == true ]]; then
        if [[ "$ALL_MODE" == true ]] || gum_confirm "Install pi?"; then
            spin_install "Installing pi..." "npm install -g @earendil-works/pi-coding-agent"
        fi
    fi

    # Re-check availability
    if command -v node &>/dev/null; then
        local v
        v=$(node --version | sed 's/^v//' | cut -d. -f1)
        ((v >= 22)) && HAS_NODE=true || HAS_NODE=false
    else
        HAS_NODE=false
    fi
    command -v git &>/dev/null && HAS_GIT=true || HAS_GIT=false
    command -v pi &>/dev/null  && HAS_PI=true  || HAS_PI=false
    command -v uv &>/dev/null  && HAS_UV=true  || HAS_UV=false

    if [[ "$HAS_NODE" == false || "$HAS_GIT" == false || \
          "$HAS_PI" == false || "$HAS_UV" == false ]]; then
        echo ""
        $GUM style --foreground 3 "Some prerequisites still missing. Tools requiring them will be disabled."
        if [[ "$ALL_MODE" != true ]]; then
            gum_confirm "Continue with limited features?" || exit 0
        fi
    fi
}

# ─── Step 1: Pi Packages ────────────────────────────────────────────────────
define_step_1() {
    T_NAMES=("pi-config" "pi-vertex-claude" "pi-web-access")
    T_DESCS=("Orchestrator + 24 agents + prompts" "Claude via Google Cloud Vertex AI" "Web search · fetch · librarian skills")
    T_HAS_UPDATE=(1 1 0); T_NEEDS_SUDO=(0 0 0)

    T_INSTALLED=()
    [[ -d "$HOME/.pi/agent/git/github.com/myk-org/pi-config" ]]         && T_INSTALLED+=(1) || T_INSTALLED+=(0)
    [[ -d "$HOME/.pi/agent/git/github.com/myk-org/pi-vertex-claude" ]]  && T_INSTALLED+=(1) || T_INSTALLED+=(0)
    grep -qF 'pi-web-access' "$HOME/.pi/agent/settings.json" 2>/dev/null && T_INSTALLED+=(1) || T_INSTALLED+=(0)

    local dis=""; [[ "$HAS_PI" == false ]] && dis="requires pi"
    T_DISABLED=("$dis" "$dis" "$dis")

    T_CMDS=()
    if [[ ${T_INSTALLED[0]:-0} -eq 1 ]]; then
        T_CMDS+=("pi update git:github.com/myk-org/pi-config")
    else
        T_CMDS+=("pi install git:github.com/myk-org/pi-config")
    fi
    if [[ ${T_INSTALLED[1]:-0} -eq 1 ]]; then
        T_CMDS+=("pi update git:github.com/myk-org/pi-vertex-claude")
    else
        T_CMDS+=("pi install git:github.com/myk-org/pi-vertex-claude")
    fi
    T_CMDS+=("pi install npm:pi-web-access")
}

# ─── Step 2: Python Tools ───────────────────────────────────────────────────
define_step_2() {
    T_NAMES=("myk-pi-tools" "mcp-launchpad (mcpl)" "prek")
    T_DESCS=("PR reviews · releases · memory management" "MCP server discovery and tool execution" "Kubernetes/OpenShift resource explorer")
    T_HAS_UPDATE=(0 0 0); T_NEEDS_SUDO=(0 0 0)

    T_INSTALLED=()
    command -v myk-pi-tools &>/dev/null && T_INSTALLED+=(1) || T_INSTALLED+=(0)
    command -v mcpl &>/dev/null          && T_INSTALLED+=(1) || T_INSTALLED+=(0)
    command -v prek &>/dev/null          && T_INSTALLED+=(1) || T_INSTALLED+=(0)

    local dis=""; [[ "$HAS_UV" == false ]] && dis="requires uv"
    T_DISABLED=("$dis" "$dis" "$dis")

    # shellcheck disable=SC2016
    T_CMDS=(
        'uv tool install myk-pi-tools --from "myk-pi-tools @ git+https://github.com/myk-org/pi-config.git"'
        'uv tool install mcp-launchpad --from "mcp-launchpad @ git+https://github.com/kenneth-liao/mcp-launchpad.git"'
        'uv tool install prek'
    )
}

# ─── Step 3: npm Packages ───────────────────────────────────────────────────
define_step_3() {
    T_NAMES=("acpx" "agent-browser")
    T_DESCS=("External AI agent proxy (Cursor/Codex/Copilot)" "Browser automation for web testing")
    T_HAS_UPDATE=(0 0); T_NEEDS_SUDO=(0 0)

    T_INSTALLED=()
    command -v acpx &>/dev/null          && T_INSTALLED+=(1) || T_INSTALLED+=(0)
    command -v agent-browser &>/dev/null && T_INSTALLED+=(1) || T_INSTALLED+=(0)

    local dis=""; [[ "$HAS_NODE" == false ]] && dis="requires Node.js"
    T_DISABLED=("$dis" "$dis")

    T_CMDS=("npm install -g acpx" "npm install -g agent-browser")
}

# ─── Step 4: CLI Tools ──────────────────────────────────────────────────────
define_step_4() {
    T_NAMES=("gh" "glab" "bun" "coderabbit")
    T_DESCS=("GitHub CLI — PRs · issues · releases" "GitLab CLI — MRs and pipelines" "JavaScript runtime — coms-net server" "Local AI code reviews")
    T_HAS_UPDATE=(0 0 0 0); T_DISABLED=("" "" "" "")

    T_NEEDS_SUDO=(0 0 0 0)
    [[ "$OS" == "Linux" && $EUID -ne 0 ]] && T_NEEDS_SUDO=(1 1 0 0)

    T_INSTALLED=()
    command -v gh   &>/dev/null && T_INSTALLED+=(1) || T_INSTALLED+=(0)
    command -v glab &>/dev/null && T_INSTALLED+=(1) || T_INSTALLED+=(0)
    command -v bun  &>/dev/null && T_INSTALLED+=(1) || T_INSTALLED+=(0)
    command -v cr   &>/dev/null && T_INSTALLED+=(1) || T_INSTALLED+=(0)

    T_CMDS=()

    # ── gh ──
    if [[ "$OS" == "Darwin" ]]; then
        T_CMDS+=("brew install gh")
    elif command -v apt-get &>/dev/null; then
        # shellcheck disable=SC2016
        T_CMDS+=('sudo mkdir -p -m 755 /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null
sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt-get update -qq
sudo apt-get install -y -qq gh')
    else
        T_CMDS+=("gh_ver=\$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | grep -o '\"tag_name\":\"v[^\"]*\"' | head -1 | cut -d'\"' -f4 | sed 's/^v//')
tmpdir=\$(mktemp -d)
curl -fsSL -o \"\$tmpdir/gh.rpm\" \"https://github.com/cli/cli/releases/download/v\${gh_ver}/gh_\${gh_ver}_linux_${ARCH_DL}.rpm\"
sudo rpm -ivh \"\$tmpdir/gh.rpm\"
rm -rf \"\$tmpdir\"")
    fi

    # ── glab ──
    if [[ "$OS" == "Darwin" ]]; then
        T_CMDS+=("brew install glab")
    else
        T_CMDS+=("glab_ver=\$(curl -fsSL 'https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases' | grep -o '\"tag_name\":\"v[^\"]*\"' | head -1 | cut -d'\"' -f4 | sed 's/^v//')
tmpdir=\$(mktemp -d)
if command -v dpkg &>/dev/null; then
    curl -fsSL -o \"\$tmpdir/glab.deb\" \"https://gitlab.com/gitlab-org/cli/-/releases/v\${glab_ver}/downloads/glab_\${glab_ver}_linux_${ARCH_DL}.deb\"
    sudo dpkg -i \"\$tmpdir/glab.deb\"
else
    curl -fsSL -o \"\$tmpdir/glab.rpm\" \"https://gitlab.com/gitlab-org/cli/-/releases/v\${glab_ver}/downloads/glab_\${glab_ver}_linux_${ARCH_DL}.rpm\"
    sudo dnf install -y \"\$tmpdir/glab.rpm\" 2>/dev/null || sudo rpm -ivh \"\$tmpdir/glab.rpm\"
fi
rm -rf \"\$tmpdir\"")
    fi

    # ── bun ──
    T_CMDS+=("curl -fsSL https://bun.sh/install | bash")

    # ── coderabbit ──
    # shellcheck disable=SC2016
    T_CMDS+=('CI=true bash -c "$(curl -fsSL https://cli.coderabbit.ai/install.sh)"')
}

# ─── Step 5: Browser Automation ─────────────────────────────────────────────
define_step_5() {
    T_NAMES=("playwright + chromium")
    T_DESCS=("Headless Chromium browser engine")
    T_HAS_UPDATE=(0); T_NEEDS_SUDO=(0)

    T_INSTALLED=()
    # shellcheck disable=SC2012
    ls "$HOME/.cache/ms-playwright"/chromium-* &>/dev/null && T_INSTALLED+=(1) || T_INSTALLED+=(0)

    local dis=""; [[ "$HAS_NODE" == false ]] && dis="requires Node.js"
    T_DISABLED=("$dis")

    T_CMDS=("npx playwright install --with-deps chromium")
}

# ─── Step 6: Infrastructure ─────────────────────────────────────────────────
define_step_6() {
    T_NAMES=("kubectl" "oc" "Go")
    T_DESCS=("Kubernetes CLI — kubernetes-expert agent" "OpenShift CLI — kubernetes-expert agent" "Go compiler — go-expert agent")
    T_HAS_UPDATE=(0 0 0); T_DISABLED=("" "" "")

    T_NEEDS_SUDO=(0 0 0)
    [[ "$OS" == "Linux" && $EUID -ne 0 ]] && T_NEEDS_SUDO=(1 1 1)

    T_INSTALLED=()
    command -v kubectl &>/dev/null && T_INSTALLED+=(1) || T_INSTALLED+=(0)
    command -v oc &>/dev/null      && T_INSTALLED+=(1) || T_INSTALLED+=(0)
    command -v go &>/dev/null      && T_INSTALLED+=(1) || T_INSTALLED+=(0)

    local do_sudo=""
    [[ "$OS" == "Linux" && $EUID -ne 0 ]] && do_sudo="sudo"

    T_CMDS=()

    # ── kubectl ──
    T_CMDS+=("kube_ver=\$(curl -fsSL https://dl.k8s.io/release/stable.txt)
tmpdir=\$(mktemp -d)
curl -fsSL -o \"\$tmpdir/kubectl\" \"https://dl.k8s.io/release/\${kube_ver}/bin/${OS_LOWER}/${ARCH_DL}/kubectl\"
chmod +x \"\$tmpdir/kubectl\"
${do_sudo} install -m 0755 \"\$tmpdir/kubectl\" /usr/local/bin/kubectl
rm -rf \"\$tmpdir\"")

    # ── oc ──
    local oc_path_arch="$ARCH"
    [[ "$oc_path_arch" == "arm64" ]] && oc_path_arch="aarch64"
    local oc_os="linux"; [[ "$OS" == "Darwin" ]] && oc_os="mac"
    local oc_arch_suffix=""; [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]] && oc_arch_suffix="-arm64"

    T_CMDS+=("tmpdir=\$(mktemp -d)
curl -fsSL \"https://mirror.openshift.com/pub/openshift-v4/${oc_path_arch}/clients/ocp/stable/openshift-client-${oc_os}${oc_arch_suffix}.tar.gz\" | tar xz -C \"\$tmpdir\" oc
${do_sudo} install -m 0755 \"\$tmpdir/oc\" /usr/local/bin/oc
rm -rf \"\$tmpdir\"")

    # ── Go ──
    T_CMDS+=("go_ver=\$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -1)
${do_sudo} rm -rf /usr/local/go
curl -fsSL \"https://go.dev/dl/\${go_ver}.${OS_LOWER}-${ARCH_DL}.tar.gz\" | ${do_sudo} tar xz -C /usr/local")
}

# ─── Step 7: Environment Setup ──────────────────────────────────────────────
define_step_7() {
    T_NAMES=(".pi/memory/ in gitignore" ".worktrees/ in gitignore")
    T_DESCS=("Prevent memory files from being committed" "Prevent git worktree dirs from being committed")
    T_HAS_UPDATE=(0 0); T_NEEDS_SUDO=(0 0)

    local gitignore
    gitignore=$(git config --global core.excludesfile 2>/dev/null || echo "")
    [[ -z "$gitignore" ]] && gitignore="$HOME/.config/git/ignore"
    gitignore="${gitignore/#\~/$HOME}"

    T_INSTALLED=()
    grep -qF '.pi/memory/' "$gitignore" 2>/dev/null && T_INSTALLED+=(1) || T_INSTALLED+=(0)
    grep -qF '.worktrees/' "$gitignore" 2>/dev/null && T_INSTALLED+=(1) || T_INSTALLED+=(0)

    local dis=""; [[ "$HAS_GIT" == false ]] && dis="requires git"
    T_DISABLED=("$dis" "$dis")

    local gitdir
    gitdir=$(dirname "$gitignore")

    T_CMDS=(
        "mkdir -p \"$gitdir\" && touch \"$gitignore\" && git config --global core.excludesfile \"$gitignore\" && echo '.pi/memory/' >> \"$gitignore\""
        "mkdir -p \"$gitdir\" && touch \"$gitignore\" && git config --global core.excludesfile \"$gitignore\" && echo '.worktrees/' >> \"$gitignore\""
    )
}

# ─── Generic step runner ────────────────────────────────────────────────────
run_step() {
    local step=$1
    "define_step_$step"
    step_header "$step"

    local count=${#T_NAMES[@]}
    local -a opts=() preselected=() labels=()

    # Show disabled items, build selectable options
    for ((i = 0; i < count; i++)); do
        if [[ -n "${T_DISABLED[$i]}" ]]; then
            labels+=("")
            $GUM style --foreground 240 "  ⊘ ${T_NAMES[$i]} — ${T_DESCS[$i]} [${T_DISABLED[$i]}]"
        else
            local lbl
            if [[ ${T_INSTALLED[$i]} -eq 1 ]]; then
                lbl="${T_NAMES[$i]} — ${T_DESCS[$i]} [installed]"
            else
                lbl="${T_NAMES[$i]} — ${T_DESCS[$i]}"
            fi
            labels+=("$lbl")
            opts+=("$lbl")
            preselected+=("$lbl")
        fi
    done

    if [[ ${#opts[@]} -eq 0 ]]; then
        $GUM style --foreground 240 "  All items require missing prerequisites — skipping"
        echo ""
        return 0
    fi

    # Multi-select (or auto-select in --all mode)
    local selected=""
    if [[ "$ALL_MODE" == true ]]; then
        selected=$(printf '%s\n' "${opts[@]}")
    else
        local csv
        csv=$(printf '%s,' "${preselected[@]}")
        csv="${csv%,}"
        local rc=0
        selected=$($GUM choose --no-limit --height=20 \
            --header="Select tools (space to toggle, enter to confirm):" \
            --selected="$csv" \
            "${opts[@]}") || rc=$?
        # gum returns 1 on Esc, 130 on Ctrl+C — both should exit
        if [[ $rc -ne 0 ]]; then
            echo ""
            echo "  Aborted."
            exit "$rc"
        fi
    fi

    if [[ -z "$selected" ]]; then
        $GUM style --faint "  Nothing selected — skipping"
        echo ""
        return 0
    fi

    # Check sudo requirement for selected items
    local step_needs_sudo=false
    for ((i = 0; i < count; i++)); do
        [[ -z "${labels[$i]}" ]] && continue
        if [[ ${T_NEEDS_SUDO[$i]} -eq 1 && ${T_INSTALLED[$i]} -eq 0 ]] \
           && echo "$selected" | grep -qxF "${labels[$i]}"; then
            step_needs_sudo=true; break
        fi
    done

    if [[ "$step_needs_sudo" == true && "$SUDO_ALLOWED" != "yes" \
          && "$OS" == "Linux" && $EUID -ne 0 ]]; then
        echo ""
        if [[ "$ALL_MODE" == true ]] || gum_confirm "Some tools require sudo. Allow?"; then
            SUDO_ALLOWED="yes"
            sudo -v 2>/dev/null || true
        else
            SUDO_ALLOWED="no"
        fi
    fi

    echo ""

    # Install each selected item
    for ((i = 0; i < count; i++)); do
        [[ -z "${labels[$i]}" ]] && continue  # disabled

        local name="${T_NAMES[$i]}"

        # Not selected → skip silently
        if ! echo "$selected" | grep -qxF "${labels[$i]}"; then
            continue
        fi

        # Already installed, no update → skip
        if [[ ${T_INSTALLED[$i]} -eq 1 && ${T_HAS_UPDATE[$i]} -eq 0 ]]; then
            $GUM style --foreground 240 "  — $name (already installed)"
            ((COUNT_SKIPPED++)) || true
            continue
        fi

        # Needs sudo but declined → skip
        if [[ ${T_NEEDS_SUDO[$i]} -eq 1 && "$SUDO_ALLOWED" == "no" ]]; then
            $GUM style --foreground 1 "  ✗ $name — requires sudo"
            ((COUNT_SKIPPED++)) || true
            continue
        fi

        # Install / update with spinner
        local action="Installing"
        [[ ${T_INSTALLED[$i]} -eq 1 ]] && action="Updating"

        if spin_install "$action $name..." "${T_CMDS[$i]}"; then
            if [[ ${T_INSTALLED[$i]} -eq 1 ]]; then
                $GUM style --foreground 2 "  ✓ $name (updated)"
                ((COUNT_UPDATED++)) || true
            else
                $GUM style --foreground 2 "  ✓ $name"
                ((COUNT_INSTALLED++)) || true
            fi
        else
            $GUM style --foreground 1 "  ✗ $name — install failed"
            ((COUNT_FAILED++)) || true
        fi
    done

    echo ""
}

# ─── Summary ─────────────────────────────────────────────────────────────────
show_summary() {
    echo ""
    $GUM style --border rounded --padding "0 2" --border-foreground 2 \
        "Install Complete"
    echo ""
    echo "  ✓ Installed: $COUNT_INSTALLED"
    echo "  ↻ Updated:   $COUNT_UPDATED"
    echo "  — Skipped:   $COUNT_SKIPPED"
    echo "  ✗ Failed:    $COUNT_FAILED"
    echo ""
    echo "  Run 'pi' to start a session!"
    echo ""
}

# ─── Usage ───────────────────────────────────────────────────────────────────
usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Interactive gum-based wizard installer for pi-config and related tooling.
Downloads gum automatically if not installed (zero permanent footprint).

Options:
  --all     Install everything non-interactively (auto-confirms all prompts)
  --help    Show this help message

Steps:
  1. 📦 Pi Packages         pi-config, pi-vertex-claude, pi-web-access
  2. 🐍 Python Tools        myk-pi-tools, mcpl, prek
  3. 📦 npm Packages        acpx, agent-browser
  4. 🔧 CLI Tools           gh, glab, bun, coderabbit
  5. 🌐 Browser Automation  playwright + chromium
  6. 🏗️  Infrastructure      kubectl, oc, Go
  7. ⚙️  Environment Setup   gitignore entries
EOF
}

# ─── Main ────────────────────────────────────────────────────────────────────
main() {
    for arg in "$@"; do
        case "$arg" in
            --all)    ALL_MODE=true ;;
            --help|-h) usage; exit 0 ;;
            *) echo "Unknown option: $arg"; usage; exit 1 ;;
        esac
    done

    ensure_gum
    check_prereqs

    for step in $(seq 1 "$TOTAL_STEPS"); do
        run_step "$step"
    done

    show_summary
}

main "$@"
