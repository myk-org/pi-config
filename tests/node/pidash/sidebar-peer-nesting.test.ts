/**
 * #1527 — Focused single-behavior unit tests for parent-nested supervised COMS peers,
 * cross-project-only Coms sidebar section, disconnect metadata preservation,
 * comsName display priority, auto-expand on selection, and parentSessionId propagation.
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import * as rootReact from "react";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import * as pidashReact from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { act, createElement } from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import type { Root } from "../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js";
import {
  deriveComsProjectFromCwd,
  flattenSidebarSessions,
  isSessionOwnComsProject,
  partitionSidebarSessions,
  sessionRowDisplayLabel,
} from "../../../extensions/pidash/pidash-ui/src/lib/pidash-ux-helpers.ts";
import { mergeSessionUpdate } from "../../../extensions/pidash/pidash-ui/src/hooks/useSessions.ts";
import { registerPidash } from "../../../extensions/pidash/pidash.ts";
import { setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.ts";
import {
  buildSessionUpdatedBroadcast,
  disconnectPidashSession,
  registerPidashSession,
  type PiClient,
} from "../../../scripts/pidash-session-state.ts";
import { collectPeers, createPidashApiRouter } from "../../../scripts/pidash-api.ts";
import { buildPodmanRunArgs } from "../../../scripts/podman-peer-image.mjs";
import type { SessionInfo } from "../../../extensions/shared/types.ts";
import { elements, installReactDomShim } from "./react-dom-shim.mjs";

let vite: ViteDevServer;
let createRoot: (container: Element) => Root;
let SessionSidebar: any;

before(async () => {
  installReactDomShim();
  ({ createRoot } = await import("../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js"));
  vite = await createViteServer({
    root: path.resolve("extensions/pidash/pidash-ui"),
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  ({ SessionSidebar } = await vite.ssrLoadModule("/src/components/SessionSidebar.tsx"));
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
const originalLocalStorage = globalThis.localStorage;

afterEach(async () => {
  while (mounted.length) await act(async () => mounted.pop()!.unmount());
  if (originalLocalStorage === undefined) {
    delete (globalThis as any).localStorage;
  } else {
    Object.defineProperty(globalThis, "localStorage", { value: originalLocalStorage, configurable: true, writable: true });
  }
});

function installMockStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
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
    startedAt: new Date().toISOString(),
    lastActivity: Date.now(),
    active: true,
    activity: "idle",
    ...overrides,
  };
}

const EMPTY_IDS = new Set<string>();

describe("sidebar peer nesting helpers (#1527)", () => {
  it("derives default comsProject slug from cwd path", () => {
    assert.equal(deriveComsProjectFromCwd("/home/myakove/git/pi-config/"), "home__myakove__git__pi-config");
  });

  it("recognizes matching full-path comsProject as own project", () => {
    assert.equal(
      isSessionOwnComsProject({ cwd: "/home/myakove/git/pi-config", comsProject: "home__myakove__git__pi-config" }),
      true,
    );
  });

  it("recognizes matching basename comsProject as own project", () => {
    assert.equal(
      isSessionOwnComsProject({ cwd: "/home/myakove/git/pi-config", comsProject: "pi-config" }),
      true,
    );
  });

  it("classifies mismatched comsProject as cross-project", () => {
    assert.equal(
      isSessionOwnComsProject({ cwd: "/home/myakove/git/rootcoz", comsProject: "home__myakove__git__pi-config" }),
      false,
    );
  });

  it("nests a supervised worktree peer under its spawning parentSessionId", () => {
    const parent = makeSession("100:/home/dev/git/pi-config", {
      cwd: "/home/dev/git/pi-config",
      comsProject: "home__dev__git__pi-config",
      comsName: "feature-manager",
    });
    const peer = makeSession("200:/home/dev/git/pi-config/.worktrees/issue-1488", {
      cwd: "/home/dev/git/pi-config/.worktrees/issue-1488",
      branch: "feat/issue-1488",
      comsProject: "home__dev__git__pi-config",
      comsName: "peer-1488-rpc-shutdown",
      supervisedPeer: true,
      parentSessionId: parent.sessionId,
    });

    const parts = partitionSidebarSessions([parent, peer], { pinnedIds: EMPTY_IDS, archivedIds: EMPTY_IDS });

    assert.deepEqual(parts.groups.map((g) => g.name), ["pi-config"]);
    assert.equal(parts.groups[0].nodes.length, 1);
    assert.deepEqual(parts.groups[0].nodes[0].children.map((c) => c.sessionId), [peer.sessionId]);
    assert.deepEqual(parts.groups[0].projectPeers, []);
    assert.deepEqual(parts.coms, []);
  });

  it("falls back to owning project folder by comsProject for Podman workspace peer when parent exited", () => {
    const restartedParent = makeSession("300:/home/dev/git/pi-config", {
      cwd: "/home/dev/git/pi-config",
      comsProject: "home__dev__git__pi-config",
    });
    const podmanPeer = makeSession("400:/home/dev/.pi/sandboxes/pi-peer-1527/workspace", {
      cwd: "/home/dev/.pi/sandboxes/pi-peer-1527/workspace",
      branch: "fix/issue-1527-pidash-dedup",
      comsProject: "home__dev__git__pi-config",
      comsName: "peer-1527-pidash-dedup",
      supervisedPeer: true,
      parentSessionId: "100:/home/dev/git/pi-config",
      container: true,
      containerName: "pi-peer-home__dev__git-peer-1527",
    });

    const parts = partitionSidebarSessions([restartedParent, podmanPeer], { pinnedIds: EMPTY_IDS, archivedIds: EMPTY_IDS });

    assert.deepEqual(parts.groups.map((g) => g.name), ["pi-config"]);
    assert.deepEqual(parts.groups[0].projectPeers.map((p) => p.sessionId), [podmanPeer.sessionId]);
    assert.deepEqual(parts.coms, []);
  });

  it("keeps disconnected supervised peer nested inside owning project without creating stray workspace folder", () => {
    const parent = makeSession("100:/home/dev/git/pi-config", {
      cwd: "/home/dev/git/pi-config",
      comsProject: "home__dev__git__pi-config",
    });
    const stoppedPeer = makeSession("400:/home/dev/.pi/sandboxes/pi-peer-1527/workspace", {
      cwd: "/home/dev/.pi/sandboxes/pi-peer-1527/workspace",
      comsProject: "home__dev__git__pi-config",
      comsName: "peer-1527-pidash-dedup",
      supervisedPeer: true,
      parentSessionId: parent.sessionId,
      active: false,
    });

    const parts = partitionSidebarSessions([parent, stoppedPeer], { pinnedIds: EMPTY_IDS, archivedIds: EMPTY_IDS });

    assert.deepEqual(parts.groups.map((g) => g.name), ["pi-config"]);
    assert.deepEqual(parts.groups[0].nodes[0].children.map((c) => c.sessionId), [stoppedPeer.sessionId]);
    assert.deepEqual(parts.coms, []);
  });

  it("keeps same-project interactive sessions in their own folders with empty Coms section", () => {
    const piConfig = makeSession("s-pi", {
      cwd: "/home/dev/git/pi-config",
      comsProject: "home__dev__git__pi-config",
      comsName: "pi-config",
    });
    const rootcoz = makeSession("s-rc", {
      cwd: "/home/dev/git/rootcoz",
      comsProject: "home__dev__git__rootcoz",
      comsName: "rootcoz",
    });

    const parts = partitionSidebarSessions([piConfig, rootcoz], { pinnedIds: EMPTY_IDS, archivedIds: EMPTY_IDS });

    assert.deepEqual(parts.groups.map((g) => g.name), ["pi-config", "rootcoz"]);
    assert.deepEqual(parts.coms, []);
  });

  it("routes unattached supervised peer to cross-project Coms section without creating top-level folder", () => {
    const localParent = makeSession("s-pi", {
      cwd: "/home/dev/git/pi-config",
      comsProject: "home__dev__git__pi-config",
    });
    const remotePeer = makeSession("s-remote", {
      cwd: "/home/dev/.pi/sandboxes/pi-peer-other/workspace",
      comsProject: "home__dev__git__other-repo",
      comsName: "peer-remote-worker",
      supervisedPeer: true,
    });

    const parts = partitionSidebarSessions([localParent, remotePeer], { pinnedIds: EMPTY_IDS, archivedIds: EMPTY_IDS });

    assert.deepEqual(parts.groups.map((g) => g.name), ["pi-config"]);
    assert.equal(parts.coms.length, 1);
    assert.equal(parts.coms[0].project, "home__dev__git__other-repo");
    assert.deepEqual(parts.coms[0].sessions.map((s) => s.sessionId), ["s-remote"]);
  });

  it("routes cross-project interactive session to bottom Coms section", () => {
    const crossSession = makeSession("s-cross", {
      cwd: "/home/dev/git/rootcoz",
      comsProject: "home__dev__git__pi-config",
      comsName: "rootcoz-helper",
    });

    const parts = partitionSidebarSessions([crossSession], { pinnedIds: EMPTY_IDS, archivedIds: EMPTY_IDS });

    assert.deepEqual(parts.groups.map((g) => g.name), ["rootcoz"]);
    assert.equal(parts.coms.length, 1);
    assert.equal(parts.coms[0].project, "home__dev__git__pi-config");
    assert.deepEqual(parts.coms[0].sessions.map((s) => s.sessionId), ["s-cross"]);
  });

  it("flattens sidebar sessions in visual order without duplicates", () => {
    const pinned = makeSession("s-pin", { cwd: "/home/dev/git/pinned" });
    const parent = makeSession("s-parent", { cwd: "/home/dev/git/pi-config", comsProject: "pi-config" });
    const child = makeSession("s-child", {
      cwd: "/home/dev/git/pi-config/.worktrees/wt-1",
      comsProject: "pi-config",
      comsName: "peer-child",
      supervisedPeer: true,
      parentSessionId: "s-parent",
    });
    const fallbackPeer = makeSession("s-fallback", {
      cwd: "/home/dev/.pi/sandboxes/sb-1/workspace",
      comsProject: "pi-config",
      comsName: "peer-fallback",
      supervisedPeer: true,
    });
    const unattached = makeSession("s-unattached", {
      cwd: "/home/dev/.pi/sandboxes/sb-2/workspace",
      comsProject: "other-project",
      comsName: "peer-other",
      supervisedPeer: true,
    });
    const archived = makeSession("s-arch", { cwd: "/home/dev/git/old" });

    const parts = partitionSidebarSessions([archived, unattached, fallbackPeer, child, parent, pinned], {
      pinnedIds: new Set(["s-pin"]),
      archivedIds: new Set(["s-arch"]),
    });

    assert.deepEqual(
      flattenSidebarSessions(parts).map((s) => s.sessionId),
      ["s-pin", "s-parent", "s-child", "s-fallback", "s-unattached", "s-arch"],
    );
  });

  it("prefers comsName over matching model name for supervisedPeer rows without preferComsName option", () => {
    const label = sessionRowDisplayLabel({
      name: "Gemini 4 Neon",
      model: "Gemini 4 Neon",
      comsName: "peer-1527-pidash-dedup",
      supervisedPeer: true,
    });
    assert.equal(label, "peer-1527-pidash-dedup");
  });

  it("prefers comsName over empty title for supervisedPeer rows without preferComsName option", () => {
    const label = sessionRowDisplayLabel({
      name: undefined,
      model: "Gemini 4 Neon",
      comsName: "peer-1527-pidash-dedup",
      supervisedPeer: true,
    });
    assert.equal(label, "peer-1527-pidash-dedup");
  });

  it("routes cross-project peer to Coms when parent uses a foreign COMS namespace", () => {
    const parentInA = makeSession("s-parent-a", {
      cwd: "/home/dev/git/project-a",
      comsProject: "namespace-b",
    });
    const peerInB = makeSession("s-peer-b", {
      cwd: "/home/dev/.pi/sandboxes/sb-b/workspace",
      comsProject: "namespace-b",
      comsName: "peer-b",
      supervisedPeer: true,
      parentSessionId: parentInA.sessionId,
    });

    const parts = partitionSidebarSessions([parentInA, peerInB], { pinnedIds: EMPTY_IDS, archivedIds: EMPTY_IDS });

    assert.deepEqual(parts.groups.map((g) => g.name), ["project-a"]);
    assert.deepEqual(parts.groups[0].nodes[0].children, []);
    assert.deepEqual(parts.groups[0].projectPeers, []);
    assert.equal(parts.coms.length, 1);
    assert.equal(parts.coms[0].project, "namespace-b");
    assert.ok(parts.coms[0].sessions.some((s) => s.sessionId === "s-peer-b"));
  });

  it("routes parent-absent cross-project peer to Coms when an interactive session joined that namespace", () => {
    const sessionInA = makeSession("s-a", {
      cwd: "/home/dev/git/project-a",
      comsProject: "namespace-b",
    });
    const peerInB = makeSession("s-peer-b", {
      cwd: "/home/dev/.pi/sandboxes/sb-b/workspace",
      comsProject: "namespace-b",
      comsName: "peer-b",
      supervisedPeer: true,
    });

    const parts = partitionSidebarSessions([sessionInA, peerInB], { pinnedIds: EMPTY_IDS, archivedIds: EMPTY_IDS });

    assert.deepEqual(parts.groups[0].projectPeers, []);
    assert.equal(parts.coms.length, 1);
    assert.ok(parts.coms[0].sessions.some((s) => s.sessionId === "s-peer-b"));
  });

  it("keeps same-project peer in local project folder when its only interactive owner is pinned", () => {
    const pinnedParent = makeSession("s-pinned-parent", {
      cwd: "/home/dev/git/pi-config",
      comsProject: "home__dev__git__pi-config",
    });
    const peer = makeSession("s-peer", {
      cwd: "/home/dev/.pi/sandboxes/sb-1/workspace",
      comsProject: "home__dev__git__pi-config",
      comsName: "peer-1527",
      supervisedPeer: true,
      parentSessionId: pinnedParent.sessionId,
    });

    const parts = partitionSidebarSessions([pinnedParent, peer], {
      pinnedIds: new Set(["s-pinned-parent"]),
      archivedIds: EMPTY_IDS,
    });

    assert.deepEqual(parts.pinned.map((s) => s.sessionId), ["s-pinned-parent"]);
    assert.deepEqual(parts.groups.map((g) => g.name), ["pi-config"]);
    assert.deepEqual(parts.groups[0].projectPeers.map((s) => s.sessionId), ["s-peer"]);
    assert.deepEqual(parts.coms, []);
  });

  it("keeps same-project peer in local project folder when its only interactive owner is archived", () => {
    const archivedParent = makeSession("s-archived-parent", {
      cwd: "/home/dev/git/pi-config",
      comsProject: "home__dev__git__pi-config",
    });
    const peer = makeSession("s-peer", {
      cwd: "/home/dev/.pi/sandboxes/sb-1/workspace",
      comsProject: "home__dev__git__pi-config",
      comsName: "peer-1527",
      supervisedPeer: true,
    });

    const parts = partitionSidebarSessions([archivedParent, peer], {
      pinnedIds: EMPTY_IDS,
      archivedIds: new Set(["s-archived-parent"]),
    });

    assert.deepEqual(parts.archived.map((s) => s.sessionId), ["s-archived-parent"]);
    assert.deepEqual(parts.groups.map((g) => g.name), ["pi-config"]);
    assert.deepEqual(parts.groups[0].projectPeers.map((s) => s.sessionId), ["s-peer"]);
    assert.deepEqual(parts.coms, []);
  });

  it("separates fallback peers across distinct projects sharing the same folder basename", () => {
    const aliceApp = makeSession("s-alice", { cwd: "/work/alice/app", comsProject: "work__alice__app" });
    const bobApp = makeSession("s-bob", { cwd: "/work/bob/app", comsProject: "work__bob__app" });
    const alicePeer = makeSession("s-peer-alice", {
      cwd: "/home/dev/.pi/sandboxes/sb-a/workspace",
      comsProject: "work__alice__app",
      comsName: "peer-alice",
      supervisedPeer: true,
    });
    const bobPeer = makeSession("s-peer-bob", {
      cwd: "/home/dev/.pi/sandboxes/sb-b/workspace",
      comsProject: "work__bob__app",
      comsName: "peer-bob",
      supervisedPeer: true,
    });

    const parts = partitionSidebarSessions([bobApp, aliceApp, bobPeer, alicePeer], {
      pinnedIds: EMPTY_IDS,
      archivedIds: EMPTY_IDS,
    });

    assert.equal(parts.groups.length, 2);
    assert.deepEqual(parts.groups.map((g) => g.id), ["/work/alice/app", "/work/bob/app"]);
    assert.deepEqual(parts.groups[0].projectPeers.map((s) => s.sessionId), ["s-peer-alice"]);
    assert.deepEqual(parts.groups[1].projectPeers.map((s) => s.sessionId), ["s-peer-bob"]);
    assert.deepEqual(parts.coms, []);
  });
});

describe("SessionSidebar component hierarchy (#1527)", () => {
  async function renderSidebar(props: Record<string, unknown>) {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);
    const render = async (nextProps: Record<string, unknown>) => {
      await act(async () => root.render(createElement(SessionSidebar, {
        activeSessionId: null,
        connected: true,
        onSelect: () => {},
        collapsed: false,
        onToggle: () => {},
        pinnedSessionIds: EMPTY_IDS,
        archivedSessionIds: EMPTY_IDS,
        ...nextProps,
      })));
    };
    await render(props);
    return { container, render };
  }

  it("hides bottom Coms section when all sessions belong to local projects", async () => {
    installMockStorage();
    const parent = makeSession("s-parent", {
      cwd: "/home/dev/git/pi-config",
      comsProject: "home__dev__git__pi-config",
      comsName: "feature-manager",
    });
    const peer = makeSession("s-peer", {
      cwd: "/home/dev/.pi/sandboxes/pi-peer-1527/workspace",
      comsProject: "home__dev__git__pi-config",
      comsName: "peer-1527-pidash-dedup",
      supervisedPeer: true,
      parentSessionId: "s-parent",
    });

    const { container } = await renderSidebar({ sessions: [parent, peer] });

    const comsSection = elements(container, "div").find((el) => el.getAttribute("data-section") === "coms");
    assert.equal(comsSection, undefined);
    const renderedRows = elements(container, "div").filter((el) => el.getAttribute("data-session-id") === "s-peer");
    assert.equal(renderedRows.length, 1);
    assert.equal(renderedRows[0].getAttribute("data-nested-under"), "s-parent");
  });

  it("renders supervisedPeer comsName in nested, pinned, archived, cross-project rows", async () => {
    installMockStorage();
    const parent = makeSession("s-parent", { cwd: "/home/dev/git/pi-config", comsProject: "pi-config", name: "Main LLM" });
    const nestedPeer = makeSession("s-nested", {
      cwd: "/home/dev/git/pi-config/.worktrees/wt-nested",
      comsProject: "pi-config",
      comsName: "peer-nested",
      model: "Gemini 4 Neon",
      name: "Gemini 4 Neon",
      supervisedPeer: true,
      parentSessionId: "s-parent",
    });
    const pinnedPeer = makeSession("s-pinned", {
      cwd: "/home/dev/.pi/sandboxes/sb-pin/workspace",
      comsProject: "pi-config",
      comsName: "peer-pinned",
      model: "Gemini 4 Neon",
      name: "Gemini 4 Neon",
      supervisedPeer: true,
    });
    const archivedPeer = makeSession("s-archived", {
      cwd: "/home/dev/.pi/sandboxes/sb-arch/workspace",
      comsProject: "pi-config",
      comsName: "peer-archived",
      model: "Gemini 4 Neon",
      name: "Gemini 4 Neon",
      supervisedPeer: true,
    });
    const crossPeer = makeSession("s-cross", {
      cwd: "/home/dev/.pi/sandboxes/sb-cross/workspace",
      comsProject: "external-proj",
      comsName: "peer-cross",
      model: "Gemini 4 Neon",
      name: "Gemini 4 Neon",
      supervisedPeer: true,
    });

    const { container } = await renderSidebar({
      sessions: [parent, nestedPeer, pinnedPeer, archivedPeer, crossPeer],
      pinnedSessionIds: new Set(["s-pinned"]),
      archivedSessionIds: new Set(["s-archived"]),
      activeSessionId: "s-archived",
    });

    const text = container.textContent ?? "";
    assert.match(text, /peer-nested/);
    assert.match(text, /peer-pinned/);
    assert.match(text, /peer-archived/);
    assert.match(text, /peer-cross/);
  });

  it("auto-expands a collapsed project group when selecting a nested peer inside it", async () => {
    installMockStorage({ "pidash-collapsed-projects-v2": JSON.stringify(["dir:pi-config"]) });
    const parent = makeSession("s-parent", { cwd: "/home/dev/git/pi-config", comsProject: "pi-config", name: "Main" });
    const child = makeSession("s-child", {
      cwd: "/home/dev/git/pi-config/.worktrees/wt-1",
      comsProject: "pi-config",
      comsName: "peer-hidden-child",
      supervisedPeer: true,
      parentSessionId: "s-parent",
    });

    const { container, render } = await renderSidebar({ sessions: [parent, child], activeSessionId: null });
    assert.equal((container.textContent ?? "").includes("peer-hidden-child"), false);

    await render({ sessions: [parent, child], activeSessionId: "s-child" });
    assert.equal((container.textContent ?? "").includes("peer-hidden-child"), true);
  });

  it("auto-expands a collapsed parent node when selecting its nested peer", async () => {
    const storage = installMockStorage();
    const selected: string[] = [];
    const parent = makeSession("s-parent", { cwd: "/home/dev/git/pi-config", comsProject: "pi-config", name: "Main" });
    const child = makeSession("s-child", {
      cwd: "/home/dev/git/pi-config/.worktrees/wt-1",
      comsProject: "pi-config",
      comsName: "peer-under-collapsed-parent",
      supervisedPeer: true,
      parentSessionId: "s-parent",
    });

    const { container, render } = await renderSidebar({
      sessions: [parent, child],
      activeSessionId: null,
      onSelect: (s: SessionInfo) => selected.push(s.sessionId),
    });
    assert.equal((container.textContent ?? "").includes("peer-under-collapsed-parent"), true);

    const toggleBtn = elements(container, "button").find((el) => el.getAttribute("data-toggle-children") === "s-parent");
    assert.ok(toggleBtn);
    assert.match(toggleBtn.textContent ?? "", /1 peer/);
    await act(async () => toggleBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.deepEqual(selected, []);
    assert.equal((container.textContent ?? "").includes("peer-under-collapsed-parent"), false);
    assert.deepEqual(JSON.parse(storage.get("pidash-collapsed-projects-v2") ?? "[]"), ["peers:session:s-parent"]);

    await render({ sessions: [parent, child], activeSessionId: "s-child" });
    assert.equal((container.textContent ?? "").includes("peer-under-collapsed-parent"), true);
  });

  it("prunes stale persisted parent peer collapse keys when the parent session is gone", async () => {
    const storage = installMockStorage({
      "pidash-collapsed-projects-v2": JSON.stringify(["dir:other", "peers:session:stale-parent", "peers:session:live-parent"]),
    });
    const liveParent = makeSession("live-parent", { cwd: "/home/dev/git/pi-config", comsProject: "pi-config", name: "Live" });

    await renderSidebar({ sessions: [liveParent], activeSessionId: null });

    const persisted = JSON.parse(storage.get("pidash-collapsed-projects-v2") ?? "[]") as string[];
    assert.deepEqual(persisted, ["dir:other", "peers:session:live-parent"]);
  });

  it("collapses project-level fallback peers independently of the project folder with busy badge", async () => {
    const storage = installMockStorage();
    const mainSession = makeSession("s-main", {
      cwd: "/home/dev/git/pi-config",
      comsProject: "home__dev__git__pi-config",
      name: "Main LLM",
    });
    const fallbackBusy = makeSession("s-fb-1", {
      cwd: "/home/dev/.pi/sandboxes/sb-1/workspace",
      comsProject: "home__dev__git__pi-config",
      comsName: "peer-fallback-busy",
      supervisedPeer: true,
      runningAsyncAgents: 2,
    });
    const fallbackWait = makeSession("s-fb-2", {
      cwd: "/home/dev/.pi/sandboxes/sb-2/workspace",
      comsProject: "home__dev__git__pi-config",
      comsName: "peer-fallback-wait",
      supervisedPeer: true,
      activity: "waiting_for_input",
    });

    const { container } = await renderSidebar({ sessions: [mainSession, fallbackBusy, fallbackWait] });

    assert.equal((container.textContent ?? "").includes("peer-fallback-busy"), true);
    const peersToggle = elements(container, "div").find(
      (el) => el.getAttribute("data-toggle-project-peers") === "/home/dev/git/pi-config",
    );
    assert.ok(peersToggle);
    assert.match(peersToggle.textContent ?? "", /Peers \(2\)/);

    await act(async () => peersToggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    assert.equal(peersToggle.getAttribute("aria-expanded"), "false");
    assert.equal((container.textContent ?? "").includes("Main LLM"), true);
    assert.equal((container.textContent ?? "").includes("peer-fallback-busy"), false);
    assert.equal((container.textContent ?? "").includes("peer-fallback-wait"), false);
    const busyBadge = elements(peersToggle, "span").find((el) => el.getAttribute("data-busy-badge") === "true");
    assert.equal(busyBadge?.textContent?.trim(), "●1");
    const waitBadge = elements(peersToggle, "span").find((el) => el.getAttribute("data-attention-badge") === "true");
    assert.equal(waitBadge?.textContent?.trim(), "1");
    assert.deepEqual(
      JSON.parse(storage.get("pidash-collapsed-projects-v2") ?? "[]"),
      ["peers:project:pi-config"],
    );
  });

  it("auto-expands a collapsed project-level Peers sub-header when selecting a fallback peer", async () => {
    installMockStorage({
      "pidash-collapsed-projects-v2": JSON.stringify(["peers:project:pi-config"]),
    });
    const mainSession = makeSession("s-main", {
      cwd: "/home/dev/git/pi-config",
      comsProject: "home__dev__git__pi-config",
      name: "Main LLM",
    });
    const fallbackPeer = makeSession("s-fb-hidden", {
      cwd: "/home/dev/.pi/sandboxes/sb-hidden/workspace",
      comsProject: "home__dev__git__pi-config",
      comsName: "peer-fallback-hidden",
      supervisedPeer: true,
    });

    const { container, render } = await renderSidebar({ sessions: [mainSession, fallbackPeer], activeSessionId: null });
    assert.equal((container.textContent ?? "").includes("peer-fallback-hidden"), false);

    await render({ sessions: [mainSession, fallbackPeer], activeSessionId: "s-fb-hidden" });
    assert.equal((container.textContent ?? "").includes("peer-fallback-hidden"), true);
  });

  it("keeps opacity-65 dark-theme contrast class on disconnected nested peer rows", async () => {
    installMockStorage();
    const parent = makeSession("s-parent", { cwd: "/home/dev/git/pi-config", comsProject: "pi-config", name: "Main" });
    const stoppedChild = makeSession("s-stopped", {
      cwd: "/home/dev/.pi/sandboxes/sb-stop/workspace",
      comsProject: "pi-config",
      comsName: "peer-stopped",
      supervisedPeer: true,
      parentSessionId: "s-parent",
      active: false,
    });

    const { container } = await renderSidebar({ sessions: [parent, stoppedChild] });
    const stoppedRow = elements(container, "div").find((el) => el.getAttribute("data-session-id") === "s-stopped");
    assert.ok(stoppedRow);
    assert.match(stoppedRow.getAttribute("class") ?? "", /\bopacity-65\b/);
  });

  it("auto-expands a collapsed cross-project Coms section when selecting an unattached peer", async () => {
    installMockStorage({
      "pidash-coms-section-open": "false",
      "pidash-collapsed-projects-v2": JSON.stringify(["coms:other-proj"]),
    });
    const remotePeer = makeSession("s-remote", {
      cwd: "/home/dev/.pi/sandboxes/sb-remote/workspace",
      comsProject: "other-proj",
      comsName: "peer-remote-hidden",
      supervisedPeer: true,
    });

    const { container, render } = await renderSidebar({ sessions: [remotePeer], activeSessionId: null });
    assert.equal((container.textContent ?? "").includes("peer-remote-hidden"), false);

    await render({ sessions: [remotePeer], activeSessionId: "s-remote" });
    assert.equal((container.textContent ?? "").includes("peer-remote-hidden"), true);
  });
});

describe("parentSessionId propagation & disconnect preservation (#1527)", () => {
  it("preserves parentSessionId, comsProject, comsName on supervised peer disconnect", () => {
    const sessions = new Map<string, PiClient>();
    const ws = { send: () => {} };
    const client = registerPidashSession(
      sessions,
      ws,
      {
        sessionId: "peer-1",
        pid: 4321,
        cwd: "/home/dev/.pi/sandboxes/sb-1/workspace",
        comsName: "peer-1527",
        comsProject: "home__dev__git__pi-config",
        supervisedPeer: true,
        parentSessionId: "100:/home/dev/git/pi-config",
      },
      () => {},
    );

    disconnectPidashSession(client, ws, "close", () => {});

    assert.equal(client.session.active, false);
    assert.equal(client.session.comsName, "peer-1527");
    assert.equal(client.session.comsProject, "home__dev__git__pi-config");
    assert.equal(client.session.parentSessionId, "100:/home/dev/git/pi-config");
    assert.equal(client.session.supervisedPeer, true);
  });

  it("ignores null coms metadata clears in broadcast payload for supervised peers", () => {
    const session = makeSession("peer-2", {
      comsName: "peer-1527",
      comsProject: "home__dev__git__pi-config",
      supervisedPeer: true,
      parentSessionId: "100:/home/dev/git/pi-config",
    });

    const broadcast = buildSessionUpdatedBroadcast(session, {
      comsName: null,
      comsPurpose: null,
      comsProject: null,
    });
    assert.equal(broadcast.session.comsName, "peer-1527");
    assert.equal(broadcast.session.comsProject, "home__dev__git__pi-config");
  });

  it("ignores null coms metadata clears in mergeSessionUpdate for supervised peers", () => {
    const session = makeSession("peer-2", {
      comsName: "peer-1527",
      comsProject: "home__dev__git__pi-config",
      supervisedPeer: true,
      parentSessionId: "100:/home/dev/git/pi-config",
    });

    const merged = mergeSessionUpdate(session, {
      comsName: null as unknown as string,
      comsProject: null as unknown as string,
      active: false,
    });
    assert.equal(merged.comsName, "peer-1527");
    assert.equal(merged.comsProject, "home__dev__git__pi-config");
    assert.equal(merged.parentSessionId, "100:/home/dev/git/pi-config");
  });

  it("passes PI_COMS_PARENT_SESSION_ID through buildPodmanRunArgs", () => {
    const args = buildPodmanRunArgs({
      imageTag: "localhost/pi-peer:abc123456789",
      piConfigDir: "/opt/pi-config",
      agentDir: "/tmp/agent",
      entrypointPath: "/opt/entrypoint.sh",
      gitconfigSeedPath: "/tmp/gitconfig.seed",
      workspacePath: "/tmp/ws",
      comsDir: "/tmp/coms",
      cname: "peer-1527",
      project: "pi-config",
      parentSessionId: "100:/home/dev/git/pi-config",
      env: { PI_COMS_PARENT_SESSION_ID: "100:/home/dev/git/pi-config" },
    });

    assert.ok(args.includes("PI_COMS_PARENT_SESSION_ID=100:/home/dev/git/pi-config"));
    assert.equal(args.filter((a) => a === "PI_COMS_PARENT_SESSION_ID").length, 0);
  });

  it("sends parentSessionId on register while ignoring null coms-identity clear for supervised peers", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pidash-parent-sid-"));
    const server = createHttpServer((_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const prevEnv = {
      PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
      PI_COMS_SUPERVISED_PEER: process.env.PI_COMS_SUPERVISED_PEER,
      PI_COMS_PARENT_SESSION_ID: process.env.PI_COMS_PARENT_SESSION_ID,
      PI_PIDASH_HOST: process.env.PI_PIDASH_HOST,
    };
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const eventListeners = new Map<string, Array<(data: any) => void>>();
    const flags = new Map<string, unknown>([
      ["coms", true],
      ["cname", "peer-1527"],
      ["project", "home__dev__git__pi-config"],
    ]);
    const pi: any = {
      on: (ev: string, fn: (...args: any[]) => any) => {
        const list = handlers.get(ev) ?? [];
        list.push(fn);
        handlers.set(ev, list);
      },
      events: {
        on: (ev: string, fn: (data: any) => void) => {
          const list = eventListeners.get(ev) ?? [];
          list.push(fn);
          eventListeners.set(ev, list);
        },
        emit: (ev: string, data: any) => {
          for (const fn of eventListeners.get(ev) ?? []) fn(data);
        },
      },
      registerCommand: () => {},
      getFlag: (name: string) => flags.get(name),
      getSessionName: () => undefined,
      getThinkingLevel: () => "medium",
    };
    const ctx: any = {
      mode: "rpc",
      hasUI: false,
      cwd: "/tmp/sandbox/workspace",
      model: { id: "gemini-4-neon", name: "Gemini 4 Neon", input: ["text"], reasoning: true, contextWindow: 128000 },
      sessionManager: { getEntries: () => [], getSessionFile: () => "" },
    };

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      assert.ok(addr && typeof addr !== "string");
      writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ pidash_enable: true, pidash_port: addr.port }));
      setGlobalSettingsPath(path.join(dir, "settings.json"));
      delete process.env.PI_SUBAGENT_CHILD;
      delete process.env.PI_PIDASH_HOST;
      process.env.PI_COMS_SUPERVISED_PEER = "1";
      process.env.PI_COMS_PARENT_SESSION_ID = "777:/home/dev/git/pi-config";

      const received: Record<string, unknown>[] = [];
      const registerPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for register frame")), 3000);
        timer.unref();
        sockets.on("connection", (socket) => {
          socket.on("message", (raw) => {
            const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
            received.push(parsed);
            if (parsed.type === "register") {
              clearTimeout(timer);
              resolve(parsed);
            }
          });
        });
      });

      registerPidash(pi);
      for (const fn of handlers.get("session_start") ?? []) fn({ reason: "startup" }, ctx);
      const reg = await registerPromise;
      assert.equal(reg.parentSessionId, "777:/home/dev/git/pi-config");
      assert.equal(reg.comsProject, "home__dev__git__pi-config");
      assert.equal(reg.supervisedPeer, true);

      // Simulate cleanShutdown emitting null identity before WS close
      pi.events.emit("pidash:coms-identity", { name: null, purpose: null });
      await new Promise((r) => setTimeout(r, 80));
      const nullClearFrames = received.filter((f) => f.type === "update_info" && f.comsName === null);
      assert.equal(nullClearFrames.length, 0);
    } finally {
      for (const fn of handlers.get("session_shutdown") ?? []) fn({}, ctx);
      for (const c of sockets.clients) c.terminate();
      await new Promise<void>((resolve) => sockets.close(() => server.close(() => resolve())));
      setGlobalSettingsPath(null);
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exposes parentSessionId on collectPeers from supervision metadata", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pidash-api-parent-"));
    try {
      const agentsDir = path.join(dir, "projects", "pi-config", "agents");
      const peersDir = path.join(dir, "peers");
      const socketsDir = path.join(dir, "sockets");
      mkdirSync(agentsDir, { recursive: true });
      mkdirSync(peersDir, { recursive: true });
      mkdirSync(socketsDir, { recursive: true });
      const sockPath = path.join(socketsDir, "peer-1527.sock");
      writeFileSync(sockPath, "");
      const nowIso = new Date().toISOString();
      writeFileSync(
        path.join(agentsDir, "peer-1527.json"),
        JSON.stringify({
          coms_session_id: "sid-1527",
          name: "peer-1527",
          project: "pi-config",
          pid: process.pid,
          cwd: "/home/dev/.pi/sandboxes/sb-1/workspace",
          purpose: "test",
          endpoint: sockPath,
          busy: false,
          started_at: nowIso,
          heartbeat_at: nowIso,
        }),
      );
      writeFileSync(
        path.join(peersDir, "peer-1527@pi-config.json"),
        JSON.stringify({
          cname: "peer-1527",
          project: "pi-config",
          pid: process.pid,
          childPid: process.pid,
          parentSessionId: "100:/home/dev/git/pi-config",
          startedAt: nowIso,
        }),
      );

      const summary = collectPeers(
        {
          getPort: () => 19190,
          getPiClients: () => new Map(),
          getBrowserCount: () => 0,
          getAsyncAgents: () => [],
          comsDir: dir,
          now: () => Date.now(),
        },
        "*",
      );

      assert.equal(summary.peers.length, 1);
      assert.equal((summary.peers[0] as any).parentSessionId, "100:/home/dev/git/pi-config");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits parentSessionId on collectPeers when only a disconnected client reuses the peer name", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pidash-api-stale-parent-"));
    try {
      const agentsDir = path.join(dir, "projects", "pi-config", "agents");
      const socketsDir = path.join(dir, "sockets");
      mkdirSync(agentsDir, { recursive: true });
      mkdirSync(socketsDir, { recursive: true });
      const sockPath = path.join(socketsDir, "peer-reuse.sock");
      writeFileSync(sockPath, "");
      const nowIso = new Date().toISOString();
      writeFileSync(
        path.join(agentsDir, "peer-reuse.json"),
        JSON.stringify({
          coms_session_id: "sid-new",
          name: "peer-reuse",
          project: "pi-config",
          pid: process.pid,
          cwd: "/home/dev/.pi/sandboxes/sb-new/workspace",
          purpose: "replacement",
          endpoint: sockPath,
          busy: false,
          started_at: nowIso,
          heartbeat_at: nowIso,
        }),
      );

      const sessions = new Map<string, PiClient>();
      const staleWs = { send: () => {} };
      const staleClient = registerPidashSession(
        sessions,
        staleWs,
        {
          sessionId: "old-peer-sid",
          pid: process.pid,
          cwd: "/home/dev/.pi/sandboxes/sb-old/workspace",
          comsName: "peer-reuse",
          comsProject: "pi-config",
          supervisedPeer: true,
          parentSessionId: "100:/home/dev/git/old-parent",
        },
        () => {},
      );
      disconnectPidashSession(staleClient, staleWs, "close", () => {});

      const summary = collectPeers(
        {
          getPort: () => 19190,
          getPiClients: () => sessions,
          getBrowserCount: () => 0,
          getAsyncAgents: () => [],
          comsDir: dir,
          now: () => Date.now(),
        },
        "*",
      );

      assert.equal(summary.peers.length, 1);
      assert.equal("parentSessionId" in summary.peers[0], false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exposes parentSessionId on collectPeers from active piClient matching live peer pid", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pidash-api-live-parent-"));
    try {
      const agentsDir = path.join(dir, "projects", "pi-config", "agents");
      const socketsDir = path.join(dir, "sockets");
      mkdirSync(agentsDir, { recursive: true });
      mkdirSync(socketsDir, { recursive: true });
      const sockPath = path.join(socketsDir, "peer-live.sock");
      writeFileSync(sockPath, "");
      const nowIso = new Date().toISOString();
      writeFileSync(
        path.join(agentsDir, "peer-live.json"),
        JSON.stringify({
          coms_session_id: "sid-live",
          name: "peer-live",
          project: "pi-config",
          pid: process.pid,
          cwd: "/home/dev/.pi/sandboxes/sb-live/workspace",
          purpose: "active",
          endpoint: sockPath,
          busy: false,
          started_at: nowIso,
          heartbeat_at: nowIso,
        }),
      );

      const sessions = new Map<string, PiClient>();
      registerPidashSession(
        sessions,
        { send: () => {} },
        {
          sessionId: "live-peer-sid",
          pid: process.pid,
          cwd: "/home/dev/.pi/sandboxes/sb-live/workspace",
          comsName: "peer-live",
          comsProject: "pi-config",
          supervisedPeer: true,
          parentSessionId: "555:/home/dev/git/pi-config",
        },
        () => {},
      );

      const summary = collectPeers(
        {
          getPort: () => 19190,
          getPiClients: () => sessions,
          getBrowserCount: () => 0,
          getAsyncAgents: () => [],
          comsDir: dir,
          now: () => Date.now(),
        },
        "*",
      );

      assert.equal(summary.peers.length, 1);
      assert.equal((summary.peers[0] as any).parentSessionId, "555:/home/dev/git/pi-config");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exposes parentSessionId on /api/status sessions snapshot", async () => {
    const sessions = new Map<string, PiClient>();
    registerPidashSession(
      sessions,
      { send: () => {} },
      {
        sessionId: "peer-status-1",
        pid: 4321,
        cwd: "/home/dev/.pi/sandboxes/sb-1/workspace",
        comsName: "peer-1527",
        comsProject: "pi-config",
        supervisedPeer: true,
        parentSessionId: "100:/home/dev/git/pi-config",
      },
      () => {},
    );
    const router = createPidashApiRouter({
      getPort: () => 19190,
      getPiClients: () => sessions,
      getBrowserCount: () => 0,
      getAsyncAgents: () => [],
      defaultCwd: process.cwd(),
      probeLocalHttp: async () => null,
      pingLspBroker: async () => null,
    });
    let statusCode = 0;
    let body = "";
    const done = new Promise<void>((resolve) => {
      const req: any = {
        method: "GET",
        url: "/api/status",
        headers: { host: "127.0.0.1:19190" },
        socket: { remoteAddress: "127.0.0.1" },
      };
      const res: any = {
        writableEnded: false,
        setHeader: () => {},
        writeHead: (code: number) => { statusCode = code; },
        end: (chunk?: string) => { body = chunk ?? ""; res.writableEnded = true; resolve(); },
      };
      const handled = router(new URL("http://127.0.0.1:19190/api/status"), req, res);
      assert.equal(handled, true);
    });
    await done;
    assert.equal(statusCode, 200);
    const parsed = JSON.parse(body);
    assert.equal(parsed.sessions.sessions[0].parentSessionId, "100:/home/dev/git/pi-config");
  });

  it("keeps scripts/pidash-api.ts free of @earendil-works runtime imports", () => {
    const src = readFileSync(path.resolve("scripts/pidash-api.ts"), "utf8");
    assert.equal(/^\s*import\b.*["']@earendil-works\//m.test(src), false);
  });
});
