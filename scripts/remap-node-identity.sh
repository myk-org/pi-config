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

# Probe bind-mounted files; print uid:gid from the first hit. Exit 1 if none.
pi_infer_ids_from_probe() {
  local probe user_home
  if [ -z "${PI_HOST_USER:-}" ] || [ "$PI_HOST_USER" = "node" ]; then
    return 1
  fi
  user_home="${PI_HOST_HOME:-/home/$PI_HOST_USER}"
  for probe in "$user_home/.pi" "$user_home/.ssh" "$user_home/.npmrc" "$user_home/.gitconfig"; do
    if [ -e "$probe" ]; then
      pi_init_log "inferred host ids $(stat -c '%u:%g' "$probe") from ${probe}"
      stat -c '%u:%g' "$probe"
      return 0
    fi
  done
  return 1
}

# Print uid:gid. Exit 1 if nothing to remap from.
# One of PI_HOST_UID / PI_HOST_GID may be omitted; the missing half is filled
# from a bind-mount probe, else from the current node uid/gid.
pi_resolve_host_ids() {
  local uid="${PI_HOST_UID:-}"
  local gid="${PI_HOST_GID:-}"
  local inferred inferred_uid inferred_gid

  if [ -n "$uid" ] && [ -n "$gid" ]; then
    printf '%s:%s\n' "$uid" "$gid"
    return 0
  fi

  inferred="$(pi_infer_ids_from_probe)" || inferred=""
  inferred_uid="${inferred%%:*}"
  inferred_gid="${inferred##*:}"
  [ "$inferred" = "$inferred_uid" ] && inferred_gid=""

  if [ -n "$uid" ] || [ -n "$gid" ]; then
    [ -z "$uid" ] && uid="${inferred_uid:-$(id -u node 2>/dev/null || true)}"
    [ -z "$gid" ] && gid="${inferred_gid:-$(id -g node 2>/dev/null || true)}"
    if [ -n "$uid" ] && [ -n "$gid" ]; then
      pi_init_log "partial PI_HOST_UID/GID; using ${uid}:${gid}"
      printf '%s:%s\n' "$uid" "$gid"
      return 0
    fi
    pi_init_log "PI_HOST_UID/GID partially set but missing half could not be filled"
    return 1
  fi

  if [ -n "$inferred" ]; then
    printf '%s\n' "$inferred"
    return 0
  fi
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
  # Numeric ids: after usermod -g to a non-node group, group "node" may still be GID 1000.
  if [ -d /home/node ]; then
    pi_init_log "chown image /home/node to $(id -u node):$(id -g node)"
    chown -R "$(id -u node):$(id -g node)" /home/node
  fi
}
