import assert from "node:assert/strict";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import * as rootReact from "react";
import { createServer, type ViteDevServer } from "vite";
import * as pidashReact from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { act, createElement } from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { createRoot, type Root } from "../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js";
import { resolvePidashHost } from "../../../extensions/pidash/pidash.ts";
import { resolvePidiffHost, resolvePidiffPortOverride } from "../../../extensions/pidiff/pidiff.ts";
import { isLoopbackAddress, registerPidashSession, type PiClient } from "../../../scripts/pidash-session-state.ts";
import { createDaemonServer } from "../../../scripts/daemon-shared.ts";
import { WebSocket } from "ws";
import fs from "node:fs";
import os from "node:os";
import type { SessionInfo } from "../../../extensions/shared/types.ts";
import { elements, installReactDomShim } from "./react-dom-shim.mjs";

let vite: ViteDevServer;
let InfoBar: any;
let ComsPanel: any;

before(async () => {
  vite = await createServer({
    root: path.resolve("extensions/pidash/pidash-ui"),
    server: { middlewareMode: true },
    appType: "custom",
  });
  ({ InfoBar } = await vite.ssrLoadModule("/src/components/InfoBar.tsx"));
  ({ ComsPanel } = await vite.ssrLoadModule("/src/components/ComsPanel.tsx"));
});

after(() => vite.close());

const rootInternals = (rootReact as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const pidashInternals = (pidashReact as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
for (const key of ["H", "A", "T"]) {
  Object.defineProperty(rootInternals, key, {
    configurable: true,
    get: () => pidashInternals[key],
    set: (value) => { pidashInternals[key] = value; },
  });
}

const mounted: Root[] = [];
afterEach(async () => {
  while (mounted.length) await act(async () => mounted.pop()!.unmount());
});

describe("Native daemon host resolution", () => {
  it("defaults resolvePidashHost to 127.0.0.1", () => {
    assert.equal(resolvePidashHost({}), "127.0.0.1");
  });

  it("honors PI_PIDASH_HOST override", () => {
    assert.equal(resolvePidashHost({ PI_PIDASH_HOST: "host.containers.internal" }), "host.containers.internal");
  });

  it("defaults resolvePidiffHost to 127.0.0.1", () => {
    assert.equal(resolvePidiffHost({}), "127.0.0.1");
  });

  it("honors PI_PIDIFF_HOST override", () => {
    assert.equal(resolvePidiffHost({ PI_PIDIFF_HOST: "host.containers.internal" }), "host.containers.internal");
  });

  it("parses valid PI_PIDIFF_PORT override", () => {
    assert.equal(resolvePidiffPortOverride({ PI_PIDIFF_PORT: "19290" }), 19290);
    assert.equal(resolvePidiffPortOverride({ PI_PIDIFF_PORT: "0" }), null);
    assert.equal(resolvePidiffPortOverride({}), null);
  });

  it("rejects unauthenticated requests when allowRequest enforces bearer token", async () => {
    const expectedToken = "host-issued-test-token"; // pragma: allowlist secret
    const daemon = createDaemonServer({
      port: 0,
      uiDir: os.tmpdir(),
      uiName: "test-ui",
      log: () => {},
      allowRequest: (pathname, _remoteAddress, req) => {
        if (pathname !== "/api/health" && pathname !== "/ws/pi") return false;
        return req.headers["x-pidiff-token"] === expectedToken;
      },
      onPiMessage: () => {},
      onPiClose: () => {},
    });
    await new Promise<void>((resolve) => daemon.server.listen(0, "127.0.0.1", resolve));
    try {
      const addr = daemon.server.address() as { port: number };
      const deniedHttp = await fetch(`http://127.0.0.1:${addr.port}/api/health`);
      assert.equal(deniedHttp.status, 403);

      const allowedHttp = await fetch(`http://127.0.0.1:${addr.port}/api/health`, {
        headers: { "x-pidiff-token": expectedToken },
      });
      assert.equal(allowedHttp.status, 200);

      const deniedWs = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws/pi`);
        ws.once("unexpected-response", (_req, res) => resolve(res.statusCode === 403));
        ws.once("open", () => { ws.close(); resolve(false); });
        ws.once("error", () => resolve(true));
      });
      assert.equal(deniedWs, true);

      const allowedWs = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws/pi`, {
          headers: { "x-pidiff-token": expectedToken },
        });
        ws.once("open", () => { ws.close(); resolve(true); });
        ws.once("error", () => resolve(false));
      });
      assert.equal(allowedWs, true);

      assert.equal(isLoopbackAddress("192.168.1.50"), false);
      assert.equal(isLoopbackAddress("127.0.0.1"), true);
    } finally {
      await new Promise<void>((resolve) => daemon.server.close(() => resolve()));
    }
  });
});

describe("Standalone daemon zero-TUI runtime import boundary", () => {
  function collectTransitiveRuntimeImports(entryFile: string): string[] {
    const visited = new Set<string>();
    const externalPackages = new Set<string>();
    const queue = [path.resolve(entryFile)];

    // Match runtime `import ... from "..."` and `export ... from "..."` (skipping `import type` / `export type`).
    const specRe = /^\s*(?:import|export)\s+(?!type\b)[\s\S]*?\bfrom\s+["']([^"']+)["']/gm;

    while (queue.length > 0) {
      const current = queue.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      if (!fs.existsSync(current)) continue;
      const src = fs.readFileSync(current, "utf8");
      for (const match of src.matchAll(specRe)) {
        const spec = match[1];
        if (!spec) continue;
        if (spec.startsWith("node:")) continue;
        if (!spec.startsWith(".")) {
          externalPackages.add(spec);
          continue;
        }
        const dir = path.dirname(current);
        const base = path.resolve(dir, spec);
        const candidates = [
          base,
          base.replace(/\.js$/, ".ts"),
          base.replace(/\.js$/, ".mjs"),
          `${base}.ts`,
          `${base}.mjs`,
        ];
        const resolved = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
        if (resolved) queue.push(resolved);
      }
    }
    return [...externalPackages].sort();
  }

  it("keeps scripts/pidash-server.ts free of transitive @earendil-works/pi-tui runtime imports", () => {
    const externals = collectTransitiveRuntimeImports("scripts/pidash-server.ts");
    assert.equal(externals.some((pkg) => pkg.startsWith("@earendil-works/pi-tui")), false, `unexpected pi-tui import: ${externals.join(", ")}`);
    assert.equal(externals.some((pkg) => pkg.startsWith("@earendil-works/pi-coding-agent")), false, `unexpected pi-coding-agent import: ${externals.join(", ")}`);
  });

  it("keeps extensions/coms/coms-registry.ts free of transitive @earendil-works/pi-tui runtime imports", () => {
    const externals = collectTransitiveRuntimeImports("extensions/coms/coms-registry.ts");
    assert.equal(externals.some((pkg) => pkg.startsWith("@earendil-works/pi-tui")), false, `unexpected pi-tui import: ${externals.join(", ")}`);
    assert.equal(externals.some((pkg) => pkg.startsWith("@earendil-works/pi-coding-agent")), false, `unexpected pi-coding-agent import: ${externals.join(", ")}`);
  });
});

describe("PiDash session container metadata", () => {
  it("preserves containerName in registerPidashSession", () => {
    const sessions = new Map<string, PiClient>();
    const client = registerPidashSession(
      sessions,
      { send() {} },
      {
        type: "register",
        sessionId: "sess-ctr",
        pid: 42,
        cwd: "/tmp/work",
        container: true,
        containerName: "pi-peer-demo-worker",
      },
      () => {},
    );
    assert.equal(client.session.container, true);
    assert.equal(client.session.containerName, "pi-peer-demo-worker");
  });
});

describe("PiDash container badges", () => {
  it("renders containerName badge in InfoBar", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);
    const sess: SessionInfo = {
      sessionId: "s1",
      pid: 100,
      cwd: "/tmp/work",
      branch: "main",
      model: "test-model",
      startedAt: "2026-11-28T00:00:00.000Z",
      lastActivity: 0,
      active: true,
      container: true,
      containerName: "pi-peer-demo-worker",
    };
    await act(async () => {
      root.render(createElement(InfoBar, {
        session: sess,
        model: sess.model,
        tokens: null,
        send: () => {},
        onMessage: () => () => {},
        activePanel: null,
        onOpenPanel: () => {},
        onCompact: () => {},
      }));
    });
    const badge = elements(container, "span").find((el) => el.getAttribute("data-testid") === "pidash-container-badge");
    assert.ok(badge, "expected container badge in InfoBar");
    assert.match(badge.textContent, /pi-peer-demo-worker/);
  });

  it("renders container badge for containerized peers in ComsPanel", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);
    let handler: ((data: any) => void) | null = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false })) as any;
    try {
      await act(async () => {
        root.render(createElement(ComsPanel, {
          sendCmd: () => {},
          onMessage: (fn: (data: any) => void) => {
            handler = fn;
            return () => {};
          },
          notify: () => {},
          sessions: [],
        }));
      });
      await act(async () => {
        handler?.({
          type: "coms-peers",
          self: { name: "main", project: "demo" },
          peers: [
            {
              name: "worker",
              purpose: "sandboxed",
              model: "m",
              busy: false,
              queueDepth: 0,
              contextUsedPct: 15,
              container: "pi-peer-demo-worker",
            },
          ],
        });
      });
      const badge = elements(container, "span").find((el) => el.getAttribute("data-testid") === "coms-peer-container-badge");
      assert.ok(badge, "expected container badge in ComsPanel");
      assert.match(badge.textContent, /pi-peer-demo-worker/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
