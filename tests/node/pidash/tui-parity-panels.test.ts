/**
 * #1481 — Unit tests for PiDash TUI parity across TasksPanel, McpPanel, MemoryPanel,
 * ComsPanel, and SessionSidebar.
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import * as rootReact from "react";
import { createServer, type ViteDevServer } from "vite";
import * as pidashReact from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { act, createElement } from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { createRoot, type Root } from "../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js";
import type { SessionInfo } from "../../../extensions/shared/types.ts";
import { sessionRowDisplayLabel } from "../../../extensions/pidash/pidash-ui/src/lib/pidash-ux-helpers.ts";
import { elements, installReactDomShim, type FakeElement } from "./react-dom-shim.mjs";

let vite: ViteDevServer;
let TasksPanel: any;
let McpPanel: any;
let MemoryPanel: any;
let ComsPanel: any;
let SessionSidebar: any;

before(async () => {
  vite = await createServer({
    root: path.resolve("extensions/pidash/pidash-ui"),
    server: { middlewareMode: true },
    appType: "custom",
  });
  ({ TasksPanel } = await vite.ssrLoadModule("/src/components/TasksPanel.tsx"));
  ({ McpPanel } = await vite.ssrLoadModule("/src/components/McpPanel.tsx"));
  ({ MemoryPanel } = await vite.ssrLoadModule("/src/components/MemoryPanel.tsx"));
  ({ ComsPanel } = await vite.ssrLoadModule("/src/components/ComsPanel.tsx"));
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
const origNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const origLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

afterEach(async () => {
  while (mounted.length) await act(async () => mounted.pop()!.unmount());
  if (origNavigator) Object.defineProperty(globalThis, "navigator", origNavigator);
  else delete (globalThis as any).navigator;
  if (origLocalStorage) Object.defineProperty(globalThis, "localStorage", origLocalStorage);
  else delete (globalThis as any).localStorage;
});

function installClipboardSpy(): string[] {
  const copied: string[] = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (text: string) => {
          copied.push(text);
        },
      },
    },
  });
  return copied;
}

function installLocalStorageStub(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
    },
  });
}

async function clickEl(el: FakeElement | undefined): Promise<void> {
  assert.ok(el, "expected clickable element");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function setInputValue(el: FakeElement | undefined, value: string): Promise<void> {
  assert.ok(el, "expected input element");
  await act(async () => {
    (el as any).value = value;
    const reactPropsKey = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
    if (reactPropsKey && typeof (el as any)[reactPropsKey]?.onChange === "function") {
      (el as any)[reactPropsKey].onChange({ target: el, currentTarget: el });
    } else {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
}

async function mountPanel(Component: any, extraProps: Record<string, unknown> = {}) {
  const { container } = installReactDomShim();
  const sent: Array<{ command: string; extra?: Record<string, unknown> }> = [];
  const notices: Array<{ msg: string; level?: string }> = [];
  let listener: ((ev: any) => void) | null = null;
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(
      createElement(Component, {
        sendCmd: (command: string, extra?: Record<string, unknown>) => sent.push({ command, extra }),
        onMessage: (handler: (ev: any) => void) => {
          listener = handler;
          return () => { listener = null; };
        },
        notify: (msg: string, level?: string) => notices.push({ msg, level }),
        ...extraProps,
      }),
    );
  });
  return {
    root,
    container,
    sent,
    notices,
    emit: async (ev: any) => act(async () => { listener?.(ev); }),
  };
}

function sampleTasks() {
  return [
    {
      id: "1",
      subject: "Approve production deploy",
      description: "Verify staging smoke checklist before sign-off",
      status: "pending",
      assignee: "user",
      blockedBy: ["2"],
    },
    {
      id: "2",
      subject: "Run backend migration",
      description: "Apply schema v12 safely",
      status: "in_progress",
      assignee: "llm",
      activeForm: "Applying schema v12",
      blockedBy: [],
    },
    {
      id: "3",
      subject: "Rotate staging token",
      description: "Updated secret in vault",
      status: "completed",
      assignee: "user",
      completedBy: "user",
      completionNote: "Rotated in vault with 30d TTL",
      blockedBy: [],
    },
  ];
}

describe("TasksPanel (#1481)", () => {
  it("renders [you] vs [llm] badges on task cards", async () => {
    const view = await mountPanel(TasksPanel);
    await view.emit({ type: "tasks-list", tasks: sampleTasks() });
    const text = view.container.textContent;
    assert.ok(text.includes("[you]"));
    assert.ok(text.includes("[llm]"));
    assert.ok(text.includes("Approve production deploy"));
    assert.ok(text.includes("Run backend migration"));
  });

  it("displays open user count badge on Mine [you] filter pill", async () => {
    const view = await mountPanel(TasksPanel);
    await view.emit({ type: "tasks-list", tasks: sampleTasks() });
    const badge = elements(view.container, "span").find(
      (s) => s.getAttribute("data-testid") === "mine-open-count",
    );
    assert.equal(badge?.textContent.trim(), "1");
  });

  it("filters task list via Mine [you] pill", async () => {
    const view = await mountPanel(TasksPanel);
    await view.emit({ type: "tasks-list", tasks: sampleTasks() });
    const mineBtn = elements(view.container, "button").find((b) => b.textContent.includes("Mine [you]"));
    await clickEl(mineBtn);
    assert.ok(view.container.textContent.includes("Approve production deploy"));
    assert.ok(view.container.textContent.includes("Rotate staging token"));
    assert.ok(!view.container.textContent.includes("Run backend migration"));
  });

  it("filters task list via Agent [llm] pill", async () => {
    const view = await mountPanel(TasksPanel);
    await view.emit({ type: "tasks-list", tasks: sampleTasks() });
    const agentBtn = elements(view.container, "button").find((b) => b.textContent.includes("Agent [llm]"));
    await clickEl(agentBtn);
    assert.ok(view.container.textContent.includes("Run backend migration"));
    assert.ok(!view.container.textContent.includes("Approve production deploy"));
  });

  it("filters task list via Open pill", async () => {
    const view = await mountPanel(TasksPanel);
    await view.emit({ type: "tasks-list", tasks: sampleTasks() });
    const openBtn = elements(view.container, "button").find((b) => b.textContent.trim() === "Open");
    await clickEl(openBtn);
    assert.ok(view.container.textContent.includes("Approve production deploy"));
    assert.ok(view.container.textContent.includes("Run backend migration"));
    assert.ok(!view.container.textContent.includes("Rotate staging token"));
  });

  it("expands collapsed task card to show full description, blockedBy, completedBy, completionNote", async () => {
    const view = await mountPanel(TasksPanel);
    await view.emit({ type: "tasks-list", tasks: sampleTasks() });
    assert.ok(!view.container.textContent.includes("Verify staging smoke checklist before sign-off"));
    assert.ok(!view.container.textContent.includes("Rotated in vault with 30d TTL"));

    const toggle1 = elements(view.container, "button").find((b) =>
      b.textContent.includes("Approve production deploy"),
    );
    await clickEl(toggle1);
    assert.ok(view.container.textContent.includes("Verify staging smoke checklist before sign-off"));
    assert.ok(view.container.textContent.includes("#2"));

    const toggle3 = elements(view.container, "button").find((b) =>
      b.textContent.includes("Rotate staging token"),
    );
    await clickEl(toggle3);
    assert.ok(view.container.textContent.includes("Completed by: user"));
    assert.ok(view.container.textContent.includes("Rotated in vault with 30d TTL"));
  });

  it("omits Start button on user-assigned tasks", async () => {
    const view = await mountPanel(TasksPanel);
    await view.emit({ type: "tasks-list", tasks: [sampleTasks()[0]] });
    const buttons = elements(view.container, "button").map((b) => b.textContent.trim());
    assert.ok(!buttons.includes("Start"));
    assert.ok(buttons.includes("Done"));
  });

  it("submits user task completion with optional completionNote", async () => {
    const view = await mountPanel(TasksPanel);
    await view.emit({ type: "tasks-list", tasks: [sampleTasks()[0]] });
    const doneBtn = elements(view.container, "button").find((b) => b.textContent.trim() === "Done");
    await clickEl(doneBtn);

    const noteInput = elements(view.container, "input").find((i) =>
      (i.getAttribute("placeholder") || "").includes("completion note"),
    );
    await setInputValue(noteInput, "Signed off after green smoke run");

    const confirmBtn = elements(view.container, "button").find(
      (b) => b.textContent.trim() === "Confirm Done",
    );
    await clickEl(confirmBtn);

    const last = view.sent.at(-1);
    assert.equal(last?.command, "task-op");
    assert.equal(last?.extra?.op, "complete");
    assert.equal(last?.extra?.taskId, "1");
    assert.equal(last?.extra?.completionNote, "Signed off after green smoke run");
    assert.equal(typeof last?.extra?.requestId, "string");
    // No premature success toast before backend confirms
    assert.equal(view.notices.some((n) => n.msg === "Task completed"), false);

    await view.emit({
      type: "task-op-result",
      op: "complete",
      taskId: "1",
      requestId: last?.extra?.requestId,
      ok: true,
    });
    assert.equal(view.notices.some((n) => n.msg === "Task completed"), true);
  });

  it("reports error toast when user task completion is rejected by backend", async () => {
    const view = await mountPanel(TasksPanel);
    await view.emit({ type: "tasks-list", tasks: [sampleTasks()[0]] });
    const doneBtn = elements(view.container, "button").find((b) => b.textContent.trim() === "Done");
    await clickEl(doneBtn);

    const confirmBtn = elements(view.container, "button").find(
      (b) => b.textContent.trim() === "Confirm Done",
    );
    await clickEl(confirmBtn);
    const reqId = view.sent.at(-1)?.extra?.requestId;

    await view.emit({
      type: "task-op-result",
      op: "complete",
      taskId: "1",
      requestId: reqId,
      ok: false,
      error: "Task already completed",
    });

    assert.equal(view.notices.some((n) => n.msg === "Task completed"), false);
    assert.equal(view.notices.some((n) => n.level === "error" && n.msg.includes("Task already completed")), true);
  });

  it("tracks concurrent user task completions independently without overwriting the first pending requestId", async () => {
    const view = await mountPanel(TasksPanel);
    const task1 = sampleTasks()[0];
    const task4 = {
      id: "4",
      subject: "Sign off release changelog",
      description: "Verify release notes",
      status: "pending",
      assignee: "user",
      blockedBy: [],
    };
    await view.emit({ type: "tasks-list", tasks: [task1, task4] });

    const cardFor = (id: string) =>
      elements(view.container, "div").find((d) => d.getAttribute("data-task-id") === id);

    // Submit Task #1
    const done1 = elements(cardFor("1")!, "button").find((b) => b.textContent.trim() === "Done");
    await clickEl(done1);
    const confirm1 = elements(cardFor("1")!, "button").find((b) => b.textContent.trim() === "Confirm Done");
    await clickEl(confirm1);
    const req1 = view.sent.at(-1)?.extra?.requestId;
    assert.equal(view.sent.at(-1)?.extra?.taskId, "1");
    assert.equal(typeof req1, "string");

    // Submit Task #4 while Task #1 is still pending
    const done4 = elements(cardFor("4")!, "button").find((b) => b.textContent.trim() === "Done");
    await clickEl(done4);
    const confirm4 = elements(cardFor("4")!, "button").find((b) => b.textContent.trim() === "Confirm Done");
    await clickEl(confirm4);
    const req4 = view.sent.at(-1)?.extra?.requestId;
    assert.equal(view.sent.at(-1)?.extra?.taskId, "4");
    assert.equal(typeof req4, "string");
    assert.notEqual(req4, req1);

    // Task #1 fails — error toast fires for Task #1 and Task #4 stays submitting
    await view.emit({
      type: "task-op-result",
      op: "complete",
      taskId: "1",
      requestId: req1,
      ok: false,
      error: "Task #1 rejected",
    });
    assert.equal(view.notices.some((n) => n.level === "error" && n.msg.includes("Task #1 rejected")), true);
    assert.equal(view.notices.some((n) => n.msg === "Task completed"), false);
    const stillSubmitting4 = elements(cardFor("4")!, "button").find((b) => b.textContent.trim() === "Completing…");
    assert.ok(stillSubmitting4, "Task #4 remains in submitting state");

    // Task #4 succeeds — Task #4's completion form closes and notifies success
    await view.emit({
      type: "task-op-result",
      op: "complete",
      taskId: "4",
      requestId: req4,
      ok: true,
    });
    assert.equal(
      elements(cardFor("4")!, "input").some((i) => (i.getAttribute("placeholder") || "").includes("completion note")),
      false,
      "Task #4 completion form closed",
    );
    assert.equal(view.notices.some((n) => n.msg === "Task completed"), true);
  });

  it("expands blocking task when blockedBy link button is clicked", async () => {
    const view = await mountPanel(TasksPanel);
    await view.emit({ type: "tasks-list", tasks: sampleTasks() });

    const toggle1 = elements(view.container, "button").find((b) =>
      b.textContent.includes("Approve production deploy"),
    );
    await clickEl(toggle1);
    assert.ok(!view.container.textContent.includes("Apply schema v12 safely"));

    const blockerBtn = elements(view.container, "button").find((b) => b.textContent.trim() === "#2");
    await clickEl(blockerBtn);
    assert.ok(view.container.textContent.includes("Apply schema v12 safely"));
  });

  it("creates user-assigned task when Me [you] assignee is toggled in + New", async () => {
    const view = await mountPanel(TasksPanel);
    const newBtn = elements(view.container, "button").find((b) => b.textContent.trim() === "+ New");
    await clickEl(newBtn);

    const subjectInput = elements(view.container, "input").find(
      (i) => i.getAttribute("placeholder") === "Task subject",
    );
    await setInputValue(subjectInput, "Merge release PR");

    const meBtn = elements(view.container, "button").find((b) => b.textContent.trim() === "Me [you]");
    await clickEl(meBtn);

    const createBtn = elements(view.container, "button").find((b) => b.textContent.trim() === "Create");
    await clickEl(createBtn);

    const last = view.sent.at(-1);
    assert.equal(last?.command, "task-op");
    assert.equal(last?.extra?.op, "create");
    assert.equal(last?.extra?.subject, "Merge release PR");
    assert.equal(last?.extra?.assignee, "user");
  });

  it("copies full task details via Copy button", async () => {
    const copied = installClipboardSpy();
    const view = await mountPanel(TasksPanel);
    await view.emit({ type: "tasks-list", tasks: [sampleTasks()[0]] });
    const copyBtn = elements(view.container, "button").find(
      (b) => b.getAttribute("aria-label") === "Copy task #1",
    );
    await clickEl(copyBtn);
    assert.equal(copied.length, 1);
    assert.ok(copied[0].includes("#1 [pending] [you] Approve production deploy"));
    assert.ok(copied[0].includes("Verify staging smoke checklist before sign-off"));
    assert.ok(copied[0].includes("Blocked by: #2"));
  });
});

describe("McpPanel (#1481)", () => {
  it("preserves full server error exceeding 200 characters without truncation", async () => {
    const longError = `MCP_ERR_${"x".repeat(320)}_TAIL_MARKER`;
    const view = await mountPanel(McpPanel);
    await view.emit({
      type: "mcp-list",
      servers: [{ name: "jira", status: "error", error: longError }],
    });

    const toggle = elements(view.container, "button").find((b) => b.textContent.includes("Error details"));
    await clickEl(toggle);
    assert.ok(view.container.textContent.includes(longError));
  });

  it("preserves full opResult output exceeding 1000 characters without truncation", async () => {
    const longOutput = `OAUTH_START_${"y".repeat(1350)}_OAUTH_END`;
    const view = await mountPanel(McpPanel);
    await view.emit({
      type: "mcp-op-result",
      op: "login",
      server: "jira",
      ok: true,
      output: longOutput,
    });
    assert.ok(view.container.textContent.includes(longOutput));
  });

  it("copies full untruncated server error via Copy button", async () => {
    const copied = installClipboardSpy();
    const longError = `ERR_${"e".repeat(260)}_END`;
    const view = await mountPanel(McpPanel);
    await view.emit({
      type: "mcp-list",
      servers: [{ name: "jira", status: "error", error: longError }],
    });
    const copyBtn = elements(view.container, "button").find(
      (b) => b.getAttribute("aria-label") === "Copy error for jira",
    );
    await clickEl(copyBtn);
    assert.deepEqual(copied, [longError]);
  });

  it("copies full untruncated command output via Copy button", async () => {
    const copied = installClipboardSpy();
    const longOutput = `OUT_${"z".repeat(1200)}_END`;
    const view = await mountPanel(McpPanel);
    await view.emit({
      type: "mcp-op-result",
      op: "logout",
      server: "jira",
      ok: true,
      output: longOutput,
    });
    const copyBtn = elements(view.container, "button").find(
      (b) => b.getAttribute("aria-label") === "Copy command output",
    );
    await clickEl(copyBtn);
    assert.deepEqual(copied, [longOutput]);
  });

  it("copies raw MCP output via Copy button", async () => {
    const copied = installClipboardSpy();
    const rawText = `RAW_${"r".repeat(250)}_END`;
    const view = await mountPanel(McpPanel);
    await view.emit({ type: "mcp-list", raw: rawText });
    const copyBtn = elements(view.container, "button").find(
      (b) => b.getAttribute("aria-label") === "Copy raw MCP output",
    );
    await clickEl(copyBtn);
    assert.deepEqual(copied, [rawText]);
  });
});

describe("MemoryPanel (#1481)", () => {
  it("copies full Situation Report via Copy button", async () => {
    const copied = installClipboardSpy();
    const report = "# Project Memory\n- [lesson] Keep panels untruncated";
    const view = await mountPanel(MemoryPanel);
    await view.emit({
      type: "memory-status",
      usagePct: 42,
      topics: [{ name: "pidash", entryCount: 4, hotness: 9, newestEntry: "2026-11-27" }],
      report,
    });
    const copyBtn = elements(view.container, "button").find(
      (b) => b.getAttribute("aria-label") === "Copy situation report",
    );
    await clickEl(copyBtn);
    assert.deepEqual(copied, [report]);
  });

  it("copies topics list via Copy button", async () => {
    const copied = installClipboardSpy();
    const view = await mountPanel(MemoryPanel);
    await view.emit({
      type: "memory-status",
      usagePct: 42,
      topics: [{ name: "pidash", entryCount: 4, hotness: 9, newestEntry: "2026-11-27" }],
      report: "Summary",
    });
    const copyBtn = elements(view.container, "button").find(
      (b) => b.getAttribute("aria-label") === "Copy topics list",
    );
    await clickEl(copyBtn);
    assert.equal(copied.length, 1);
    assert.ok(copied[0].includes("pidash — 4 entries (hotness 9)"));
  });

  it("dispatches memory-status when Refresh button is clicked", async () => {
    const view = await mountPanel(MemoryPanel);
    await view.emit({ type: "memory-status", usagePct: 10, topics: [], report: "ok" });
    const beforeCount = view.sent.filter((s) => s.command === "memory-status").length;
    const refreshBtn = elements(view.container, "button").find((b) => b.textContent.trim() === "Refresh");
    await clickEl(refreshBtn);
    const afterCount = view.sent.filter((s) => s.command === "memory-status").length;
    assert.equal(afterCount, beforeCount + 1);
  });

  it("dispatches memory-dream when Dream button is clicked", async () => {
    const view = await mountPanel(MemoryPanel);
    await view.emit({ type: "memory-status", usagePct: 10, topics: [], report: "ok" });
    const dreamBtn = elements(view.container, "button").find((b) => b.textContent.trim() === "Dream");
    await clickEl(dreamBtn);
    const dreamCmd = view.sent.find((s) => s.command === "memory-dream");
    assert.ok(dreamCmd);

    await view.emit({
      type: "memory-dream-result",
      requestId: dreamCmd?.extra?.requestId,
      ok: true,
      message: "Started background memory consolidation (job d1).",
    });
    assert.ok(view.notices.some((n) => n.msg.includes("job d1")));
  });

  it("times out after 15s when no memory-dream-result arrives, re-enables Dream, and notifies error", async (t) => {
    const view = await mountPanel(MemoryPanel);
    await view.emit({ type: "memory-status", usagePct: 10, topics: [], report: "ok" });

    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const dreamBtn = elements(view.container, "button").find((b) => b.textContent.trim() === "Dream");
      await clickEl(dreamBtn);

      const dreamingBtn = elements(view.container, "button").find((b) => b.textContent.trim() === "Dreaming…");
      assert.ok(dreamingBtn, "Dream button enters Dreaming… state");
      assert.equal(dreamingBtn.hasAttribute("disabled"), true);

      await act(async () => {
        t.mock.timers.tick(15_000);
      });

      const reEnabledBtn = elements(view.container, "button").find((b) => b.textContent.trim() === "Dream");
      assert.ok(reEnabledBtn, "Dream button re-enabled after 15s timeout");
      assert.equal(reEnabledBtn.hasAttribute("disabled"), false);
      assert.ok(
        view.notices.some((n) => n.level === "error" && /timed out/i.test(n.msg)),
        "notifies error on dream timeout",
      );
    } finally {
      t.mock.timers.reset();
    }
  });

  it("resets Dream state on session switch and ignores stale memory-dream-result from previous session", async () => {
    const view = await mountPanel(MemoryPanel);
    await view.emit({ type: "memory-status", usagePct: 10, topics: [], report: "session A" });

    const dreamBtn = elements(view.container, "button").find((b) => b.textContent.trim() === "Dream");
    await clickEl(dreamBtn);
    const oldRequestId = view.sent.find((s) => s.command === "memory-dream")?.extra?.requestId;
    assert.ok(oldRequestId);
    assert.ok(elements(view.container, "button").find((b) => b.textContent.trim() === "Dreaming…"));

    const sentB: Array<{ command: string; extra?: Record<string, unknown> }> = [];
    const noticesB: Array<{ msg: string; level?: string }> = [];
    let listenerB: ((ev: any) => void) | null = null;
    await act(async () => {
      view.root.render(
        createElement(MemoryPanel, {
          sendCmd: (command: string, extra?: Record<string, unknown>) => sentB.push({ command, extra }),
          onMessage: (handler: (ev: any) => void) => {
            listenerB = handler;
            return () => { listenerB = null; };
          },
          notify: (msg: string, level?: string) => noticesB.push({ msg, level }),
        }),
      );
    });

    const resetBtn = elements(view.container, "button").find((b) => b.textContent.trim() === "Dream");
    assert.ok(resetBtn, "Dream button re-enabled after switching watched session");
    assert.equal(resetBtn.hasAttribute("disabled"), false);

    // Late result from session A must be ignored in session B.
    await act(async () => {
      listenerB?.({ type: "memory-dream-result", requestId: oldRequestId, ok: true, message: "late from A" });
    });
    assert.equal(noticesB.length, 0, "stale memory-dream-result does not notify the new session");
  });
});

describe("ComsPanel (#1481)", () => {
  it("requests all projects scope when All projects pill is clicked", async () => {
    const view = await mountPanel(ComsPanel);
    assert.equal(view.sent[0]?.command, "coms-peers");
    assert.equal(view.sent[0]?.extra?.scope, "project");

    const allBtn = elements(view.container, "button").find((b) => b.textContent.trim() === "All projects");
    await clickEl(allBtn);

    const peerCmds = view.sent.filter((s) => s.command === "coms-peers");
    assert.equal(peerCmds.at(-1)?.extra?.scope, "all");
  });

  it("requires confirmation before dispatching coms-kill for supervised peers", async () => {
    const view = await mountPanel(ComsPanel);
    await view.emit({
      type: "coms-peers",
      self: { name: "feature-manager", project: "pi-config" },
      peers: [
        { name: "peer-supervised", project: "pi-config", model: "m1", busy: false, queueDepth: 0, contextUsedPct: 12, supervised: true },
        { name: "human-peer", project: "pi-config", model: "m1", busy: false, queueDepth: 0, contextUsedPct: 8, supervised: false },
      ],
    });

    const killButtons = elements(view.container, "button").filter((b) => b.textContent.trim() === "Kill");
    assert.equal(killButtons.length, 1);

    await clickEl(killButtons[0]);
    assert.equal(view.sent.filter((s) => s.command === "coms-kill").length, 0);
    assert.ok(view.container.textContent.includes("Kill peer-supervised?"));

    const confirmBtn = elements(view.container, "button").find(
      (b) => b.textContent.trim() === "Confirm Kill",
    );
    await clickEl(confirmBtn);

    const killCmd = view.sent.find((s) => s.command === "coms-kill");
    assert.ok(killCmd);
    assert.equal(killCmd?.extra?.name, "peer-supervised");
    assert.equal(killCmd?.extra?.project, "pi-config");
  });

  it("cancels queued inbound message via coms-queue-kill", async () => {
    const view = await mountPanel(ComsPanel);
    await view.emit({
      type: "coms-queue",
      active: true,
      items: [
        {
          id: "msg-00112233",
          msg_id: "msg-00112233",
          sender_name: "peer-1479",
          prompt: "Please review PR #1481",
          status: "pending",
        },
      ],
    });

    assert.ok(view.container.textContent.includes("Inbound Queue (1)"));
    const cancelBtn = elements(view.container, "button").find((b) => b.textContent.trim() === "Cancel");
    await clickEl(cancelBtn);

    const cancelCmd = view.sent.find((s) => s.command === "coms-queue-kill");
    assert.ok(cancelCmd);
    assert.equal(cancelCmd?.extra?.msg_id, "msg-00112233");
  });

  it("copies peer summary via Copy button", async () => {
    const copied = installClipboardSpy();
    const view = await mountPanel(ComsPanel);
    await view.emit({
      type: "coms-peers",
      self: { name: "feature-manager", project: "pi-config" },
      peers: [
        { name: "peer-1481", project: "pi-config", purpose: "TUI parity", model: "gemini-4-neon", busy: true, queueDepth: 1, contextUsedPct: 35, supervised: true },
      ],
    });
    const copyBtn = elements(view.container, "button").find(
      (b) => b.getAttribute("aria-label") === "Copy peer peer-1481",
    );
    await clickEl(copyBtn);
    assert.equal(copied.length, 1);
    assert.ok(copied[0].includes("Peer: peer-1481 (pi-config)"));
    assert.ok(copied[0].includes("Purpose: TUI parity"));
  });

  it("copies queued inbound message via Copy button", async () => {
    const copied = installClipboardSpy();
    const view = await mountPanel(ComsPanel);
    await view.emit({
      type: "coms-queue",
      active: true,
      items: [
        {
          id: "msg-abcdef99",
          msg_id: "msg-abcdef99",
          sender_name: "feature-manager",
          prompt: "Run full DoD verification",
          status: "processing",
        },
      ],
    });
    const copyBtn = elements(view.container, "button").find(
      (b) => b.getAttribute("aria-label") === "Copy queued message abcdef99",
    );
    await clickEl(copyBtn);
    assert.equal(copied.length, 1);
    assert.ok(copied[0].includes("From: feature-manager"));
    assert.ok(copied[0].includes("Run full DoD verification"));
  });

  it("keeps Inbound Queue collapsed after user collapses it on subsequent queue events", async () => {
    const view = await mountPanel(ComsPanel);
    const item = {
      id: "msg-keep-closed",
      msg_id: "msg-keep-closed",
      sender_name: "peer-a",
      prompt: "Heartbeat test prompt",
      status: "processing",
    };
    await view.emit({ type: "coms-queue", active: true, items: [item] });
    assert.ok(view.container.textContent.includes("peer-a"));

    const queueHeader = elements(view.container, "button").find((b) =>
      b.textContent.includes("Inbound Queue (1)"),
    );
    await clickEl(queueHeader);
    assert.ok(!view.container.textContent.includes("peer-a"));

    // Subsequent heartbeat must not force the collapsed queue back open
    await view.emit({ type: "coms-queue", active: true, items: [item] });
    assert.ok(!view.container.textContent.includes("peer-a"));
  });

  it("preserves tab-local project scope when coms-peers payload includes allPeers", async () => {
    const view = await mountPanel(ComsPanel);
    await view.emit({
      type: "coms-peers",
      scope: "all",
      ownProject: "proj-a",
      self: { name: "me", project: "proj-a" },
      peers: [
        { name: "local-peer", project: "proj-a", busy: false, queueDepth: 0, contextUsedPct: 10 },
        { name: "remote-peer", project: "proj-b", busy: false, queueDepth: 0, contextUsedPct: 20 },
      ],
      allPeers: [
        { name: "local-peer", project: "proj-a", busy: false, queueDepth: 0, contextUsedPct: 10 },
        { name: "remote-peer", project: "proj-b", busy: false, queueDepth: 0, contextUsedPct: 20 },
      ],
    });
    // Tab stays on "This project" even if another tab requested scope "all"
    assert.ok(view.container.textContent.includes("local-peer"));
    assert.ok(!view.container.textContent.includes("remote-peer"));
  });

  it("omits the redundant send-message composer from peer cards", async () => {
    const view = await mountPanel(ComsPanel);
    await view.emit({
      type: "coms-peers",
      self: { name: "feature-manager", project: "pi-config" },
      peers: [
        { name: "peer-1481", project: "pi-config", purpose: "parity", model: "gemini-4-neon", busy: false, queueDepth: 0, contextUsedPct: 12, supervised: true },
      ],
    });
    assert.equal(elements(view.container, "textarea").length, 0);
    assert.equal(
      elements(view.container, "button").some((b) => b.textContent.trim() === "Send"),
      false,
    );
  });

  it("counts a peer with busy false plus workload.agents 1 as busy in ComsPanel", async () => {
    const view = await mountPanel(ComsPanel);
    await view.emit({
      type: "coms-peers",
      self: { name: "feature-manager", project: "pi-config" },
      peers: [
        {
          name: "peer-async",
          project: "pi-config",
          purpose: "running subagent",
          model: "gemini-4-neon",
          busy: false,
          workload: { agents: 2, tasks: 0, crons: 0 },
          queueDepth: 0,
          contextUsedPct: 18,
          supervised: true,
        },
        {
          name: "peer-tasks",
          project: "pi-config",
          purpose: "planning",
          model: "gemini-4-neon",
          busy: false,
          workload: { agents: 0, tasks: 3, crons: 0 },
          queueDepth: 0,
          contextUsedPct: 10,
          supervised: true,
        },
      ],
    });
    assert.ok(view.container.textContent.includes("1 busy / 2"));
    assert.ok(view.container.textContent.includes("busy (2 agents)"));
  });

  it("keeps a peer with workload.agents 0 plus pending tasks idle in ComsPanel", async () => {
    const view = await mountPanel(ComsPanel);
    await view.emit({
      type: "coms-peers",
      self: { name: "feature-manager", project: "pi-config" },
      peers: [
        {
          name: "peer-tasks",
          project: "pi-config",
          purpose: "planning",
          model: "gemini-4-neon",
          busy: false,
          workload: { agents: 0, tasks: 3, crons: 1 },
          queueDepth: 0,
          contextUsedPct: 10,
          supervised: true,
        },
      ],
    });
    assert.ok(view.container.textContent.includes("0 busy / 1"));
    assert.equal(view.container.textContent.includes("⚙"), false);
  });
});

describe("SessionSidebar Coms peer display name (#1481)", () => {
  it("falls back to comsName when session title is empty", () => {
    const label = sessionRowDisplayLabel(
      { name: undefined, model: "Gemini 4 Neon", comsName: "peer-1479-pidash-data" },
      { preferComsName: true },
    );
    assert.equal(label, "peer-1479-pidash-data");
  });

  it("falls back to comsName when session title matches model name", () => {
    const label = sessionRowDisplayLabel(
      { name: "Gemini 4 Neon", model: "Gemini 4 Neon", comsName: "peer-1481-pidash-parity" },
      { preferComsName: true },
    );
    assert.equal(label, "peer-1481-pidash-parity");
  });

  it("preserves custom session title under Coms section", () => {
    const label = sessionRowDisplayLabel(
      { name: "Release verification", model: "Gemini 4 Neon", comsName: "peer-1481-pidash-parity" },
      { preferComsName: true },
    );
    assert.equal(label, "Release verification");
  });

  it("renders comsName inside SessionSidebar Coms section rows", async () => {
    installLocalStorageStub();
    const { container } = installReactDomShim();
    const sessions: SessionInfo[] = [
      {
        sessionId: "s-peer",
        cwd: "/repo/.worktrees/issue-1479",
        branch: "fix/issue-1479",
        gitDirty: false,
        active: true,
        activity: "working",
        model: "Gemini 4 Neon",
        name: "Gemini 4 Neon",
        comsProject: "pi-config",
        comsName: "peer-1479-pidash-data",
        startedAt: new Date().toISOString(),
        lastActivity: Date.now(),
      } as SessionInfo,
    ];
    const root = createRoot(container);
    mounted.push(root);
    await act(async () => {
      root.render(
        createElement(SessionSidebar, {
          sessions,
          activeSessionId: null,
          connected: true,
          onSelect: () => {},
          collapsed: false,
          onToggle: () => {},
        }),
      );
    });
    assert.ok(container.textContent.includes("peer-1479-pidash-data"));
  });

  it("counts an idle Coms session with runningAsyncAgents 1 in SessionSidebar busy count", async () => {
    installLocalStorageStub();
    const { container } = installReactDomShim();
    const sessions: SessionInfo[] = [
      {
        sessionId: "s-peer-async",
        cwd: "/repo/.worktrees/issue-1509",
        branch: "fix/issue-1509",
        gitDirty: false,
        active: true,
        activity: "idle",
        runningAsyncAgents: 1,
        model: "Gemini 4 Neon",
        comsProject: "pi-config",
        comsName: "peer-1509",
        startedAt: new Date().toISOString(),
        lastActivity: Date.now(),
      } as SessionInfo,
    ];
    const root = createRoot(container);
    mounted.push(root);
    await act(async () => {
      root.render(
        createElement(SessionSidebar, {
          sessions,
          activeSessionId: null,
          connected: true,
          onSelect: () => {},
          collapsed: false,
          onToggle: () => {},
        }),
      );
    });
    assert.ok(container.textContent.includes("●1"));
    assert.ok(container.textContent.includes("⏳1"));
  });

  it("omits an idle Coms session with runningAsyncAgents 0 from SessionSidebar busy count", async () => {
    installLocalStorageStub();
    const { container } = installReactDomShim();
    const sessions: SessionInfo[] = [
      {
        sessionId: "s-peer-idle",
        cwd: "/repo/.worktrees/issue-1509",
        branch: "fix/issue-1509",
        gitDirty: false,
        active: true,
        activity: "idle",
        runningAsyncAgents: 0,
        model: "Gemini 4 Neon",
        comsProject: "pi-config",
        comsName: "peer-idle",
        startedAt: new Date().toISOString(),
        lastActivity: Date.now(),
      } as SessionInfo,
    ];
    const root = createRoot(container);
    mounted.push(root);
    await act(async () => {
      root.render(
        createElement(SessionSidebar, {
          sessions,
          activeSessionId: null,
          connected: true,
          onSelect: () => {},
          collapsed: false,
          onToggle: () => {},
        }),
      );
    });
    assert.equal(container.textContent.includes("●1"), false);
    assert.equal(container.textContent.includes("⏳"), false);
  });
});
