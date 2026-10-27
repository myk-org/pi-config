import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import * as rootReact from "react";
import { createServer, type ViteDevServer } from "vite";
import * as pidashReact from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { act, createElement } from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { createRoot, type Root } from "../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js";
import type { SessionInfo } from "../../../extensions/shared/types.ts";
import { elements, installReactDomShim } from "./react-dom-shim.mjs";

let vite: ViteDevServer;
let InfoBar: any;
before(async () => {
  vite = await createServer({
    root: path.resolve("extensions/pidash/pidash-ui"),
    server: { middlewareMode: true },
    appType: "custom",
  });
  ({ InfoBar } = await vite.ssrLoadModule("/src/components/InfoBar.tsx"));
});
after(() => vite.close());

const rootInternals = (rootReact as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const pidashInternals = (pidashReact as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
for (const key of ["H", "A", "T"]) {
  Object.defineProperty(rootInternals, key, { configurable: true, get: () => pidashInternals[key], set: (value) => { pidashInternals[key] = value; } });
}

const mounted: Root[] = [];
afterEach(async () => {
  while (mounted.length) await act(async () => mounted.pop()!.unmount());
});

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "selected", pid: 1, cwd: "/tmp/project", branch: "main", model: "model",
    startedAt: "now", lastActivity: 0, active: true, ...overrides,
  };
}

async function renderInfoBar(value: SessionInfo, send: (data: object) => void = () => {}) {
  const { container, document } = installReactDomShim();
  const root = createRoot(container);
  mounted.push(root);
  const props = { session: value, model: value.model, tokens: null, send, onMessage: () => () => {} };
  await act(async () => root.render(createElement(InfoBar, props)));
  return {
    container, document, root,
    rerender: async (next: SessionInfo) => act(async () => {
      root.render(createElement(InfoBar, { ...props, session: next, model: next.model }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }),
  };
}

async function renderInfoBarWithTokens(value: SessionInfo, tokens: any) {
  const { container, document } = installReactDomShim();
  const root = createRoot(container);
  mounted.push(root);
  const props = { session: value, model: value.model, tokens, send: () => {}, onMessage: () => () => {} };
  await act(async () => root.render(createElement(InfoBar, props)));
  return { container, document, root };
}

function button(root: any, text: string) {
  const match = elements(root, "button").find((item: any) => item.textContent.trim() === text);
  assert.ok(match, `button ${text} should exist`);
  return match;
}

function key(target: any, value: string) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
}

describe("InfoBar thinking selector", () => {
  it("renders only for reasoning-capable sessions", async () => {
    const view = await renderInfoBar(session({ reasoning: false }));
    assert.equal(elements(view.container, "button").some((item: any) => item.getAttribute("aria-controls") === "thinking-level-menu"), false);
    await view.rerender(session({ reasoning: true }));
    assert.equal(elements(view.container, "button").some((item: any) => item.getAttribute("aria-controls") === "thinking-level-menu"), true);
  });

  it("supports keyboard navigation", async () => {
    const view = await renderInfoBar(session({ reasoning: true, thinkingLevel: "medium" }));
    const trigger = elements(view.container, "button").find((item: any) => item.getAttribute("aria-controls") === "thinking-level-menu");
    await act(async () => key(trigger, "ArrowDown"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
    assert.equal(view.document.activeElement.textContent.trim(), "medium");
    await act(async () => key(view.document.activeElement, "End"));
    assert.equal(view.document.activeElement.textContent.trim(), "max");
  });

  it("dispatches keyboard selection", async () => {
    const sent: object[] = [];
    const view = await renderInfoBar(session({ reasoning: true, thinkingLevel: "medium" }), (data) => sent.push(data));
    const trigger = elements(view.container, "button").find((item: any) => item.getAttribute("aria-controls") === "thinking-level-menu");
    await act(async () => key(trigger, "ArrowDown"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
    await act(async () => key(view.document.activeElement, "End"));
    await act(async () => view.document.activeElement.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.deepEqual(sent, [{ type: "pidash-command", sessionId: "selected", command: "set-thinking", level: "max" }]);
  });

  it("restores trigger focus after selection", async () => {
    const view = await renderInfoBar(session({ reasoning: true, thinkingLevel: "medium" }));
    const trigger = elements(view.container, "button").find((item: any) => item.getAttribute("aria-controls") === "thinking-level-menu");
    await act(async () => key(trigger, "ArrowDown"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
    await act(async () => view.document.activeElement.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.equal(view.document.activeElement, trigger);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
  });

  it("restores trigger focus when Escape closes the menu", async () => {
    const view = await renderInfoBar(session({ reasoning: true, thinkingLevel: "high" }));
    const trigger = elements(view.container, "button").find((item: any) => item.getAttribute("aria-controls") === "thinking-level-menu");
    await act(async () => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
    assert.equal(view.document.activeElement.textContent.trim(), "high");
    await act(async () => view.document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    assert.equal(view.document.activeElement, trigger);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
  });

  it("model menu is a real menu: its trigger's aria-controls resolves", async () => {
    // The trigger points at #model-menu; a dangling reference tells screen
    // readers and tests nothing about what opened.
    const view = await renderInfoBar(session());
    const trigger = elements(view.container, "button").find((item: any) => item.getAttribute("aria-controls") === "model-menu");
    assert.ok(trigger, "model trigger exposes aria-controls");
    await act(async () => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    // The shim exposes a node tree, not a live DOM — traverse it like the
    // other tests here instead of calling querySelector.
    const menu = elements(view.container, "div").find((item: any) => item.getAttribute("id") === "model-menu");
    assert.ok(menu, "#model-menu exists while open");
    // The popup is a searchable dialog, not an ARIA menu: it has no menu items
    // or arrow-key navigation, so it must not claim role="menu".
    assert.equal(menu!.getAttribute("role"), "dialog");
    assert.equal(menu!.getAttribute("aria-label"), "Select model");
    assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
  });

  it("Escape closes the model menu", async () => {
    const view = await renderInfoBar(session());
    const trigger = elements(view.container, "button").find((item: any) => item.getAttribute("aria-controls") === "model-menu");
    await act(async () => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
    await act(async () => view.document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    const stillOpen = elements(view.container, "div").some((item: any) => item.getAttribute("id") === "model-menu");
    assert.equal(stillOpen, false, "menu removed from the tree");
  });

  it("updates reasoning visibility", async () => {
    const view = await renderInfoBar(session({ reasoning: false, thinkingLevel: "xhigh" }));
    await view.rerender(session({ reasoning: true, thinkingLevel: "xhigh" }));
    const trigger = elements(view.container, "button").find((item: any) => item.getAttribute("aria-controls") === "thinking-level-menu");
    assert.match(trigger?.textContent ?? "", /xhigh/);
  });

  it("context gauge matches the TUI shape and counts the cached prompt", async () => {
    // Regression: the gauge divided only `tokens.input` (fresh tokens) by the
    // window, so an almost fully cached session read "ctx 0%".
    const view = await renderInfoBarWithTokens(
      session({ contextWindow: 1048576 }),
      { input: 92, output: 10, cacheRead: 333632 },
    );
    const gauge = elements(view.container, "span").find((item: any) =>
      /^ctx /.test((item.textContent || "").trim()),
    );
    assert.ok(gauge, "context gauge rendered");
    assert.equal(gauge!.textContent.trim(), "ctx 31.8%/1.0M");
    assert.match(gauge!.getAttribute("title") || "", /333,724 \/ 1,048,576 tokens \(92 fresh \+ 333,632 cache-read\)/);
  });

  it("context gauge shows the session window compactly", async () => {
    const view = await renderInfoBarWithTokens(session({ contextWindow: 262144 }), { input: 65536, output: 10 });
    const gauge = elements(view.container, "span").find((item: any) => /^ctx /.test((item.textContent || "").trim()));
    assert.equal(gauge!.textContent.trim(), "ctx 25.0%/262.1K");
  });

  it("context gauge falls back to a 1M window when the session reports none", async () => {
    const view = await renderInfoBarWithTokens(session(), { input: 524288, output: 1 });
    const gauge = elements(view.container, "span").find((item: any) => /^ctx /.test((item.textContent || "").trim()));
    assert.equal(gauge!.textContent.trim(), "ctx 52.4%/1.0M");
  });

  it("reserves the Graft slot when savings are unknown", async () => {
    // The bar must not reflow when this value appears mid-turn: the slot is
    // always mounted and hidden instead of being conditionally created.
    const view = await renderInfoBar(session());
    assert.match(view.container.textContent, /◤\s*0 saved/);
    const slot = elements(view.container, "span").find(
      (item: any) => /saved/.test(item.textContent || "") && /invisible/.test(String(item.getAttribute("class") || "")),
    );
    assert.ok(slot, "graft slot is reserved (invisible) when unknown");
  });

  it("shows Graft savings when reported", async () => {
    const view = await renderInfoBar(session({ graftTokenSavings: 1250 }));
    assert.match(view.container.textContent, /1\.3k saved/);
  });

  it("preserves its component instance across capability updates", async () => {
    let mounts = 0; let unmounts = 0;
    const onMessage = () => { mounts++; return () => { unmounts++; }; };
    const { container } = installReactDomShim();
    const root = createRoot(container); mounted.push(root);
    const render = (value: SessionInfo) => root.render(createElement(InfoBar, { session: value, model: value.model, tokens: null, send: () => {}, onMessage }));
    await act(async () => render(session({ reasoning: false })));
    await act(async () => render(session({ reasoning: true, graftTokenSavings: 1250 })));
    assert.deepEqual({ mounts, unmounts }, { mounts: 1, unmounts: 0 });
    // Capability updates must reach the same instance (the thinking control
    // appears without re-running the onMessage subscription).
    assert.ok(
      elements(container, "button").some((item: any) => item.getAttribute("aria-controls") === "thinking-level-menu"),
      "thinking control reflects the updated capability",
    );
    await act(async () => root.unmount()); mounted.pop();
    assert.equal(unmounts, 1);
  });
});
