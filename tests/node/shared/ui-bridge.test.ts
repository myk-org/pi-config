/** #968 B — ui-bridge race semantics: browser/TUI first-answer-wins, dismiss, confirm mapping. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Container } from "@earendil-works/pi-tui";
import { createBridgedUi, isBrowserDispatch, markBrowserDispatch } from "../../../extensions/shared/ui-bridge.ts";

type Handler = (data: unknown) => void;

function fakePi() {
  const listeners = new Map<string, Handler[]>();
  const emitted: Array<{ channel: string; data: unknown }> = [];
  return {
    events: {
      emit: (channel: string, data: unknown) => { emitted.push({ channel, data }); },
      on: (channel: string, handler: Handler) => {
        if (!listeners.has(channel)) listeners.set(channel, []);
        listeners.get(channel)!.push(handler);
        return () => {
          const arr = listeners.get(channel) ?? [];
          const i = arr.indexOf(handler);
          if (i >= 0) arr.splice(i, 1);
        };
      },
    },
    fire: (channel: string, data: unknown) => {
      for (const h of [...(listeners.get(channel) ?? [])]) h(data);
    },
    emitted,
  };
}

interface CustomCall {
  render: (tui: any, theme: any, kb: any, done: (v: any) => void) => any;
  done: (v: any) => void;
  component: any;
}

function fakeCtx() {
  const calls: CustomCall[] = [];
  return {
    hasUI: true,
    ui: {
      custom: (render: any) =>
        new Promise((resolve) => {
          const call: CustomCall = { render, done: resolve, component: null } as any;
          calls.push(call);
          call.component = render(
            { requestRender: () => {} },
            { fg: (_c: string, s: string) => s },
            {},
            (v: any) => resolve(v),
          );
        }),
    },
    calls,
  };
}

describe("ui-bridge", () => {
  it("emits a browser request on select", async () => {
    const pi = fakePi();
    const ctx = fakeCtx();
    const bridged = createBridgedUi(pi as any);
    const p = bridged.select(ctx as any, "Pick one", ["a", "b"]);
    const req = pi.emitted.find((e) => e.channel === "pidash:ui-request");
    assert.ok(req, "ui-request emitted");
    assert.equal((req!.data as any).method, "select");
    assert.deepEqual((req!.data as any).options, ["a", "b"]);
    assert.equal((req!.data as any).title, "Pick one");
    // Answer from browser
    pi.fire("pidash:ui-response", { id: (req!.data as any).id, value: "a" });
    assert.equal(await p, "a");
  });

  it("browser answer resolves the promise and closes the TUI dialog (first answer wins)", async () => {
    const pi = fakePi();
    const ctx = fakeCtx();
    const bridged = createBridgedUi(pi as any);
    const p = bridged.select(ctx as any, "Pick", ["x", "y"]);
    const req = pi.emitted.find((e) => e.channel === "pidash:ui-request")!;
    pi.fire("pidash:ui-response", { id: (req.data as any).id, value: "x" });
    assert.equal(await p, "x");
    // The TUI dialog's done was invoked — the promise resolved.
    // A late second browser answer must be a no-op.
    pi.fire("pidash:ui-response", { id: (req.data as any).id, value: "y" });
    // And a late TUI answer must not re-resolve (done already consumed).
    ctx.calls[0].done("y");
    // No unhandled rejection; nothing else to assert — the awaited value stays "x".
  });

  it("TUI answer dismisses the browser dialog", async () => {
    const pi = fakePi();
    const ctx = fakeCtx();
    const bridged = createBridgedUi(pi as any);
    const p = bridged.select(ctx as any, "Pick", ["x", "y"]);
    const req = pi.emitted.find((e) => e.channel === "pidash:ui-request")!;
    // TUI answers through the component input pipeline (enter selects the first option)
    ctx.calls[0].component.handleInput("\r");
    assert.equal(await p, "x");
    const dismiss = pi.emitted.find((e) => e.channel === "pidash:ui-dismiss");
    assert.ok(dismiss, "ui-dismiss emitted so browser marks the prompt answered");
    assert.equal((dismiss!.data as any).id, (req.data as any).id);
  });

  it("confirm maps a browser-confirmed answer to true", async () => {
    const pi = fakePi();
    const ctx = fakeCtx();
    const bridged = createBridgedUi(pi as any);
    const p = bridged.confirm(ctx as any, "Proceed?");
    const req = pi.emitted.find((e) => e.channel === "pidash:ui-request")!;
    assert.equal((req.data as any).method, "confirm");
    pi.fire("pidash:ui-response", { id: (req.data as any).id, confirmed: true });
    assert.equal(await p, true);
  });

  it("confirm maps a browser-denied answer to false", async () => {
    const pi2 = fakePi();
    const ctx2 = fakeCtx();
    const bridged2 = createBridgedUi(pi2 as any);
    const p2 = bridged2.confirm(ctx2 as any, "Proceed?");
    const req2 = pi2.emitted.find((e) => e.channel === "pidash:ui-request")!;
    pi2.fire("pidash:ui-response", { id: (req2.data as any).id, confirmed: false });
    assert.equal(await p2, false);
  });

  it("cancelled browser response resolves undefined", async () => {
    const pi = fakePi();
    const ctx = fakeCtx();
    const bridged = createBridgedUi(pi as any);
    const p = bridged.input(ctx as any, "Name?");
    const req = pi.emitted.find((e) => e.channel === "pidash:ui-request")!;
    pi.fire("pidash:ui-response", { id: (req.data as any).id, cancelled: true });
    assert.equal(await p, undefined);
  });

  it("no UI context resolves undefined without emitting", async () => {
    const pi = fakePi();
    const bridged = createBridgedUi(pi as any);
    const v = await bridged.select({ hasUI: false } as any, "T", ["a"]);
    assert.equal(v, undefined);
    assert.equal(pi.emitted.filter((e) => e.channel === "pidash:ui-request").length, 0);
  });

  it("responses for other prompt ids are ignored", async () => {
    const pi = fakePi();
    const ctx = fakeCtx();
    const bridged = createBridgedUi(pi as any);
    const p = bridged.select(ctx as any, "Pick", ["a"]);
    pi.fire("pidash:ui-response", { id: "other-prompt", value: "a" });
    // Not resolved yet — answer with the right id
    const req = pi.emitted.find((e) => e.channel === "pidash:ui-request")!;
    pi.fire("pidash:ui-response", { id: (req.data as any).id, value: "a" });
    assert.equal(await p, "a");
  });
});


describe("ui-bridge degrade path (no ctx.ui.custom)", () => {
  it("confirm true resolves true instead of always cancelling", async () => {
    const bridged = createBridgedUi(fakePi() as any);
    const ctx = { hasUI: true, ui: { confirm: async () => true } };
    assert.equal(await bridged.confirm(ctx as any, "Run project-local agents?"), true);
  });

  it("confirm false resolves false", async () => {
    const bridged = createBridgedUi(fakePi() as any);
    const ctx = { hasUI: true, ui: { confirm: async () => false } };
    assert.equal(await bridged.confirm(ctx as any, "Run?"), false);
  });

  it("no UI resolves false without calling the prompt", async () => {
    const bridged = createBridgedUi(fakePi() as any);
    let called = false;
    const ctx = { hasUI: false, ui: { confirm: async () => { called = true; return true; } } };
    assert.equal(await bridged.confirm(ctx as any, "Run?"), false);
    assert.equal(called, false);
  });
});

describe("browser dispatch marker (#1082)", () => {
  it("is false for a terminal command", () => {
    assert.equal(isBrowserDispatch({ hasUI: true }), false);
    assert.equal(isBrowserDispatch({ hasUI: false }), false);
  });

  it("is false for an unmarked context", () => {
    assert.equal(isBrowserDispatch(undefined), false);
    assert.equal(isBrowserDispatch(null), false);
  });

  it("marks the context pidash hands a browser-dispatched command", () => {
    const ctx: Record<string, unknown> = { hasUI: true };
    markBrowserDispatch(ctx);
    assert.equal(isBrowserDispatch(ctx), true);
  });

  it("does not tag the live context, only the copy", () => {
    const live = { hasUI: true };
    const copy = { ...live };
    markBrowserDispatch(copy);
    assert.equal(isBrowserDispatch(copy), true);
    assert.equal(isBrowserDispatch(live), false, "the session ctx must stay unmarked");
  });
});

describe("ui-bridge Container & header caching (#1313)", () => {
  it("returns identical lines from the same Container across repeated render calls", async () => {
    const pi = fakePi();
    const ctx = fakeCtx();
    const bridged = createBridgedUi(pi as any);
    const p = bridged.select(ctx as any, "Pick target", ["alpha", "beta", "gamma"]);
    const comp = ctx.calls[0].component;

    const seenContainers = new Set<Container>();
    const origRender = Container.prototype.render;
    Container.prototype.render = function (this: Container, width: number) {
      seenContainers.add(this);
      return origRender.call(this, width);
    };

    try {
      const f1 = comp.render(60);
      const f2 = comp.render(60);
      const f3 = comp.render(60);
      assert.deepEqual(f1, f2);
      assert.deepEqual(f2, f3);
      assert.equal(seenContainers.size, 1, "same Container reused across renders");
    } finally {
      Container.prototype.render = origRender;
    }

    comp.handleInput("\x1b");
    assert.equal(await p, undefined);
  });

  it("reuses the Container while filtering updates visible options", async () => {
    const pi = fakePi();
    const ctx = fakeCtx();
    const bridged = createBridgedUi(pi as any);
    const p = bridged.select(ctx as any, "Pick target", ["alpha", "beta", "gamma"]);
    const comp = ctx.calls[0].component;

    const seenContainers = new Set<Container>();
    const origRender = Container.prototype.render;
    Container.prototype.render = function (this: Container, width: number) {
      seenContainers.add(this);
      return origRender.call(this, width);
    };

    try {
      const initialFrame = comp.render(60).join("\n");
      assert.match(initialFrame, /Pick target/);
      assert.match(initialFrame, /alpha/);
      assert.match(initialFrame, /gamma/);

      comp.handleInput("/");
      comp.handleInput("g");
      const filteredFrame = comp.render(60).join("\n");
      assert.match(filteredFrame, /Pick target/);
      assert.match(filteredFrame, /gamma/);
      assert.doesNotMatch(filteredFrame, /alpha/);
      assert.equal(seenContainers.size, 1, "Container instance reused after filter update");
    } finally {
      Container.prototype.render = origRender;
    }

    comp.handleInput("\r");
    assert.equal(await p, "gamma");
  });
});

describe("ui-bridge bounded viewport, on-demand filter, peek, and Esc cancel (#1317, #1313)", () => {
  function fakeCtxWithRows(rows: number) {
    const calls: CustomCall[] = [];
    let termRows = rows;
    return {
      hasUI: true,
      ui: {
        custom: (render: any) =>
          new Promise((resolve) => {
            const call: CustomCall = { render, done: resolve, component: null } as any;
            calls.push(call);
            const terminal = { columns: 80 };
            Object.defineProperty(terminal, "rows", { get: () => termRows, configurable: true });
            call.component = render(
              { requestRender: () => {}, terminal },
              { fg: (_c: string, s: string) => s },
              {},
              (v: any) => resolve(v),
            );
          }),
      },
      calls,
      setRows: (next: number) => { termRows = next; },
    };
  }

  it("bounds a 25-line title in select mode so all options stay visible", async () => {
    const pi = fakePi();
    const ctx = fakeCtxWithRows(35);
    const bridged = createBridgedUi(pi as any);
    const longTitle = Array.from({ length: 25 }, (_, i) => `Line ${i + 1}: rm -rf details`).join("\n");
    const options = ["run once", "this session", "this project", "everywhere", "no"];
    const p = bridged.select(ctx as any, longTitle, options);
    const comp = ctx.calls[0].component;

    const lines = comp.render(80);
    const joined = lines.join("\n");
    assert.match(joined, /lines 1–4 of 25/);
    for (const opt of options) {
      assert.match(joined, new RegExp(opt));
    }
    assert.ok(lines.length <= 16, `expected compact height <= 16 lines, got ${lines.length}`);

    comp.handleInput("\x1b");
    assert.equal(await p, undefined);
  });

  it("updates the highlighted selection in rendered output on arrow down", async () => {
    const pi = fakePi();
    const ctx = fakeCtxWithRows(24);
    const bridged = createBridgedUi(pi as any);
    const p = bridged.select(ctx as any, "Pick target", ["alpha", "beta", "gamma"]);
    const comp = ctx.calls[0].component;

    const before = comp.render(60).join("\n");
    assert.match(before, /→ alpha/);
    assert.doesNotMatch(before, /→ beta/);

    comp.handleInput("\x1b[B");
    const after = comp.render(60).join("\n");
    assert.match(after, /→ beta/);
    assert.doesNotMatch(after, /→ alpha/);

    comp.handleInput("\r");
    assert.equal(await p, "beta");
  });

  it("hides filter input for fewer than 6 options until slash is pressed", async () => {
    const pi = fakePi();
    const ctx = fakeCtxWithRows(24);
    const bridged = createBridgedUi(pi as any);
    const p = bridged.select(ctx as any, "Allow?", ["run once", "no"]);
    const comp = ctx.calls[0].component;

    const initial = comp.render(80).join("\n");
    assert.match(initial, /\/ filter/);
    assert.doesNotMatch(initial, /type to filter/);

    // Printable keys are ignored while filter is hidden
    comp.handleInput("n");
    const unchanged = comp.render(80).join("\n");
    assert.match(unchanged, /run once/);
    assert.match(unchanged, /no/);

    comp.handleInput("/");
    assert.match(comp.render(80).join("\n"), /type to filter/);

    comp.handleInput("\x1b"); // close filter
    comp.handleInput("\x1b"); // cancel prompt
    assert.equal(await p, undefined);
  });

  it("shows filter input immediately for 6 or more options", async () => {
    const pi = fakePi();
    const ctx = fakeCtxWithRows(24);
    const bridged = createBridgedUi(pi as any);
    const p = bridged.select(ctx as any, "Pick", ["one", "two", "three", "four", "five", "six"]);
    const comp = ctx.calls[0].component;

    assert.match(comp.render(80).join("\n"), /type to filter/);

    comp.handleInput("\x1b");
    assert.equal(await p, undefined);
  });

  it("collapses select mode to a 1-line paused bar on Tab", async () => {
    const pi = fakePi();
    const ctx = fakeCtxWithRows(24);
    const bridged = createBridgedUi(pi as any);
    const p = bridged.select(ctx as any, "Allow?", ["run once", "no"]);
    const comp = ctx.calls[0].component;

    comp.handleInput("\t");
    const lines = comp.render(80);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /◷ prompt paused — press Tab \(or Alt\+P\) to resume answering · Esc cancel/);

    comp.handleInput("\x1b");
    assert.equal(await p, undefined);
  });

  it("restores select mode from minimized state preserving highlighted selection", async () => {
    const pi = fakePi();
    const ctx = fakeCtxWithRows(24);
    const bridged = createBridgedUi(pi as any);
    const p = bridged.select(ctx as any, "Allow?", ["run once", "this session", "no"]);
    const comp = ctx.calls[0].component;

    comp.handleInput("\x1b[B"); // highlight "this session"
    comp.handleInput("\t"); // minimize
    assert.equal(comp.render(80).length, 1);

    comp.handleInput("\x1bp"); // restore with Alt+P
    comp.handleInput("\r");
    assert.equal(await p, "this session");
  });

  it("cancels select mode with undefined on legacy Esc", async () => {
    const pi = fakePi();
    const ctx = fakeCtxWithRows(24);
    const bridged = createBridgedUi(pi as any);
    const p = bridged.select(ctx as any, "Allow?", ["run once", "no"]);
    const comp = ctx.calls[0].component;

    comp.handleInput("\x1b");
    assert.equal(await p, undefined);
  });

  it("cancels select mode with undefined on Kitty Esc", async () => {
    const pi = fakePi();
    const ctx = fakeCtxWithRows(24);
    const bridged = createBridgedUi(pi as any);
    const p = bridged.select(ctx as any, "Allow?", ["run once", "no"]);
    const comp = ctx.calls[0].component;

    comp.handleInput("\x1b[27u");
    assert.equal(await p, undefined);
  });

  it("cancels select mode with undefined on Kitty Esc when filter is always shown", async () => {
    const pi = fakePi();
    const ctx = fakeCtxWithRows(24);
    const bridged = createBridgedUi(pi as any);
    const p = bridged.select(ctx as any, "Pick", ["one", "two", "three", "four", "five", "six"]);
    const comp = ctx.calls[0].component;

    comp.handleInput("\x1b[27u");
    assert.equal(await p, undefined);
  });

  it("cancels confirm mode with false on Kitty Esc", async () => {
    const pi = fakePi();
    const ctx = fakeCtxWithRows(24);
    const bridged = createBridgedUi(pi as any);
    const p = bridged.confirm(ctx as any, "Proceed?");
    const comp = ctx.calls[0].component;

    comp.handleInput("\x1b[27u");
    assert.equal(await p, false);
  });

  it("cancels input mode with undefined on Kitty Esc", async () => {
    const pi = fakePi();
    const ctx = fakeCtxWithRows(24);
    const bridged = createBridgedUi(pi as any);
    const p = bridged.input(ctx as any, "Enter value");
    const comp = ctx.calls[0].component;

    comp.handleInput("\x1b[27u");
    assert.equal(await p, undefined);
  });

  it("cancels select mode with undefined on Ctrl+C", async () => {
    const pi = fakePi();
    const ctx = fakeCtxWithRows(24);
    const bridged = createBridgedUi(pi as any);
    const p = bridged.select(ctx as any, "Allow?", ["run once", "no"]);
    const comp = ctx.calls[0].component;

    comp.handleInput("\x03");
    assert.equal(await p, undefined);
  });

  it("refreshes input mode viewport when terminal height changes at the same width", async () => {
    const pi = fakePi();
    const ctx = fakeCtxWithRows(35);
    const bridged = createBridgedUi(pi as any);
    const longTitle = Array.from({ length: 12 }, (_, i) => `Prompt line ${i + 1}`).join("\n");
    const p = bridged.input(ctx as any, longTitle);
    const comp = ctx.calls[0].component;

    assert.match(comp.render(60).join("\n"), /lines 1–4 of 12/);

    ctx.setRows(20);
    assert.match(comp.render(60).join("\n"), /lines 1–3 of 12/);

    comp.handleInput("\x1b");
    assert.equal(await p, undefined);
  });

  it("refreshes select mode viewport when terminal height changes at the same width without changing list rows", async () => {
    const pi = fakePi();
    const ctx = fakeCtxWithRows(35);
    const bridged = createBridgedUi(pi as any);
    const longTitle = Array.from({ length: 12 }, (_, i) => `Prompt line ${i + 1}`).join("\n");
    const p = bridged.select(ctx as any, longTitle, ["Yes", "No"]);
    const comp = ctx.calls[0].component;

    assert.match(comp.render(60).join("\n"), /lines 1–4 of 12/);

    ctx.setRows(20);
    assert.match(comp.render(60).join("\n"), /lines 1–3 of 12/);

    comp.handleInput("\x1b");
    assert.equal(await p, undefined);
  });
});
