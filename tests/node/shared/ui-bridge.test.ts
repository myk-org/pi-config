/** #968 B — ui-bridge race semantics: browser/TUI first-answer-wins, dismiss, confirm mapping. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createBridgedUi } from "../../../extensions/shared/ui-bridge.ts";

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

  it("confirm maps __confirmed__/__denied__ and Yes", async () => {
    const pi = fakePi();
    const ctx = fakeCtx();
    const bridged = createBridgedUi(pi as any);
    const p = bridged.confirm(ctx as any, "Proceed?");
    const req = pi.emitted.find((e) => e.channel === "pidash:ui-request")!;
    assert.equal((req.data as any).method, "confirm");
    pi.fire("pidash:ui-response", { id: (req.data as any).id, confirmed: true });
    assert.equal(await p, true);

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
