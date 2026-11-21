/** #968 B — ui-bridge race semantics: browser/TUI first-answer-wins, dismiss, confirm mapping. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Container, Text } from "@earendil-works/pi-tui";
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
  it("reuses Container and hoisted header Text across repeated render() calls and filter updates", async () => {
    const pi = fakePi();
    const ctx = fakeCtx();
    const bridged = createBridgedUi(pi as any);
    const p = bridged.select(ctx as any, "Pick target", ["alpha", "beta", "gamma"]);
    const comp = ctx.calls[0].component;

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
      const f1 = comp.render(60);
      const f2 = comp.render(60);
      const f3 = comp.render(60);
      assert.deepEqual(f1, f2);
      assert.deepEqual(f2, f3);
      assert.equal(seenContainers.size, 1, "same Container reused across renders");
      assert.equal(addChildCalls, 0, "no container rebuild on repeated render(w)");

      const [container] = [...seenContainers];
      const headerBefore = container.children.find((c) => c instanceof Text);
      assert.ok(headerBefore, "header Text child present");

      // Navigation does not rebuild container
      comp.handleInput("\x1b[B");
      comp.render(60);
      assert.equal(addChildCalls, 0, "arrow navigation does not rebuild container");

      // Typing a filter query swaps SelectList on the same Container while keeping the hoisted header Text
      comp.handleInput("g");
      assert.ok(addChildCalls > 0, "filter update syncs container children");
      const countAfterFilter = addChildCalls;
      const filteredFrame = comp.render(60).join("\n");
      assert.match(filteredFrame, /gamma/);
      assert.doesNotMatch(filteredFrame, /alpha/);
      assert.equal(addChildCalls, countAfterFilter, "render after filter does not rebuild container");
      assert.equal(seenContainers.size, 1, "Container instance still reused after filter update");
      const headerAfter = container.children.find((c) => c instanceof Text);
      assert.strictEqual(headerAfter, headerBefore, "hoisted header Text instance preserved");
    } finally {
      Container.prototype.render = origRender;
      Container.prototype.addChild = origAddChild;
    }

    // Select filtered item ("gamma")
    comp.handleInput("\r");
    assert.equal(await p, "gamma");
  });
});
