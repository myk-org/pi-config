import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WebSocketServer } from "ws";
import * as rootReact from "react";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import * as pidashReact from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { act, createElement } from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { createRoot, type Root } from "../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js";
import { isLocalDaemonHost, registerPidash, resolvePidashHost } from "../../../extensions/pidash/pidash.ts";
import { resolvePidiffHost, resolvePidiffPortOverride } from "../../../extensions/pidiff/pidiff.ts";
import { clearSettingsCache, setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.ts";
import { isLoopbackAddress, registerPidashSession, type PiClient } from "../../../scripts/pidash-session-state.ts";
import fs from "node:fs";
import os from "node:os";
import type { SessionInfo } from "../../../extensions/shared/types.ts";
import { elements, installReactDomShim } from "./react-dom-shim.mjs";

let vite: ViteDevServer;
let InfoBar: any;
let ComsPanel: any;

before(async () => {
  vite = await createViteServer({
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

  it("treats localhost as a local loopback host for PiDash auto-spawn", () => {
    assert.equal(isLocalDaemonHost("localhost"), true);
    assert.equal(isLocalDaemonHost("127.0.0.1"), true);
    assert.equal(isLocalDaemonHost("::1"), true);
  });

  it("treats alternate 127.0.0.0/8 IPv4 loopback addresses as local for PiDash auto-spawn", () => {
    assert.equal(isLocalDaemonHost("127.0.0.2"), true);
    assert.equal(isLocalDaemonHost("127.255.255.254"), true);
    assert.equal(isLocalDaemonHost("127.256.0.1"), false);
    assert.equal(isLocalDaemonHost("192.168.1.10"), false);
  });

  it("disables PiDash auto-spawn for host.containers.internal", () => {
    assert.equal(isLocalDaemonHost("host.containers.internal"), false);
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

  it("keeps scripts/pidiff-server.ts strictly bound to host loopback 127.0.0.1", () => {
    const src = fs.readFileSync(path.resolve("scripts", "pidiff-server.ts"), "utf8");
    assert.match(src, /listenAddress:\s*"127\.0\.0\.1"/);
    assert.doesNotMatch(src, /PI_PIDIFF_LISTEN_HOST/);
    assert.doesNotMatch(src, /PI_PIDIFF_AUTH_TOKEN/);
    assert.equal(isLoopbackAddress("192.168.1.50"), false);
    assert.equal(isLoopbackAddress("127.0.0.1"), true);
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
  async function runRegisterPidashProbe(envOverrides: { host: string; containerName?: string }) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pidash-reg-env-"));
    const prevEnv: Record<string, string | undefined> = {
      PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
      PI_COMS_SUPERVISED_PEER: process.env.PI_COMS_SUPERVISED_PEER,
      PI_PIDASH_HOST: process.env.PI_PIDASH_HOST,
      PI_PIDASH_PORT: process.env.PI_PIDASH_PORT,
      PI_COMS_CONTAINER_NAME: process.env.PI_COMS_CONTAINER_NAME,
    };

    let healthHostHeader = "";
    let wsHostHeader = "";
    const server: Server = createServer((req, res) => {
      if (req.url === "/api/health") {
        healthHostHeader = String(req.headers.host || "");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      if (req.url === "/ws/pi") {
        wsHostHeader = String(req.headers.host || "");
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      } else {
        socket.destroy();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr !== "string");

    const registerPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for register frame")), 4000);
      timer.unref();
      wss.on("connection", (ws) => {
        ws.on("message", (raw) => {
          const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (parsed.type === "register") {
            clearTimeout(timer);
            resolve(parsed);
          }
        });
      });
    });

    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
    const pi = {
      events: new EventEmitter(),
      on: (name: string, fn: (event: unknown, ctx: unknown) => void) => {
        const list = handlers.get(name) ?? [];
        list.push(fn);
        handlers.set(name, list);
      },
      registerCommand: () => {},
      getThinkingLevel: () => "medium",
      getFlag: () => undefined,
    } as unknown as ExtensionAPI;

    try {
      setGlobalSettingsPath(path.join(tmpDir, "global.json"));
      clearSettingsCache();
      delete process.env.PI_SUBAGENT_CHILD;
      process.env.PI_COMS_SUPERVISED_PEER = "1";
      process.env.PI_PIDASH_HOST = envOverrides.host;
      process.env.PI_PIDASH_PORT = String(addr.port);
      if (envOverrides.containerName) process.env.PI_COMS_CONTAINER_NAME = envOverrides.containerName;
      else delete process.env.PI_COMS_CONTAINER_NAME;

      registerPidash(pi, {
        fetchGitStatus: async () => ({ branch: "main", dirty: false, changes: 0 }),
        fetchWorktreeSummary: async () => ({ worktreeCount: 0, worktreeDirtyCount: 0, inLinkedWorktree: false }),
      });

      const ctx = {
        mode: "rpc",
        hasUI: false,
        cwd: tmpDir,
        model: null,
        sessionManager: { getEntries: () => [], getSessionFile: () => "" },
      };
      for (const h of handlers.get("session_start") ?? []) h({ reason: "startup" }, ctx);

      const frame = await registerPromise;
      for (const h of handlers.get("session_shutdown") ?? []) h({}, ctx);
      return { healthHostHeader, wsHostHeader, frame };
    } finally {
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      setGlobalSettingsPath(null);
      clearSettingsCache();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

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

  it("forwards PI_PIDASH_HOST on HTTP health probe via registerPidash", async () => {
    const { healthHostHeader } = await runRegisterPidashProbe({ host: "localhost" });
    assert.ok(healthHostHeader.startsWith("localhost:"), `expected localhost host header, got ${healthHostHeader}`);
  });

  it("forwards PI_PIDASH_HOST on WebSocket upgrade via registerPidash", async () => {
    const { wsHostHeader } = await runRegisterPidashProbe({ host: "localhost" });
    assert.ok(wsHostHeader.startsWith("localhost:"), `expected localhost ws host header, got ${wsHostHeader}`);
  });

  it("forwards PI_COMS_CONTAINER_NAME in register payload via registerPidash", async () => {
    const { frame } = await runRegisterPidashProbe({ host: "127.0.0.1", containerName: "pi-peer-reg-test-12345678" });
    assert.equal(frame.container, true);
    assert.equal(frame.containerName, "pi-peer-reg-test-12345678");
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
