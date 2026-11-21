/**
 * #1317 + #1313 — ask_user TUI UX & Container caching tests.
 *
 * Covers:
 * - Bounded scrollable wrapped question viewport + Shift+Up/Down, PgUp/PgDn, Ctrl+E expand/collapse
 * - On-demand `/` filter for < 6 options vs always-shown filter for >= 6 options
 * - Dynamic SelectList max visible rows sized to terminal height
 * - Wrapped preview footer for truncated highlighted option labels
 * - Multi-line Editor free-text mode (submit, Shift+Enter/newline, Esc back vs cancel)
 * - executionMode: "sequential"
 * - Container reuse across repeated render(w) calls (#1313)
 * - Preserved pidash events, blocked status, and headless COMS fallback
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Container, Input, Text } from "@earendil-works/pi-tui";
import {
  computeQuestionViewportCap,
  computeSelectMaxVisible,
  registerAskUser,
} from "../../../extensions/orchestrator/ask-user.js";
import { fakeKeybindings, fakeTheme, fakeTui } from "../helpers/fake-tui.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";

interface AskHarness {
  tool: any;
  component: any;
  resultPromise: Promise<any>;
  events: Array<{ name: string; payload: any }>;
  customOptions: any;
  renderCount: () => number;
  setTermRows: (rows: number) => void;
}

function mountAskUser(
  params: { question: string; options?: string[] },
  opts: { rows?: number } = {},
): AskHarness {
  let tool: any;
  const events: Array<{ name: string; payload: any }> = [];
  const pi = {
    registerTool: (t: any) => {
      tool = t;
    },
    events: {
      emit: (name: string, payload: any) => events.push({ name, payload }),
      on: () => () => {},
    },
  };
  withSubagentChildEnv(undefined, () => {
    registerAskUser(pi as any, () => {});
  });
  assert.ok(tool, "ask_user tool must register");

  let renderRequests = 0;
  let termRows = opts.rows ?? 24;
  const tui = fakeTui({
    rows: termRows,
    requestRender: () => {
      renderRequests++;
    },
  });
  Object.defineProperty(tui.terminal, "rows", {
    get: () => termRows,
    configurable: true,
  });

  let component: any;
  let customOptions: any;

  const ctx = {
    hasUI: true,
    ui: {
      custom: (factory: any, options?: any) => {
        customOptions = options;
        return new Promise((resolve) => {
          component = factory(tui, fakeTheme(), fakeKeybindings(), (value: string | null) => {
            resolve(value);
          });
        });
      },
    },
  };

  const resultPromise = tool.execute("call-1", params, undefined, undefined, ctx);
  assert.ok(component, "custom UI component must be created synchronously");

  return {
    tool,
    component,
    resultPromise,
    events,
    customOptions,
    renderCount: () => renderRequests,
    setTermRows: (rows: number) => {
      termRows = rows;
    },
  };
}

describe("ask_user tool registration & sizing helpers", () => {
  it("registers with executionMode: 'sequential'", () => {
    let tool: any;
    const pi = {
      registerTool: (t: any) => {
        tool = t;
      },
      events: { emit: () => {}, on: () => () => {} },
    };
    withSubagentChildEnv(undefined, () => {
      registerAskUser(pi as any, () => {});
    });
    assert.ok(tool);
    assert.equal(tool.executionMode, "sequential");
  });

  it("caps question viewport to ~30% of terminal height clamped to 4..8", () => {
    assert.equal(computeQuestionViewportCap(10), 4);
    assert.equal(computeQuestionViewportCap(20), 6);
    assert.equal(computeQuestionViewportCap(24), 7);
    assert.equal(computeQuestionViewportCap(30), 8);
    assert.equal(computeQuestionViewportCap(60), 8);
  });

  it("sizes SelectList maxVisible dynamically to terminal height", () => {
    assert.equal(computeSelectMaxVisible(0, 24), 0);
    assert.equal(computeSelectMaxVisible(3, 24), 3);
    assert.equal(computeSelectMaxVisible(20, 10), 4);
    assert.equal(computeSelectMaxVisible(20, 20), 7);
    assert.equal(computeSelectMaxVisible(20, 24), 8);
    assert.equal(computeSelectMaxVisible(20, 40), 14);
  });

  it("preserves headless COMS fallback when ctx.hasUI is false", async () => {
    let tool: any;
    const pi = {
      registerTool: (t: any) => {
        tool = t;
      },
      events: { emit: () => {}, on: () => () => {} },
    };
    withSubagentChildEnv(undefined, () => {
      registerAskUser(pi as any, () => {});
    });
    assert.ok(tool);
    const result = await tool.execute(
      "id",
      { question: "Approve?", options: ["Yes", "No"] },
      undefined,
      undefined,
      { hasUI: false },
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /coms_send/);
  });
});

describe("ask_user question viewport, scrolling, and Ctrl+E expand (#1317)", () => {
  it("renders short questions inside the box without overflow indicator", async () => {
    const h = mountAskUser({ question: "Deploy to staging?", options: ["Yes", "No"] }, { rows: 24 });
    const lines = h.component.render(60);
    const joined = lines.join("\n");
    assert.match(joined, /Deploy to staging\?/);
    assert.doesNotMatch(joined, /lines \d+–\d+ of \d+/);
    assert.deepStrictEqual(h.customOptions, {
      blocked: { kind: "question", message: "Deploy to staging?" },
    });
    h.component.handleInput("\r");
    const res = await h.resultPromise;
    assert.equal(res.content[0].text, "Yes");
  });

  it("bounds long questions, scrolls with Shift+Arrows and PgUp/PgDn, and toggles Ctrl+E", async () => {
    const longQuestion = Array.from({ length: 16 }, (_, i) => `Line ${i + 1}: detail about change`).join("\n");
    const h = mountAskUser({ question: longQuestion, options: ["Approve", "Reject"] }, { rows: 20 });

    // On 20-row terminal, cap = 6 lines
    const initial = h.component.render(60).join("\n");
    assert.match(initial, /Line 1: detail/);
    assert.match(initial, /Line 6: detail/);
    assert.doesNotMatch(initial, /Line 7: detail/);
    assert.match(initial, /lines 1–6 of 16/);

    // Shift+Down scrolls by 1 line
    h.component.handleInput("\x1b[1;2B");
    const afterShiftDown = h.component.render(60).join("\n");
    assert.doesNotMatch(afterShiftDown, /Line 1: detail/);
    assert.match(afterShiftDown, /Line 2: detail/);
    assert.match(afterShiftDown, /Line 7: detail/);
    assert.match(afterShiftDown, /lines 2–7 of 16/);

    // Shift+Up scrolls back up by 1 line
    h.component.handleInput("\x1b[1;2A");
    const afterShiftUp = h.component.render(60).join("\n");
    assert.match(afterShiftUp, /lines 1–6 of 16/);

    // PgDn scrolls by a page (cap - 1 = 5 lines -> lines 6-11)
    h.component.handleInput("\x1b[6~");
    const afterPgDn = h.component.render(60).join("\n");
    assert.match(afterPgDn, /lines 6–11 of 16/);

    // PgUp scrolls back to lines 1-6
    h.component.handleInput("\x1b[5~");
    const afterPgUp = h.component.render(60).join("\n");
    assert.match(afterPgUp, /lines 1–6 of 16/);

    // Ctrl+E expands to show all 16 lines
    h.component.handleInput("\x05");
    const expanded = h.component.render(60).join("\n");
    assert.match(expanded, /Line 1: detail/);
    assert.match(expanded, /Line 16: detail/);
    assert.match(expanded, /lines 1–16 of 16 \(expanded\)/);

    // Ctrl+E again collapses back to bounded viewport
    h.component.handleInput("\x05");
    const collapsed = h.component.render(60).join("\n");
    assert.doesNotMatch(collapsed, /Line 16: detail/);
    assert.match(collapsed, /lines 1–6 of 16/);

    h.component.handleInput("\x1b");
    const res = await h.resultPromise;
    assert.equal(res.terminate, true);
  });
});

describe("ask_user filter visibility and dynamic list height (#1317)", () => {
  it("hides filter input for < 6 options until `/` is pressed, and Esc closes filter before cancelling", async () => {
    const h = mountAskUser(
      { question: "Pick env", options: ["Alpha", "Beta", "Gamma"] },
      { rows: 24 },
    );

    const beforeSlash = h.component.render(70).join("\n");
    assert.match(beforeSlash, /\/ filter/);
    assert.doesNotMatch(beforeSlash, /type to filter/);

    // Typing a regular letter when filter is hidden does NOT filter options
    h.component.handleInput("g");
    const afterLetterIgnored = h.component.render(70).join("\n");
    assert.match(afterLetterIgnored, /Alpha/);
    assert.match(afterLetterIgnored, /Gamma/);

    // Pressing `/` opens the filter input
    h.component.handleInput("/");
    const afterSlash = h.component.render(70).join("\n");
    assert.match(afterSlash, /type to filter/);

    // Now typing filters to Gamma
    h.component.handleInput("G");
    h.component.handleInput("a");
    h.component.handleInput("m");
    const filtered = h.component.render(70).join("\n");
    assert.match(filtered, /Gamma/);
    assert.doesNotMatch(filtered, /Alpha/);

    // Esc closes the on-demand filter and restores all options (does NOT cancel dialog)
    h.component.handleInput("\x1b");
    const restored = h.component.render(70).join("\n");
    assert.match(restored, /\/ filter/);
    assert.match(restored, /Alpha/);
    assert.match(restored, /Gamma/);

    // Second Esc cancels dialog
    h.component.handleInput("\x1b");
    const res = await h.resultPromise;
    assert.equal(res.terminate, true);
  });

  it("shows filter input immediately for >= 6 options", async () => {
    const options = ["One", "Two", "Three", "Four", "Five", "Six"];
    const h = mountAskUser({ question: "Pick number", options }, { rows: 24 });

    const initial = h.component.render(70).join("\n");
    assert.match(initial, /type to filter/);

    // Typing immediately filters
    h.component.handleInput("S");
    h.component.handleInput("i");
    h.component.handleInput("x");
    const filtered = h.component.render(70).join("\n");
    assert.match(filtered, /Six/);
    assert.doesNotMatch(filtered, /One/);

    // Enter selects the filtered item
    h.component.handleInput("\r");
    const res = await h.resultPromise;
    assert.equal(res.content[0].text, "Six");
  });

  it("sizes SelectList rows dynamically to terminal height instead of hardcoded 15", async () => {
    const options = Array.from({ length: 18 }, (_, i) => `Option ${i + 1}`);
    const h = mountAskUser({ question: "Many choices", options }, { rows: 20 });

    // 20 rows -> maxVisible = Math.max(4, Math.floor(20 * 0.35)) = 7
    const lines = h.component.render(60);
    const optionLines = lines.filter((line: string) => /Option \d+/.test(line));
    assert.equal(optionLines.length, 7);
    assert.match(lines.join("\n"), /\(1\/19\)/);

    // Resize terminal to 10 rows -> maxVisible = 4
    h.setTermRows(10);
    const resizedLines = h.component.render(60);
    const resizedOptionLines = resizedLines.filter((line: string) => /Option \d+/.test(line));
    assert.equal(resizedOptionLines.length, 4);

    h.component.handleInput("\x1b");
    await h.resultPromise;
  });
});

describe("ask_user truncated option preview (#1317)", () => {
  it("renders wrapped full text below the list when highlighted option overflows 1 line", async () => {
    const longOpt =
      "Deploy to production with canary rollout enabled and automatic rollback on elevated error rate";
    const shortOpt = "Cancel";
    const h = mountAskUser(
      { question: "Proceed?", options: [longOpt, shortOpt] },
      { rows: 24 },
    );

    const width = 44;
    const firstFrame = h.component.render(width).join("\n");
    // Preview prefix + wrapped tail that would have been truncated in the 1-line SelectList
    assert.match(firstFrame, /↳ /);
    assert.match(firstFrame, /automatic rollback/);
    assert.match(firstFrame, /error rate/);

    // Move selection to short option -> preview disappears
    h.component.handleInput("\x1b[B");
    const secondFrame = h.component.render(width).join("\n");
    assert.doesNotMatch(secondFrame, /↳ /);

    h.component.handleInput("\r");
    const res = await h.resultPromise;
    assert.equal(res.content[0].text, "Cancel");
  });
});

describe("ask_user multi-line Editor free-text mode (#1317)", () => {
  it("switches to Editor on Other, allows Esc back to options, and submits multi-line text", async () => {
    const h = mountAskUser({ question: "Explain?", options: ["Keep"] }, { rows: 24 });

    // Move down to "✎  Other (type custom answer)" and press Enter
    h.component.handleInput("\x1b[B");
    h.component.handleInput("\r");
    const inEditor = h.component.render(60).join("\n");
    assert.match(inEditor, /shift\+enter newline/);
    assert.match(inEditor, /esc back/);

    // Esc returns to options mode
    h.component.handleInput("\x1b");
    const backInSelect = h.component.render(60).join("\n");
    assert.match(backInSelect, /\/ filter/);

    // Re-enter Editor (selection still on Other), type two lines, submit
    h.component.handleInput("\r");
    for (const ch of "first line") h.component.handleInput(ch);
    h.component.handleInput("\n"); // newline in Editor
    for (const ch of "second line") h.component.handleInput(ch);
    h.component.handleInput("\r"); // submit

    const res = await h.resultPromise;
    assert.equal(res.content[0].text, "first line\nsecond line");
  });

  it("cancels on Esc in free-text-only mode and submits multi-line input", async () => {
    const cancelHarness = mountAskUser({ question: "Notes?" }, { rows: 24 });
    const frame = cancelHarness.component.render(60).join("\n");
    assert.match(frame, /Notes\?/);
    assert.match(frame, /esc cancel/);
    cancelHarness.component.handleInput("\x1b");
    const cancelled = await cancelHarness.resultPromise;
    assert.equal(cancelled.terminate, true);

    const submitHarness = mountAskUser({ question: "Notes?", options: [] }, { rows: 24 });
    for (const ch of "line A") submitHarness.component.handleInput(ch);
    submitHarness.component.handleInput("\n");
    for (const ch of "line B") submitHarness.component.handleInput(ch);
    submitHarness.component.handleInput("\r");
    const submitted = await submitHarness.resultPromise;
    assert.equal(submitted.content[0].text, "line A\nline B");
  });
});

describe("ask_user Container reuse across redraws (#1313)", () => {
  it("reuses the same Container without rebuilding on repeated render(w) calls", async () => {
    const h = mountAskUser({ question: "Choose", options: ["A", "B", "C"] }, { rows: 24 });

    const seenContainers = new Set<Container>();
    let addChildCalls = 0;
    const origRender = Container.prototype.render;
    const origAddChild = Container.prototype.addChild;

    Container.prototype.render = function (this: Container, width: number) {
      seenContainers.add(this);
      return origRender.call(this, width);
    };
    Container.prototype.addChild = function (this: Container, child: any) {
      addChildCalls++;
      return origAddChild.call(this, child);
    };

    try {
      const r1 = h.component.render(60);
      const r2 = h.component.render(60);
      const r3 = h.component.render(60);
      assert.deepStrictEqual(r1, r2);
      assert.deepStrictEqual(r2, r3);
      assert.equal(seenContainers.size, 1, "same Container instance reused across renders");
      assert.equal(addChildCalls, 0, "no container rebuild during repeated render(w)");

      // Opening filter rebuilds children on the same Container instance
      h.component.handleInput("/");
      assert.ok(addChildCalls > 0, "container children rebuilt when filter visibility toggles");
      const countAfterOpen = addChildCalls;

      // Repeated renders after opening filter do NOT rebuild again
      h.component.render(60);
      h.component.render(60);
      assert.equal(addChildCalls, countAfterOpen);
      assert.equal(seenContainers.size, 1, "Container instance still reused after state change");

      // Navigating up/down in SelectList does NOT rebuild container
      h.component.handleInput("\x1b[B");
      h.component.render(60);
      assert.equal(addChildCalls, countAfterOpen);
    } finally {
      Container.prototype.render = origRender;
      Container.prototype.addChild = origAddChild;
    }

    // Verify searchInput is actually mounted only when filter is visible
    const hasInput = (container: Container) => container.children.some((c) => c instanceof Input);
    const [onlyContainer] = [...seenContainers];
    assert.equal(hasInput(onlyContainer), true);
    h.component.handleInput("\x1b"); // close filter
    assert.equal(hasInput(onlyContainer), false);
    assert.ok(onlyContainer.children.some((c) => c instanceof Text));

    h.component.handleInput("\x1b"); // cancel
    await h.resultPromise;
  });
});
