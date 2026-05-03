#!/usr/bin/env python3
"""Simple HTTP file server for pi file preview."""

import argparse
import http.server
import os
import signal
import socket
import sys


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        return s.getsockname()[1]


def serve(port: int, directory: str, bind: str) -> None:
    if not os.path.isdir(directory):
        print(f"Error: {directory} is not a directory", file=sys.stderr)
        sys.exit(1)
    os.chdir(directory)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)

    handler = http.server.SimpleHTTPRequestHandler
    httpd = http.server.HTTPServer((bind, port), handler)

    print(f"Serving {directory} on http://localhost:{port} (bind {bind})")
    sys.stdout.flush()
    httpd.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description="Simple HTTP file server for pi file preview.")
    parser.add_argument("--port", type=int, help="Port to serve on")
    parser.add_argument("--dir", type=str, help="Directory to serve")
    parser.add_argument("--bind", type=str, default="127.0.0.1", help="Address to bind (default: 127.0.0.1)")
    parser.add_argument("--find-port", action="store_true", help="Print a free port and exit")
    args = parser.parse_args()

    if args.find_port:
        print(find_free_port())
        return

    if args.port is None or args.dir is None:
        parser.error("--port and --dir are required unless --find-port is used")

    serve(args.port, args.dir, args.bind)


if __name__ == "__main__":
    main()
