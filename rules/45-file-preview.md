# File Preview (Container)

When generating or modifying HTML, frontend, or any browser-viewable files inside a container:

1. Save the file under the project directory (`$PWD`) or `/tmp/pi-work/`
2. Serve it using:

   ```bash
   uv run python -m http.server <port> --directory <dir>
   ```

   Use port `8080` by default. If the port is in use, try `8081`, `8082`, etc.

3. Tell the user:

   > File is being served at `http://localhost:<port>/<filename>` — open this URL in your browser.

4. Keep the server running until the user confirms they're done previewing.

This works because the container uses `--network host`, so the host can reach services on any port.
