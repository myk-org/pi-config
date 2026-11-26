import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import * as rootReact from "react";
import { createServer, type ViteDevServer } from "vite";
import * as pidashReact from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { act, createElement } from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { createRoot, type Root } from "../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js";
import type { SessionInfo } from "../../../extensions/shared/types.ts";
import { elements, installReactDomShim, type FakeElement } from "./react-dom-shim.mjs";

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

function button(root: FakeElement, text: string) {
  const match = elements(root, "button").find((item) => item.textContent.trim() === text);
  assert.ok(match, `button ${text} should exist`);
  return match;
}

/** The button that opens the menu named by its `aria-controls`; asserting presence here keeps
 *  every call site free of `possibly undefined`. */
function menuTrigger(root: FakeElement, menu: string) {
  const trigger = elements(root, "button").find((item) => item.getAttribute("aria-controls") === menu);
  assert.ok(trigger, `a trigger for #${menu} should exist`);
  return trigger;
}

function key(target: any, value: string) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
}

describe("InfoBar thinking selector", () => {
  it("renders only for reasoning-capable sessions", async () => {
    const view = await renderInfoBar(session({ reasoning: false }));
    assert.equal(elements(view.container, "button").some((item) => item.getAttribute("aria-controls") === "thinking-level-menu"), false);
    await view.rerender(session({ reasoning: true }));
    assert.equal(elements(view.container, "button").some((item) => item.getAttribute("aria-controls") === "thinking-level-menu"), true);
  });

  it("supports keyboard navigation", async () => {
    const view = await renderInfoBar(session({ reasoning: true, thinkingLevel: "medium" }));
    const trigger = menuTrigger(view.container, "thinking-level-menu");
    await act(async () => key(trigger, "ArrowDown"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
    assert.equal(view.document.activeElement.textContent.trim(), "medium");
    await act(async () => key(view.document.activeElement, "End"));
    assert.equal(view.document.activeElement.textContent.trim(), "max");
  });

  it("dispatches keyboard selection", async () => {
    const sent: object[] = [];
    const view = await renderInfoBar(session({ reasoning: true, thinkingLevel: "medium" }), (data) => sent.push(data));
    const trigger = menuTrigger(view.container, "thinking-level-menu");
    await act(async () => key(trigger, "ArrowDown"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
    await act(async () => key(view.document.activeElement, "End"));
    await act(async () => view.document.activeElement.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.deepEqual(sent, [{ type: "pidash-command", sessionId: "selected", command: "set-thinking", level: "max" }]);
  });

  it("restores trigger focus after selection", async () => {
    const view = await renderInfoBar(session({ reasoning: true, thinkingLevel: "medium" }));
    const trigger = menuTrigger(view.container, "thinking-level-menu");
    await act(async () => key(trigger, "ArrowDown"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
    await act(async () => view.document.activeElement.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.equal(view.document.activeElement, trigger);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
  });

  it("restores trigger focus when Escape closes the menu", async () => {
    const view = await renderInfoBar(session({ reasoning: true, thinkingLevel: "high" }));
    const trigger = menuTrigger(view.container, "thinking-level-menu");
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
    const trigger = menuTrigger(view.container, "model-menu");
    assert.ok(trigger, "model trigger exposes aria-controls");
    await act(async () => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    // The shim exposes a node tree, not a live DOM — traverse it like the
    // other tests here instead of calling querySelector.
    const menu = elements(view.container, "div").find((item) => item.getAttribute("id") === "model-menu");
    assert.ok(menu, "#model-menu exists while open");
    // The popup is a searchable dialog, not an ARIA menu: it has no menu items
    // or arrow-key navigation, so it must not claim role="menu".
    assert.equal(menu!.getAttribute("role"), "dialog");
    assert.equal(menu!.getAttribute("aria-label"), "Select model");
    assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
  });

  it("a broadcast models-list does not open the picker", async () => {
    // models-list is broadcast to every browser: any other tab (or automation)
    // asking for the list used to pop this tab's dropdown open.
    let emit: (ev: any) => void = () => {};
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);
    const value = session();
    await act(async () => root.render(createElement(InfoBar, {
      session: value, model: value.model, tokens: null, send: () => {},
      onMessage: (handler: any) => { emit = handler; return () => {}; },
    })));
    await act(async () => emit({ type: "models-list", models: [{ id: "m", name: "M", provider: "p", reasoning: true }] }));
    const trigger = menuTrigger(container, "model-menu");
    assert.equal(trigger.getAttribute("aria-expanded"), "false", "picker stays closed");
    assert.equal(elements(container, "div").some((item) => item.getAttribute("id") === "model-menu"), false);
  });

  it("Escape closes the model menu", async () => {
    const view = await renderInfoBar(session());
    const trigger = menuTrigger(view.container, "model-menu");
    await act(async () => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
    await act(async () => view.document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    const stillOpen = elements(view.container, "div").some((item) => item.getAttribute("id") === "model-menu");
    assert.equal(stillOpen, false, "menu removed from the tree");
  });

  it("updates reasoning visibility", async () => {
    const view = await renderInfoBar(session({ reasoning: false, thinkingLevel: "xhigh" }));
    await view.rerender(session({ reasoning: true, thinkingLevel: "xhigh" }));
    const trigger = menuTrigger(view.container, "thinking-level-menu");
    assert.match(trigger?.textContent ?? "", /xhigh/);
  });

  it("context gauge matches the TUI shape and counts the cached prompt", async () => {
    // Regression: the gauge divided only `tokens.input` (fresh tokens) by the
    // window, so an almost fully cached session read "ctx 0%".
    const view = await renderInfoBarWithTokens(
      session({ contextWindow: 1048576 }),
      { input: 92, output: 10, cacheRead: 333632 },
    );
    const gauge = elements(view.container, "span").find((item) =>
      /^ctx /.test((item.textContent || "").trim()),
    );
    assert.ok(gauge, "context gauge rendered");
    assert.equal(gauge!.textContent.trim(), "ctx 31.8%/1.0M");
    assert.match(gauge!.getAttribute("title") || "", /333,724 \/ 1,048,576 tokens \(92 fresh \+ 333,632 cache-read\)/);
  });

  it("context gauge counts cache writes toward the prompt", async () => {
    // Cache-write tokens are part of the prompt the model received; leaving them
    // out under-reports the session's context on providers that report them.
    const view = await renderInfoBarWithTokens(
      session({ contextWindow: 1048576 }),
      { input: 1000, output: 10, cacheRead: 100000, cacheWrite: 47000 },
    );
    const gauge = elements(view.container, "span").find((item) => /^ctx /.test((item.textContent || "").trim()));
    assert.equal(gauge!.textContent.trim(), "ctx 14.1%/1.0M");
    assert.match(gauge!.getAttribute("title") || "", /\(1,000 fresh \+ 100,000 cache-read \+ 47,000 cache-write\)/);
  });

  it("context gauge shows the session window compactly", async () => {
    const view = await renderInfoBarWithTokens(session({ contextWindow: 262144 }), { input: 65536, output: 10 });
    const gauge = elements(view.container, "span").find((item) => /^ctx /.test((item.textContent || "").trim()));
    assert.equal(gauge!.textContent.trim(), "ctx 25.0%/262.1K");
  });

  it("context gauge falls back to a 1M window when the session reports none", async () => {
    const view = await renderInfoBarWithTokens(session(), { input: 524288, output: 1 });
    const gauge = elements(view.container, "span").find((item) => /^ctx /.test((item.textContent || "").trim()));
    assert.equal(gauge!.textContent.trim(), "ctx 52.4%/1.0M");
  });

  it("omits optional Trail, diff, container, and Coms slots when absent so no invisible placeholders steal width", async () => {
    const view = await renderInfoBar(session());
    assert.doesNotMatch(view.container.textContent, /saved/);
    assert.doesNotMatch(view.container.textContent, /\bdiff\b/);
    assert.doesNotMatch(view.container.textContent, /🧊/);
    assert.doesNotMatch(view.container.textContent, /Coms:/);
    const invisibleSpans = elements(view.container, "span").filter((item) =>
      /\binvisible\b/.test(String(item.getAttribute("class") || "")),
    );
    assert.equal(invisibleSpans.length, 0, "no invisible placeholder spans should consume horizontal width");
  });

  it("shows Trail savings, diff, container, Coms, and non-crushing branch when reported", async () => {
    const view = await renderInfoBar(session({
      branch: "stage",
      gitDirty: true,
      gitChanges: 1,
      trailTokenSavings: 1250,
      diffPort: 4312,
      container: true,
      comsName: "feature-manager",
      comsProject: "pi-config",
    }));
    assert.match(view.container.textContent, /1\.3k saved/);
    assert.match(view.container.textContent, /diff/);
    assert.match(view.container.textContent, /🧊/);
    assert.match(view.container.textContent, /Coms:\s*feature-manager/);
    const branchSpan = elements(view.container, "span").find((item) =>
      (item.getAttribute("title") || "").startsWith("Git branch: stage"),
    );
    assert.ok(branchSpan, "git branch indicator rendered");
    assert.match(String(branchSpan!.getAttribute("class") || ""), /min-w-\[4\.5rem\]/, "git branch keeps a min-width so it cannot crush to 0px");
  });

  it("preserves its component instance across capability updates", async () => {
    let mounts = 0; let unmounts = 0;
    const onMessage = () => { mounts++; return () => { unmounts++; }; };
    const { container } = installReactDomShim();
    const root = createRoot(container); mounted.push(root);
    const render = (value: SessionInfo) => root.render(createElement(InfoBar, { session: value, model: value.model, tokens: null, send: () => {}, onMessage }));
    await act(async () => render(session({ reasoning: false })));
    await act(async () => render(session({ reasoning: true, trailTokenSavings: 1250 })));
    assert.deepEqual({ mounts, unmounts }, { mounts: 1, unmounts: 0 });
    // Capability updates must reach the same instance (the thinking control
    // appears without re-running the onMessage subscription).
    assert.ok(
      elements(container, "button").some((item) => item.getAttribute("aria-controls") === "thinking-level-menu"),
      "thinking control reflects the updated capability",
    );
    await act(async () => root.unmount()); mounted.pop();
    assert.equal(unmounts, 1);
  });

});

describe("InfoBar cron status trigger", () => {
  async function renderCronBar() {
    let emit: (ev: any) => void = () => {};
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);
    const value = session();
    await act(async () => root.render(createElement(InfoBar, {
      session: value, model: value.model, tokens: null, send: () => {},
      onMessage: (handler: any) => { emit = handler; return () => {}; },
    })));
    const cronTrigger = () => elements(container, "button").find((item) => /cron|⏸/.test(item.textContent || ""));
    return { emit, cronTrigger };
  }

  it("renders muted cron trigger when no crons exist", async () => {
    const { cronTrigger } = await renderCronBar();
    assert.equal(cronTrigger()!.textContent.trim(), "⏰ 0 crons");
    assert.match(String(cronTrigger()!.getAttribute("class") || ""), /text-muted-foreground\/50/);
  });

  it("renders blue cron trigger when all crons are active", async () => {
    const { emit, cronTrigger } = await renderCronBar();
    await act(async () => emit({
      type: "cron-status",
      count: 2,
      tasks: [
        { id: "session:1", description: "a", schedule: "every 1m", paused: false },
        { id: "session:2", description: "b", schedule: "every 5m" },
      ],
    }));
    assert.equal(cronTrigger()!.textContent.trim(), "⏰ 2 crons");
    assert.match(String(cronTrigger()!.getAttribute("class") || ""), /text-blue-400/);
  });

  it("renders amber paused trigger when all crons are paused", async () => {
    const { emit, cronTrigger } = await renderCronBar();
    await act(async () => emit({
      type: "cron-status",
      count: 1,
      tasks: [{ id: "session:1", description: "a", schedule: "every 1m", paused: true }],
    }));
    assert.equal(cronTrigger()!.textContent.trim(), "⏸ 1 cron");
    assert.match(String(cronTrigger()!.getAttribute("class") || ""), /text-amber-400/);
  });

  it("renders active count beside amber paused count for mixed crons", async () => {
    const { emit, cronTrigger } = await renderCronBar();
    await act(async () => emit({
      type: "cron-status",
      count: 3,
      tasks: [
        { id: "session:1", description: "a", schedule: "every 1m", paused: false },
        { id: "session:2", description: "b", schedule: "every 5m", paused: true },
        { id: "session:3", description: "c", schedule: "every 10m", paused: true },
      ],
    }));
    const mixed = cronTrigger()!;
    assert.equal(mixed.textContent.trim(), "⏰ 1 · ⏸ 2");
    const spans = elements(mixed, "span");
    assert.equal(spans.length, 3);
    assert.match(String(spans[0].getAttribute("class") || ""), /text-blue-400/);
    assert.match(String(spans[1].getAttribute("class") || ""), /text-muted-foreground\/50/);
    assert.match(String(spans[2].getAttribute("class") || ""), /text-amber-400/);
  });
});
