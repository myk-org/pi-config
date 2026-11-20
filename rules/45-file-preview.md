# File Preview

When generating or modifying HTML, frontend, or browser-viewable files:

1. Save them under `$PWD` or `${PROJECT_TMP_DIR}`.
2. Replace `/path/to/serve` with the directory containing the file, pick a free port, and start the server (`nohup` and `disown` protect it from `SIGHUP` when `uv run` is the
   parent):

   ```bash
   HTTPD="$HOME/.pi/agent/npm/node_modules/pi-orchestrator-config/scripts/httpd.py"
   PORT=$(uv run python3 "$HTTPD" --find-port)
   nohup uv run python3 "$HTTPD" --port "$PORT" --dir /path/to/serve > "${PROJECT_TMP_DIR}/httpd-$PORT.log" 2>&1 &
   disown
   sleep 0.5
   if ! kill -0 $! 2>/dev/null; then echo "Server failed to start:"; cat "${PROJECT_TMP_DIR}/httpd-$PORT.log"; fi
   ```

3. Share `http://localhost:<port>/<filename>` **only if `kill -0 $!` succeeded** (on failure, print `${PROJECT_TMP_DIR}/httpd-$PORT.log` and report the error instead). Keep
   running until the user confirms they are done previewing.
