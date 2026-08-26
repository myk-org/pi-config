/**
 * useWebSocket.send drop and deliver paths.
 * Run with: npx tsx --test tests/node/pidiff/use-websocket.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToString } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { createLogger } from "../../../extensions/pidiff/pidiff-ui/src/lib/create-logger.ts";
import { useWebSocket } from "../../../extensions/pidiff/pidiff-ui/src/hooks/useWebSocket.ts";
import { installReactDomShim } from "./react-dom-shim.mjs";

const log = createLogger("pidiff-ui");
(globalThis as { __PIDIFF_DEBUG?: boolean }).__PIDIFF_DEBUG = true;

(globalThis as { WebSocket?: typeof WebSocket }).WebSocket = class {
  static OPEN = 1;
} as unknown as typeof WebSocket;

function DropProbe({ onResult }: { onResult: (ok: boolean) => void }) {
  log.debug("DropProbe");
  const { send } = useWebSocket({ testWs: null });
  onResult(send({ type: "request-diffs" }));
  return null;
}

function OpenProbe({
  ws,
  onResult,
}: {
  ws: WebSocket;
  onResult: (ok: boolean) => void;
}) {
  log.debug("OpenProbe");
  const { send } = useWebSocket({ testWs: ws });
  onResult(send({ type: "request-diffs", mode: "branch" }));
  return null;
}

describe("useWebSocket send", () => {
  it("returns false when the socket is unavailable", () => {
    let ok = true;
    renderToString(createElement(DropProbe, { onResult: (v) => { ok = v; } }));
    assert.equal(ok, false);
  });

  it("returns true when the socket is open", () => {
    const sent: string[] = [];
    const ws = {
      readyState: 1,
      send: (payload: string) => { sent.push(payload); },
      close() {},
    } as unknown as WebSocket;
    let ok = false;
    renderToString(createElement(OpenProbe, { ws, onResult: (v) => { ok = v; } }));
    assert.equal(ok, true);
    assert.deepEqual(sent, [JSON.stringify({ type: "request-diffs", mode: "branch" })]);
  });
});

describe("useWebSocket cleanup", () => {
  it("unmount close does not open another socket", async () => {
    log.debug("useWebSocket unmount cleanup");
    const sockets: Array<{ close: () => void; onclose?: () => void }> = [];
    (globalThis as { WebSocket?: unknown }).WebSocket = class {
      static OPEN = 1;
      readyState = 0;
      onclose?: () => void;
      constructor() {
        log.debug("FakeWs construct");
        sockets.push(this);
      }
      close() {
        log.debug("FakeWs close");
        this.readyState = 3;
        this.onclose?.();
      }
    } as unknown as typeof WebSocket;
    const container = installReactDomShim();
    function Probe() {
      log.debug("CleanupProbe");
      useWebSocket({ reconnectMs: 20 });
      return null;
    }
    const root = createRoot(container);
    await act(async () => {
      log.debug("act mount Probe");
      root.render(createElement(Probe));
    });
    assert.equal(sockets.length, 1);
    await act(async () => {
      log.debug("act unmount Probe");
      root.unmount();
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(sockets.length, 1);
  });
});
