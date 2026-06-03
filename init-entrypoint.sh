#!/bin/bash
# Init wrapper — handles HOME mapping for PI_HOST_USER.
# When called as node (by docker), re-execs as root via sudo for chown/symlink,
# then execs entrypoint.sh as node. No root access remains after setup.
set -e

# If running as node, re-exec as root for the setup phase
if [ "$(id -u)" != "0" ]; then
    if { [ -n "$PI_HOST_USER" ] && [ "$PI_HOST_USER" != "node" ]; } || [ -S /var/run/docker.sock ]; then
        exec sudo --preserve-env "$0" "$@"
    fi
    # No PI_HOST_USER and no docker socket — skip root setup, run entrypoint directly as node
    for d in /tmp/pi-work /tmp/pi-data; do
        if ! mkdir -p "$d" 2>/dev/null; then
            echo "WARNING: failed to create $d — temp files may fail. Fix with: sudo mkdir -p $d && sudo chown $(id -u):$(id -g) $d" >&2
        elif _probe="$d/.pi-probe-$$" && ! touch "$_probe" 2>/dev/null; then
            echo "WARNING: $d is not writable by $(whoami) — temp files may fail. Fix with: sudo chown $(id -u):$(id -g) $d" >&2
        else
            rm -f "$_probe" 2>/dev/null
        fi
    done
    exec entrypoint.sh "$@"
fi

# Running as root — do the HOME setup
if [ -n "$PI_HOST_USER" ] && [ "$PI_HOST_USER" != "node" ] && [ -d "/home/$PI_HOST_USER" ]; then
    NEW_HOME="/home/$PI_HOST_USER"
    chown node:node "$NEW_HOME"
    [ -d "$NEW_HOME/.config" ] && chown node:node "$NEW_HOME/.config"

    # Symlink container-internal tool dirs/files into the new HOME
    for item in .npm-global .npm .npmrc .cache .local .claude .claude.json \
                .cursor .acpx .agent-browser .bashrc .bash_logout .profile; do
        if [ -e "/home/node/$item" ] && [ ! -e "$NEW_HOME/$item" ]; then
            ln -sf "/home/node/$item" "$NEW_HOME/$item"
        fi
    done

    # Reverse symlinks: point everything under /home/node to NEW_HOME
    # so docker exec (HOME=/home/node) and tools find all mounted content.
    # Scans what docker actually mounted — works for any user's mounts.
    for item in "$NEW_HOME"/.* "$NEW_HOME"/*; do
        [ -e "$item" ] || continue
        name=$(basename "$item")
        [ "$name" = "." ] || [ "$name" = ".." ] && continue
        # Skip items already symlinked from /home/node (forward symlinks)
        [ -L "$NEW_HOME/$name" ] && continue
        # Replace /home/node version with symlink to mounted version
        if [ ! -L "/home/node/$name" ]; then
            rm -rf "/home/node/$name"
            ln -sf "$NEW_HOME/$name" "/home/node/$name"
        fi
    done
    # Same for .config subdirectories (skip if .config is already a symlink
    # to NEW_HOME — the main loop above handled it, and writing through the
    # symlink would create self-referential links)
    if [ ! -L "/home/node/.config" ] && [ -d "$NEW_HOME/.config" ]; then
        for item in "$NEW_HOME/.config"/*; do
            [ -e "$item" ] || continue
            name=$(basename "$item")
            if [ ! -L "/home/node/.config/$name" ]; then
                rm -rf "/home/node/.config/$name" 2>/dev/null || true
                ln -sf "$item" "/home/node/.config/$name" 2>/dev/null || true
            fi
        done
    fi

    export HOME="$NEW_HOME"
    # Ensure PATH includes new HOME-based paths
    export PATH="$NEW_HOME/.npm-global/bin:$NEW_HOME/.pi/agent/bin:$NEW_HOME/.local/bin:$PATH"
fi

# Ensure HOME is set for node (skipped above when PI_HOST_USER is unset)
export HOME="${HOME:-/home/node}"
[ "$HOME" = "/root" ] && export HOME="/home/node"

# Docker socket access — add node to the socket's group if mounted
DOCKER_SOCK="/var/run/docker.sock"
if [ -S "$DOCKER_SOCK" ]; then
    SOCK_GID=$(stat -c '%g' "$DOCKER_SOCK")
    if [ "$SOCK_GID" = "0" ]; then
        # Socket owned by root group — use ACL instead of adding node to root
        setfacl -m u:node:rw "$DOCKER_SOCK" 2>/dev/null || chmod 666 "$DOCKER_SOCK"
    elif ! id -G node | tr ' ' '\n' | grep -qx "$SOCK_GID"; then
        # Find or create a group with this GID, then add node to it
        SOCK_GROUP=$(getent group "$SOCK_GID" | cut -d: -f1)
        if [ -z "$SOCK_GROUP" ]; then
            SOCK_GROUP="docker-host"
            groupadd -g "$SOCK_GID" "$SOCK_GROUP"
        fi
        usermod -aG "$SOCK_GROUP" node
    fi
fi

# Ensure temp dirs exist and are owned by node (not root)
for d in /tmp/pi-work /tmp/pi-data; do
    # Refuse to operate on symlinks — prevents chown escape
    if [ -L "$d" ]; then
        echo "WARNING: $d is a symlink — removing to prevent chown escape" >&2
        rm -f "$d" || true
    fi
    if ! mkdir -p "$d" 2>/dev/null; then
        echo "WARNING: failed to create $d — temp files may fail" >&2
        continue
    fi
    if ! chown node:node "$d" 2>/dev/null; then
        echo "WARNING: could not chown $d — temp file writes may fail on mounted volumes" >&2
    fi
done

# Drop to node permanently — runuser replaces the process
exec runuser -m -u node -- entrypoint.sh "$@"
