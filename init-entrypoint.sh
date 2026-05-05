#!/bin/bash
# Init wrapper — handles HOME mapping for PI_HOST_USER.
# When called as node (by docker), re-execs as root via sudo for chown/symlink,
# then execs entrypoint.sh as node. No root access remains after setup.
set -e

# If running as node, re-exec as root for the setup phase
if [ "$(id -u)" != "0" ]; then
    if [ -n "$PI_HOST_USER" ] && [ "$PI_HOST_USER" != "node" ]; then
        exec sudo --preserve-env "$0" "$@"
    fi
    # No PI_HOST_USER — skip root setup, run entrypoint directly as node
    exec entrypoint.sh "$@"
fi

# Running as root — do the HOME setup
NEW_HOME="/home/$PI_HOST_USER"
if [ -d "$NEW_HOME" ]; then
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
    # Same for .config subdirectories
    if [ -d "$NEW_HOME/.config" ]; then
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

# Drop to node permanently — runuser replaces the process
exec runuser -m -u node -- entrypoint.sh "$@"
