import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  TuiMainScreen,
  isKittyProtocolActive,
  setKittyProtocolActive,
  stripTerminalSequences,
  type Terminal,
} from "@earendil-works/pi-tui";
import {
  OVERLAY_OPTS,
  OverlayListDashboard,
  OverlayScrollDetail,
  matchesOverlayKey,
  normalizeOverlayKey,
  openListDetailOverlay,
  type OverlayListSpec,
  type OverlayNotify,
  type OverlaySelection,
} from "../../../extensions/orchestrator/overlay-dashboard.ts";
import { openTasksOverlay } from "../../../extensions/pitasks/tasks-ui.ts";
import type { Task } from "../../../extensions/pitasks/types.ts";
import { createLogger } from "../../../extensions/shared/logger.js";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { fakeCommandCtx, fakeCustom, type FakeCustomFactory } from "../helpers/fake-extension-ctx.js";
import { fakeKeybindings, fakeTheme, fakeTui } from "../helpers/fake-tui.js";

const log = createLogger("overlay-multi-select-test");

interface Row { id: string; status: string }

/** Fake TUI/Theme/KeybindingsManager — only what OverlayListDashboard touches.
 *  `persisted` = the selection a caller kept from a previous open (#1084 round trip). */
function harness(options: {
  selectable?: boolean;
  killAll?: boolean;
  persisted?: string[];
  onNotify?: OverlayNotify;
  noticeTimeoutMs?: number;
} = {}) {
  log.debug("create_harness", { selectable: options.selectable === true });
  const kills: string[][] = [];
  const keyCalls: Array<{ key: string; id: string | undefined; selected: string[] }> = [];
  const composes: Array<{ ids: string[]; missing: readonly string[] }> = [];
  const selectionChanges: string[][] = [];
  let killAllCalls = 0;
  let closedWith: Array<string | null> = [];
  let rows: Row[] = [
    { id: "a", status: "running" },
    { id: "b", status: "queued" },
    { id: "c", status: "running" },
  ];
  const selection: OverlaySelection<string> = { index: 0, id: "a" };
  // Typed against the real contract: a recorder whose signature drifts from OverlayListSpec
  // must fail the compiler (`npm run typecheck:tests`), which is what `any` here used to hide.
  const spec: OverlayListSpec<string, Row> = {
    title: "Jobs",
    countLabel: (items: readonly Row[]) => `${items.length}`,
    borderTitle: (items: readonly Row[]) => `jobs · ${items.length}`,
    footerHints: undefined,
    selectable: options.selectable,
    listItems: () => rows,
    rowParts: (job: Row) => ({
      glyph: "■",
      title: job.id,
      idLabel: job.id.slice(-2),
      rightParts: [job.status],
    }),
    onX: (job: Row) => { kills.push([job.id]); },
    onXSelected: (items: Row[]) => { kills.push(items.map((i) => i.id)); },
    onKillAll: options.killAll === false ? undefined : () => { killAllCalls++; },
    onCompose: (items: Row[], missingIds: readonly string[]) => {
      composes.push({ ids: items.map((i) => i.id), missing: missingIds });
    },
    // Returns false so the built-in keys still act; this only records what onKey was handed.
    onKey: (key: string, item: Row | undefined, selected: readonly Row[]) => {
      keyCalls.push({ key, id: item?.id, selected: selected.map((row) => row.id) });
      return false as const;
    },
    onSelectionChange: (ids: string[]) => { selectionChanges.push(ids); },
  };
  const theme = fakeTheme();
  const tui = fakeTui();
  // Never matches, so the built-in keys act: the assertions are about `onKey` seeing them.
  const kb = fakeKeybindings(() => false);
  const dash = new OverlayListDashboard<string, Row>(
    tui,
    theme,
    kb,
    spec,
    selection,
    (value) => { closedWith.push(value); },
    options.persisted ?? [],
    false,
    options.onNotify,
    options.noticeTimeoutMs,
  );
  return {
    dash,
    selectionChanges,
    spec,
    selection,
    kills,
    keyCalls,
    composes,
    closedWith,
    get killAllCalls() { return killAllCalls; },
    footer: () => dash.render(100).find((l) => l.includes("select")) ?? "",
    press: (key: string) => dash.handleInput(key),
    /** The dashboard owns a 1s render ticker; a test that never closes it keeps the suite alive. */
    dispose: () => { dash.dispose(); },
    setRows: (next: Row[]) => { rows = next; dash.invalidate(); },
    /** The overlay's multi-selection is private — observable through the `x` callback. */
  };
}

describe("OverlayListDashboard multi-select", () => {
  it("x acts on the whole selection, not just the focused row", () => {
    const h = harness({ selectable: true });
    h.press(" "); // select a
    h.press("j"); // focus b
    h.press(" "); // select b
    h.press("x");
    log.debug("case", { via: "multi-x" });
    // Space selects the focused row, so a AND b are both in the selection and x acts on both.
    assert.deepEqual(h.kills, [["a", "b"]]);
    h.dash.dispose();
  });

  it("x with an empty selection still kills the focused row (back-compat)", () => {
    const h = harness({ selectable: true });
    h.press("j");
    h.press("x");
    log.debug("case", { via: "empty-selection-x" });
    assert.deepEqual(h.kills, [["b"]]);
    h.dash.dispose();
  });

  it("clears the selection after an x action", () => {
    const h = harness({ selectable: true });
    h.press(" "); // select a
    h.press("j"); // focus b
    h.press(" "); // select b
    h.press("x"); // kills the selection, which is then cleared
    h.press("x"); // nothing selected now, so falls back to the focused row
    log.debug("case", { via: "selection-cleared" });
    assert.deepEqual(h.kills, [["a", "b"], ["b"]]);
    h.dash.dispose();
  });

  it("space toggles a row back out of the selection", () => {
    const h = harness({ selectable: true });
    h.press(" ");
    h.press(" "); // off again
    h.press("x");
    log.debug("case", { via: "toggle-off" });
    assert.deepEqual(h.kills, [["a"]]);
    h.dash.dispose();
  });

  it("ignores space entirely when not selectable", () => {
    const h = harness();
    h.press(" ");
    h.press("x");
    log.debug("case", { via: "not-selectable" });
    assert.deepEqual(h.kills, [["a"]]);
    h.dash.dispose();
  });

  it("multi-select collects rows in list order, skipping removed jobs", () => {
    const h = harness({ selectable: true });
    h.press(" ");
    h.press("j");
    h.press(" ");
    h.press("j");
    h.press(" ");
    // A killed job disappears from the list before x fires.
    h.setRows([
      { id: "b", status: "queued" },
      { id: "c", status: "running" },
    ]);
    h.press("x");
    log.debug("case", { via: "stale-id-filtered" });
    assert.deepEqual(h.kills, [["b", "c"]]);
    h.dash.dispose();
  });

  it("renders a selection marker on selected rows", () => {
    const h = harness({ selectable: true });
    h.press(" ");
    const lines = h.dash.render(60);
    const body = lines.find((l) => l.includes("a"));
    log.debug("case", { via: "marker-render" });
    assert.ok(body?.includes("▸"), "expected a selection marker on the selected row");
    h.dash.dispose();
  });

  it("X invokes onKillAll directly, with no confirmation gate", () => {
    const h = harness({ selectable: true });
    h.press("X");
    log.debug("case", { via: "kill-all" });
    // No confirmation gate: pressing X must call onKillAll directly. The previous
    // confirm() prompt left the overlay hanging on hosts where it never resolved.
    assert.equal(h.killAllCalls, 1);
    h.dash.dispose();
  });

  it("hands onKey the focused row and the Space-picked selection", () => {
    const h = harness({ selectable: true });
    h.press(" ");            // select the focused row (a)
    h.press("j");            // focus b, still unselected
    h.press("q");            // a key no built-in handles
    assert.deepEqual(h.keyCalls.at(-1), { key: "q", id: "b", selected: ["a"] });
    h.dash.dispose();
  });

  it("hands onKey an empty selection when nothing is picked", () => {
    const h = harness({ selectable: true });
    h.press("j");
    h.press("q");
    assert.deepEqual(h.keyCalls.at(-1), { key: "q", id: "b", selected: [] });
    h.dash.dispose();
  });

  it("advertises only the bulk keys the spec really wires", () => {
    // A list with `x` on the selection but no kill-all must not promise `X`.
    const partial = harness({ selectable: true, killAll: false });
    const partialFooter = partial.footer();
    assert.match(partialFooter, /x on selection/);
    assert.doesNotMatch(partialFooter, /X on selection/);
    partial.dash.dispose();

    const full = harness({ selectable: true });
    assert.match(full.footer(), /x\/X on selection/);
    full.dash.dispose();
  });

  it("non-selectable overlays keep the original footer hints", () => {
    const plain = harness({});
    // Asserted through the rendered frame — what the user actually sees — not the
    // private footerText method, which a refactor may legitimately rename or inline.
    const rendered = plain.dash.render(100).join("\n");
    assert.match(rendered, /↑↓\/jk select · Enter view · x kill · Esc close/,
      "non-selectable overlays keep the original hints verbatim");
    assert.doesNotMatch(rendered, /Space select/,
      "the multi-select hint must not leak into non-selectable overlays");
    plain.dash.dispose();
  });

  it("bulk kill clears the selection so the next x hits the focused row", () => {
    // Regression: X left the selected ids in place, so a following x acted on those
    // now-failed jobs — or on nothing — instead of the newly focused running row.
    const h = harness({ selectable: true });
    h.setRows([
      { id: "a", status: "running" },
      { id: "b", status: "running" },
    ]);
    h.press(" ");                       // select the focused row (a)
    assert.equal(h.dash.render(100).join("\n").includes("▸"), true, "row a is selected");
    h.press("X");                       // bulk kill
    assert.equal(h.killAllCalls, 1);
    assert.equal(h.selection.index, 0, "focus is still on row a");

    h.dash.handleInput("j");            // move focus to the still-running row b
    h.press("x");
    log.debug("case", { via: "bulk-clears-selection" });
    assert.deepEqual(h.kills.at(-1), ["b"],
      "x after a bulk kill must act on the focused row, not the cleared selection");
    h.dash.dispose();
  });

  it("a and A remain aliases for kill-all", () => {
    for (const key of ["a", "A"]) {
      const h = harness({ selectable: true });
      h.press(key);
      assert.equal(h.killAllCalls, 1, `${key} must trigger kill-all`);
      h.dash.dispose();
    }
  });
});

describe("OverlayListDashboard compose key (#1084): the selection, like x", () => {
  it("hands over every multi-selected row, in row order", () => {
    const h = harness({ selectable: true });
    h.press(" "); // select a
    h.press("j");
    h.press(" "); // select b
    h.press("j");
    h.press(" "); // select c
    h.press("m");
    assert.deepEqual(h.composes, [{ ids: ["a", "b", "c"], missing: [] }]);
    // Compose acts on the selection, so it must not also fire a per-row send.
    assert.deepEqual(h.kills, []);
  });

  it("falls back to the focused row when nothing is selected", () => {
    const h = harness({ selectable: true });
    h.press("j"); // focus b, select nothing
    h.press("m");
    assert.deepEqual(h.composes, [{ ids: ["b"], missing: [] }]);
  });

  it("uses the focused row on a non-selectable list", () => {
    const h = harness();
    h.press("j");
    h.press("m");
    assert.deepEqual(h.composes, [{ ids: ["b"], missing: [] }]);
  });

  it("hands over the ids that vanished instead of dropping them (#1084 finding 2)", () => {
    const h = harness({ selectable: true });
    h.press(" "); // select a
    h.press("j");
    h.press(" "); // select b
    h.setRows([{ id: "a", status: "running" }, { id: "c", status: "running" }]); // b left
    h.press("m");
    assert.deepEqual(h.composes, [{ ids: ["a"], missing: ["b"] }]);
  });

  it("still reports when every selected row is gone", () => {
    const h = harness({ selectable: true });
    h.press(" "); // select a
    h.press("j");
    h.press(" "); // select b
    h.setRows([{ id: "c", status: "running" }]);
    h.press("m");
    assert.deepEqual(h.composes, [{ ids: [], missing: ["a", "b"] }]);
  });
});

describe("selection survives a re-opened dashboard (#1084)", () => {
  it("keeps the ticks the caller persisted, so `m` still gets both", () => {
    // First open: tick a and b — the caller records what the overlay reported.
    const first = harness({ selectable: true });
    first.press(" ");
    first.press("j");
    first.press(" ");
    const persisted = first.selectionChanges.at(-1) ?? [];
    assert.deepEqual(persisted, ["a", "b"]);
    first.dispose();

    // Drilldown + Esc: the overlay is rebuilt, seeded with what the caller kept.
    const second = harness({ selectable: true, persisted });
    second.press("m");
    assert.deepEqual(second.composes, [{ ids: ["a", "b"], missing: [] }]);
    second.dispose();
  });

  it("reports the peer that vanished and sends to the one that is left", () => {
    const first = harness({ selectable: true });
    first.press(" ");
    first.press("j");
    first.press(" ");
    first.dispose();
    // b leaves the registry while the user is inside the drilldown.
    const second = harness({ selectable: true, persisted: ["a", "b"] });
    second.setRows([{ id: "a", status: "running" }]);
    second.press("m");
    assert.deepEqual(second.composes, [{ ids: ["a"], missing: ["b"] }]);
    second.dispose();
  });

  it("kills the persisted selection, not just the focused row", () => {
    const second = harness({ selectable: true, persisted: ["a", "b"] });
    second.press("x");
    assert.deepEqual(second.kills, [["a", "b"]]);
    second.dispose();
  });

  it("tells the caller when a bulk kill clears the selection", () => {
    const h = harness({ selectable: true, persisted: ["a", "b"] });
    const before = h.selectionChanges.length;
    h.press("x");
    assert.deepEqual(h.selectionChanges.slice(before), [[]]);
    h.dispose();
  });

  it("starts empty when the caller had nothing ticked", () => {
    const h = harness({ selectable: true });
    h.press("m");
    assert.deepEqual(h.composes, [{ ids: ["a"], missing: [] }], "the focused row");
    h.dispose();
  });

  it("evaluates functional emptyBody dynamically on render", () => {
    let filtered = false;
    const h = harness({ selectable: true });
    try {
      h.spec.emptyBody = () => (filtered ? "Filtered empty." : "All empty.");
      h.setRows([]);
      assert.match(h.dash.render(80).join("\n"), /All empty\./);
      filtered = true;
      h.dash.invalidate();
      assert.match(h.dash.render(80).join("\n"), /Filtered empty\./);
    } finally {
      h.dispose();
    }
  });

  it("prunes hidden multi-selections when onKey returns redraw", () => {
    const h = harness({ selectable: true });
    try {
      h.spec.onKey = (key: string) => {
        if (key !== "f") return false as const;
        h.setRows([{ id: "b", status: "queued" }]);
        return "redraw" as const;
      };
      h.press(" "); // select a
      h.press("f"); // filter hides a, leaving only b
      h.press("x"); // no visible selection remains, so focused row b is killed
      assert.deepEqual(h.kills, [["b"]]);
    } finally {
      h.dispose();
    }
  });
});

describe("Kitty CSI-u / layout-safe overlay key matching (#1391)", () => {
  it("matches lowercase letters across plain, Kitty CSI-u, lock bits, repeat, and non-Latin layouts", () => {
    for (const seq of [
      "x",
      "\x1b[120u",
      "\x1b[120;1u",
      "\x1b[120;1:2u",
      "\x1b[120;129u",       // NumLock
      "\x1b[120;65u",        // CapsLock
      "\x1b[120:88;65u",     // CapsLock + shifted key
      "\x1b[120;193u",       // CapsLock + NumLock
      "\x1b[1505::120u",     // Hebrew base layout 'x'
      "\x1b[1505::120;129u", // Hebrew + NumLock
      "\x1b[27;1;120~",      // modifyOtherKeys
    ]) {
      assert.equal(matchesOverlayKey(seq, "x"), true, `expected ${JSON.stringify(seq)} to match "x"`);
      assert.equal(matchesOverlayKey(seq, "X"), false, `expected ${JSON.stringify(seq)} NOT to match "X"`);
      assert.equal(normalizeOverlayKey(seq), "x");
    }
  });

  it("matches uppercase bindings via Shift without matching lowercase", () => {
    for (const seq of [
      "X",
      "\x1b[120;2u",
      "\x1b[120:88;2u",
      "\x1b[88;2u",
      "\x1b[120;130u",       // Shift + NumLock
      "\x1b[1505::120;2u",   // Shift + non-Latin base layout 'x'
      "\x1b[27;2;88~",       // modifyOtherKeys Shift+X
    ]) {
      assert.equal(matchesOverlayKey(seq, "X"), true, `expected ${JSON.stringify(seq)} to match "X"`);
      assert.equal(matchesOverlayKey(seq, "x"), false, `expected ${JSON.stringify(seq)} NOT to match "x"`);
      assert.equal(normalizeOverlayKey(seq), "X");
    }
  });

  it("rejects Ctrl-modified letters and Kitty key-release events", () => {
    assert.equal(matchesOverlayKey("\x1b[120;5u", "x"), false, "Ctrl+x must not match plain x");
    assert.equal(matchesOverlayKey("\x1b[120;1:3u", "x"), false, "key release must be ignored");
    assert.equal(matchesOverlayKey("\x1b[120;2:3u", "X"), false, "shifted key release must be ignored");
    assert.equal(normalizeOverlayKey("\x1b[120;1:3u"), "");
  });

  it("selects with Kitty Space and kills selection with non-Latin x under NumLock", () => {
    const h = harness({ selectable: true });
    try {
      h.press("\x1b[32;129u");     // Space + NumLock → select a
      h.press("\x1b[106;129u");    // j + NumLock → focus b
      h.press("\x1b[1505::120u");  // non-Latin base 'x' → kills selected ["a"]
      assert.deepEqual(h.kills, [["a"]]);
    } finally {
      h.dispose();
    }
  });

  it("ignores Kitty key-release events inside OverlayListDashboard", () => {
    const h = harness({ selectable: true });
    try {
      h.press("\x1b[32;129u");   // Space press → select a
      h.press("\x1b[32;1:3u");   // Space release → must not untoggle a
      h.press("\x1b[120;1:3u");  // x release → must not kill
      assert.deepEqual(h.kills, []);
      assert.deepEqual(h.selectionChanges, [["a"]]);
    } finally {
      h.dispose();
    }
  });

  it("navigates with Kitty k and composes with m under CapsLock", () => {
    const h = harness({ selectable: true });
    try {
      h.press("j");            // focus b
      h.press("\x1b[107u");    // k → focus a
      h.press("\x1b[109;65u"); // m + CapsLock → compose on focused a
      assert.deepEqual(h.composes, [{ ids: ["a"], missing: [] }]);
    } finally {
      h.dispose();
    }
  });

  it("triggers kill-all with Kitty Shift+x", () => {
    const h = harness({ selectable: true });
    try {
      h.press("\x1b[120:88;2u");
      assert.equal(h.killAllCalls, 1);
    } finally {
      h.dispose();
    }
  });

  it("normalizes Kitty CSI-u keys before handing them to onKey", () => {
    const h = harness({ selectable: true });
    try {
      h.press("\x1b[113;129u"); // q + NumLock
      assert.equal(h.keyCalls.at(-1)?.key, "q");
    } finally {
      h.dispose();
    }
  });

  it("scrolls with Kitty j/k inside OverlayScrollDetail", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i}`);
    const detail = new OverlayScrollDetail(
      fakeTui({ rows: 14 }),
      fakeTheme(),
      {
        footerHints: "Esc back",
        tickMs: 60_000,
        getHeader: () => "header",
        getBodyLines: () => lines,
      },
      () => {},
    );
    try {
      assert.match(detail.render(60).join("\n"), /line-0/);
      detail.handleInput("\x1b[106;129u"); // j + NumLock
      const afterJ = detail.render(60).join("\n");
      assert.doesNotMatch(afterJ, /line-0/);
      assert.match(afterJ, /line-1/);
      detail.handleInput("\x1b[107u");     // k
      assert.match(detail.render(60).join("\n"), /line-0/);
    } finally {
      detail.dispose();
    }
  });

  it("dispatches Kitty x and normalized onKey while ignoring release in OverlayScrollDetail", () => {
    let xCalls = 0;
    const seenKeys: string[] = [];
    const detail = new OverlayScrollDetail(
      fakeTui({ rows: 14 }),
      fakeTheme(),
      {
        footerHints: "Esc back",
        tickMs: 60_000,
        getHeader: () => "header",
        getBodyLines: () => ["line-0"],
        onX: () => { xCalls++; return false; },
        onKey: (key) => { seenKeys.push(key); return false; },
      },
      () => {},
    );
    try {
      detail.handleInput("\x1b[1505::120u"); // non-Latin 'x'
      detail.handleInput("\x1b[120;1:3u");   // release ignored
      detail.handleInput("\x1b[112;129u");   // p + NumLock → normalized to "p"
      assert.equal(xCalls, 1);
      assert.deepEqual(seenKeys, ["p"]);
    } finally {
      detail.dispose();
    }
  });
});

describe("OverlayListDashboard inline feedback banner (#1391)", () => {
  it("renders inline notice inside the fullscreen frame and forwards to onNotify", () => {
    const forwarded: Array<{ message: string; level?: string }> = [];
    const h = harness({
      selectable: true,
      onNotify: (message, level) => forwarded.push({ message, level }),
      noticeTimeoutMs: 0,
    });
    try {
      h.spec.onXSelected = (_items, notify) => notify("deleted 1 row", "warning");
      h.press(" ");
      h.press("x");
      const frame = h.dash.render(80).join("\n");
      assert.match(frame, /⚠ deleted 1 row/);
      assert.deepEqual(forwarded, [{ message: "deleted 1 row", level: "warning" }]);
    } finally {
      h.dispose();
    }
  });

  it("clears inline notice on next navigation key", () => {
    const h = harness({ selectable: true, noticeTimeoutMs: 0 });
    try {
      h.dash.setNotice("Heads up", "info");
      assert.match(h.dash.render(80).join("\n"), /ℹ Heads up/);
      h.press("j");
      assert.doesNotMatch(h.dash.render(80).join("\n"), /Heads up/);
    } finally {
      h.dispose();
    }
  });

  it("clears inline notice on Space toggle", () => {
    const h = harness({ selectable: true, noticeTimeoutMs: 0 });
    try {
      h.dash.setNotice("Second notice", "error");
      assert.match(h.dash.render(80).join("\n"), /✖ Second notice/);
      h.press(" ");
      assert.doesNotMatch(h.dash.render(80).join("\n"), /Second notice/);
    } finally {
      h.dispose();
    }
  });

  it("auto-clears inline notice after noticeTimeoutMs", async () => {
    const h = harness({ selectable: true, noticeTimeoutMs: 20 });
    try {
      h.dash.setNotice("Transient toast", "info");
      assert.match(h.dash.render(80).join("\n"), /Transient toast/);
      await new Promise((r) => setTimeout(r, 45));
      assert.doesNotMatch(h.dash.render(80).join("\n"), /Transient toast/);
    } finally {
      h.dispose();
    }
  });
});

describe("OverlayListDashboard multi-select UX & openListDetailOverlay persistence (#1391)", () => {
  it("shows N selected in border and Esc clear in footer while selection is active", () => {
    const h = harness({ selectable: true });
    try {
      const before = h.dash.render(120).join("\n");
      assert.doesNotMatch(before, /selected/);
      assert.match(before, /Esc close/);

      h.press(" ");
      h.press("j");
      h.press(" ");
      const after = h.dash.render(120).join("\n");
      assert.match(after, /jobs · 3 · 2 selected/);
      assert.match(after, /2 selected · .*Esc clear/);
    } finally {
      h.dispose();
    }
  });

  it("does not count vanished selected rows in badge/footer and lets Esc close immediately", () => {
    const h = harness({ selectable: true, persisted: ["gone-1", "gone-2"] });
    try {
      const frame = h.dash.render(120).join("\n");
      assert.doesNotMatch(frame, /selected/, "stale ids must not render a phantom selection badge");
      assert.match(frame, /Esc close/);
      h.press("\x1b");
      assert.deepEqual(h.closedWith, [null], "first Esc closes immediately when no visible row is selected");
    } finally {
      h.dispose();
    }
  });

  it("clears active selection on first Esc and closes overlay on second Esc", () => {
    const h = harness({ selectable: true });
    try {
      h.press(" "); // select a
      h.press("\x1b[27u"); // Kitty Esc clears selection, does not close
      assert.deepEqual(h.closedWith, []);
      assert.deepEqual(h.selectionChanges.at(-1), []);
      assert.doesNotMatch(h.dash.render(100).join("\n"), /1 selected/);

      h.press("\x1b"); // second Esc closes overlay
      assert.deepEqual(h.closedWith, [null]);
    } finally {
      h.dispose();
    }
  });

  it("closes immediately on Ctrl+C even when a selection is active", () => {
    const h = harness({ selectable: true });
    try {
      h.press(" ");
      h.press("\x03");
      assert.deepEqual(h.closedWith, [null]);
    } finally {
      h.dispose();
    }
  });

  it("preserves multi-selection across Enter -> detail -> Esc in openListDetailOverlay", async () => {
    const rows = [{ id: "1" }, { id: "2" }, { id: "3" }];
    const killedSelected: string[][] = [];
    const scripts = [
      [" ", "j", " ", "\r"],
      ["\x1b"],
      ["x", "\x1b"],
    ];
    const frames: string[] = [];
    let openIndex = 0;
    const custom = (<T,>(factory: FakeCustomFactory<T>) => {
      const keys = scripts[openIndex++] ?? ["\x1b"];
      return fakeCustom(factory, keys, {
        onOpen: (comp) => { frames.push(comp.render(100).join("\n")); },
      });
    }) satisfies ExtensionUIContext["custom"];
    const ctx = fakeCommandCtx({ notify: () => {}, custom });

    await openListDetailOverlay(ctx, {
      emptyMessage: "Empty",
      listSpec: {
        title: "Items",
        countLabel: (items) => `${items.length}`,
        borderTitle: (items) => `items · ${items.length}`,
        listItems: () => rows,
        rowParts: (item) => ({ glyph: "■", title: item.id, idLabel: "", rightParts: [] }),
        selectable: true,
        onXSelected: (selected) => { killedSelected.push(selected.map((s) => s.id)); },
      },
      createDetail: (item, tui, theme, done) =>
        new OverlayScrollDetail(
          tui,
          theme,
          {
            footerHints: "Esc back",
            getHeader: () => item.id,
            getBodyLines: () => [item.id],
          },
          done,
        ),
    });

    assert.match(frames[2], /2 selected/, "returning from detail preserves both ticks");
    assert.deepEqual(killedSelected, [["1", "2"]]);
  });

  it("prunes a row deleted inside detail view from multi-selection on return", async () => {
    let rows = [{ id: "1" }, { id: "2" }, { id: "3" }];
    const killedSelected: string[][] = [];
    const scripts = [
      [" ", "j", " ", "\r"],
      ["x"],
      ["x", "\x1b"],
    ];
    const frames: string[] = [];
    let openIndex = 0;
    const custom = (<T,>(factory: FakeCustomFactory<T>) => {
      const keys = scripts[openIndex++] ?? ["\x1b"];
      return fakeCustom(factory, keys, {
        onOpen: (comp) => { frames.push(comp.render(100).join("\n")); },
      });
    }) satisfies ExtensionUIContext["custom"];
    const ctx = fakeCommandCtx({ notify: () => {}, custom });

    await openListDetailOverlay(ctx, {
      emptyMessage: "Empty",
      listSpec: {
        title: "Items",
        countLabel: (items) => `${items.length}`,
        borderTitle: (items) => `items · ${items.length}`,
        listItems: () => rows,
        rowParts: (item) => ({ glyph: "■", title: item.id, idLabel: "", rightParts: [] }),
        selectable: true,
        onXSelected: (selected) => { killedSelected.push(selected.map((s) => s.id)); },
      },
      createDetail: (item, tui, theme, done) =>
        new OverlayScrollDetail(
          tui,
          theme,
          {
            footerHints: "Esc back",
            getHeader: () => item.id,
            getBodyLines: () => [item.id],
            onX: () => {
              rows = rows.filter((r) => r.id !== item.id);
              return true;
            },
          },
          done,
        ),
    });

    assert.match(frames[2], /1 selected/, "deleting #2 inside detail prunes #2 and keeps #1");
    assert.deepEqual(killedSelected, [["1"]]);
  });
});

describe("real TuiMainScreen + Kitty protocol integration (#1391)", () => {
  function runWithRealTui<T>(
    factory: FakeCustomFactory<T>,
    keys: readonly string[],
    opts?: { overlay?: boolean; overlayOptions?: unknown },
  ): Promise<{ result: T; frames: string[] }> {
    let onInput: ((data: string) => void) | undefined;
    const term: Terminal = {
      columns: 110,
      rows: 24,
      kittyProtocolActive: true,
      start(inputCb) { onInput = inputCb; },
      stop() {},
      async drainInput() {},
      write() {},
      moveBy() {},
      hideCursor() {},
      showCursor() {},
      clearLine() {},
      clearFromCursor() {},
      clearScreen() {},
      setTitle() {},
      setProgress() {},
      setProgramStatus() {},
    };
    const tui = new TuiMainScreen(term);
    const kb = new KeybindingsManager(TUI_KEYBINDINGS);
    const frames: string[] = [];
    let resolveDone!: (value: T) => void;
    const closed = new Promise<T>((resolve) => { resolveDone = resolve; });
    return Promise.resolve(factory(tui as never, fakeTheme(), kb as never, resolveDone)).then(async (comp) => {
      tui.start();
      const handle = opts?.overlay ? tui.showOverlay(comp, opts.overlayOptions as never) : undefined;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        for (const key of keys) {
          onInput?.(key);
          frames.push(stripTerminalSequences((comp.render?.(110) ?? []).join("\n")));
        }
        const timeout = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`runWithRealTui timed out waiting for close (${frames.length} frames captured)`)),
            2000,
          );
          timeoutId.unref?.();
        });
        return { result: await Promise.race([closed, timeout]), frames };
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        handle?.hide();
        comp.dispose?.();
        tui.stop();
      }
    });
  }

  function makeRealTuiTasks(): Task[] {
    return [
      {
        id: "1", subject: "owner item", description: "", status: "pending", assignee: "user",
        metadata: {}, blocks: [], blockedBy: [],
        createdBy: { type: "local", origin: "user", session: "", project: "" },
        createdAt: 1, updatedAt: 1,
        statusHistory: { pending_at: "", in_progress_at: null, completed_at: null, deleted_at: null },
      },
      {
        id: "2", subject: "agent item", description: "", status: "pending", assignee: "llm",
        metadata: {}, blocks: [], blockedBy: [],
        createdBy: { type: "local", origin: "user", session: "", project: "" },
        createdAt: 1, updatedAt: 1,
        statusHistory: { pending_at: "", in_progress_at: null, completed_at: null, deleted_at: null },
      },
    ];
  }

  it("clears active selection on first Kitty Esc before closing on second Esc via real TuiMainScreen", async () => {
    const prevKitty = isKittyProtocolActive();
    setKittyProtocolActive(true);
    try {
      const closedValues: Array<string | null> = [];
      const rows = [{ id: "1" }, { id: "2" }];
      const { frames } = await runWithRealTui<string | null>(
        (tui, theme, kb, done) =>
          new OverlayListDashboard<string, { id: string }>(
            tui,
            theme,
            kb,
            {
              title: "Jobs",
              countLabel: (items) => `${items.length}`,
              borderTitle: (items) => `jobs · ${items.length}`,
              listItems: () => rows,
              rowParts: (item) => ({ glyph: "■", title: item.id, idLabel: "", rightParts: [] }),
              selectable: true,
            },
            { index: 0, id: "1" },
            (v) => { closedValues.push(v); done(v); },
          ),
        ["\x1b[32;129u", "\x1b[27;129u", "\x1b[27u"],
        OVERLAY_OPTS,
      );
      assert.match(frames[0], /1 selected/, "Space+NumLock ticks row 1");
      assert.match(frames[0], /Esc clear/, "footer switches to Esc clear while selected");
      assert.doesNotMatch(frames[1], /1 selected/, "first Kitty Esc clears selection without closing");
      assert.deepEqual(closedValues, [null], "second Kitty Esc closes overlay");
    } finally {
      setKittyProtocolActive(prevKitty);
    }
  });

  it("preserves /tasks multi-selection across detail view via real TuiMainScreen", async () => {
    const prevKitty = isKittyProtocolActive();
    setKittyProtocolActive(true);
    try {
      const tasks = makeRealTuiTasks();
      const scripts = [
        ["\x1b[32;129u", "\x1b[106;65u", "\x1b[32;129u", "\r"], // select both with NumLock/CapsLock, Enter detail
        ["\x1b[27;129u"],                                        // Esc back from detail
        ["\x1b[27;129u", "\x1b[27u"],                            // first Esc clears selection, second Esc closes
      ];
      const framesByOpen: string[][] = [];
      let openIdx = 0;
      const custom = (<T,>(factory: FakeCustomFactory<T>, opts?: unknown) => {
        const idx = openIdx++;
        return runWithRealTui(factory, scripts[idx] ?? ["\x1b"], opts as { overlay?: boolean; overlayOptions?: unknown })
          .then(({ result, frames }) => {
            framesByOpen[idx] = frames;
            return result;
          });
      }) satisfies ExtensionUIContext["custom"];
      const ctx = fakeCommandCtx({ notify: () => {}, custom });
      await openTasksOverlay(ctx, {
        listTasks: () => tasks,
        deleteTask: () => true,
        completeTask: () => true,
        createTask: () => "3",
        updateTaskSubject: () => true,
      });
      assert.match(framesByOpen[0][2], /2 selected/, "both rows selected before entering detail");
      assert.doesNotMatch(framesByOpen[2][0], /2 selected/, "first Kitty Esc after returning from detail cleared the preserved selection");
    } finally {
      setKittyProtocolActive(prevKitty);
    }
  });

  it("renders /tasks bulk-d inline banner under non-Latin Kitty input via real TuiMainScreen", async () => {
    const prevKitty = isKittyProtocolActive();
    setKittyProtocolActive(true);
    try {
      const tasks = makeRealTuiTasks().map((t) => ({ ...t, assignee: "llm" as const }));
      const allFrames: string[] = [];
      const custom = (<T,>(factory: FakeCustomFactory<T>, opts?: unknown) =>
        runWithRealTui(
          factory,
          ["\x1b[32;129u", "\x1b[106;65u", "\x1b[32;129u", "\x1b[1490::100u", "\x1b[27u"],
          opts as { overlay?: boolean; overlayOptions?: unknown },
        ).then(({ result, frames }) => {
          allFrames.push(...frames);
          return result;
        })) satisfies ExtensionUIContext["custom"];
      const ctx = fakeCommandCtx({ notify: () => {}, custom });
      await openTasksOverlay(ctx, {
        listTasks: () => tasks,
        deleteTask: () => true,
        completeTask: (id) => {
          const target = tasks.find((t) => t.id === id);
          if (target) target.status = "completed";
          return true;
        },
        createTask: () => "3",
        updateTaskSubject: () => true,
      });
      assert.ok(allFrames.some((f) => f.includes("ℹ completed 2 tasks")), "inline bulk-done banner rendered");
      assert.deepEqual(tasks.map((t) => t.status), ["completed", "completed"]);
    } finally {
      setKittyProtocolActive(prevKitty);
    }
  });
});
