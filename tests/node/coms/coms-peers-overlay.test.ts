/**
 * #1077 — the peers overlay's `m` composer (Qodo finding 6: the key shipped untested).
 *
 * Only input handling is exercised: `ctx.ui.custom` is mocked so the real OverlayListDashboard
 * receives keystrokes, which is where `m` lives. Rendering (theme/TUI) is not touched.
 *
 * Run with: npx tsx --test tests/node/coms/coms-peers-overlay.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openComsPeersOverlay } from "../../../extensions/coms/coms-peers-ui.js";
import type { RegistryRow } from "../../../extensions/coms/coms-peers.js";

const worker: RegistryRow = {
  project: "repo",
  name: "worker",
  pid: 4242,
  cwd: "/repo",
  purpose: "builds things",
  endpoint: "/tmp/worker.sock",
  busy: false,
  queueDepth: 0,
  contextUsedPct: 10,
  startedAt: null,
  heartbeatAt: null,
  origin: "user",
  createdBy: null,
};

/** Minimal ctx: the list opens once, the keys are fed to it, the second open closes immediately. */
function makeCtx(keys: string[], typed: string | undefined) {
  const inputTitles: string[] = [];
  const notifications: string[] = [];
  let opened = 0;
  const tui = { terminal: { rows: 20 }, requestRender: () => {} };
  // `close` is the cancel keybinding the dashboard really checks — needed when a test presses a
  // key the overlay does NOT handle (a never-closing overlay would hang the suite).
  const keybindings = { matches: (data: string, action: string) => action === "tui.select.cancel" && data === "close" };
  const ctx = {
    hasUI: true,
    ui: {
      notify: (message: string) => { notifications.push(message); },
      input: async (title: string) => {
        inputTitles.push(title);
        return typed;
      },
      custom: async (factory: any) => {
        opened += 1;
        if (opened > 1) return null; // the list re-opened after the send: close it and finish
        return new Promise((resolve) => {
          const component = factory(tui, {}, keybindings, resolve);
          for (const key of keys) component.handleInput(key);
        });
      },
    },
  };
  return { ctx, inputTitles, notifications, openedCount: () => opened };
}

describe("openComsPeersOverlay compose key (#1077)", () => {
  it("sends one line to the focused peer with the row's scope", async () => {
    const sent: Array<{ target: string; prompt: string; project?: string }> = [];
    const { ctx, inputTitles, openedCount } = makeCtx(["m"], "  ship it  ");
    await openComsPeersOverlay(ctx, {
      listPeers: () => [worker],
      killPeer: () => "killed",
      killAll: () => "killed all",
      tellPeer: async (request) => {
        sent.push(request);
        return "📡 sent to worker";
      },
    });
    assert.deepEqual(sent, [{ target: "worker", prompt: "ship it", project: "repo" }]);
    assert.match(inputTitles[0], /Message worker/);
    // The list comes back after the send instead of dropping the user into the chat.
    assert.equal(openedCount(), 2);
  });

  it("treats a blank line as nothing to send and returns to the list", async () => {
    const sent: unknown[] = [];
    const { ctx, openedCount } = makeCtx(["m"], "   ");
    await openComsPeersOverlay(ctx, {
      listPeers: () => [worker],
      killPeer: () => "killed",
      killAll: () => "killed all",
      tellPeer: async (request) => {
        sent.push(request);
        return "should not happen";
      },
    });
    assert.deepEqual(sent, []);
    // "returns to the list" is half the title, so it is asserted: the list re-opened.
    assert.equal(openedCount(), 2);
  });

  it("offers no composer when the caller passes no tellPeer", async () => {
    // `m` must fall through to nothing, so close the list explicitly afterwards.
    const { ctx, inputTitles } = makeCtx(["m", "close"], "ignored");
    await openComsPeersOverlay(ctx, {
      listPeers: () => [worker],
      killPeer: () => "killed",
      killAll: () => "killed all",
    });
    assert.deepEqual(inputTitles, []);
  });
});

describe("openComsPeersOverlay failure reporting (#1084)", () => {
  it("sanitizes the whole failed-send status before notifying", async () => {
    // The status carries the peer's own socket error: a raw ESC/BEL would reach the terminal.
    const hostile = "\u26a0\ufe0f delivery to worker failed: \u001b[2J\u0007boom";
    const { ctx, notifications } = makeCtx(["m"], "hi");
    await openComsPeersOverlay(ctx, {
      listPeers: () => [worker],
      killPeer: () => "killed",
      killAll: () => "killed all",
      tellPeer: async () => hostile,
    });
    assert.equal(notifications.length, 1);
    assert.equal(/[\u001b\u0007]/.test(notifications[0]), false);
    assert.match(notifications[0], /boom/);
    assert.equal(notifications[0].length <= 120, true);
  });

  it("stays quiet when the send succeeded", async () => {
    const { ctx, notifications } = makeCtx(["m"], "hi");
    await openComsPeersOverlay(ctx, {
      listPeers: () => [worker],
      killPeer: () => "killed",
      killAll: () => "killed all",
      tellPeer: async () => "\ud83d\udce1 sent to worker",
    });
    assert.deepEqual(notifications, []);
  });
});
