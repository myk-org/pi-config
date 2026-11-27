/**
 * #1448 — Unit and component tests for PiDash UX polish:
 * 1. Browser tab title formatting (`document.title`)
 * 2. Sidebar Needs Attention, Pin, Archived (closed by default), auto-unarchive, and localStorage persistence
 * 3. Keyboard-first `1`–`9` prompt option selection and multi-line custom answer `<textarea>`
 * 4. One-click Copy output button on bash/shell tool cards
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import * as rootReact from "react";
import { createServer, type ViteDevServer } from "vite";
import * as pidashReact from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { act, createElement } from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { createRoot, type Root } from "../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js";
import {
  ARCHIVED_SESSIONS_STORAGE_KEY,
  PINNED_SESSIONS_STORAGE_KEY,
  flattenSidebarSessions,
  formatDocumentTitle,
  isBashToolRole,
  loadSessionIdSet,
  partitionSidebarSessions,
  saveSessionIdSet,
  stripToolResultPrefix,
  toggleArchivedSession,
  togglePinnedSession,
  unarchiveSessionId,
} from "../../../extensions/pidash/pidash-ui/src/lib/pidash-ux-helpers.ts";
import type { ChatMessage, SessionInfo } from "../../../extensions/shared/types.ts";
import { elements, installReactDomShim } from "./react-dom-shim.mjs";

let vite: ViteDevServer;
let SessionSidebar: any;
let MessageList: any;
let MessageItem: any;
let ToolGroup: any;

before(async () => {
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
  it("reverts to 'pidash' when no session is selected", () => {
    assert.equal(formatDocumentTitle(null), "pidash");
    assert.equal(formatDocumentTitle(undefined), "pidash");
  });

  it("uses session name when idle or working", () => {
    const idle = makeSession("s1", { name: "Auth Refactor", activity: "idle" });
    const working = makeSession("s2", { name: "Build Fix", activity: "working" });
    assert.equal(formatDocumentTitle(idle), "Auth Refactor — pidash");
    assert.equal(formatDocumentTitle(working), "Build Fix — pidash");
  });

  it("falls back to project directory name when unnamed", () => {
    const unnamed = makeSession("s1", { name: "", cwd: "/home/dev/pi-config/" });
    assert.equal(formatDocumentTitle(unnamed), "pi-config — pidash");
  });

  it("prefixes [!] when active session is waiting_for_input", () => {
    const waiting = makeSession("s1", { name: "Deploy", activity: "waiting_for_input", active: true });
    assert.equal(formatDocumentTitle(waiting), "[!] Deploy — pidash");
  });

  it("prefixes [!] when active session has a pending prompt even if activity is idle", () => {
    const active = makeSession("s1", { name: "Review", activity: "idle", active: true });
    assert.equal(formatDocumentTitle(active, true), "[!] Review — pidash");
  });

  it("omits [!] when session is offline", () => {
    const offline = makeSession("s1", { name: "Old", activity: "waiting_for_input", active: false });
    assert.equal(formatDocumentTitle(offline, true), "Old — pidash");
  });
});

describe("sidebar state helpers & persistence (#1448)", () => {
  it("toggles pin and unarchives an archived session when pinned", () => {
    const pinned = new Set<string>();
    const archived = new Set<string>(["s1"]);

    const afterPin = togglePinnedSession(pinned, archived, "s1");
    assert.equal(afterPin.isPinned, true);
    assert.equal(afterPin.pinned.has("s1"), true);
    assert.equal(afterPin.archived.has("s1"), false);

    const afterUnpin = togglePinnedSession(afterPin.pinned, afterPin.archived, "s1");
    assert.equal(afterUnpin.isPinned, false);
    assert.equal(afterUnpin.pinned.has("s1"), false);
  });

  it("toggles archive and unpins a pinned session when archived", () => {
    const pinned = new Set<string>(["s1"]);
    const archived = new Set<string>();

    const afterArchive = toggleArchivedSession(pinned, archived, "s1");
    assert.equal(afterArchive.isArchived, true);
    assert.equal(afterArchive.archived.has("s1"), true);
    assert.equal(afterArchive.pinned.has("s1"), false);

    const afterUnarchive = toggleArchivedSession(afterArchive.pinned, afterArchive.archived, "s1");
    assert.equal(afterUnarchive.isArchived, false);
    assert.equal(afterUnarchive.archived.has("s1"), false);
  });

  it("auto-unarchives an archived session on send and no-ops otherwise", () => {
    const archived = new Set<string>(["s1"]);
    const unchanged = unarchiveSessionId(archived, "s2");
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.archived.has("s1"), true);

    const updated = unarchiveSessionId(archived, "s1");
    assert.equal(updated.changed, true);
    assert.equal(updated.archived.has("s1"), false);
  });

  it("persists and reloads session ID sets in localStorage and tolerates invalid JSON", () => {
    const { map } = installMockStorage();
    saveSessionIdSet(PINNED_SESSIONS_STORAGE_KEY, new Set(["a", "b"]));
    saveSessionIdSet(ARCHIVED_SESSIONS_STORAGE_KEY, new Set(["c"]));

    assert.deepEqual([...loadSessionIdSet(PINNED_SESSIONS_STORAGE_KEY)], ["a", "b"]);
    assert.deepEqual([...loadSessionIdSet(ARCHIVED_SESSIONS_STORAGE_KEY)], ["c"]);

    map.set(PINNED_SESSIONS_STORAGE_KEY, "{not valid json");
    assert.deepEqual([...loadSessionIdSet(PINNED_SESSIONS_STORAGE_KEY)], []);
  });

  it("surfaces archived waiting_for_input sessions in Needs attention while keeping them archived", () => {
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

    // Flattened list matches visual order without duplicating s-arch-wait.
    assert.deepEqual(
      flattenSidebarSessions(parts).map((s) => s.sessionId),
      ["s-arch-wait", "s-attn", "s-pin", "s-reg", "s-arch"],
    );
  });
});

describe("SessionSidebar UI sections & row actions (#1448)", () => {
  it("renders Needs attention at top, Pinned next, and Archived collapsed by default with count", async () => {
    installMockStorage();
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const sessions = [
      makeSession("s-wait", { name: "Waiting Archived", activity: "waiting_for_input" }),
      makeSession("s-pin", { name: "Pinned Session" }),
      makeSession("s-reg", { name: "Regular Session", cwd: "/work/repo" }),
      makeSession("s-arch", { name: "Hidden Archived" }),
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

    const text = container.textContent ?? "";
    const attnIdx = text.indexOf("Needs attention");
    const pinIdx = text.indexOf("Pinned");
    const repoIdx = text.indexOf("repo");
    const archIdx = text.lastIndexOf("Archived");
    assert.ok(attnIdx >= 0 && pinIdx > attnIdx && repoIdx > pinIdx && archIdx > repoIdx, "section order is Needs attention → Pinned → project → Archived");
    assert.match(text, /Waiting Archived/);
    assert.equal(text.includes("Hidden Archived"), false, "Archived section starts collapsed");

    // Expand Archived section and verify archived session appears
    const archHeader = elements(container, "div").find(
      (el) => el.getAttribute("role") === "button" && (el.textContent ?? "").includes("Archived"),
    );
    assert.ok(archHeader);
    assert.equal(archHeader.getAttribute("aria-expanded"), "false");
    assert.match(archHeader.textContent ?? "", /2/);
    await act(async () => archHeader.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.equal(archHeader.getAttribute("aria-expanded"), "true");
    assert.match(container.textContent ?? "", /Hidden Archived/);
  });

  it("triggers pin and archive row buttons without selecting the session", async () => {
    installMockStorage();
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const selected: string[] = [];
    const pinnedCalls: string[] = [];
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
      onTogglePin: (id: string) => pinnedCalls.push(id),
      onToggleArchive: (id: string) => archivedCalls.push(id),
    })));

    const pinBtn = elements(container, "button").find((b) => b.getAttribute("aria-label") === "Pin session");
    const archiveBtn = elements(container, "button").find((b) => b.getAttribute("aria-label") === "Archive session");
    assert.ok(pinBtn && archiveBtn);

    await act(async () => pinBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => archiveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    assert.deepEqual(pinnedCalls, ["s-1"]);
    assert.deepEqual(archivedCalls, ["s-1"]);
    assert.deepEqual(selected, []);
  });
});

describe("AskPromptCard 1-9 hotkeys & multi-line custom answer (#1448)", () => {
  it("renders 1..9 badges and selects option N when pressing keys 1-9", async () => {
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

    const kbds = elements(container, "kbd").map((k) => k.textContent);
    assert.deepEqual(kbds, ["1", "2", "3"]);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    });
    assert.deepEqual(chosen, ["ask-1", "Staging"]);
    assert.match(container.textContent ?? "", /✓ Answered: Staging/);
  });

  it("maps confirm prompt hotkeys 1 and 2 to __confirmed__ and __denied__", async () => {
    const { container, document } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    let chosen: [string, string] | null = null;
    const msg: ChatMessage = {
      id: "m-confirm-1",
      role: "ask_user" as any,
      text: "Continue?",
      className: "ask|ask-c1|confirm|Yes|||No",
    };

    await act(async () => root.render(createElement(MessageItem, {
      msg,
      onAskResponse: (id: string, value: string) => { chosen = [id, value]; },
    })));

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    });
    assert.deepEqual(chosen, ["ask-c1", "__denied__"]);
  });

  it("ignores 1-9 hotkeys when focus is inside an input, textarea, or contenteditable, or when modifiers are held", async () => {
    const { container, document } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    let chosen: [string, string] | null = null;
    const msg: ChatMessage = {
      id: "m-ask-2",
      role: "ask_user" as any,
      text: "Pick one",
      className: "ask|ask-2|select|One|||Two",
    };

    await act(async () => root.render(createElement(MessageItem, {
      msg,
      onAskResponse: (id: string, value: string) => { chosen = [id, value]; },
    })));

    // Focused <input>
    const input = document.createElement("input");
    input.focus();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    assert.equal(chosen, null);

    // Focused <textarea>
    const area = document.createElement("textarea");
    area.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    assert.equal(chosen, null);

    // Focused contenteditable div
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    editable.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    assert.equal(chosen, null);

    // Clear focus; test Ctrl+1 modifier & out-of-range key "9"
    (document as any).activeElement = null;
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", ctrlKey: true, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "9", bubbles: true }));
    });
    assert.equal(chosen, null);

    // Now unmodified "1" selects option 1
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    assert.deepEqual(chosen, ["ask-2", "One"]);
  });

  it("routes 1-9 hotkeys only to the latest active prompt card in MessageList", async () => {
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

  it("supports multi-line custom answer textarea (Shift+Enter newline, Enter submits)", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    let submitted: [string, string] | null = null;
    const msg: ChatMessage = {
      id: "m-input-1",
      role: "ask_user" as any,
      text: "Describe changes",
      className: "ask|ask-in-1|input|",
    };

    await act(async () => root.render(createElement(MessageItem, {
      msg,
      onAskResponse: (id: string, value: string) => { submitted = [id, value]; },
    })));

    const textarea = elements(container, "textarea")[0] as any;
    assert.ok(textarea, "renders a textarea for custom answers");

    // Simulate typing multi-line text via React's controlled onChange handler
    const propsKey = Object.keys(textarea).find((k) => k.startsWith("__reactProps$"));
    assert.ok(propsKey);
    await act(async () => {
      textarea.value = "line one\nline two";
      textarea[propsKey].onChange({ target: textarea });
    });

    // Shift+Enter must NOT submit
    await act(async () => {
      const shiftEnter = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true });
      textarea[propsKey].onKeyDown(shiftEnter);
      assert.equal(shiftEnter.defaultPrevented, false);
    });
    assert.equal(submitted, null);

    // Enter (without Shift) submits the multi-line answer verbatim
    await act(async () => {
      const enter = new KeyboardEvent("keydown", { key: "Enter", shiftKey: false, bubbles: true });
      textarea[propsKey].onKeyDown(enter);
      assert.equal(enter.defaultPrevented, true);
    });
    assert.deepEqual(submitted, ["ask-in-1", "line one\nline two"]);
  });
});

describe("bash tool card one-click Copy output button (#1448)", () => {
  it("detects bash/shell tool roles and strips synthetic status prefixes", () => {
    assert.equal(isBashToolRole("bash"), true);
    assert.equal(isBashToolRole("shell"), true);
    assert.equal(isBashToolRole("BASH"), true);
    assert.equal(isBashToolRole("read"), false);
    assert.equal(stripToolResultPrefix("✓ hello\nworld"), "hello\nworld");
    assert.equal(stripToolResultPrefix("✗ exit 1"), "exit 1");
    assert.equal(stripToolResultPrefix("plain output"), "plain output");
  });

  it("renders a one-click Copy output button on collapsed bash ToolGroup and shows Copied feedback", async () => {
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
    assert.ok(copyBtn, "Copy output button is visible on collapsed bash card");
    assert.match(copyBtn.textContent ?? "", /Copy/);

    await act(async () => {
      copyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.deepEqual(copiedTexts, ["hi\nthere"]);
    assert.match(copyBtn.textContent ?? "", /Copied/);
  });

  it("does not render header Copy output button on non-bash tool cards", async () => {
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
