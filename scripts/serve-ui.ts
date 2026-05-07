/**
 * Shared static UI serving for daemon servers (pidash, pidiff).
 * Handles file serving, SPA fallback, and auto-build when dist/ is missing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { ServerResponse } from "node:http";

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "application/javascript",
  ".css": "text/css", ".json": "application/json",
  ".woff2": "font/woff2", ".woff": "font/woff",
  ".svg": "image/svg+xml", ".png": "image/png",
};

export interface ServeUiOptions {
  /** Absolute path to the dist/ directory */
  uiDir: string;
  /** Name for logging (e.g., "pidash-ui", "pidiff-ui") */
  name: string;
  /** Logger function */
  log: (msg: string) => void;
}

/**
 * Serve a static file from the UI dist directory.
 * Handles SPA fallback (serves index.html for unknown routes) and
 * auto-builds the UI if dist/ is missing.
 */
export function serveUi(
  pathname: string,
  res: ServerResponse,
  opts: ServeUiOptions,
): void {
  const filePath = pathname === "/" ? "/index.html" : pathname;
  const absPath = path.resolve(path.join(opts.uiDir, filePath));

  // Security: prevent directory traversal
  if (!absPath.startsWith(path.resolve(opts.uiDir))) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = fs.readFileSync(absPath);
    const ext = path.extname(absPath).toLowerCase();
    const headers: Record<string, string> = {
      "Content-Type": MIME[ext] || "application/octet-stream",
    };
    // No cache for HTML, long cache for hashed assets
    if (ext === ".html") {
      headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
    } else if (filePath.includes("/assets/")) {
      headers["Cache-Control"] = "public, max-age=31536000, immutable";
    }
    res.writeHead(200, headers);
    res.end(data);
  } catch (err: any) {
    // SPA fallback — only for missing files; log other errors
    if (err?.code && err.code !== "ENOENT") {
      opts.log(`static file error: ${absPath} (${err.code})`);
    }
    try {
      const html = fs.readFileSync(path.join(opts.uiDir, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } catch (err: any) {
      // dist/ missing or unreadable — try to build it
      if (err?.code && err.code !== "ENOENT") {
        opts.log(`index.html unreadable: ${err.code}, attempting build`);
      }
      const uiSrcDir = path.join(opts.uiDir, "..");
      if (fs.existsSync(path.join(uiSrcDir, "package.json"))) {
        try {
          opts.log(`dist/ missing, building ${opts.name}...`);
          execSync("npm install --production=false && npm run build", {
            cwd: uiSrcDir,
            stdio: "ignore",
            timeout: 60000,
          });
          opts.log(`${opts.name} build complete`);
          const html = fs.readFileSync(path.join(opts.uiDir, "index.html"));
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(html);
          return;
        } catch (buildErr: any) {
          opts.log(`${opts.name} build failed: ${buildErr.message}`);
        }
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<h1>${opts.name.replace("-ui", "")}</h1><p>UI build failed. Run <code>/${opts.name.replace("-ui", "")} restart</code> from the pi TUI, then refresh this page.</p>`);
    }
  }
}
