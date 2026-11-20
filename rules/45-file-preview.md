# File Preview

When generating or modifying HTML, frontend, or browser-viewable files under `$PWD` or `${PROJECT_TMP_DIR}`: find a free port and launch
`HTTPD="$HOME/.pi/agent/npm/node_modules/pi-orchestrator-config/scripts/httpd.py"; PORT=$(uv run python3 "$HTTPD" --find-port); nohup uv run python3 "$HTTPD" --port
"$PORT" --dir /path/to/serve > "${PROJECT_TMP_DIR}/httpd-$PORT.log" 2>&1 & disown`, share `http://localhost:<port>/<filename>`, and keep it running until the user
confirms they are done previewing.
