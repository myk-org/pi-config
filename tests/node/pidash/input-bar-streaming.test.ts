/**
 * The Stop button is the ONLY abort path (no key is bound to abort), so it
 * must appear whenever the watched session is streaming — including a page
 * reloaded mid-turn, which never received the agent_start that would have set
 * a client-side flag.
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import * as rootReact from "react";
import { createServer, type ViteDevServer } from "vite";
import * as pidashReact from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { act, createElement } from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { createRoot, type Root } from "../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js";
import { elements, installReactDomShim } from "./react-dom-shim.mjs";

let vite: ViteDevServer;
let InputBar: any;
before(async () => {
  vite = await createServer({
    root: path.resolve("extensions/pidash/pidash-ui"),
    server: { middlewareMode: true },
    appType: "custom",
  });
  ({ InputBar } = await vite.ssrLoadModule("/src/components/InputBar.tsx"));
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

async function renderInputBar(props: Record<string, unknown>) {
  const { container, document } = installReactDomShim();
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => root.render(createElement(InputBar, { disabled: false, onSend: () => {}, ...props })));
  return { container, document, root };
}

describe("pidash composer streaming state", () => {
  it("shows the Stop button while streaming and hides Send", async () => {
    const view = await renderInputBar({ streaming: true, onAbort: () => {} });
    const buttons = elements(view.container, "button");
    const stop = buttons.find((b: any) => b.getAttribute("aria-label") === "Stop");
    assert.ok(stop, "Stop button is present while streaming");
    assert.equal(stop.getAttribute("title"), "Stop the running turn");
    assert.equal(buttons.some((b: any) => b.getAttribute("aria-label") === "Send"), false);
  });

  it("never advertises Escape as the abort key", async () => {
    const view = await renderInputBar({ streaming: true, onAbort: () => {} });
    const area = elements(view.container, "textarea")[0];
    const placeholder = area.getAttribute("placeholder");
    assert.equal(placeholder, "Working... press ■ to stop");
    assert.equal(/esc/i.test(placeholder), false);
    const stop = elements(view.container, "button").find((b: any) => b.getAttribute("aria-label") === "Stop");
    assert.equal(/esc/i.test(stop.getAttribute("title") || ""), false);
  });

  it("falls back to Send when the session is idle", async () => {
    const view = await renderInputBar({ streaming: false });
    const buttons = elements(view.container, "button");
    assert.equal(buttons.some((b: any) => b.getAttribute("aria-label") === "Stop"), false);
    const area = elements(view.container, "textarea")[0];
    assert.match(area.getAttribute("placeholder"), /^Send a message/);
  });

  it("Stop invokes the abort handler", async () => {
    let aborted = 0;
    const view = await renderInputBar({ streaming: true, onAbort: () => { aborted += 1; } });
    const stop = elements(view.container, "button").find((b: any) => b.getAttribute("aria-label") === "Stop");
    await act(async () => stop.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.equal(aborted, 1);
  });
});
