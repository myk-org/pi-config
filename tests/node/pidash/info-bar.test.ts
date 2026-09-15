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
    assert.equal(elements(view.container, "button").some((item: any) => item.getAttribute("aria-haspopup") === "menu"), false);
    await view.rerender(session({ reasoning: true }));
    assert.equal(elements(view.container, "button").some((item: any) => item.getAttribute("aria-haspopup") === "menu"), true);
  });

  it("supports keyboard navigation, selection dispatch, and trigger focus restoration", async () => {
    const sent: object[] = [];
    const view = await renderInfoBar(session({ reasoning: true, thinkingLevel: "medium" }), (data) => sent.push(data));
    const trigger = elements(view.container, "button").find((item: any) => item.getAttribute("aria-haspopup") === "menu");
    assert.ok(trigger);

    await act(async () => key(trigger, "ArrowDown"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
    assert.equal(view.document.activeElement.textContent.trim(), "medium");

    await act(async () => key(view.document.activeElement, "End"));
    assert.equal(view.document.activeElement.textContent.trim(), "max");
    await act(async () => view.document.activeElement.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    assert.deepEqual(sent, [{ type: "pidash-command", sessionId: "selected", command: "set-thinking", level: "max" }]);
    assert.equal(view.document.activeElement, trigger);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
  });

  it("restores trigger focus when Escape closes the menu", async () => {
    const view = await renderInfoBar(session({ reasoning: true, thinkingLevel: "high" }));
    const trigger = elements(view.container, "button").find((item: any) => item.getAttribute("aria-haspopup") === "menu");
    await act(async () => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
    assert.equal(view.document.activeElement.textContent.trim(), "high");
    await act(async () => view.document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    assert.equal(view.document.activeElement, trigger);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
  });

  it("updates reasoning visibility and Graft savings without remounting", async () => {
    const view = await renderInfoBar(session({ reasoning: false, thinkingLevel: "xhigh" }));
    await view.rerender(session({ reasoning: true, thinkingLevel: "xhigh", graftTokenSavings: 1250 }));
    const trigger = elements(view.container, "button").find((item: any) => item.getAttribute("aria-haspopup") === "menu");
    assert.match(trigger?.textContent ?? "", /xhigh/);
    assert.match(view.container.textContent, /1\.3k saved/);
  });
});
