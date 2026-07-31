#!/bin/bash
# NOTE: Use tini as PID 1 (ENTRYPOINT ["tini", "--", "/app/entrypoint.sh"])
# Without tini, signals won't reach the app process for graceful shutdown.
set -euo pipefail

# =============================================================================
# Pi-Sidecar Example Entrypoint
#
# Starts the sidecar in background, waits for health, then starts your app.
# Copy this to your project and adapt the last section for your application.
# =============================================================================

# ---------------------------------------------------------------------------
# Start Pi SDK sidecar
# ---------------------------------------------------------------------------
export SIDECAR_PORT="${SIDECAR_PORT:-9100}"

if [ -f /app/sidecar-helper/dist/server.js ]; then
    node /app/sidecar-helper/dist/server.js &
    SIDECAR_PID=$!
    echo "[sidecar] Started (PID $SIDECAR_PID) on port $SIDECAR_PORT"

    # Lifecycle coupling: kill sidecar when app exits
    trap 'kill $SIDECAR_PID 2>/dev/null; wait $SIDECAR_PID 2>/dev/null' EXIT

    # Monitor: if sidecar dies unexpectedly, kill the container
    (trap 'exit 0' TERM
     while kill -0 $SIDECAR_PID 2>/dev/null; do sleep 5; done
     echo "[sidecar] Sidecar died, shutting down container"
     kill 1 2>/dev/null) &

    # Wait for health (up to 15s)
    echo "[sidecar] Waiting for health check..."
    for i in $(seq 1 30); do
        if curl -sf "http://127.0.0.1:${SIDECAR_PORT}/health" > /dev/null 2>&1; then
            echo "[sidecar] Health check passed"
            break
        fi
        sleep 0.5
    done

    if ! curl -sf "http://127.0.0.1:${SIDECAR_PORT}/health" > /dev/null 2>&1; then
        echo "[sidecar] ERROR: not healthy after 15s — aborting" >&2
        exit 1
    fi
else
    echo "[sidecar] WARNING: sidecar-helper/dist/server.js not found, AI features unavailable"
fi

# ---------------------------------------------------------------------------
# Start your application
#
# Run in background + wait so the shell can forward signals.
# The EXIT trap cleans up the sidecar; SIGTERM is forwarded to the app.
# ---------------------------------------------------------------------------
export PORT="${PORT:-8000}"

# Replace this with your application start command:
uv run --no-sync uvicorn your_app.main:app --host 0.0.0.0 --port "$PORT" &
APP_PID=$!

# Forward signals to the app process (main wait below handles reaping)
trap 'kill -TERM $APP_PID 2>/dev/null || true' TERM
trap 'kill -INT $APP_PID 2>/dev/null || true' INT

# Wait for app to exit
wait $APP_PID
