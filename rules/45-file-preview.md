# File Preview

When generating or modifying HTML, frontend, or any browser-viewable files:

1. Save the file under the project directory (`$PWD`) or `/tmp/pi-work/`
2. Find a free port and launch the server:

   ```bash
   HTTPD=~/.pi/agent/git/github.com/myk-org/pi-config/scripts/httpd.py
   PORT=$(uv run python3 $HTTPD --find-port)
   nohup uv run python3 $HTTPD --port $PORT --dir /path/to/serve > /tmp/httpd-$PORT.log 2>&1 &
   disown
   sleep 0.5
   if ! kill -0 $! 2>/dev/null; then echo "Server failed to start:"; cat /tmp/httpd-$PORT.log; fi
   ```

   Replace `/path/to/serve` with the directory containing the files.

3. Tell the user:

   > File is being served at `http://localhost:<port>/<filename>` — open this URL in your browser.

4. Keep the server running until the user confirms they're done previewing.

**Why `nohup` + `disown`?** `uv run` creates a parent process chain. When bash
cleans up background jobs, it kills the `uv` parent. `nohup` protects from
SIGHUP, `disown` removes it from bash's job table.

This works in containers (`--network host`) and native installs.
