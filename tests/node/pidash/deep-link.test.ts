/**
 * #1537 — Focused single-behavior unit and component tests for PiDash URL deep-linking
 * (`?session=<sessionId>`, `?peer=<comsName>`, optional `&project=<comsProject>`).
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import * as rootReact from "react";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import * as pidashReact from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { act, createElement } from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import type { Root } from "../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js";
import {
  DEEP_LINK_INACTIVE_PEER_SETTLE_MS,
  isDefinitiveDeepLinkMatch,
  matchDeepLinkSession,
  parsePidashDeepLink,
} from "../../../extensions/pidash/pidash-ui/src/lib/pidash-ux-helpers.ts";
import type { SessionInfo } from "../../../extensions/shared/types.ts";
import { elements, installReactDomShim } from "./react-dom-shim.mjs";

let vite: ViteDevServer;
let createRoot: (container: Element) => Root;
let App: any;

before(async () => {
  installReactDomShim();
  ({ createRoot } = await import("../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js"));
  vite = await createViteServer({
    root: path.resolve("extensions/pidash/pidash-ui"),
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  ({ App } = await vite.ssrLoadModule("/src/App.tsx"));
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

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  emitOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emitMessage(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

const mounted: Root[] = [];
const originalLocalStorage = globalThis.localStorage;
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const originalLocation = globalThis.location;

afterEach(async () => {
  while (mounted.length) await act(async () => mounted.pop()!.unmount());
  FakeWebSocket.instances = [];
  if (originalLocalStorage === undefined) {
    delete (globalThis as any).localStorage;
  } else {
    Object.defineProperty(globalThis, "localStorage", { value: originalLocalStorage, configurable: true, writable: true });
  }
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  if (originalLocation === undefined) {
    delete (globalThis as any).location;
  } else {
    Object.defineProperty(globalThis, "location", { value: originalLocation, configurable: true, writable: true });
  }
});

function installMockStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  return map;
}

function makeSession(sessionId: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId,
    pid: 1000,
    cwd: "/home/dev/git/pi-config",
    branch: "main",
    model: "Gemini 4 Neon",
    startedAt: "2026-01-01T00:00:00Z",
    lastActivity: 1000,
    active: true,
    activity: "idle",
    ...overrides,
  };
}

function watchedSessionIds(ws: FakeWebSocket): string[] {
  return ws.sent
    .filter((msg) => msg.type === "watch" && typeof msg.sessionId === "string")
    .map((msg) => msg.sessionId as string);
}

async function mountApp(opts: {
  search: string;
  initialSessions: SessionInfo[];
  storage?: Record<string, string>;
}) {
  const { container, document: doc } = installReactDomShim();
  const origCreateElement = doc.createElement;
  doc.createElement = (tag: string) => {
    const el = origCreateElement(tag);
    if (String(tag).toLowerCase() === "select") {
      Object.defineProperty(el, "options", {
        get: () => Array.from(el.childNodes).filter((c: any) => c.tagName === "OPTION"),
      });
    }
    return el;
  };
  installMockStorage(opts.storage ?? {});
  Object.defineProperty(globalThis, "location", {
    value: { protocol: "http:", host: "127.0.0.1:19190", search: opts.search },
    configurable: true,
    writable: true,
  });
  let currentSessions = opts.initialSessions;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => currentSessions.map((s) => ({ ...s })),
  })) as unknown as typeof fetch;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(createElement(App));
  });
  const ws = FakeWebSocket.instances.at(-1)!;
  await act(async () => {
    ws.emitOpen();
  });
  // Flush microtasks so /api/sessions fetch + restore effect settle.
  await act(async () => {
    await Promise.resolve();
  });
  return {
    container,
    ws,
    setSessions: (next: SessionInfo[]) => { currentSessions = next; },
  };
}

describe("parsePidashDeepLink (#1537)", () => {
  it("parses the session query parameter", () => {
    assert.deepEqual(parsePidashDeepLink("?session=123:/work/app"), { session: "123:/work/app" });
  });

  it("parses the peer query parameter", () => {
    assert.deepEqual(parsePidashDeepLink("?peer=peer-1537"), { peer: "peer-1537" });
  });

  it("parses peer with a project disambiguator", () => {
    assert.deepEqual(
      parsePidashDeepLink("?peer=peer-1537&project=home__myakove__git__pi-config"),
      { peer: "peer-1537", project: "home__myakove__git__pi-config" },
    );
  });

  it("trims whitespace from deep-link parameter values", () => {
    assert.deepEqual(
      parsePidashDeepLink("?session=%20s-1%20&peer=%20worker%20&project=%20proj-a%20"),
      { session: "s-1", peer: "worker", project: "proj-a" },
    );
  });

  it("parses a query string without a leading question mark", () => {
    assert.deepEqual(parsePidashDeepLink("peer=worker&project=proj-a"), { peer: "worker", project: "proj-a" });
  });

  it("returns null for an empty query string", () => {
    assert.equal(parsePidashDeepLink(""), null);
    assert.equal(parsePidashDeepLink("?"), null);
    assert.equal(parsePidashDeepLink(null), null);
    assert.equal(parsePidashDeepLink(undefined), null);
  });

  it("returns null for whitespace-only deep-link parameters", () => {
    assert.equal(parsePidashDeepLink("?session=%20%20&peer=%09"), null);
  });

  it("returns null when only project is provided without session or peer", () => {
    assert.equal(parsePidashDeepLink("?project=home__myakove__git__pi-config"), null);
  });

  it("returns null for unrelated query parameters", () => {
    assert.equal(parsePidashDeepLink("?foo=bar&baz=1"), null);
  });
});

describe("matchDeepLinkSession (#1537)", () => {
  it("matches an exact sessionId", () => {
    const s1 = makeSession("s1");
    const s2 = makeSession("s2");
    assert.equal(matchDeepLinkSession([s1, s2], { session: "s2" })?.sessionId, "s2");
  });

  it("prioritizes exact sessionId over peer when both are present", () => {
    const byId = makeSession("s-exact", { comsName: "other" });
    const byPeer = makeSession("s-peer", { comsName: "target-peer" });
    assert.equal(
      matchDeepLinkSession([byPeer, byId], { session: "s-exact", peer: "target-peer" })?.sessionId,
      "s-exact",
    );
  });

  it("falls back to peer when sessionId is missing from the session list", () => {
    const byPeer = makeSession("s-peer", { comsName: "target-peer", comsProject: "proj-a" });
    assert.equal(
      matchDeepLinkSession([byPeer], { session: "missing", peer: "target-peer", project: "proj-a" })?.sessionId,
      "s-peer",
    );
  });

  it("matches a peer by comsName when no project filter is specified", () => {
    const s1 = makeSession("s1", { comsName: "alpha" });
    const s2 = makeSession("s2", { comsName: "beta" });
    assert.equal(matchDeepLinkSession([s1, s2], { peer: "beta" })?.sessionId, "s2");
  });

  it("prefers an active peer over an inactive peer with the same comsName", () => {
    const inactive = makeSession("s-old", { comsName: "worker", active: false });
    const active = makeSession("s-live", { comsName: "worker", active: true });
    assert.equal(matchDeepLinkSession([inactive, active], { peer: "worker" })?.sessionId, "s-live");
  });

  it("selects an inactive peer when no active peer shares the comsName", () => {
    const inactive = makeSession("s-old", { comsName: "worker", active: false });
    assert.equal(matchDeepLinkSession([inactive], { peer: "worker" })?.sessionId, "s-old");
  });

  it("disambiguates same-named peers using exact comsProject", () => {
    const projA = makeSession("s-a", { comsName: "worker", comsProject: "proj-a", active: true });
    const projB = makeSession("s-b", { comsName: "worker", comsProject: "proj-b", active: false });
    assert.equal(
      matchDeepLinkSession([projA, projB], { peer: "worker", project: "proj-b" })?.sessionId,
      "s-b",
    );
  });

  it("prefers an active peer within the matching comsProject", () => {
    const inactiveB = makeSession("s-b-old", { comsName: "worker", comsProject: "proj-b", active: false });
    const activeB = makeSession("s-b-live", { comsName: "worker", comsProject: "proj-b", active: true });
    const activeA = makeSession("s-a-live", { comsName: "worker", comsProject: "proj-a", active: true });
    assert.equal(
      matchDeepLinkSession([activeA, inactiveB, activeB], { peer: "worker", project: "proj-b" })?.sessionId,
      "s-b-live",
    );
  });

  it("returns null when comsName exists only in a different comsProject", () => {
    const projA = makeSession("s-a", { comsName: "worker", comsProject: "proj-a", active: true });
    assert.equal(matchDeepLinkSession([projA], { peer: "worker", project: "proj-b" }), null);
  });

  it("returns null cleanly when no session matches the target", () => {
    const s1 = makeSession("s1", { comsName: "alpha", comsProject: "proj-a" });
    assert.equal(matchDeepLinkSession([s1], { session: "nonexistent" }), null);
    assert.equal(matchDeepLinkSession([s1], { peer: "ghost" }), null);
    assert.equal(matchDeepLinkSession([], { session: "s1" }), null);
    assert.equal(matchDeepLinkSession([s1], null), null);
  });
});

describe("isDefinitiveDeepLinkMatch (#1537)", () => {
  it("treats exact sessionId match as definitive even when inactive", () => {
    const inactive = makeSession("s1", { active: false });
    assert.equal(isDefinitiveDeepLinkMatch(inactive, { session: "s1" }), true);
  });

  it("treats active peer match as definitive", () => {
    const active = makeSession("s1", { active: true, comsName: "worker" });
    assert.equal(isDefinitiveDeepLinkMatch(active, { peer: "worker" }), true);
  });

  it("treats inactive peer match as provisional", () => {
    const inactive = makeSession("s1", { active: false, comsName: "worker" });
    assert.equal(isDefinitiveDeepLinkMatch(inactive, { peer: "worker" }), false);
  });
});

describe("App URL deep-link integration (#1537)", () => {
  it("selects the ?session= target over stale localStorage on initial load", async () => {
    const stale = makeSession("stale-session", { pid: 101, name: "Stale" });
    const target = makeSession("target-session", { pid: 202, name: "Target" });

    const { ws } = await mountApp({
      search: "?session=target-session",
      initialSessions: [stale, target],
      storage: {
        "pidash-state": JSON.stringify({
          sidebarWidth: 280,
          sidebarCollapsed: false,
          watchPid: 101,
          watchSessionId: "stale-session",
          activePanel: null,
        }),
      },
    });

    assert.deepEqual(watchedSessionIds(ws), ["target-session"]);
  });

  it("selects the ?peer= target with project disambiguator over stale localStorage", async () => {
    const stale = makeSession("stale-session", { pid: 101, name: "Stale" });
    const wrongProject = makeSession("wrong-proj", {
      pid: 201,
      comsName: "peer-1537",
      comsProject: "other-proj",
      active: true,
    });
    const inactiveTarget = makeSession("inactive-target", {
      pid: 202,
      comsName: "peer-1537",
      comsProject: "home__myakove__git__pi-config",
      active: false,
    });
    const activeTarget = makeSession("active-target", {
      pid: 203,
      comsName: "peer-1537",
      comsProject: "home__myakove__git__pi-config",
      active: true,
    });

    const { ws } = await mountApp({
      search: "?peer=peer-1537&project=home__myakove__git__pi-config",
      initialSessions: [stale, wrongProject, inactiveTarget, activeTarget],
      storage: {
        "pidash-state": JSON.stringify({
          sidebarWidth: 280,
          sidebarCollapsed: false,
          watchPid: 101,
          watchSessionId: "stale-session",
          activePanel: null,
        }),
      },
    });

    assert.deepEqual(watchedSessionIds(ws), ["active-target"]);
  });

  it("switches from localStorage fallback to a late-arriving session on session_added", async () => {
    const stale = makeSession("stale-session", { pid: 101, name: "Stale" });
    const late = makeSession("late-target", { pid: 303, name: "Late Peer" });

    const { ws, setSessions } = await mountApp({
      search: "?session=late-target",
      initialSessions: [stale],
      storage: {
        "pidash-state": JSON.stringify({
          sidebarWidth: 280,
          sidebarCollapsed: false,
          watchPid: 101,
          watchSessionId: "stale-session",
          activePanel: null,
        }),
      },
    });

    assert.deepEqual(watchedSessionIds(ws), ["stale-session"]);

    setSessions([stale, late]);
    await act(async () => {
      ws.emitMessage({ type: "session_added", session: late });
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    assert.deepEqual(watchedSessionIds(ws), ["stale-session", "late-target"]);
  });

  it("resolves a late-arriving peer when session_updated populates COMS metadata", async () => {
    const peerWithoutMeta = makeSession("peer-sess", { pid: 404, name: "Booting Peer" });

    const { ws } = await mountApp({
      search: "?peer=peer-1537&project=proj-x",
      initialSessions: [peerWithoutMeta],
    });

    assert.deepEqual(watchedSessionIds(ws), []);

    await act(async () => {
      ws.emitMessage({
        type: "session_updated",
        session: { sessionId: "peer-sess", comsName: "peer-1537", comsProject: "proj-x" },
      });
    });

    assert.deepEqual(watchedSessionIds(ws), ["peer-sess"]);
  });

  it("cancels a pending deep-link immediately upon manual session selection", async () => {
    const manual = makeSession("manual-session", { pid: 101, name: "Manual Pick" });
    const lateTarget = makeSession("late-target", { pid: 202, comsName: "late-peer" });

    const { container, ws, setSessions } = await mountApp({
      search: "?peer=late-peer",
      initialSessions: [manual],
    });

    assert.deepEqual(watchedSessionIds(ws), []);

    const manualRow = elements(container, "div").find((el) => el.getAttribute("data-session-id") === "manual-session");
    assert.ok(manualRow, "expected manual-session row in sidebar");
    await act(async () => {
      manualRow.dispatchEvent(new (globalThis as any).MouseEvent("click", { bubbles: true }));
    });
    assert.deepEqual(watchedSessionIds(ws), ["manual-session"]);

    setSessions([manual, lateTarget]);
    await act(async () => {
      ws.emitMessage({ type: "session_added", session: lateTarget });
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    assert.deepEqual(watchedSessionIds(ws), ["manual-session"]);
  });

  it("falls back to saved localStorage session for an unmatched deep-link target", async () => {
    const existing = makeSession("existing-session", { pid: 101, name: "Existing" });

    const { ws } = await mountApp({
      search: "?session=does-not-exist",
      initialSessions: [existing],
      storage: {
        "pidash-state": JSON.stringify({
          sidebarWidth: 280,
          sidebarCollapsed: false,
          watchPid: 101,
          watchSessionId: "existing-session",
          activePanel: null,
        }),
      },
    });

    assert.deepEqual(watchedSessionIds(ws), ["existing-session"]);
  });

  it("leaves no session selected for an unmatched deep-link when localStorage is empty", async () => {
    const existing = makeSession("existing-session", { pid: 101, name: "Existing" });

    const { container, ws } = await mountApp({
      search: "?session=does-not-exist",
      initialSessions: [existing],
    });

    assert.deepEqual(watchedSessionIds(ws), []);
    assert.match(container.textContent, /Select a session/);
  });

  it("promotes a provisional inactive peer match when an active peer arrives during the settling window", async () => {
    const inactivePeer = makeSession("peer-old", {
      pid: 101,
      comsName: "worker",
      comsProject: "proj-a",
      active: false,
    });
    const activePeer = makeSession("peer-live", {
      pid: 202,
      comsName: "worker",
      comsProject: "proj-a",
      active: true,
    });

    const { ws, setSessions } = await mountApp({
      search: "?peer=worker&project=proj-a",
      initialSessions: [inactivePeer],
    });

    assert.deepEqual(watchedSessionIds(ws), ["peer-old"]);

    setSessions([inactivePeer, activePeer]);
    await act(async () => {
      ws.emitMessage({ type: "session_added", session: activePeer });
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    assert.deepEqual(watchedSessionIds(ws), ["peer-old", "peer-live"]);
  });

  it("commits an inactive peer match after the settling timeout expires", async () => {
    const inactivePeer = makeSession("peer-old", {
      pid: 101,
      comsName: "worker",
      comsProject: "proj-a",
      active: false,
    });
    const lateActivePeer = makeSession("peer-live", {
      pid: 202,
      comsName: "worker",
      comsProject: "proj-a",
      active: true,
    });

    const origSetTimeout = globalThis.setTimeout;
    const origClearTimeout = globalThis.clearTimeout;
    const settleCallbacks: Array<() => void> = [];
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      if (ms === DEEP_LINK_INACTIVE_PEER_SETTLE_MS) {
        settleCallbacks.push(fn);
        return 777 as unknown as ReturnType<typeof setTimeout>;
      }
      return origSetTimeout(fn, ms);
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: any) => {
      if (id === 777) return;
      origClearTimeout(id);
    }) as typeof clearTimeout;

    try {
      const { ws, setSessions } = await mountApp({
        search: "?peer=worker&project=proj-a",
        initialSessions: [inactivePeer],
      });

      assert.deepEqual(watchedSessionIds(ws), ["peer-old"]);
      assert.equal(settleCallbacks.length, 1);

      await act(async () => {
        settleCallbacks[0]();
      });

      setSessions([inactivePeer, lateActivePeer]);
      await act(async () => {
        ws.emitMessage({ type: "session_added", session: lateActivePeer });
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });

      assert.deepEqual(watchedSessionIds(ws), ["peer-old"]);
    } finally {
      globalThis.setTimeout = origSetTimeout;
      globalThis.clearTimeout = origClearTimeout;
    }
  });

  it("cancels a provisional inactive peer match upon manual session selection", async () => {
    const inactivePeer = makeSession("peer-old", {
      pid: 101,
      comsName: "worker",
      comsProject: "proj-a",
      active: false,
    });
    const manualPick = makeSession("manual-session", { pid: 102, name: "Manual Pick" });
    const activePeer = makeSession("peer-live", {
      pid: 202,
      comsName: "worker",
      comsProject: "proj-a",
      active: true,
    });

    const { container, ws, setSessions } = await mountApp({
      search: "?peer=worker&project=proj-a",
      initialSessions: [inactivePeer, manualPick],
    });

    assert.deepEqual(watchedSessionIds(ws), ["peer-old"]);

    const manualRow = elements(container, "div").find((el) => el.getAttribute("data-session-id") === "manual-session");
    assert.ok(manualRow, "expected manual-session row in sidebar");
    await act(async () => {
      manualRow.dispatchEvent(new (globalThis as any).MouseEvent("click", { bubbles: true }));
    });
    assert.deepEqual(watchedSessionIds(ws), ["peer-old", "manual-session"]);

    setSessions([inactivePeer, manualPick, activePeer]);
    await act(async () => {
      ws.emitMessage({ type: "session_added", session: activePeer });
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    assert.deepEqual(watchedSessionIds(ws), ["peer-old", "manual-session"]);
  });

  it("restores localStorage normally when only unrelated query parameters exist", async () => {
    const saved = makeSession("saved-session", { pid: 101, name: "Saved" });
    const other = makeSession("other-session", { pid: 202, name: "Other" });

    const { ws } = await mountApp({
      search: "?foo=bar",
      initialSessions: [other, saved],
      storage: {
        "pidash-state": JSON.stringify({
          sidebarWidth: 280,
          sidebarCollapsed: false,
          watchPid: 101,
          watchSessionId: "saved-session",
          activePanel: null,
        }),
      },
    });

    assert.deepEqual(watchedSessionIds(ws), ["saved-session"]);
  });

  it("preserves the deep-linked session across WebSocket reconnect", async () => {
    const stale = makeSession("stale-session", { pid: 101, name: "Stale" });
    const target = makeSession("target-session", { pid: 202, name: "Target" });

    const origSetTimeout = globalThis.setTimeout;
    const reconnectCallbacks: Array<() => void> = [];
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      if (ms === 3000) {
        reconnectCallbacks.push(fn);
        return 999 as unknown as ReturnType<typeof setTimeout>;
      }
      return origSetTimeout(fn, ms);
    }) as typeof setTimeout;

    try {
      const { ws } = await mountApp({
        search: "?session=target-session",
        initialSessions: [stale, target],
        storage: {
          "pidash-state": JSON.stringify({
            sidebarWidth: 280,
            sidebarCollapsed: false,
            watchPid: 101,
            watchSessionId: "stale-session",
            activePanel: null,
          }),
        },
      });
      assert.deepEqual(watchedSessionIds(ws), ["target-session"]);

      await act(async () => {
        ws.close();
      });
      assert.equal(reconnectCallbacks.length, 1);

      await act(async () => {
        reconnectCallbacks[0]();
      });
      const reconnectedWs = FakeWebSocket.instances.at(-1)!;
      await act(async () => {
        reconnectedWs.emitOpen();
      });
      await act(async () => {
        await Promise.resolve();
      });

      assert.deepEqual(watchedSessionIds(reconnectedWs), ["target-session"]);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });

  it("auto-expands a collapsed parent group in SessionSidebar for a deep-linked nested peer", async () => {
    const parent = makeSession("parent-100", {
      pid: 100,
      cwd: "/home/dev/git/pi-config",
      comsName: "feature-manager",
      comsProject: "home__dev__git__pi-config",
    });
    const nestedPeer = makeSession("peer-200", {
      pid: 200,
      cwd: "/home/dev/git/pi-config/.worktrees/issue-1537",
      comsName: "peer-1537-pidash-deeplink",
      comsProject: "home__dev__git__pi-config",
      supervisedPeer: true,
      parentSessionId: "parent-100",
    });

    const { container, ws } = await mountApp({
      search: "?peer=peer-1537-pidash-deeplink&project=home__dev__git__pi-config",
      initialSessions: [parent, nestedPeer],
      storage: {
        "pidash-collapsed-projects-v2": JSON.stringify(["dir:pi-config", "peers:session:parent-100"]),
      },
    });

    assert.deepEqual(watchedSessionIds(ws), ["peer-200"]);
    const peerRow = elements(container, "div").find((el) => el.getAttribute("data-session-id") === "peer-200");
    assert.ok(peerRow, "expected collapsed project and parent peer group to auto-expand for deep-linked peer");
  });
});
