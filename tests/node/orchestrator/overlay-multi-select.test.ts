import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OverlayListDashboard } from "../../../extensions/orchestrator/overlay-dashboard.ts";
import { createLogger } from "../../../extensions/shared/logger.js";

const log = createLogger("overlay-multi-select-test");

interface Row { id: string; status: string }

/** Fake TUI/Theme/KeybindingsManager — only what OverlayListDashboard touches.
 *  `persisted` = the selection a caller kept from a previous open (#1084 round trip). */
function harness(options: { selectable?: boolean; killAll?: boolean; persisted?: string[] } = {}) {
  log.debug("create_harness", { selectable: options.selectable === true });
  const kills: string[][] = [];
  const keyCalls: Array<{ key: string; id: string | undefined; selected: string[] }> = [];
  const composes: Array<{ ids: string[]; missing: readonly string[] }> = [];
  const selectionChanges: string[][] = [];
  let killAllCalls = 0;
  let rows: Row[] = [
    { id: "a", status: "running" },
    { id: "b", status: "queued" },
    { id: "c", status: "running" },
  ];
  const selection = { index: 0, id: "a" as string | undefined };
  const spec: any = {
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
  const theme = {
    fg: (_c: string, v: string) => v,
    bold: (v: string) => v,
  } as any;
  const tui = { terminal: { rows: 20 }, requestRender: () => {} } as any;
  const kb = { matches: () => false } as any;
  const dash = new OverlayListDashboard<string, Row>(
    tui, theme, kb, spec, selection as any, () => {}, options.persisted ?? [],
  );
  return {
    dash,
    selectionChanges,
    spec,
    selection,
    kills,
    keyCalls,
    composes,
    get killAllCalls() { return killAllCalls; },
    footer: () => dash.render(100).find((l) => l.includes("select")) ?? "",
    press: (key: string) => dash.handleInput(key),
    /** The dashboard owns a 1s render ticker; a test that never closes it keeps the suite alive. */
    dispose: () => { try { (dash as any).close(null); } catch {} },
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
      { id: "a", label: "alpha" },
      { id: "b", label: "beta" },
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
});
