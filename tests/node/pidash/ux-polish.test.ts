/**
 * #1448 — Unit and component tests for PiDash UX polish:
 * 1. Browser tab title formatting (`document.title`)
 * 2. Sidebar Needs Attention, Pin, Archived (closed by default), auto-unarchive, cross-tab sync, 200-ID cap
 * 3. Keyboard-first `1`–`9` prompt option selection (with confirm focus guard & mobile drawer pause) and multi-line custom answer `<textarea>`
 * 4. One-click Copy output button on bash/shell tool cards and logger diagnostics
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import * as rootReact from "react";
import { createServer, type ViteDevServer } from "vite";
import * as pidashReact from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { StrictMode, act, createElement } from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import type { Root } from "../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js";
import {
  ARCHIVED_SESSIONS_STORAGE_KEY,
  MAX_PERSISTED_SESSION_IDS,
  PINNED_SESSIONS_STORAGE_KEY,
  flattenSidebarSessions,
  formatDocumentTitle,
  isBashToolRole,
  loadSessionIdSet,
  partitionSidebarSessions,
  saveSessionIdSet,
  shouldPausePromptHotkeys,
  stripToolResultPrefix,
  toggleArchivedSession,
  togglePinnedSession,
  unarchiveSessionId,
} from "../../../extensions/pidash/pidash-ui/src/lib/pidash-ux-helpers.ts";
import { useSidebarSessionFlags } from "../../../extensions/pidash/pidash-ui/src/hooks/useSidebarSessionFlags.ts";
import type { ChatMessage, SessionInfo } from "../../../extensions/shared/types.ts";
import { elements, installReactDomShim } from "./react-dom-shim.mjs";

type LogRecord = { name: string; level: string; msg: string };
type LogBag = { __pidashUiLogs?: LogRecord[]; __PIDASH_DEBUG?: boolean };

function logBag(): LogBag {
  return globalThis as LogBag;
}

let vite: ViteDevServer;
let createRoot: (container: Element) => Root;
let SessionSidebar: any;
let MessageList: any;
let MessageItem: any;
let ToolGroup: any;

before(async () => {
  // Install the DOM shim before loading react-dom/client so React detects native
  // `oninput` support instead of activating its legacy IE9 keydown polyfill.
  installReactDomShim();
  ({ createRoot } = await import("../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js"));
  vite = await createServer({
    root: path.resolve("extensions/pidash/pidash-ui"),
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  ({ SessionSidebar } = await vite.ssrLoadModule("/src/components/SessionSidebar.tsx"));
  ({ MessageList, MessageItem, ToolGroup } = await vite.ssrLoadModule("/src/components/MessageList.tsx"));
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
const originalClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator ?? {}, "clipboard");

afterEach(async () => {
  while (mounted.length) await act(async () => mounted.pop()!.unmount());
  logBag().__pidashUiLogs = [];
  logBag().__PIDASH_DEBUG = false;
  if (originalLocalStorage === undefined) {
    delete (globalThis as any).localStorage;
  } else {
    Object.defineProperty(globalThis, "localStorage", { value: originalLocalStorage, configurable: true, writable: true });
  }
  if (globalThis.navigator) {
    if (originalClipboard) {
      Object.defineProperty(globalThis.navigator, "clipboard", originalClipboard);
    } else {
      delete (globalThis.navigator as any).clipboard;
    }
  }
});

function installMockStorage() {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  return { storage, map };
}

function makeSession(sessionId: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId,
    pid: 1,
    cwd: `/work/${sessionId}`,
    branch: "main",
    model: "claude-sonnet",
    startedAt: "2026-01-01T00:00:00Z",
    lastActivity: 0,
    active: true,
    activity: "idle",
    ...overrides,
  };
}

describe("formatDocumentTitle (#1448)", () => {
  it("returns 'pidash' when no session is selected", () => {
    assert.equal(formatDocumentTitle(null), "pidash");
    assert.equal(formatDocumentTitle(undefined), "pidash");
  });

  it("formats an idle named session title", () => {
    const idle = makeSession("s1", { name: "Auth Refactor", activity: "idle" });
    assert.equal(formatDocumentTitle(idle), "Auth Refactor — pidash");
  });

  it("formats a working named session title", () => {
    const working = makeSession("s2", { name: "Build Fix", activity: "working" });
    assert.equal(formatDocumentTitle(working), "Build Fix — pidash");
  });

  it("falls back to the project directory name for an unnamed session", () => {
    const unnamed = makeSession("s1", { name: "", cwd: "/home/dev/pi-config/" });
    assert.equal(formatDocumentTitle(unnamed), "pi-config — pidash");
  });

  it("prefixes [!] when an active session is waiting_for_input", () => {
    const waiting = makeSession("s1", { name: "Deploy", activity: "waiting_for_input", active: true });
    assert.equal(formatDocumentTitle(waiting), "[!] Deploy — pidash");
  });

  it("prefixes [!] when an active session has a pending prompt", () => {
    const active = makeSession("s1", { name: "Review", activity: "idle", active: true });
    assert.equal(formatDocumentTitle(active, true), "[!] Review — pidash");
  });

  it("omits [!] when the session is offline", () => {
    const offline = makeSession("s1", { name: "Old", activity: "waiting_for_input", active: false });
    assert.equal(formatDocumentTitle(offline, true), "Old — pidash");
  });
});

describe("sidebar state helpers (#1448)", () => {
  it("adds an unpinned session on togglePinnedSession", () => {
    const next = togglePinnedSession(new Set(), new Set(), "s1");
    assert.equal(next.isPinned, true);
    assert.equal(next.pinned.has("s1"), true);
  });

  it("removes an already pinned session on togglePinnedSession", () => {
    const next = togglePinnedSession(new Set(["s1"]), new Set(), "s1");
    assert.equal(next.isPinned, false);
    assert.equal(next.pinned.has("s1"), false);
  });

  it("unarchives an archived session when it is pinned", () => {
    const next = togglePinnedSession(new Set(), new Set(["s1"]), "s1");
    assert.equal(next.pinned.has("s1"), true);
    assert.equal(next.archived.has("s1"), false);
  });

  it("unpins a pinned session when it is archived", () => {
    const next = toggleArchivedSession(new Set(["s1"]), new Set(), "s1");
    assert.equal(next.isArchived, true);
    assert.equal(next.archived.has("s1"), true);
    assert.equal(next.pinned.has("s1"), false);
  });

  it("removes an archived session on toggleArchivedSession", () => {
    const next = toggleArchivedSession(new Set(), new Set(["s1"]), "s1");
    assert.equal(next.isArchived, false);
    assert.equal(next.archived.has("s1"), false);
  });

  it("removes an archived session on unarchiveSessionId", () => {
    const updated = unarchiveSessionId(new Set(["s1"]), "s1");
    assert.equal(updated.changed, true);
    assert.equal(updated.archived.has("s1"), false);
  });

  it("no-ops on unarchiveSessionId for a non-archived session", () => {
    const unchanged = unarchiveSessionId(new Set(["s1"]), "s2");
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.archived.has("s1"), true);
  });

  it("round-trips persisted session ID sets through localStorage", () => {
    installMockStorage();
    saveSessionIdSet(PINNED_SESSIONS_STORAGE_KEY, new Set(["a", "b"]));
    assert.deepEqual([...loadSessionIdSet(PINNED_SESSIONS_STORAGE_KEY)], ["a", "b"]);
  });

  it("recovers with an empty set when localStorage holds invalid JSON", () => {
    const { map } = installMockStorage();
    logBag().__pidashUiLogs = [];
    map.set(PINNED_SESSIONS_STORAGE_KEY, "{not valid json");
    assert.deepEqual([...loadSessionIdSet(PINNED_SESSIONS_STORAGE_KEY)], []);
    assert.ok(
      (logBag().__pidashUiLogs ?? []).some(
        (entry) => entry.name === "pidash-ux" && entry.level === "warn" && entry.msg.includes("failed to load persisted session id set"),
      ),
    );
  });

  it("logs a warning when saveSessionIdSet encounters a storage write error", () => {
    logBag().__pidashUiLogs = [];
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: () => null,
        setItem: () => { throw new Error("QuotaExceededError"); },
        removeItem: () => {},
        clear: () => {},
        key: () => null,
        length: 0,
      },
      configurable: true,
      writable: true,
    });
    assert.equal(saveSessionIdSet(PINNED_SESSIONS_STORAGE_KEY, new Set(["s-1"])), false);
    assert.ok(
      (logBag().__pidashUiLogs ?? []).some(
        (entry) => entry.name === "pidash-ux" && entry.level === "warn" && entry.msg.includes("failed to save persisted session id set"),
      ),
    );
  });

  it("caps persisted session ID sets to the most recent 200 entries", () => {
    installMockStorage();
    const many = new Set<string>();
    for (let i = 0; i < MAX_PERSISTED_SESSION_IDS + 25; i++) {
      many.add(`s-${i}`);
    }
    saveSessionIdSet(PINNED_SESSIONS_STORAGE_KEY, many);
    const reloaded = [...loadSessionIdSet(PINNED_SESSIONS_STORAGE_KEY)];
    assert.equal(reloaded.length, MAX_PERSISTED_SESSION_IDS);
    assert.equal(reloaded[0], "s-25");
    assert.equal(reloaded.at(-1), `s-${MAX_PERSISTED_SESSION_IDS + 24}`);
  });

  it("surfaces archived waiting_for_input sessions in Needs attention", () => {
    const sAttention = makeSession("s-attn", { name: "Needs Input", activity: "waiting_for_input" });
    const sArchivedWaiting = makeSession("s-arch-wait", { name: "Archived Prompt", activity: "waiting_for_input" });
    const sPinned = makeSession("s-pin", { name: "Pinned Work", activity: "working" });
    const sRegular = makeSession("s-reg", { name: "Regular", cwd: "/work/app" });
    const sArchivedIdle = makeSession("s-arch", { name: "Archived Idle" });

    const parts = partitionSidebarSessions(
      [sRegular, sArchivedIdle, sPinned, sAttention, sArchivedWaiting],
      {
        pinnedIds: new Set(["s-pin"]),
        archivedIds: new Set(["s-arch", "s-arch-wait"]),
      },
    );

    assert.deepEqual(parts.needsAttention.map((s) => s.sessionId), ["s-arch-wait", "s-attn"]);
    assert.deepEqual(parts.pinned.map((s) => s.sessionId), ["s-pin"]);
    assert.deepEqual(parts.groups.flatMap((g) => g.sessions.map((s) => s.sessionId)), ["s-reg"]);
    assert.deepEqual(parts.archived.map((s) => s.sessionId), ["s-arch", "s-arch-wait"]);
  });

  it("deduplicates archived attention sessions in flattenSidebarSessions", () => {
    const sArchivedWaiting = makeSession("s-arch-wait", { name: "Archived Prompt", activity: "waiting_for_input" });
    const sRegular = makeSession("s-reg", { name: "Regular", cwd: "/work/app" });
    const parts = partitionSidebarSessions([sRegular, sArchivedWaiting], {
      pinnedIds: new Set(),
      archivedIds: new Set(["s-arch-wait"]),
    });
    assert.deepEqual(
      flattenSidebarSessions(parts).map((s) => s.sessionId),
      ["s-arch-wait", "s-reg"],
    );
  });
});

describe("useSidebarSessionFlags hook (#1448)", () => {
  async function mountFlagsHook() {
    const { container } = installReactDomShim();
    let api!: ReturnType<typeof useSidebarSessionFlags>;
    function Probe() {
      api = useSidebarSessionFlags();
      return null;
    }
    const root = createRoot(container);
    mounted.push(root);
    await act(async () => root.render(createElement(Probe)));
    return { getApi: () => api };
  }

  it("persists pin toggles to localStorage", async () => {
    installMockStorage();
    const { getApi } = await mountFlagsHook();

    await act(async () => getApi().togglePin("s-1"));
    assert.equal(getApi().pinned.has("s-1"), true);
    assert.deepEqual([...loadSessionIdSet(PINNED_SESSIONS_STORAGE_KEY)], ["s-1"]);
  });

  it("persists archive toggles to localStorage", async () => {
    installMockStorage();
    const { getApi } = await mountFlagsHook();

    await act(async () => getApi().toggleArchive("s-2"));
    assert.equal(getApi().archived.has("s-2"), true);
    assert.deepEqual([...loadSessionIdSet(ARCHIVED_SESSIONS_STORAGE_KEY)], ["s-2"]);
  });

  it("auto-unarchives an archived session on send", async () => {
    installMockStorage();
    saveSessionIdSet(ARCHIVED_SESSIONS_STORAGE_KEY, new Set(["s-3"]));
    logBag().__pidashUiLogs = [];

    const { getApi } = await mountFlagsHook();
    assert.equal(getApi().archived.has("s-3"), true);

    await act(async () => getApi().unarchive("s-3"));
    assert.equal(getApi().archived.has("s-3"), false);
    assert.deepEqual([...loadSessionIdSet(ARCHIVED_SESSIONS_STORAGE_KEY)], []);
    assert.ok(
      (logBag().__pidashUiLogs ?? []).some(
        (entry) => entry.name === "SidebarFlags" && entry.level === "info" && entry.msg.includes("auto-unarchived"),
      ),
    );
  });

  it("preserves alternating pin updates made across two tabs", async () => {
    installMockStorage();
    const tabA = await mountFlagsHook();
    const tabB = await mountFlagsHook();

    await act(async () => tabA.getApi().togglePin("s-tab-a"));
    // Tab B toggles a different session before receiving a storage event
    await act(async () => tabB.getApi().togglePin("s-tab-b"));

    assert.deepEqual([...loadSessionIdSet(PINNED_SESSIONS_STORAGE_KEY)], ["s-tab-a", "s-tab-b"]);
    assert.deepEqual([...tabB.getApi().pinned], ["s-tab-a", "s-tab-b"]);
  });

  it("syncs state when another tab dispatches a storage event", async () => {
    installMockStorage();
    const { getApi } = await mountFlagsHook();
    assert.equal(getApi().pinned.has("s-remote"), false);

    saveSessionIdSet(PINNED_SESSIONS_STORAGE_KEY, new Set(["s-remote"]));
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: PINNED_SESSIONS_STORAGE_KEY }));
    });
    assert.equal(getApi().pinned.has("s-remote"), true);
  });

  it("keeps a pin applied under React StrictMode without double-toggling", async () => {
    installMockStorage();
    const { container } = installReactDomShim();
    let api!: ReturnType<typeof useSidebarSessionFlags>;
    function Probe() {
      api = useSidebarSessionFlags();
      return null;
    }
    const root = createRoot(container);
    mounted.push(root);
    await act(async () => root.render(createElement(StrictMode, null, createElement(Probe))));

    await act(async () => api.togglePin("s-strict"));
    assert.equal(api.pinned.has("s-strict"), true);
    assert.deepEqual([...loadSessionIdSet(PINNED_SESSIONS_STORAGE_KEY)], ["s-strict"]);
  });

  it("retains in-memory flags across subsequent toggles when storage writes fail", async () => {
    const map = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: () => { throw new Error("QuotaExceededError"); },
        removeItem: (k: string) => map.delete(k),
        clear: () => map.clear(),
        key: () => null,
        length: 0,
      },
      configurable: true,
      writable: true,
    });
    const { getApi } = await mountFlagsHook();

    await act(async () => getApi().togglePin("s-mem-1"));
    await act(async () => getApi().togglePin("s-mem-2"));
    assert.deepEqual([...getApi().pinned], ["s-mem-1", "s-mem-2"]);
  });

  it("rolls back the first key write when persisting pin+archive fails halfway", async () => {
    const map = new Map<string, string>([
      [PINNED_SESSIONS_STORAGE_KEY, JSON.stringify([])],
      [ARCHIVED_SESSIONS_STORAGE_KEY, JSON.stringify(["s-arch-1"])],
    ]);
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => {
          if (k === ARCHIVED_SESSIONS_STORAGE_KEY) throw new Error("QuotaExceededError");
          map.set(k, v);
        },
        removeItem: (k: string) => map.delete(k),
        clear: () => map.clear(),
        key: () => null,
        get length() { return map.size; },
      },
      configurable: true,
      writable: true,
    });
    const { getApi } = await mountFlagsHook();

    await act(async () => getApi().togglePin("s-arch-1"));
    // In-memory state reflects the user action while storage was rolled back atomically.
    assert.equal(getApi().pinned.has("s-arch-1"), true);
    assert.equal(getApi().archived.has("s-arch-1"), false);
    assert.deepEqual(JSON.parse(map.get(PINNED_SESSIONS_STORAGE_KEY) ?? "[]"), []);
    assert.deepEqual(JSON.parse(map.get(ARCHIVED_SESSIONS_STORAGE_KEY) ?? "[]"), ["s-arch-1"]);
  });
});

describe("SessionSidebar UI sections (#1448)", () => {
  it("orders Needs attention, Pinned, project groups, then Archived", async () => {
    installMockStorage();
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const sessions = [
      makeSession("s-wait", { name: "Waiting Session", activity: "waiting_for_input" }),
      makeSession("s-pin", { name: "Pinned Session" }),
      makeSession("s-reg", { name: "Regular Session", cwd: "/work/repo" }),
      makeSession("s-arch", { name: "Hidden Session" }),
    ];

    await act(async () => root.render(createElement(SessionSidebar, {
      sessions,
      activeSessionId: null,
      connected: true,
      onSelect: () => {},
      collapsed: false,
      onToggle: () => {},
      pinnedSessionIds: new Set(["s-pin"]),
      archivedSessionIds: new Set(["s-arch", "s-wait"]),
      onTogglePin: () => {},
      onToggleArchive: () => {},
    })));

    const sections = elements(container, "div")
      .map((el) => el.getAttribute("data-section"))
      .filter((s): s is string => Boolean(s));
    assert.deepEqual(sections, ["needs-attention", "pinned", "archived"]);
  });

  it("keeps the Archived section collapsed by default with its count", async () => {
    installMockStorage();
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const sessions = [
      makeSession("s-wait", { name: "Waiting Session", activity: "waiting_for_input" }),
      makeSession("s-arch", { name: "Hidden Session" }),
    ];

    await act(async () => root.render(createElement(SessionSidebar, {
      sessions,
      activeSessionId: null,
      connected: true,
      onSelect: () => {},
      collapsed: false,
      onToggle: () => {},
      pinnedSessionIds: new Set(),
      archivedSessionIds: new Set(["s-arch", "s-wait"]),
      onTogglePin: () => {},
      onToggleArchive: () => {},
    })));

    assert.equal((container.textContent ?? "").includes("Hidden Session"), false);
    const archHeader = elements(container, "div").find(
      (el) => el.getAttribute("role") === "button" && (el.textContent ?? "").includes("Archived"),
    );
    assert.ok(archHeader);
    assert.equal(archHeader.getAttribute("aria-expanded"), "false");
    assert.match(archHeader.textContent ?? "", /2/);
  });

  it("reveals archived sessions when the Archived header is clicked", async () => {
    installMockStorage();
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    await act(async () => root.render(createElement(SessionSidebar, {
      sessions: [makeSession("s-arch", { name: "Hidden Session" })],
      activeSessionId: null,
      connected: true,
      onSelect: () => {},
      collapsed: false,
      onToggle: () => {},
      pinnedSessionIds: new Set(),
      archivedSessionIds: new Set(["s-arch"]),
      onTogglePin: () => {},
      onToggleArchive: () => {},
    })));

    const archHeader = elements(container, "div").find(
      (el) => el.getAttribute("role") === "button" && (el.textContent ?? "").includes("Archived"),
    );
    assert.ok(archHeader);
    await act(async () => archHeader.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.equal(archHeader.getAttribute("aria-expanded"), "true");
    assert.match(container.textContent ?? "", /Hidden Session/);
  });

  it("excludes archived Coms members from the Coms section", async () => {
    installMockStorage();
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const sessions = [
      makeSession("s-coms-live", { name: "Live Peer", comsProject: "team-proj", comsName: "peer-live" }),
      makeSession("s-coms-arch", { name: "Archived Peer", comsProject: "team-proj", comsName: "peer-arch" }),
    ];

    await act(async () => root.render(createElement(SessionSidebar, {
      sessions,
      activeSessionId: null,
      connected: true,
      onSelect: () => {},
      collapsed: false,
      onToggle: () => {},
      pinnedSessionIds: new Set(),
      archivedSessionIds: new Set(["s-coms-arch"]),
      onTogglePin: () => {},
      onToggleArchive: () => {},
    })));

    const text = container.textContent ?? "";
    assert.match(text, /Live Peer/);
    assert.equal(text.includes("Archived Peer"), false);
  });

  it("invokes onTogglePin without selecting the row", async () => {
    installMockStorage();
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const selected: string[] = [];
    const pinnedCalls: string[] = [];

    await act(async () => root.render(createElement(SessionSidebar, {
      sessions: [makeSession("s-1", { name: "Alpha" })],
      activeSessionId: null,
      connected: true,
      onSelect: (s: SessionInfo) => selected.push(s.sessionId),
      collapsed: false,
      onToggle: () => {},
      pinnedSessionIds: new Set(),
      archivedSessionIds: new Set(),
      onTogglePin: (id: string) => pinnedCalls.push(id),
      onToggleArchive: () => {},
    })));

    const pinBtn = elements(container, "button").find((b) => b.getAttribute("aria-label") === "Pin session");
    assert.ok(pinBtn);
    await act(async () => pinBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    assert.deepEqual(pinnedCalls, ["s-1"]);
    assert.deepEqual(selected, []);
  });

  it("invokes onToggleArchive without selecting the row", async () => {
    installMockStorage();
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const selected: string[] = [];
    const archivedCalls: string[] = [];

    await act(async () => root.render(createElement(SessionSidebar, {
      sessions: [makeSession("s-1", { name: "Alpha" })],
      activeSessionId: null,
      connected: true,
      onSelect: (s: SessionInfo) => selected.push(s.sessionId),
      collapsed: false,
      onToggle: () => {},
      pinnedSessionIds: new Set(),
      archivedSessionIds: new Set(),
      onTogglePin: () => {},
      onToggleArchive: (id: string) => archivedCalls.push(id),
    })));

    const archiveBtn = elements(container, "button").find((b) => b.getAttribute("aria-label") === "Archive session");
    assert.ok(archiveBtn);
    await act(async () => archiveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    assert.deepEqual(archivedCalls, ["s-1"]);
    assert.deepEqual(selected, []);
  });
});

describe("AskPromptCard 1-9 hotkeys (#1448)", () => {
  it("renders 1..9 keycap badges on option buttons", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const msg: ChatMessage = {
      id: "m-ask-badges",
      role: "ask_user" as any,
      text: "Choose target",
      className: "ask|ask-b|select|Dev|||Staging|||Prod",
    };

    await act(async () => root.render(createElement(MessageItem, { msg })));
    assert.deepEqual(elements(container, "kbd").map((k) => k.textContent), ["1", "2", "3"]);
  });

  it("selects option N on an unmodified number keypress for select prompts", async () => {
    const { container, document } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    let chosen: [string, string] | null = null;
    const msg: ChatMessage = {
      id: "m-ask-1",
      role: "ask_user" as any,
      text: "Choose target",
      className: "ask|ask-1|select|Dev|||Staging|||Prod",
    };

    await act(async () => root.render(createElement(MessageItem, {
      msg,
      onAskResponse: (id: string, value: string) => { chosen = [id, value]; },
    })));

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    });
    assert.deepEqual(chosen, ["ask-1", "Staging"]);
    assert.match(container.textContent ?? "", /✓ Answered: Staging/);
  });

  it("ignores global number keys for confirm prompts when focus is outside the card", async () => {
    const { container, document } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    let chosen: [string, string] | null = null;
    const msg: ChatMessage = {
      id: "m-confirm-1",
      role: "ask_user" as any,
      text: "Run rm -rf?",
      className: "ask|ask-c1|confirm|Yes|||No",
    };

    await act(async () => root.render(createElement(MessageItem, {
      msg,
      onAskResponse: (id: string, value: string) => { chosen = [id, value]; },
    })));

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    assert.equal(chosen, null);
  });

  it("accepts number keys for confirm prompts when focus is inside the card", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    let chosen: [string, string] | null = null;
    const msg: ChatMessage = {
      id: "m-confirm-2",
      role: "ask_user" as any,
      text: "Continue?",
      className: "ask|ask-c2|confirm|Yes|||No",
    };

    await act(async () => root.render(createElement(MessageItem, {
      msg,
      onAskResponse: (id: string, value: string) => { chosen = [id, value]; },
    })));

    const yesBtn = elements(container, "button").find((b) => b.textContent?.includes("Yes"));
    assert.ok(yesBtn);
    yesBtn.focus();
    await act(async () => {
      yesBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    });
    assert.deepEqual(chosen, ["ask-c2", "__denied__"]);
  });

  it("ignores repeated keydown events on select prompts", async () => {
    const { container, document } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    let chosen: [string, string] | null = null;
    const msg: ChatMessage = {
      id: "m-ask-rep",
      role: "ask_user" as any,
      text: "Pick one",
      className: "ask|ask-rep|select|One|||Two",
    };

    await act(async () => root.render(createElement(MessageItem, {
      msg,
      onAskResponse: (id: string, value: string) => { chosen = [id, value]; },
    })));

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", repeat: true, bubbles: true }));
    });
    assert.equal(chosen, null);
  });

  it("ignores number keys when an input element is focused", async () => {
    const { container, document } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    let chosen: [string, string] | null = null;
    const msg: ChatMessage = {
      id: "m-ask-in",
      role: "ask_user" as any,
      text: "Pick one",
      className: "ask|ask-in|select|One|||Two",
    };

    await act(async () => root.render(createElement(MessageItem, {
      msg,
      onAskResponse: (id: string, value: string) => { chosen = [id, value]; },
    })));

    const input = document.createElement("input");
    input.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    assert.equal(chosen, null);
  });

  it("ignores number keys when a textarea element is focused", async () => {
    const { container, document } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    let chosen: [string, string] | null = null;
    const msg: ChatMessage = {
      id: "m-ask-ta",
      role: "ask_user" as any,
      text: "Pick one",
      className: "ask|ask-ta|select|One|||Two",
    };

    await act(async () => root.render(createElement(MessageItem, {
      msg,
      onAskResponse: (id: string, value: string) => { chosen = [id, value]; },
    })));

    const area = document.createElement("textarea");
    area.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    assert.equal(chosen, null);
  });

  it("ignores number keys when a contenteditable element is focused", async () => {
    const { container, document } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    let chosen: [string, string] | null = null;
    const msg: ChatMessage = {
      id: "m-ask-ce",
      role: "ask_user" as any,
      text: "Pick one",
      className: "ask|ask-ce|select|One|||Two",
    };

    await act(async () => root.render(createElement(MessageItem, {
      msg,
      onAskResponse: (id: string, value: string) => { chosen = [id, value]; },
    })));

    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    editable.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    assert.equal(chosen, null);
  });

  it("ignores number keys when modifier keys are held", async () => {
    const { container, document } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    let chosen: [string, string] | null = null;
    const msg: ChatMessage = {
      id: "m-ask-mod",
      role: "ask_user" as any,
      text: "Pick one",
      className: "ask|ask-mod|select|One|||Two",
    };

    await act(async () => root.render(createElement(MessageItem, {
      msg,
      onAskResponse: (id: string, value: string) => { chosen = [id, value]; },
    })));

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", ctrlKey: true, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", metaKey: true, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", altKey: true, bubbles: true }));
    });
    assert.equal(chosen, null);
  });

  it("ignores out-of-range digit keys", async () => {
    const { container, document } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    let chosen: [string, string] | null = null;
    const msg: ChatMessage = {
      id: "m-ask-range",
      role: "ask_user" as any,
      text: "Pick one",
      className: "ask|ask-range|select|One|||Two",
    };

    await act(async () => root.render(createElement(MessageItem, {
      msg,
      onAskResponse: (id: string, value: string) => { chosen = [id, value]; },
    })));

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "9", bubbles: true }));
    });
    assert.equal(chosen, null);
  });

  it("routes number keys only to the latest active select prompt in MessageList", async () => {
    const { container, document } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const calls: Array<[string, string]> = [];
    const messages: ChatMessage[] = [
      { id: "m-old", role: "ask_user" as any, text: "First", className: "ask|ask-old|select|A1|||A2" },
      { id: "m-new", role: "ask_user" as any, text: "Second", className: "ask|ask-new|select|B1|||B2" },
    ];

    await act(async () => root.render(createElement(MessageList, {
      messages,
      onAskResponse: (id: string, value: string) => calls.push([id, value]),
    })));

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    assert.deepEqual(calls, [["ask-new", "B1"]]);
  });

  it("does not skip past a newer unanswered confirm prompt to answer an older select prompt", async () => {
    const { container, document } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const calls: Array<[string, string]> = [];
    const messages: ChatMessage[] = [
      { id: "m-old-sel", role: "ask_user" as any, text: "Earlier select", className: "ask|ask-old-sel|select|A1|||A2" },
      { id: "m-new-cfm", role: "ask_user" as any, text: "Confirm deploy?", className: "ask|ask-new-cfm|confirm|Yes|||No" },
    ];

    await act(async () => root.render(createElement(MessageList, {
      messages,
      onAskResponse: (id: string, value: string) => calls.push([id, value]),
    })));

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    assert.deepEqual(calls, []);
  });

  it("restores number shortcuts to an older pending select prompt right after a newer prompt is answered locally", async () => {
    const { container, document } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const calls: Array<[string, string]> = [];
    const messages: ChatMessage[] = [
      { id: "m-old-2", role: "ask_user" as any, text: "Earlier select", className: "ask|ask-old-2|select|A1|||A2" },
      { id: "m-new-2", role: "ask_user" as any, text: "Latest select", className: "ask|ask-new-2|select|B1|||B2" },
    ];

    await act(async () => root.render(createElement(MessageList, {
      messages,
      onAskResponse: (id: string, value: string) => calls.push([id, value]),
    })));

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    assert.deepEqual(calls, [["ask-new-2", "B1"]]);

    // Before ui-dismiss mutates messages, pressing 2 immediately answers the older pending select card.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    });
    assert.deepEqual(calls, [["ask-new-2", "B1"], ["ask-old-2", "A2"]]);
  });

  it("does not answer an older search-matched select prompt while a newer unanswered prompt is filtered out", async () => {
    const { container, document } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const calls: Array<[string, string]> = [];
    const messages: ChatMessage[] = [
      { id: "m-old-match", role: "ask_user" as any, text: "Alpha question", className: "ask|ask-old-match|select|A1|||A2" },
      { id: "m-new-hidden", role: "ask_user" as any, text: "Beta question", className: "ask|ask-new-hidden|select|B1|||B2" },
    ];

    await act(async () => root.render(createElement(MessageList, {
      messages,
      searchQuery: "Alpha",
      onAskResponse: (id: string, value: string) => calls.push([id, value]),
    })));

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    assert.deepEqual(calls, []);
  });

  it("pauses prompt hotkeys when a mobile SidePanel drawer covers the chat", () => {
    assert.equal(
      shouldPausePromptHotkeys({
        showSwitcher: false,
        showSettings: false,
        showNewSession: false,
        hasActivePanel: true,
        sidebarOpen: false,
        isMobileViewport: true,
      }),
      true,
    );
    assert.equal(
      shouldPausePromptHotkeys({
        showSwitcher: false,
        showSettings: false,
        showNewSession: false,
        hasActivePanel: true,
        sidebarOpen: false,
        isMobileViewport: false,
      }),
      false,
    );
  });

  it("suppresses number keys in MessageList while promptHotkeysPaused is true", async () => {
    const { container, document } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const calls: Array<[string, string]> = [];
    const messages: ChatMessage[] = [
      { id: "m-hidden", role: "ask_user" as any, text: "Hidden", className: "ask|ask-hidden|select|Yes|||No" },
    ];

    await act(async () => root.render(createElement(MessageList, {
      messages,
      promptHotkeysPaused: true,
      onAskResponse: (id: string, value: string) => calls.push([id, value]),
    })));

    const drawerButton = document.createElement("button");
    drawerButton.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    assert.deepEqual(calls, []);
  });
});

describe("AskPromptCard multi-line custom answer textarea (#1448)", () => {
  it("does not submit on Shift+Enter so a newline can be inserted", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    let submitted: [string, string] | null = null;
    const msg: ChatMessage = {
      id: "m-input-shift",
      role: "ask_user" as any,
      text: "Describe changes",
      className: "ask|ask-in-shift|input|",
    };

    await act(async () => root.render(createElement(MessageItem, {
      msg,
      onAskResponse: (id: string, value: string) => { submitted = [id, value]; },
    })));

    const textarea = elements(container, "textarea")[0] as HTMLTextAreaElement;
    assert.ok(textarea);
    textarea.value = "line one";

    const shiftEnter = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true });
    await act(async () => { textarea.dispatchEvent(shiftEnter); });
    assert.equal(shiftEnter.defaultPrevented, false);
    assert.equal(submitted, null);
  });

  it("submits multi-line text on unmodified Enter through public DOM events", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    let submitted: [string, string] | null = null;
    const msg: ChatMessage = {
      id: "m-input-enter",
      role: "ask_user" as any,
      text: "Describe changes",
      className: "ask|ask-in-enter|input|",
    };

    await act(async () => root.render(createElement(MessageItem, {
      msg,
      onAskResponse: (id: string, value: string) => { submitted = [id, value]; },
    })));

    const textarea = elements(container, "textarea")[0] as HTMLTextAreaElement;
    textarea.value = "line one\nline two";

    const enter = new KeyboardEvent("keydown", { key: "Enter", shiftKey: false, bubbles: true });
    await act(async () => { textarea.dispatchEvent(enter); });
    assert.equal(enter.defaultPrevented, true);
    assert.deepEqual(submitted, ["ask-in-enter", "line one\nline two"]);
  });

  it("preserves outer indentation plus trailing newline in multi-line answers", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    let submitted: [string, string] | null = null;
    const msg: ChatMessage = {
      id: "m-input-ws",
      role: "ask_user" as any,
      text: "Paste snippet",
      className: "ask|ask-in-ws|input|",
    };

    await act(async () => root.render(createElement(MessageItem, {
      msg,
      onAskResponse: (id: string, value: string) => { submitted = [id, value]; },
    })));

    const textarea = elements(container, "textarea")[0] as HTMLTextAreaElement;
    const raw = "  const x = 1;\n  return x;\n";
    textarea.value = raw;

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    assert.deepEqual(submitted, ["ask-in-ws", raw]);
  });

  it("ignores whitespace-only custom answers", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    let submitted: [string, string] | null = null;
    const msg: ChatMessage = {
      id: "m-input-blank",
      role: "ask_user" as any,
      text: "Enter value",
      className: "ask|ask-in-blank|input|",
    };

    await act(async () => root.render(createElement(MessageItem, {
      msg,
      onAskResponse: (id: string, value: string) => { submitted = [id, value]; },
    })));

    const textarea = elements(container, "textarea")[0] as HTMLTextAreaElement;
    textarea.value = "   \n\t  ";

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    assert.equal(submitted, null);
  });

  it("does not submit on Enter while IME isComposing is true", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    let submitted: [string, string] | null = null;
    const msg: ChatMessage = {
      id: "m-input-ime",
      role: "ask_user" as any,
      text: "Enter Japanese text",
      className: "ask|ask-in-ime|input|",
    };

    await act(async () => root.render(createElement(MessageItem, {
      msg,
      onAskResponse: (id: string, value: string) => { submitted = [id, value]; },
    })));

    const textarea = elements(container, "textarea")[0] as HTMLTextAreaElement;
    textarea.value = "にほんご";

    const imeEnter = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true } as any);
    await act(async () => { textarea.dispatchEvent(imeEnter); });
    assert.equal(imeEnter.defaultPrevented, false);
    assert.equal(submitted, null);
  });

  it("does not submit on Enter when IME keyCode is 229", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    let submitted: [string, string] | null = null;
    const msg: ChatMessage = {
      id: "m-input-ime229",
      role: "ask_user" as any,
      text: "Enter CJK text",
      className: "ask|ask-in-ime229|input|",
    };

    await act(async () => root.render(createElement(MessageItem, {
      msg,
      onAskResponse: (id: string, value: string) => { submitted = [id, value]; },
    })));

    const textarea = elements(container, "textarea")[0] as HTMLTextAreaElement;
    textarea.value = "中文";

    const imeEnter = new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true } as any);
    await act(async () => { textarea.dispatchEvent(imeEnter); });
    assert.equal(imeEnter.defaultPrevented, false);
    assert.equal(submitted, null);
  });
});

describe("bash tool card Copy output button (#1448)", () => {
  it("recognizes bash or shell tool roles case-insensitively", () => {
    assert.equal(isBashToolRole("bash"), true);
    assert.equal(isBashToolRole("shell"), true);
    assert.equal(isBashToolRole("BASH"), true);
    assert.equal(isBashToolRole("read"), false);
  });

  it("strips synthetic status prefixes from tool output", () => {
    assert.equal(stripToolResultPrefix("✓ hello\nworld"), "hello\nworld");
    assert.equal(stripToolResultPrefix("✗ exit 1"), "exit 1");
    assert.equal(stripToolResultPrefix("plain output"), "plain output");
  });

  it("copies raw bash output from a collapsed ToolGroup with Copied feedback", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const copiedTexts: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: async (txt: string) => { copiedTexts.push(txt); } },
      configurable: true,
    });

    const call: ChatMessage = { id: "c1", role: "bash" as any, text: "echo hi", className: "tool-call", meta: { callId: "k1" } };
    const result: ChatMessage = { id: "r1", role: "bash" as any, text: "✓ hi\nthere", className: "tool-result", meta: { callId: "k1" } };

    await act(async () => root.render(createElement(ToolGroup, { call, result })));

    const copyBtn = elements(container, "button").find((b) => b.getAttribute("aria-label") === "Copy output");
    assert.ok(copyBtn);
    assert.match(copyBtn.textContent ?? "", /Copy/);

    await act(async () => {
      copyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.deepEqual(copiedTexts, ["hi\nthere"]);
    assert.match(copyBtn.textContent ?? "", /Copied/);
  });

  it("logs a debug entry when bash output copy succeeds", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    logBag().__PIDASH_DEBUG = true;
    logBag().__pidashUiLogs = [];
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: async () => {} },
      configurable: true,
    });

    const call: ChatMessage = { id: "c-log-ok", role: "bash" as any, text: "pwd", className: "tool-call", meta: { callId: "k-log-ok" } };
    const result: ChatMessage = { id: "r-log-ok", role: "bash" as any, text: "✓ /repo", className: "tool-result", meta: { callId: "k-log-ok" } };

    await act(async () => root.render(createElement(ToolGroup, { call, result })));

    const copyBtn = elements(container, "button").find((b) => b.getAttribute("aria-label") === "Copy output");
    assert.ok(copyBtn);
    await act(async () => {
      copyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    assert.ok(
      (logBag().__pidashUiLogs ?? []).some(
        (entry) => entry.name === "MessageList" && entry.level === "debug" && entry.msg.includes("copied bash tool output"),
      ),
    );
  });

  it("logs a warning when clipboard write rejects", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    logBag().__pidashUiLogs = [];
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: async () => { throw new Error("clipboard denied"); } },
      configurable: true,
    });

    const call: ChatMessage = { id: "c-log-err", role: "bash" as any, text: "pwd", className: "tool-call", meta: { callId: "k-log-err" } };
    const result: ChatMessage = { id: "r-log-err", role: "bash" as any, text: "✓ /repo", className: "tool-result", meta: { callId: "k-log-err" } };

    await act(async () => root.render(createElement(ToolGroup, { call, result })));

    const copyBtn = elements(container, "button").find((b) => b.getAttribute("aria-label") === "Copy output");
    assert.ok(copyBtn);
    await act(async () => {
      copyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    assert.ok(
      (logBag().__pidashUiLogs ?? []).some(
        (entry) => entry.name === "MessageList" && entry.level === "warn" && entry.msg.includes("failed to copy bash tool output"),
      ),
    );
  });

  it("omits the header Copy output button on non-bash tool cards", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const call: ChatMessage = { id: "c2", role: "read" as any, text: "README.md", className: "tool-call", meta: { callId: "k2" } };
    const result: ChatMessage = { id: "r2", role: "read" as any, text: "✓ contents", className: "tool-result", meta: { callId: "k2" } };

    await act(async () => root.render(createElement(ToolGroup, { call, result })));

    const copyBtn = elements(container, "button").find((b) => b.getAttribute("aria-label") === "Copy output");
    assert.equal(copyBtn, undefined);
  });
});
