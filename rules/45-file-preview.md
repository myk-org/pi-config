# File Preview

When generating or modifying HTML, frontend, or any browser-viewable files:

1. Save the file under the project directory (`$PWD`) or `/tmp/pi-work/`
2. Serve it using a Python script that ignores SIGHUP (survives shell cleanup):

   ```bash
   uv run python3 -c "
   import signal, http.server, socketserver
   signal.signal(signal.SIGHUP, signal.SIG_IGN)
   socketserver.TCPServer.allow_reuse_address = True
   with socketserver.TCPServer(('', PORT), http.server.SimpleHTTPRequestHandler) as s:
       s.serve_forever()
   " &
   ```

   To find a free port, ask the OS:

   ```bash
   uv run python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()"
   ```

   Use the printed port number as `PORT`.

3. Tell the user:

   > File is being served at `http://localhost:<port>/<filename>` — open this URL in your browser.

4. Keep the server running until the user confirms they're done previewing.

**Why not `python -m http.server`?** The `uv run` wrapper creates a parent
process chain. When bash background job cleanup runs, the parent `uv` process
gets killed, taking the Python child with it. The `signal.SIGHUP` ignore
prevents this.

This works in containers (`--network host`) and native installs.
