/**
 * #1077 — the peers overlay's `m` composer (Qodo finding 6: the key shipped untested).
 *
 * Only input handling is exercised: `ctx.ui.custom` is mocked so the real OverlayListDashboard
 * receives keystrokes, which is where `m` lives. Rendering (theme/TUI) is not touched.
 *
 * Run with: npx tsx --test tests/node/coms/coms-peers-overlay.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { after, before } from "node:test";
import { describe, it } from "node:test";

import { openComsPeersOverlay } from "../../../extensions/coms/coms-peers-ui.js";
import { clearLogLevelCache, getPiLogPath, setGlobalSessionId } from "../../../extensions/shared/file-logger.ts";
import { makeTempDir } from "../helpers/temp-dirs.js";
import type { RegistryRow } from "../../../extensions/coms/coms-peers.js";

type Row = RegistryRow & { id: string };

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
        return { ok: true } as const;
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
        return { ok: true } as const;
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
    const hostile = "delivery to worker failed: \u001b[2J\u0007boom";
    const { ctx, notifications } = makeCtx(["m"], "hi");
    await openComsPeersOverlay(ctx, {
      listPeers: () => [worker],
      killPeer: () => "killed",
      killAll: () => "killed all",
      tellPeer: async () => ({ ok: false, code: "send-failed", reason: hostile }) as const,
    });
    assert.equal(notifications.length, 1);
    assert.equal(/[\u001b\u0007]/.test(notifications[0]), false);
    assert.match(notifications[0], /boom/);
    assert.equal(notifications[0].startsWith("\u26a0"), true, "a failed send is never styled as success");
    assert.equal(notifications[0].length <= 200, true);
  });

  it("stays quiet when the send succeeded", async () => {
    const { ctx, notifications } = makeCtx(["m"], "hi");
    await openComsPeersOverlay(ctx, {
      listPeers: () => [worker],
      killPeer: () => "killed",
      killAll: () => "killed all",
      tellPeer: async () => ({ ok: true }) as const,
    });
    assert.deepEqual(notifications, []);
  });
});

describe("openComsPeersOverlay drilldown (#1084 finding 1)", () => {
  it("Enter opens the peer's sections and Esc re-opens the list on that row", async () => {
    const opened: any[] = [];
    const described: string[] = [];
    await openComsPeersOverlay({ hasUI: true, ui: { notify: () => {} } } as any, {
      listPeers: () => [worker],
      killPeer: () => "killed",
      killAll: () => "killed all",
      describePeer: async (row) => {
        described.push(row.name);
        return { ok: false, reason: "not-reported" };
      },
      // The overlay's Enter path without a TUI: pick the peer on the first call, then leave each
      // deeper level immediately, which is what Esc does.
      openOverlay: async (_ctx: any, options: any) => {
        opened.push(options);
        if (opened.length === 1) options.listSpec.onSelect({ ...worker, id: "repo:worker" });
      },
    } as any);

    // 1) the drilldown really was opened for the selected row
    assert.deepEqual(described, ["worker"]);
    // 2) its first row is the peer info row, and the count ignores it (F2)
    assert.equal(opened[1].listSpec.listItems()[0].label, "peer info");
    assert.equal(opened[1].listSpec.countLabel(opened[1].listSpec.listItems()), "");
    // 3) Esc came back to the peer list focused on the peer it came from
    assert.equal(opened[2].initialSelectionId, "repo:worker");
    assert.equal(opened[2].listSpec.title, "Coms peers");
  });
});

describe("openComsPeersOverlay multi-select compose (#1084)", () => {
  const peer = (name: string): RegistryRow => ({ ...worker, name, endpoint: `/tmp/${name}.sock` });

  it("sends one request per selected peer and reports them in ONE notify line", async () => {
    const sent: string[] = [];
    const { ctx, notifications, inputTitles } = makeCtx([" ", "j", " ", "m"], "go");
    await openComsPeersOverlay(ctx, {
      listPeers: () => [peer("alpha"), peer("beta"), peer("gamma")],
      killPeer: () => "killed",
      killAll: () => "killed all",
      tellPeer: async (request) => {
        sent.push(request.target);
        return { ok: true } as const;
      },
    });
    assert.deepEqual(sent, ["alpha", "beta"]);
    assert.match(inputTitles[0], /Message 2 peers/);
    assert.equal(notifications.length, 1, "one line for the whole send");
    assert.match(notifications[0], /sent 2 peers/);
  });

  it("names the peer that failed and never reports a partial send as success", async () => {
    const { ctx, notifications } = makeCtx([" ", "j", " ", "m"], "go");
    await openComsPeersOverlay(ctx, {
      listPeers: () => [peer("alpha"), peer("beta"), peer("gamma")],
      killPeer: () => "killed",
      killAll: () => "killed all",
      tellPeer: async (request) =>
        request.target === "beta"
          ? ({ ok: false, code: "send-failed", reason: "delivery to beta failed: gone" } as const)
          : ({ ok: true } as const),
    });
    assert.equal(notifications.length, 1);
    assert.match(notifications[0], /sent 1 of 2 · failed 1: beta/);
    assert.equal(notifications[0].startsWith("\u26a0"), true);
  });

  it("sends once when the same peer is selected twice", async () => {
    const sent: string[] = [];
    // Space toggles: select alpha, deselect it, select it again — the id must still send once.
    const { ctx } = makeCtx([" ", " ", " ", "m"], "go");
    await openComsPeersOverlay(ctx, {
      listPeers: () => [peer("alpha"), peer("beta")],
      killPeer: () => "killed",
      killAll: () => "killed all",
      tellPeer: async (request) => {
        sent.push(request.target);
        return { ok: true } as const;
      },
    });
    assert.deepEqual(sent, ["alpha"]);
  });
});

describe("openComsPeersOverlay delivery truth (#1084 findings 1-3)", () => {
  // The overlay normally stamps the row id (`project:name`); this helper bypasses the list, so the
  // ids that dedupe by id depend on must be present here too.
  const peer = (name: string): Row => ({ ...worker, name, endpoint: `/tmp/${name}.sock`, id: `repo:${name}` });

  /** Drive the composer without keystrokes: hand the overlay the selection it would report. */
  const driveCompose = async (
    rows: Row[],
    selected: Row[],
    missing: string[],
    deps: Partial<Parameters<typeof openComsPeersOverlay>[1]>,
  ) => {
    const { ctx, notifications, inputTitles } = makeCtx([], "go");
    let called = false;
    await openComsPeersOverlay(ctx, {
      listPeers: () => rows,
      killPeer: () => "killed",
      killAll: () => "killed all",
      openOverlay: async (_ctx: any, options: any) => {
        // One pass only: the loop re-opens the list after a send, and a second compose would
        // send forever.
        if (called) return;
        called = true;
        options.listSpec.onCompose(selected, missing);
      },
      ...deps,
    } as any);
    return { ctx, notifications, inputTitles };
  };

  it("counts a stated failure as NOT sent when coms is inactive", async () => {
    const targets = [peer("alpha"), peer("beta")];
    const { notifications, inputTitles } = await driveCompose(targets, targets, [], {
      tellPeer: async () => ({ ok: false, code: "coms-inactive", reason: "coms is not active — run /coms start first." }) as const,
    });
    assert.match(inputTitles[0], /Message 2 peers/);
    assert.equal(notifications.length, 1);
    // Both named, and the count admits nothing arrived.
    assert.match(notifications[0], /sent 0 of 2 · failed 2: alpha, beta/);
    assert.equal(notifications[0].startsWith("\u26a0"), true);
  });

  it("reports a peer that left between selection and send, instead of dropping it", async () => {
    const alive = [peer("alpha")];
    const { notifications } = await driveCompose(alive, alive, ["repo:beta"], {
      tellPeer: async () => ({ ok: true }) as const,
    });
    assert.equal(notifications.length, 1);
    assert.match(notifications[0], /sent 1 of 2 · 1 peer left before sending: beta/);
  });

  it("says nothing was sent when every selected peer is gone, and asks for no text", async () => {
    const { notifications, inputTitles } = await driveCompose([peer("alpha")], [], ["repo:beta", "repo:gamma"], {
      tellPeer: async () => {
        throw new Error("must not be called");
      },
    });
    assert.deepEqual(inputTitles, [], "no dialog for a send that cannot happen");
    assert.equal(notifications.length, 1);
    assert.match(notifications[0], /nothing sent · 2 peers left before sending: beta, gamma/);
    assert.equal(notifications[0].startsWith("\u26a0"), true);
  });

  it("treats a thrown send as a failure, not a crash and not a success", async () => {
    const { notifications } = await driveCompose([peer("alpha")], [peer("alpha")], [], {
      tellPeer: async () => {
        throw new Error("socket exploded");
      },
    });
    assert.equal(notifications.length, 1);
    assert.match(notifications[0], /sent 0 of 1 · failed 1: alpha \(socket exploded\)/);
  });

  it("reports a clean multi-peer send with no failure wording", async () => {
    const targets = [peer("alpha"), peer("beta"), peer("gamma")];
    const { notifications } = await driveCompose(targets, targets, [], {
      tellPeer: async () => ({ ok: true }) as const,
    });
    assert.equal(notifications.length, 1);
    assert.match(notifications[0], /sent 3 peers/);
    assert.equal(notifications[0].startsWith("\ud83d"), true);
  });
});

describe("overlay_tell_failed (#1084 finding 3): one event, error level", () => {
  let savedHome: string | undefined;
  const sink = (): string => {
    const logPath = getPiLogPath("coms-peers-ui");
    assert.ok(logPath, "coms-peers-ui log path must resolve");
    return existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
  };
  const failLines = (): string[] => sink().split("\n").filter((line) => line.includes("overlay_tell_failed"));

  before(() => {
    savedHome = process.env.HOME;
    const dir = makeTempDir("pi-coms-tell-log-");
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    process.env.PI_LOG_COMS_PEERS_UI = "debug";
    setGlobalSessionId("coms-tell-log");
    clearLogLevelCache();
  });

  after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    delete process.env.PI_LOG_COMS_PEERS_UI;
    clearLogLevelCache();
  });

  const peer = (name: string): Row => ({ ...worker, name, endpoint: `/tmp/${name}.sock`, id: `repo:${name}` });

  const send = async (tellPeer: any) => {
    const { ctx } = makeCtx([], "go");
    let called = false;
    await openComsPeersOverlay(ctx, {
      listPeers: () => [peer("alpha")],
      killPeer: () => "killed",
      killAll: () => "killed all",
      openOverlay: async (_ctx: any, options: any) => {
        if (called) return;
        called = true;
        options.listSpec.onCompose([peer("alpha")], []);
      },
      tellPeer,
    } as any);
  };

  it("logs a thrown send as one error-level overlay_tell_failed with a code, no message text", async () => {
    const before = failLines().length;
    await send(async () => {
      throw new Error("socket exploded");
    });
    const lines = failLines();
    assert.equal(lines.length, before + 1, "exactly one failure line for one peer");
    const line = lines[lines.length - 1];
    assert.match(line, /\[error\]/);
    assert.match(line, /"code":"threw"/);
    assert.equal(line.includes("socket exploded"), false, "the thrown message is not logged");
  });

  it("logs no failure line for a clean send", async () => {
    const before = failLines().length;
    await send(async () => ({ ok: true }) as const);
    assert.equal(failLines().length, before);
  });
});

describe("openComsPeersOverlay keeps the ticks across a drilldown (#1084)", () => {
  const peer = (name: string): Row => ({ ...worker, name, endpoint: `/tmp/${name}.sock`, id: `repo:${name}` });

  it("re-opens the peer list with the selection it reported earlier", async () => {
    const opened: any[] = [];
    await openComsPeersOverlay({ hasUI: true, ui: { notify: () => {} } } as any, {
      listPeers: () => [peer("alpha"), peer("beta")],
      killPeer: () => "killed",
      killAll: () => "killed all",
      describePeer: async () => ({ ok: false, reason: "not-reported" }),
      openOverlay: async (_ctx: any, options: any) => {
        opened.push(options);
        if (opened.length === 1) {
          // Tick two peers, then Enter into one — the round trip that used to lose them.
          options.listSpec.onSelectionChange(["repo:alpha", "repo:beta"]);
          options.listSpec.onSelect(peer("alpha"));
        }
      },
    } as any);

    // 1 = peer list, 2 = the drilldown's sections (left immediately), 3 = the peer list again
    assert.equal(opened.length, 3);
    assert.deepEqual(opened[2].initialSelectionIds, ["repo:alpha", "repo:beta"]);
    assert.equal(typeof opened[0].listSpec.onSelectionChange, "function", "the overlay reports ticks back");
  });
});
