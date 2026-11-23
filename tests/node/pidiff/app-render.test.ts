/**
 * Render App and RefreshButton to verify presentation over DiffSessionController.
 * Run with: npx tsx --test tests/node/pidiff/app-render.test.ts
 */
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createLogger } from "../../../extensions/pidiff/pidiff-ui/src/lib/create-logger.ts";

(globalThis as { __PIDIFF_DEBUG?: boolean }).__PIDIFF_DEBUG = true;

const log = createLogger("pidiff-ui");
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
register(pathToFileURL(join(here, "pierre-mock-loader.mjs")).href);

(globalThis as { React?: typeof React }).React = React;
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { hardwareConcurrency: 2 } as Navigator,
});
after(() => {
  delete (globalThis as { __pidiffTestStale?: boolean }).__pidiffTestStale;
  if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
  else delete (globalThis as { navigator?: Navigator }).navigator;
});
globalThis.window = { location: { protocol: "http:", host: "localhost" } } as Window & typeof globalThis;
globalThis.Worker = class { constructor() {} } as unknown as typeof Worker;
globalThis.WebSocket = class {
  static OPEN = 1;
  readyState = 0;
  send() {}
  close() {}
} as unknown as typeof WebSocket;
globalThis.localStorage = {
  getItem: (k: string) => {
    log.debug("localStorage getItem", k);
    return k === "pidiff-session"
      ? JSON.stringify({ sessionId: "s1", cwd: "/tmp/proj", branch: "main", repo: "proj", worktrees: [] })
      : null;
  },
  setItem() {},
  removeItem() {},
} as unknown as Storage;

beforeEach(() => {
  delete (globalThis as { __pidiffTestStale?: boolean }).__pidiffTestStale;
});

describe("App presentation over DiffSessionController", () => {
  it("mounts a header Refresh control when a session is active", async () => {
    const { App } = await import("../../../extensions/pidiff/pidiff-ui/src/App.tsx");
    const html = renderToString(createElement(App));
    assert.match(html, /data-pidiff-refresh="true"/);
    assert.match(html, /data-pidiff-refresh-slot="header"/);
  });

  it("renders header Refresh disabled while disconnected", async () => {
    const { App } = await import("../../../extensions/pidiff/pidiff-ui/src/App.tsx");
    const html = renderToString(createElement(App));
    assert.match(html, /data-pidiff-refresh-slot="header"/);
    assert.match(html, /disabled/);
    assert.doesNotMatch(html, /data-spinning="true"/);
  });

  it("mounts a banner Refresh control when stale", async () => {
    (globalThis as { __pidiffTestStale?: boolean }).__pidiffTestStale = true;
    const { App } = await import("../../../extensions/pidiff/pidiff-ui/src/App.tsx");
    const html = renderToString(createElement(App));
    assert.match(html, /data-pidiff-refresh-slot="banner"/);
  });

  it("contains no inline request-diffs bypasses in App.tsx", () => {
    const appSrc = readFileSync(join(repoRoot, "extensions/pidiff/pidiff-ui/src/App.tsx"), "utf8");
    assert.doesNotMatch(appSrc, /request-diffs/);
    assert.doesNotMatch(appSrc, /useWebSocket/);
  });
});

describe("RefreshButton", () => {
  it("renders an enabled control when idle", async () => {
    const { RefreshButton } = await import("../../../extensions/pidiff/pidiff-ui/src/App.tsx");
    const html = renderToString(
      createElement(RefreshButton, {
        button: { disabled: false, spinning: false, unmountBody: false },
        onRefresh: () => {},
        slot: "header",
      }),
    );
    assert.match(html, /Refresh/);
    assert.match(html, /data-pidiff-refresh="true"/);
    assert.doesNotMatch(html, /disabled/);
  });

  it("renders a disabled spinning control while refreshing", async () => {
    const { RefreshButton } = await import("../../../extensions/pidiff/pidiff-ui/src/App.tsx");
    const html = renderToString(
      createElement(RefreshButton, {
        button: { disabled: true, spinning: true, unmountBody: false },
        onRefresh: () => {},
        slot: "banner",
      }),
    );
    assert.match(html, /disabled/);
    assert.match(html, /data-spinning="true"/);
  });

  it("invokes onRefresh when clicked", async () => {
    const { RefreshButton } = await import("../../../extensions/pidiff/pidiff-ui/src/App.tsx");
    let clicks = 0;
    const vnode = RefreshButton({
      button: { disabled: false, spinning: false, unmountBody: false },
      onRefresh: () => { clicks += 1; },
      slot: "header",
    }) as { type: string; props: { onClick: () => void } };
    assert.equal(vnode.type, "button");
    vnode.props.onClick();
    assert.equal(clicks, 1);
  });
});
