/**
 * #1427 — Unit tests for PiDash WorktreesPanel UI, protocol sync helpers, and InfoBar worktree badge.
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import * as rootReact from "react";
import { createServer, type ViteDevServer } from "vite";
import * as pidashReact from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { act, createElement } from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { createRoot, type Root } from "../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js";
import type { SessionInfo, WorktreeItem } from "../../../extensions/shared/types.ts";
import {
  computeOpTimeoutMs,
  getRemovableWorktrees,
  isSafePrUrl,
  pruneSelectedWorktreePaths,
  shouldAcceptWorktreesList,
} from "../../../extensions/pidash/pidash-ui/src/lib/worktrees-panel-helpers.ts";
import { elements, installReactDomShim, type FakeElement } from "./react-dom-shim.mjs";

let vite: ViteDevServer;
let WorktreesPanel: any;
let InfoBar: any;

before(async () => {
  vite = await createServer({
    root: path.resolve("extensions/pidash/pidash-ui"),
    server: { middlewareMode: true },
    appType: "custom",
  });
  ({ WorktreesPanel } = await vite.ssrLoadModule("/src/components/WorktreesPanel.tsx"));
  ({ InfoBar } = await vite.ssrLoadModule("/src/components/InfoBar.tsx"));
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

function sampleWorktrees(): WorktreeItem[] {
  return [
    {
      id: "/repo",
      path: "/repo",
      relativePath: ".",
      label: "main",
      head: "1111111111",
      branch: "main",
      detached: false,
      bare: false,
      isMain: true,
      isCurrent: true,
      locked: false,
      prunable: false,
      dirty: { modified: 0, added: 0, deleted: 0, untracked: 0, total: 0 },
      dirtyText: "clean",
      tags: ["[current]", "[main]"],
      peers: [],
      canRemove: false,
      removeBlockedReason: "Cannot remove the main worktree.",
    },
    {
      id: "/repo/.worktrees/feat-clean",
      path: "/repo/.worktrees/feat-clean",
      relativePath: ".worktrees/feat-clean",
      label: "feat/clean",
      head: "2222222222",
      branch: "feat/clean",
      detached: false,
      bare: false,
      isMain: false,
      isCurrent: false,
      locked: false,
      prunable: false,
      dirty: { modified: 0, added: 0, deleted: 0, untracked: 0, total: 0 },
      dirtyText: "clean",
      tags: [],
      peers: [],
      pr: { number: 1427, url: "https://github.com/myk-org/pi-config/pull/1427" },
      canRemove: true,
    },
    {
      id: "/repo/.worktrees/feat-peer",
      path: "/repo/.worktrees/feat-peer",
      relativePath: ".worktrees/feat-peer",
      label: "feat/peer",
      head: "3333333333",
      branch: "feat/peer",
      detached: false,
      bare: false,
      isMain: false,
      isCurrent: false,
      locked: false,
      prunable: false,
      dirty: { modified: 1, added: 0, deleted: 0, untracked: 1, total: 2 },
      dirtyText: "~1 ?1",
      tags: [],
      peers: [{ name: "peer-1427", project: "pi-config", cwd: "/repo/.worktrees/feat-peer", busy: true, pid: 42, purpose: "PR work" }],
      canRemove: false,
      removeBlockedReason: "Cannot remove worktree with active COMS peer: peer-1427.",
    },
    {
      id: "/repo/.worktrees/feat-clean-2",
      path: "/repo/.worktrees/feat-clean-2",
      relativePath: ".worktrees/feat-clean-2",
      label: "feat/clean-2",
      head: "4444444444",
      branch: "feat/clean-2",
      detached: false,
      bare: false,
      isMain: false,
      isCurrent: false,
      locked: false,
      prunable: false,
      dirty: { modified: 0, added: 0, deleted: 0, untracked: 0, total: 0 },
      dirtyText: "clean",
      tags: [],
      peers: [],
      canRemove: true,
    },
  ];
}

describe("worktrees-panel-helpers", () => {
  it("shouldAcceptWorktreesList enforces session, cwd, and latest requestId correlation", () => {
    assert.equal(shouldAcceptWorktreesList({ sourceSessionId: "s1", cwd: "/repo", requestId: "r2" }, "s1", "/repo", "r2"), true);
    assert.equal(shouldAcceptWorktreesList({ sourceSessionId: "s1", cwd: "/repo/", requestId: "r2" }, "s1", "/repo", "r2"), true);
    // Out-of-order stale requestId rejected
    assert.equal(shouldAcceptWorktreesList({ sourceSessionId: "s1", cwd: "/repo", requestId: "r1" }, "s1", "/repo", "r2"), false);
    // Foreign cwd rejected (e.g. previous project before switch)
    assert.equal(shouldAcceptWorktreesList({ sourceSessionId: "s1", cwd: "/old-repo", requestId: "r2" }, "s1", "/repo", "r2"), false);
    // Foreign session rejected
    assert.equal(shouldAcceptWorktreesList({ sourceSessionId: "s2", cwd: "/repo", requestId: "r2" }, "s1", "/repo", "r2"), false);
  });

  it("computeOpTimeoutMs scales remove timeout by target count", () => {
    assert.equal(computeOpTimeoutMs("prune", 1), 30_000);
    assert.equal(computeOpTimeoutMs("remove", 1), 45_000);
    assert.equal(computeOpTimeoutMs("remove", 5), 105_000);
  });

  it("pruneSelectedWorktreePaths keeps only still-removable paths", () => {
    const items = sampleWorktrees();
    const pruned = pruneSelectedWorktreePaths(
      new Set(["/repo", "/repo/.worktrees/feat-clean", "/repo/.worktrees/feat-peer", "/repo/.worktrees/gone"]),
      items,
    );
    assert.deepEqual([...pruned], ["/repo/.worktrees/feat-clean"]);
    assert.deepEqual(getRemovableWorktrees(items).map((w) => w.label), ["feat/clean", "feat/clean-2"]);
  });

  it("isSafePrUrl accepts https URLs and rejects unsafe schemes or whitespace", () => {
    assert.equal(isSafePrUrl("https://github.com/myk-org/pi-config/pull/1427"), true);
    assert.equal(isSafePrUrl("javascript:alert(1)"), false);
    assert.equal(isSafePrUrl("http://github.com/myk-org/pi-config/pull/1427"), false);
    assert.equal(isSafePrUrl("https://github.com/a b"), false);
    assert.equal(isSafePrUrl(undefined), false);
  });
});

describe("WorktreesPanel component (#1427)", () => {
  async function mountPanel() {
    const { container } = installReactDomShim();
    const sent: Array<{ command: string; extra?: Record<string, unknown> }> = [];
    const notices: Array<{ msg: string; level?: string }> = [];
    let listener: ((ev: any) => void) | null = null;
    const root = createRoot(container);
    mounted.push(root);
    await act(async () => {
      root.render(
        createElement(WorktreesPanel, {
          sessionId: "s1",
          cwd: "/repo",
          sendCmd: (command: string, extra?: Record<string, unknown>) => sent.push({ command, extra }),
          onMessage: (handler: (ev: any) => void) => {
            listener = handler;
            return () => { listener = null; };
          },
          notify: (msg: string, level?: string) => notices.push({ msg, level }),
        }),
      );
    });
    return {
      container,
      sent,
      notices,
      emit: async (ev: any) => act(async () => { listener?.(ev); }),
    };
  }

  it("fetches worktrees on mount, renders badges/PR/peers, disables protected removals, and supports detail drawer + guarded remove modal", async () => {
    const view = await mountPanel();
    assert.equal(view.sent.length, 1);
    assert.equal(view.sent[0].command, "worktrees-list");

    const items = sampleWorktrees();
    await view.emit({
      type: "worktrees-list",
      requestId: view.sent[0].extra?.requestId,
      sourceSessionId: "s1",
      cwd: "/repo",
      repoRoot: "/repo",
      linkedCount: 3,
      dirtyCount: 1,
      inLinkedWorktree: false,
      worktrees: items,
    });

    // External PR link present
    const links = elements(view.container, "a");
    assert.ok(links.some((a) => a.getAttribute("href") === "https://github.com/myk-org/pi-config/pull/1427"));

    // Main & active-peer remove buttons are disabled with reason tooltip; clean is enabled
    const buttons = elements(view.container, "button");
    const mainRemove = buttons.find((b) => (b.getAttribute("aria-label") || "").includes("Cannot remove main"));
    const peerRemove = buttons.find((b) => (b.getAttribute("aria-label") || "").includes("Cannot remove feat/peer"));
    const cleanRemove = buttons.find((b) => b.getAttribute("aria-label") === "Remove worktree feat/clean");
    assert.ok(mainRemove && mainRemove.getAttribute("disabled") !== null);
    assert.ok(peerRemove && peerRemove.getAttribute("disabled") !== null);
    assert.ok(cleanRemove && cleanRemove.getAttribute("disabled") === null);

    // Expand detail drawer -> triggers worktrees-detail and renders git status --short + truncation
    const expandBtn = buttons.find((b) => b.textContent.includes("feat/peer"));
    assert.ok(expandBtn);
    await act(async () => {
      expandBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.equal(view.sent.at(-1)?.command, "worktrees-detail");
    assert.equal(view.sent.at(-1)?.extra?.path, "/repo/.worktrees/feat-peer");

    await view.emit({
      type: "worktrees-detail",
      requestId: view.sent.at(-1)?.extra?.requestId,
      path: "/repo/.worktrees/feat-peer",
      headSubject: "feat: panel parity",
      statusLines: [" M src/index.ts", "?? tmp.ts"],
      truncatedCount: 4,
      statusOk: true,
    });
    assert.ok(view.container.textContent.includes("feat: panel parity"));
    assert.ok(view.container.textContent.includes(" M src/index.ts"));
    assert.ok(view.container.textContent.includes("+4 more files"));

    // Clicking Remove opens explicit confirmation modal; confirming sends worktrees-remove
    await act(async () => {
      cleanRemove!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const dialog = elements(view.container, "div").find((d) => d.getAttribute("role") === "dialog");
    assert.ok(dialog, "explicit confirmation modal must open before removal");
    const confirmBtn = elements(dialog!, "button").find((b) => b.textContent.trim() === "Remove");
    assert.ok(confirmBtn);
    await act(async () => {
      confirmBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.equal(view.sent.at(-1)?.command, "worktrees-remove");
    assert.deepEqual(view.sent.at(-1)?.extra?.paths, ["/repo/.worktrees/feat-clean"]);

    // Operation result surfaces toast
    await view.emit({
      type: "worktrees-op-result",
      op: "remove",
      ok: true,
      message: "Removed worktree: .worktrees/feat-clean",
      removed: ["/repo/.worktrees/feat-clean"],
      requestId: view.sent.at(-1)?.extra?.requestId,
    });
    assert.ok(view.notices.some((n) => n.msg.includes("Removed worktree")));
  });

  it("supports bulk select-removable removal, prune, worktrees-changed refetch, stale-cwd rejection, and Retry on error", async () => {
    const view = await mountPanel();
    await view.emit({
      type: "worktrees-list",
      requestId: view.sent[0].extra?.requestId,
      sourceSessionId: "s1",
      cwd: "/repo",
      repoRoot: "/repo",
      linkedCount: 3,
      dirtyCount: 1,
      inLinkedWorktree: false,
      worktrees: sampleWorktrees(),
    });

    const selectAllBtn = elements(view.container, "button").find((b) => b.textContent.trim() === "Select removable");
    assert.ok(selectAllBtn);
    await act(async () => {
      selectAllBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const bulkBtn = elements(view.container, "button").find((b) => b.textContent.trim() === "Remove (2)");
    assert.ok(bulkBtn);
    await act(async () => {
      bulkBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const dialog = elements(view.container, "div").find((d) => d.getAttribute("role") === "dialog");
    assert.ok(dialog);
    const confirmBulk = elements(dialog!, "button").find((b) => b.textContent.trim() === "Remove (2)");
    assert.ok(confirmBulk);
    await act(async () => {
      confirmBulk!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.equal(view.sent.at(-1)?.command, "worktrees-remove");
    assert.deepEqual(view.sent.at(-1)?.extra?.paths, [
      "/repo/.worktrees/feat-clean",
      "/repo/.worktrees/feat-clean-2",
    ]);

    // Settle remove op, then test Prune
    await view.emit({
      type: "worktrees-op-result",
      op: "remove",
      ok: true,
      message: "Removed 2 worktrees.",
      removed: ["/repo/.worktrees/feat-clean", "/repo/.worktrees/feat-clean-2"],
      requestId: view.sent.at(-1)?.extra?.requestId,
    });

    const pruneBtn = elements(view.container, "button").find((b) => b.textContent.trim() === "Prune");
    assert.ok(pruneBtn);
    await act(async () => {
      pruneBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.equal(view.sent.at(-1)?.command, "worktrees-prune");
    await view.emit({
      type: "worktrees-op-result",
      op: "prune",
      ok: true,
      message: "No stale worktrees to prune.",
      requestId: view.sent.at(-1)?.extra?.requestId,
    });

    // Server-scoped minimal worktrees-changed notice triggers a refetch for this session
    const countBefore = view.sent.length;
    await view.emit({ type: "worktrees-changed", sourceSessionId: "s2" });
    assert.equal(view.sent.length, countBefore + 1);
    assert.equal(view.sent.at(-1)?.command, "worktrees-list");
    const refetchReqId = view.sent.at(-1)?.extra?.requestId;

    // Stale worktrees-list from another cwd must be ignored
    await view.emit({
      type: "worktrees-list",
      requestId: refetchReqId,
      sourceSessionId: "s1",
      cwd: "/other-repo",
      linkedCount: 0,
      dirtyCount: 0,
      inLinkedWorktree: false,
      worktrees: [],
    });
    assert.ok(view.container.textContent.includes("feat/clean"), "foreign-cwd list must not overwrite current repo");

    // Error reply clears loading state and renders Retry button
    await view.emit({
      type: "worktrees-list",
      requestId: refetchReqId,
      sourceSessionId: "s1",
      cwd: "/repo",
      linkedCount: 0,
      dirtyCount: 0,
      inLinkedWorktree: false,
      worktrees: [],
      error: "Watched Pi session is disconnected.",
    });
    assert.ok(view.container.textContent.includes("Watched Pi session is disconnected."));
    const retryBtn = elements(view.container, "button").find((b) => b.textContent.trim() === "Retry");
    assert.ok(retryBtn, "Retry button should be rendered on error");
    await act(async () => {
      retryBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.equal(view.sent.at(-1)?.command, "worktrees-list");
  });
});

describe("InfoBar worktrees badge (#1427)", () => {
  function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
    return {
      sessionId: "selected",
      pid: 1,
      cwd: "/repo",
      branch: "main",
      model: "model",
      startedAt: "now",
      lastActivity: 0,
      active: true,
      ...overrides,
    };
  }

  async function renderBar(s: SessionInfo, opened: string[]) {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);
    await act(async () => {
      root.render(
        createElement(InfoBar, {
          session: s,
          model: s.model,
          tokens: null,
          send: () => {},
          onMessage: () => () => {},
          activePanel: null,
          onOpenPanel: (tab: string) => opened.push(tab),
          onCompact: () => {},
        }),
      );
    });
    return container;
  }

  it("hides badge when there are no linked worktrees and opens worktrees panel when badge or icon is clicked", async () => {
    const opened: string[] = [];
    const c0 = await renderBar(makeSession({ worktreeCount: 0, worktreeDirtyCount: 0, inLinkedWorktree: false }), opened);
    assert.equal(elements(c0, "button").some((b) => b.textContent.includes(" wt")), false);

    // Panel icon button still opens worktrees panel
    const panelIcon = elements(c0, "button").find((b) => b.getAttribute("title") === "Worktrees panel");
    assert.ok(panelIcon);
    await act(async () => {
      panelIcon!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.deepEqual(opened, ["worktrees"]);

    // Linked + dirty badge shows counts and opens worktrees panel
    const c1 = await renderBar(makeSession({ worktreeCount: 2, worktreeDirtyCount: 1, inLinkedWorktree: true }), opened);
    const badge = elements(c1, "button").find((b) => b.textContent.includes("2 wt") && b.textContent.includes("1 dirty"));
    assert.ok(badge, "InfoBar should display linked and dirty worktree counts");
    await act(async () => {
      badge!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.deepEqual(opened, ["worktrees", "worktrees"]);

    // Detached HEAD (empty branch) still renders worktree badge when in linked worktree
    const c2 = await renderBar(makeSession({ branch: "", worktreeCount: 1, worktreeDirtyCount: 0, inLinkedWorktree: true }), opened);
    assert.ok(elements(c2, "button").some((b) => b.textContent.includes("1 wt")));
  });
});
