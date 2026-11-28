import assert from "node:assert/strict";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import * as rootReact from "react";
import { createServer, type ViteDevServer } from "vite";
import * as pidashReact from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { act, createElement } from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { createRoot, type Root } from "../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js";
import { resolvePidashHost } from "../../../extensions/pidash/pidash.ts";
import { resolvePidiffHost } from "../../../extensions/pidiff/pidiff.ts";
import { registerPidashSession, type PiClient } from "../../../scripts/pidash-session-state.ts";
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
