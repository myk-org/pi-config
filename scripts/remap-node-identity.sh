#!/bin/bash
# Remap image user `node` (build UID/GID 1000) to the host IDs so bind-mounted
# 0600/0700 files are readable. Sourced from init-entrypoint.sh as root.
#
# PI_HOST_UID / PI_HOST_GID: explicit (alias should pass $(id -u) / $(id -g)).
# Fallback: stat a bind-mounted probe under /home/$PI_HOST_USER — never the
# docker-created parent directory (that inode is root).
# PI_HOST_HOME: optional override of that parent (tests).

pi_init_log() {
  echo "init-entrypoint: $*" >&2
}

pi_is_uint() {
  case "${1:-}" in
    '' | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

# Print uid:gid. Exit 1 if nothing to remap from.
pi_resolve_host_ids() {
  local uid="${PI_HOST_UID:-}"
  local gid="${PI_HOST_GID:-}"
  local probe user_home

  if [ -n "$uid" ] && [ -n "$gid" ]; then
    printf '%s:%s\n' "$uid" "$gid"
    return 0
  fi

  if [ -z "${PI_HOST_USER:-}" ] || [ "$PI_HOST_USER" = "node" ]; then
    return 1
  fi

  user_home="${PI_HOST_HOME:-/home/$PI_HOST_USER}"
  for probe in "$user_home/.pi" "$user_home/.ssh" "$user_home/.npmrc" "$user_home/.gitconfig"; do
    if [ -e "$probe" ]; then
      uid="$(stat -c '%u' "$probe")"
      gid="$(stat -c '%g' "$probe")"
      pi_init_log "inferred host ids ${uid}:${gid} from ${probe}"
      printf '%s:%s\n' "$uid" "$gid"
      return 0
    fi
  done
  return 1
}

pi_validate_host_ids() {
  local uid="$1"
  local gid="$2"
  if ! pi_is_uint "$uid" || ! pi_is_uint "$gid"; then
    pi_init_log "invalid PI_HOST_UID/PI_HOST_GID (${uid}:${gid})"
    return 1
  fi
  if [ "$uid" -eq 0 ] || [ "$gid" -eq 0 ]; then
    pi_init_log "refusing to remap node to uid/gid 0"
    return 1
  fi
  return 0
}

# Apply usermod/groupmod + chown /home/node. No-op if already matched or no ids.
# Set PI_REMAP_DRY_RUN=1 to skip mutating commands (tests).
pi_remap_node_identity() {
  local ids uid gid cur_uid cur_gid occupant existing_group

  ids="$(pi_resolve_host_ids)" || {
    pi_init_log "no host uid/gid; leaving node as $(id -u node 2>/dev/null || echo unknown)"
    return 0
  }
  uid="${ids%%:*}"
  gid="${ids##*:}"
  pi_validate_host_ids "$uid" "$gid" || return 1

  cur_uid="$(id -u node)"
  cur_gid="$(id -g node)"
  if [ "$cur_uid" = "$uid" ] && [ "$cur_gid" = "$gid" ]; then
    pi_init_log "node already ${uid}:${gid}"
    return 0
  fi

  if [ "${PI_REMAP_DRY_RUN:-}" = "1" ]; then
    pi_init_log "dry-run: would remap node ${cur_uid}:${cur_gid} -> ${uid}:${gid}"
    return 0
  fi

  if [ "$cur_gid" != "$gid" ]; then
    existing_group="$(getent group "$gid" | cut -d: -f1 || true)"
    if [ -z "$existing_group" ]; then
      pi_init_log "groupmod node gid ${cur_gid} -> ${gid}"
      groupmod -g "$gid" node
    elif [ "$existing_group" != "node" ]; then
      pi_init_log "using existing group ${existing_group} (gid ${gid}) as node's primary group"
      usermod -g "$gid" node
    fi
  fi

  if [ "$(id -u node)" != "$uid" ]; then
    occupant="$(getent passwd "$uid" | cut -d: -f1 || true)"
    if [ -n "$occupant" ] && [ "$occupant" != "node" ]; then
      pi_init_log "UID ${uid} already belongs to ${occupant}; cannot remap node"
      return 1
    fi
    pi_init_log "usermod node uid $(id -u node) -> ${uid}"
    usermod -u "$uid" node
  fi

  # Image home only — caller must run this before reverse-symlinks into bind mounts.
  if [ -d /home/node ]; then
    pi_init_log "chown image /home/node to node:node ($(id -u node):$(id -g node))"
    chown -R node:node /home/node
  fi
}
