/**
 * Verify ask_user / extension_ui_request persistence across session switches,
 * reloads, live age >10s, duplicate askId delivery, and ui-dismiss sync (#1331).
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import * as rootReact from "react";
import { createServer, type ViteDevServer } from "vite";
import * as pidashReact from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { act, createElement } from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { createRoot, type Root } from "../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js";
import { useMessageHandler } from "../../../extensions/pidash/pidash-ui/src/hooks/useMessageHandler.ts";
import type { ChatMessage } from "../../../extensions/pidash/pidash-ui/src/types.ts";
import type { SessionInfo } from "../../../extensions/shared/types.ts";
import { elements, installReactDomShim } from "./react-dom-shim.mjs";

let vite: ViteDevServer;
let MessageItem: any;
before(async () => {
  vite = await createServer({
    root: path.resolve("extensions/pidash/pidash-ui"),
    server: { middlewareMode: true },
    appType: "custom",
  });
  ({ MessageItem } = await vite.ssrLoadModule("/src/components/MessageList.tsx"));
});
after(() => vite.close());

const rootInternals = (rootReact as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const pidashInternals = (pidashReact as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
for (const key of ["H", "A", "T"]) {
  Object.defineProperty(rootInternals, key, {
    configurable: true,
    get: () => pidashInternals[key],
    set: (value) => { pidashInternals[key] = value; },
  });
}

const mounted: Root[] = [];
afterEach(async () => {
  while (mounted.length) await act(async () => mounted.pop()!.unmount());
});

const notifications = {
  permission: "denied" as NotificationPermission,
  supported: false,
  preferences: { enabled: false, sound: false, sessionEnd: false, awaitingInput: false },
  setPreference: () => {},
  requestPermission: () => {},
} as any;

const session: SessionInfo = {
  sessionId: "s1",
  pid: 1,
  cwd: "/tmp/project",
  branch: "main",
  model: "m",
  startedAt: "now",
  lastActivity: 0,
  active: true,
};

async function mountHandler() {
  const { container } = installReactDomShim();
  let emit: (ev: any) => void = () => {};
  let latestMessages: ChatMessage[] = [];

  function Probe() {
    const state = useMessageHandler(
      (handler) => { emit = handler as any; return () => {}; },
      session,
      notifications,
      () => {},
    );
    latestMessages = state.messages;
    return null;
  }

  const root = createRoot(container);
  mounted.push(root);
  await act(async () => root.render(createElement(Probe)));
  return {
    emit: (ev: any) => emit(ev),
    messages: () => latestMessages,
  };
}

describe("useMessageHandler extension_ui_request persistence (#1331)", () => {
  it("renders a live extension_ui_request older than 10 seconds", async () => {
    const h = await mountHandler();

    await act(async () => {
      h.emit({ type: "replay_start" });
      h.emit({ type: "replay_end" });
      h.emit({
        type: "extension_ui_request",
        id: "ask-old",
        method: "select",
        title: "Deploy now?",
        options: ["Yes", "No"],
        timestamp: Date.now() - 60_000,
      });
    });

    assert.equal(h.messages().length, 1);
    assert.equal(h.messages()[0].className, "ask|ask-old|select|Yes|||No");
  });

  it("drops a stale extension_ui_request during historical replay", async () => {
    const h = await mountHandler();

    await act(async () => {
      h.emit({ type: "replay_start" });
      h.emit({
        type: "extension_ui_request",
        id: "ask-replay-stale",
        method: "confirm",
        title: "Old replay prompt",
        timestamp: Date.now() - 60_000,
      });
      h.emit({ type: "replay_end" });
    });

    assert.equal(h.messages().length, 0);
  });

  it("deduplicates a live extension_ui_request with an existing askId", async () => {
    const h = await mountHandler();
    const req = {
      type: "extension_ui_request",
      id: "ask-dup",
      method: "select",
      title: "Choose target",
      options: ["Staging", "Prod"],
    };

    await act(async () => {
      h.emit(req);
      h.emit(req);
    });
    await act(async () => {
      h.emit(req);
    });

    assert.equal(h.messages().length, 1);
    assert.equal(h.messages()[0].className, "ask|ask-dup|select|Staging|||Prod");
  });

  it("renders a post-replay active prompt with the same askId after replay_start clears prior session", async () => {
    const h = await mountHandler();

    await act(async () => {
      h.emit({
        type: "extension_ui_request",
        id: "ask-shared",
        method: "select",
        title: "Session A question",
        options: ["A"],
      });
    });

    await act(async () => {
      h.emit({ type: "replay_start" });
      h.emit({ type: "replay_end" });
      h.emit({
        type: "extension_ui_request",
        id: "ask-shared",
        method: "select",
        title: "Session B question",
        options: ["B"],
      });
    });

    assert.equal(h.messages().length, 1);
    assert.equal(h.messages()[0].text, "Session B question");
    assert.equal(h.messages()[0].className, "ask|ask-shared|select|B");
  });
});

describe("MessageItem ask-answered state sync (#1331)", () => {
  it("switches an active select prompt to dismissed when className becomes ask-answered", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const activeMsg: ChatMessage = {
      id: "m-1",
      role: "ask_user" as any,
      text: "Pick an option",
      className: "ask|ask-1|select|Alpha|||Beta",
    };

    await act(async () => root.render(createElement(MessageItem, { msg: activeMsg })));
    assert.equal(elements(container, "button").length, 2);

    const dismissedMsg: ChatMessage = { ...activeMsg, className: "ask-answered|ask-1" };
    await act(async () => root.render(createElement(MessageItem, { msg: dismissedMsg })));

    assert.equal(elements(container, "button").length, 0);
    assert.match(container.textContent ?? "", /✓ Answered: dismissed/);
  });

  it("switches an active input prompt to dismissed when className becomes ask-answered", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const activeMsg: ChatMessage = {
      id: "m-2",
      role: "ask_user" as any,
      text: "Enter name",
      className: "ask|ask-2|input|",
    };

    await act(async () => root.render(createElement(MessageItem, { msg: activeMsg })));
    assert.equal(elements(container, "input").length, 1);

    const dismissedMsg: ChatMessage = { ...activeMsg, className: "ask-answered|ask-2" };
    await act(async () => root.render(createElement(MessageItem, { msg: dismissedMsg })));

    assert.equal(elements(container, "input").length, 0);
    assert.match(container.textContent ?? "", /✓ Answered: dismissed/);
  });

  it("keeps the chosen option label when dismissed after a local answer", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    let chosen: [string, string] | null = null;
    const activeMsg: ChatMessage = {
      id: "m-3",
      role: "ask_user" as any,
      text: "Pick an option",
      className: "ask|ask-3|select|Alpha|||Beta",
    };

    await act(async () => root.render(createElement(MessageItem, {
      msg: activeMsg,
      onAskResponse: (id: string, value: string) => { chosen = [id, value]; },
    })));

    const alphaBtn = elements(container, "button").find((b) => b.textContent === "Alpha");
    assert.ok(alphaBtn);
    await act(async () => alphaBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.deepEqual(chosen, ["ask-3", "Alpha"]);

    const dismissedMsg: ChatMessage = { ...activeMsg, className: "ask-answered|ask-3" };
    await act(async () => root.render(createElement(MessageItem, { msg: dismissedMsg })));

    assert.match(container.textContent ?? "", /✓ Answered: Alpha/);
  });
});
