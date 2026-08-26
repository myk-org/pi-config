/**
 * Render App and assert header Refresh is mounted.
 * Run with: npx tsx --test tests/node/pidiff/app-render.test.ts
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createLogger } from "../../../extensions/pidiff/pidiff-ui/src/lib/create-logger.ts";

const log = createLogger("pidiff-ui");
const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "pierre-mock-loader.mjs")).href);

(globalThis as { React?: typeof React }).React = React;
globalThis.navigator = { hardwareConcurrency: 2 } as Navigator;
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
      ? JSON.stringify({ sessionId: "s1", cwd: "/tmp/proj", branch: "main" })
      : null;
  },
  setItem() {},
  removeItem() {},
} as Storage;

describe("App Refresh render", () => {
  it("App header mounts a Refresh control", async () => {
    log.debug("import App");
    const { App } = await import("../../../extensions/pidiff/pidiff-ui/src/App.tsx");
    const html = renderToString(createElement(App));
    log.debug("App html length", html.length);
    assert.match(html, /data-pidiff-refresh="true"/);
    assert.match(html, /data-pidiff-refresh-slot="header"/);
  });

  it("App header Refresh is disabled while disconnected", async () => {
    const { App } = await import("../../../extensions/pidiff/pidiff-ui/src/App.tsx");
    const html = renderToString(createElement(App));
    assert.match(html, /data-pidiff-refresh-slot="header"/);
    assert.match(html, /disabled/);
  });

  it("App stale banner mounts a Refresh control", async () => {
    (globalThis as { __pidiffTestStale?: boolean }).__pidiffTestStale = true;
    log.debug("render App stale banner");
    const { App } = await import("../../../extensions/pidiff/pidiff-ui/src/App.tsx");
    const html = renderToString(createElement(App));
    assert.match(html, /data-pidiff-refresh-slot="banner"/);
  });
});
