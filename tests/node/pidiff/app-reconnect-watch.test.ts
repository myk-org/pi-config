/**
 * Mount AppReconnectWatch so React useEffect runs a disconnected→connected transition.
 * Run with: npx tsx --test tests/node/pidiff/app-reconnect-watch.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createLogger } from "../../../extensions/pidiff/pidiff-ui/src/lib/create-logger.ts";
import { AppReconnectWatch } from "../../../extensions/pidiff/pidiff-ui/src/lib/app-reconnect-watch.tsx";
import { installReactDomShim } from "./react-dom-shim.mjs";

(globalThis as { __PIDIFF_DEBUG?: boolean }).__PIDIFF_DEBUG = true;
const log = createLogger("pidiff-ui");
const container = installReactDomShim();

describe("AppReconnectWatch mount", () => {
  it("sends session then worktree watch after reconnect", async () => {
    log.debug("AppReconnectWatch mount reconnect");
    const sent: object[] = [];
    const send = (m: object) => {
      log.debug("watch send", m);
      sent.push(m);
    };
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(AppReconnectWatch, {
        connected: false,
        worktreePath: "/tmp/wt",
        sessionId: "sess",
        send,
      }));
    });
    await act(async () => {
      root.render(createElement(AppReconnectWatch, {
        connected: true,
        worktreePath: "/tmp/wt",
        sessionId: "sess",
        send,
      }));
    });
    await act(async () => { root.unmount(); });
    assert.deepEqual(sent, [
      { type: "watch", sessionId: "sess" },
      { type: "watch-worktree", worktreePath: "/tmp/wt" },
    ]);
  });
});
