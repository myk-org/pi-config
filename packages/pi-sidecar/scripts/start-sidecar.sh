#!/usr/bin/env bash
# ---------------------------------------------------------
# start-sidecar.sh — Start the pi-sidecar HTTP server for
# local development and testing.
#
# Usage:
#   scripts/start-sidecar.sh              # background (default)
#   scripts/start-sidecar.sh --foreground # foreground (Ctrl-C to stop)
#   scripts/start-sidecar.sh --stop       # kill a running sidecar
#   scripts/start-sidecar.sh --help       # show usage
#
# Environment:
#   SIDECAR_PORT  — listen port  (default: 9201)
#   SIDECAR_HOST  — bind address (default: 127.0.0.1)
# ---------------------------------------------------------
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PKG_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly PORT="${SIDECAR_PORT:-9201}"
readonly HOST="${SIDECAR_HOST:-127.0.0.1}"
readonly LOG_DIR="/tmp/pi-work/pi-sidecar"
readonly LOG_FILE="${LOG_DIR}/sidecar.log"
# Bind host may be a wildcard (0.0.0.0 / ::); health probes need a connectable loopback.
case "${HOST}" in
    0.0.0.0) readonly HEALTH_HOST="127.0.0.1" ;;
    ::)      readonly HEALTH_HOST="::1" ;;
    *)       readonly HEALTH_HOST="${HOST}" ;;
esac
# IPv6 literals must be bracketed in URL authorities (http://[::1]:9201/...).
host_for_url() {
    local h="$1"
    case "${h}" in
        \[*\]) printf '%s\n' "${h}" ;;
        *:*)   printf '[%s]\n' "${h}" ;;
        *)     printf '%s\n' "${h}" ;;
    esac
}
readonly HEALTH_URL="http://$(host_for_url "${HEALTH_HOST}"):${PORT}/health"
readonly HEALTH_TIMEOUT=60
readonly PID_FILE="${LOG_DIR}/sidecar-${PORT}.pid"

# ── Helpers ──────────────────────────────────────────────

usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Start or stop the pi-sidecar HTTP server.

Options:
  --foreground   Run in the foreground (default: background)
  --stop         Stop a running sidecar on the configured port
  -h, --help     Show this help message

Environment variables:
  SIDECAR_PORT   Listen port   (default: 9201)
  SIDECAR_HOST   Bind address  (default: 127.0.0.1)

Log file: ${LOG_DIR}/sidecar.log
EOF
}

die() { echo "ERROR: $*" >&2; exit 1; }

# Return the first PID listening on the configured port, or empty string.
pid_on_port() {
    # Try lsof first (macOS, full Linux), fall back to fuser (minimal containers)
    if command -v lsof >/dev/null 2>&1; then
        lsof -ti "tcp:${PORT}" -s "tcp:listen" 2>/dev/null | head -1 || true
    elif command -v fuser >/dev/null 2>&1; then
        # fuser often prints a "PORT/tcp:" label before PIDs — take the first
        # numeric token only so --stop never tries to kill a non-PID string.
        fuser "${PORT}/tcp" 2>/dev/null | grep -Eo '[0-9]+' | head -1 || true
    else
        echo ""
    fi
}

read_pid_file() {
    if [[ -f "${PID_FILE}" ]]; then
        tr -d '[:space:]' < "${PID_FILE}" || true
    fi
    return 0
}

write_pid_file() {
    local pid="$1"
    ensure_log_dir
    printf '%s\n' "${pid}" > "${PID_FILE}"
}

clear_pid_file() {
    rm -f "${PID_FILE}" 2>/dev/null || true
}

wait_for_health() {
    # Bound each probe so a hung TCP/connect cannot stall past HEALTH_TIMEOUT.
    local curl_connect_timeout=2
    local curl_max_time=5
    local start=$SECONDS
    local remaining max_time
    echo "Waiting for sidecar health check (up to ${HEALTH_TIMEOUT}s)…"
    while (( SECONDS - start < HEALTH_TIMEOUT )); do
        remaining=$(( HEALTH_TIMEOUT - (SECONDS - start) ))
        if (( remaining < 1 )); then
            break
        fi
        # Cap probe so we never overshoot the wall-clock budget by a full curl_max_time.
        max_time="${curl_max_time}"
        if (( remaining < curl_max_time )); then
            max_time="${remaining}"
        fi
        if curl -sf --connect-timeout "${curl_connect_timeout}" --max-time "${max_time}" \
            "${HEALTH_URL}" >/dev/null 2>&1; then
            echo "Health check passed after $(( SECONDS - start ))s."
            return 0
        fi
        # Only sleep if we still have budget remaining after the probe.
        if (( SECONDS - start >= HEALTH_TIMEOUT )); then
            break
        fi
        sleep 1
    done
    die "Sidecar did not become healthy within ${HEALTH_TIMEOUT}s. Check ${LOG_FILE}"
}

# True when /health looks like this sidecar (200 ready or 503 starting).
health_looks_like_sidecar() {
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 1 --max-time 2 \
        "${HEALTH_URL}" 2>/dev/null || echo "000")"
    [[ "${code}" == "200" || "${code}" == "503" ]]
}

# True when /proc/$pid/cmdline looks like our sidecar entrypoint (Linux).
pid_cmdline_looks_like_sidecar() {
    local pid="$1"
    local cmdline=""
    if [[ -r "/proc/${pid}/cmdline" ]]; then
        cmdline="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)"
    fi
    [[ "${cmdline}" == *dist/server.js* || "${cmdline}" == *src/server.ts* ]]
}

# Confirm pid is safe to signal: numeric, matches port listener when known,
# and (when checkable) cmdline and/or /health look like the sidecar.
confirm_sidecar_pid() {
    local pid="$1"
    local port_pid

    if [[ ! "${pid}" =~ ^[0-9]+$ ]]; then
        return 1
    fi
    if ! kill -0 "${pid}" 2>/dev/null; then
        return 1
    fi

    port_pid="$(pid_on_port | tr -d '[:space:]')"
    if [[ -n "${port_pid}" && "${port_pid}" != "${pid}" ]]; then
        return 1
    fi

    # Prefer positive identity when we can read cmdline; otherwise require
    # matching port listener OR sidecar-shaped /health.
    if [[ -r "/proc/${pid}/cmdline" ]]; then
        if ! pid_cmdline_looks_like_sidecar "${pid}"; then
            return 1
        fi
        return 0
    fi

    if [[ -n "${port_pid}" && "${port_pid}" == "${pid}" ]] && health_looks_like_sidecar; then
        return 0
    fi
    if [[ -n "${port_pid}" && "${port_pid}" == "${pid}" ]]; then
        # Same PID owns the port; accept even if health probe is briefly down during stop.
        return 0
    fi
    return 1
}

# ── Commands ─────────────────────────────────────────────

stop_sidecar() {
    local pid=""
    local candidate
    local port_pid

    candidate="$(read_pid_file)"
    if [[ -n "${candidate}" && "${candidate}" =~ ^[0-9]+$ ]]; then
        pid="${candidate}"
    elif [[ -n "${candidate}" ]]; then
        echo "WARNING: PID file contains non-numeric value (${candidate}); clearing." >&2
        clear_pid_file
    fi

    port_pid="$(pid_on_port | tr -d '[:space:]')"

    # Prefer the live port listener when it disagrees with a stale PID file.
    if [[ -n "${port_pid}" ]]; then
        if [[ -z "${pid}" || "${pid}" != "${port_pid}" ]]; then
            if [[ -n "${pid}" && "${pid}" != "${port_pid}" ]]; then
                echo "WARNING: PID file (${pid}) does not match listener on port ${PORT} (${port_pid}); using port PID." >&2
                clear_pid_file
            fi
            pid="${port_pid}"
        fi
    fi

    if [[ -z "${pid}" ]]; then
        if health_looks_like_sidecar; then
            echo "WARNING: ${HEALTH_URL} still responds but no PID is visible in this namespace." >&2
            echo "Kill the orphan on the host, e.g.: fuser -k ${PORT}/tcp" >&2
            clear_pid_file
            return 1
        fi
        echo "No sidecar running on port ${PORT}."
        clear_pid_file
        return 0
    fi

    if ! confirm_sidecar_pid "${pid}"; then
        echo "WARNING: refusing to kill PID ${pid} — could not verify it is the sidecar on port ${PORT}." >&2
        clear_pid_file
        return 1
    fi

    echo "Stopping sidecar (PID ${pid}) on port ${PORT}…"
    kill "${pid}" 2>/dev/null || true
    # Wait up to 5 seconds for a clean exit.
    local i=0
    while (( i < 50 )); do
        if ! kill -0 "${pid}" 2>/dev/null; then
            clear_pid_file
            echo "Sidecar stopped."
            return 0
        fi
        sleep 0.1
        (( i++ )) || true
    done
    echo "Sending SIGKILL…"
    kill -9 "${pid}" 2>/dev/null || true
    clear_pid_file
    echo "Sidecar killed."
}

ensure_log_dir() {
    mkdir -p -m 700 "${LOG_DIR}"
    # Refuse to write if another user owns the path (symlink / sticky /tmp races).
    if [[ ! -O "${LOG_DIR}" ]]; then
        die "Log directory ${LOG_DIR} is not owned by the current user"
    fi
    chmod 700 "${LOG_DIR}" 2>/dev/null || true
}

start_foreground() {
    echo "Starting sidecar in foreground on ${HOST}:${PORT}"
    echo "Log: ${LOG_FILE}"
    ensure_log_dir
    # Prefer compiled dist/server.js (published package); fall back to tsx+src for local checkout.
    # Do NOT use `exec cmd | tee` — exec only applies to the left of a pipe and leaves the
    # sidecar as a non-PID-1 pipeline member (broken signals / orphan on shell exit).
    # Redirect the shell through tee, then exec the server as this process.
    if [[ -f "${PKG_ROOT}/dist/server.js" ]]; then
        exec > >(tee -a "${LOG_FILE}") 2>&1
        exec env SIDECAR_PORT="${PORT}" SIDECAR_HOST="${HOST}" \
            node "${PKG_ROOT}/dist/server.js"
    elif [[ -f "${PKG_ROOT}/src/server.ts" ]]; then
        exec > >(tee -a "${LOG_FILE}") 2>&1
        exec env SIDECAR_PORT="${PORT}" SIDECAR_HOST="${HOST}" \
            npx tsx "${PKG_ROOT}/src/server.ts"
    else
        die "No sidecar entrypoint found under ${PKG_ROOT} (expected dist/server.js or src/server.ts)"
    fi
}

start_background() {
    ensure_log_dir
    # Refuse to "start" against an already-healthy port we don't own — otherwise
    # wait_for_health succeeds on a foreign/orphan listener and we leave a dead child.
    if curl -sf --connect-timeout 1 --max-time 2 "${HEALTH_URL}" >/dev/null 2>&1; then
        local existing
        existing="$(read_pid_file)"
        if [[ -n "${existing}" ]] && kill -0 "${existing}" 2>/dev/null; then
            die "Sidecar already running on ${HOST}:${PORT} (PID ${existing}). Use --stop first."
        fi
        die "Port ${PORT} already serves ${HEALTH_URL} but no owned PID file. Stop the orphan (fuser -k ${PORT}/tcp) then retry."
    fi

    local pid
    if [[ -f "${PKG_ROOT}/dist/server.js" ]]; then
        nohup env SIDECAR_PORT="${PORT}" SIDECAR_HOST="${HOST}" \
            node "${PKG_ROOT}/dist/server.js" >> "${LOG_FILE}" 2>&1 &
        pid=$!
    elif [[ -f "${PKG_ROOT}/src/server.ts" ]]; then
        nohup env SIDECAR_PORT="${PORT}" SIDECAR_HOST="${HOST}" \
            npx tsx "${PKG_ROOT}/src/server.ts" >> "${LOG_FILE}" 2>&1 &
        pid=$!
    else
        die "No sidecar entrypoint found under ${PKG_ROOT} (expected dist/server.js or src/server.ts)"
    fi
    write_pid_file "${pid}"
    disown "${pid}" 2>/dev/null || disown || true

    # If health never becomes OK, die() would leave this nohup process orphaned.
    # Kill it on any non-zero exit during the startup wait, then clear the trap.
    cleanup_startup() {
        local ec=$?
        if [[ "${ec}" -ne 0 ]] && kill -0 "${pid}" 2>/dev/null; then
            echo "Startup failed (exit=${ec}); killing sidecar PID ${pid}…" >&2
            echo "──── last 40 log lines ────" >&2
            tail -n 40 "${LOG_FILE}" 2>/dev/null >&2 || true
            echo "───────────────────────────" >&2
            kill "${pid}" 2>/dev/null || true
            sleep 1
            kill -9 "${pid}" 2>/dev/null || true
            clear_pid_file
        fi
    }
    trap cleanup_startup EXIT

    wait_for_health
    # Confirm our child still owns the process — not a race against a foreign listener.
    if ! kill -0 "${pid}" 2>/dev/null; then
        clear_pid_file
        die "Sidecar PID ${pid} exited during startup (port may already be in use). Check ${LOG_FILE}"
    fi
    trap - EXIT

    echo "──────────────────────────────────────"
    echo "pi-sidecar running"
    echo "  URL : http://$(host_for_url "${HOST}"):${PORT}"
    echo "  PID : ${pid}"
    echo "  Log : ${LOG_FILE}"
    echo "  Pidfile: ${PID_FILE}"
    echo "──────────────────────────────────────"
}

# ── Main ─────────────────────────────────────────────────

main() {
    local foreground=false
    local stop=false

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --foreground) foreground=true ;;
            --stop)       stop=true ;;
            -h|--help)    usage; exit 0 ;;
            *)            die "Unknown option: $1 (see --help)" ;;
        esac
        shift
    done

    if "${stop}"; then
        stop_sidecar
        exit 0
    fi

    # Guard: port must be free.
    local existing_pid
    existing_pid="$(pid_on_port)"
    if [[ -n "${existing_pid}" ]]; then
        die "Port ${PORT} is already in use (PID ${existing_pid}). Stop it first with: $0 --stop"
    fi

    if "${foreground}"; then
        start_foreground
    else
        start_background
    fi
}

main "$@"
