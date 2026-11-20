/**
 * Verify pidash-ui useWebSocket shares cleanup/reconnect cancellation on unmount (#1176).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useWebSocket } from "../../../extensions/pidash/pidash-ui/src/hooks/useWebSocket.ts";
import { installReactDomShim } from "./react-dom-shim.mjs";

describe("pidash-ui useWebSocket cleanup", () => {
  it("cancels scheduled reconnect timer on unmount", async () => {
    const { container } = installReactDomShim();
    const prevWs = globalThis.WebSocket;
    const prevLocation = (globalThis.window as any).location;
    const sockets: Array<{ close: () => void; onclose?: () => void }> = [];

    Object.defineProperty(globalThis.window, "location", {
      configurable: true,
      value: { protocol: "http:", host: "localhost:19190" },
    });
    (globalThis as { WebSocket?: unknown }).WebSocket = class {
      static OPEN = 1;
      readyState = 0;
      onclose?: () => void;
      constructor() { sockets.push(this); }
      close() { this.readyState = 3; this.onclose?.(); }
    } as unknown as typeof WebSocket;

    function Probe() {
      useWebSocket("/ws/browser", { reconnectMs: 20 });
      return null;
    }

    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(Probe)); });
      assert.equal(sockets.length, 1);
      await act(async () => { root.unmount(); });
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(sockets.length, 1, "unmounted hook must not open a reconnect socket");
    } finally {
      globalThis.WebSocket = prevWs;
      Object.defineProperty(globalThis.window, "location", {
        configurable: true,
        value: prevLocation,
      });
    }
  });
});
