/**
 * The Stop button is the only abort path, so its visibility must follow the
 * daemon, not a client-side event that a reload never sees.
 *
 * `useMessageHandler` adopts `session_updated.streaming` (Qodo 6284bef1). Before
 * that, a page reloaded mid-turn — or one watching a session made busy by the
 * TUI — showed Send instead of Stop and could not interrupt the run at all.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { createRoot, type Root } from "../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js";
import { useMessageHandler } from "../../../extensions/pidash/pidash-ui/src/hooks/useMessageHandler.ts";
import type { SessionInfo } from "../../../extensions/shared/types.ts";
import { installReactDomShim } from "./react-dom-shim.mjs";

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

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "watched", pid: 1, cwd: "/tmp/project", branch: "main", model: "m",
    startedAt: "now", lastActivity: 0, active: true, ...overrides,
  };
}

describe("streaming state follows the daemon (Qodo 6284bef1)", () => {
  it("session_updated streaming:true makes the composer offer Stop", async () => {
    const { container } = installReactDomShim();
    let emit: (ev: any) => void = () => {};
    let streaming = false;
    const watched = session();

    function Probe() {
      const state = useMessageHandler(
        (handler) => { emit = handler as any; return () => {}; },
        watched,
        notifications,
        () => {},
      );
      streaming = state.streaming;
      return null;
    }

    const root = createRoot(container);
    mounted.push(root);
    await act(async () => root.render(createElement(Probe)));
    assert.equal(streaming, false, "starts idle");

    await act(async () => emit({ type: "session_updated", session: { sessionId: "watched", streaming: true } }));
    assert.equal(streaming, true, "daemon says the turn is running");

    await act(async () => emit({ type: "session_updated", session: { sessionId: "watched", streaming: false } }));
    assert.equal(streaming, false, "daemon says the turn settled");
  });

  it("updates for another session do not flip this one", async () => {
    const { container } = installReactDomShim();
    let emit: (ev: any) => void = () => {};
    let streaming = false;

    // The hook reports on the session it was given; a foreign session's
    // streaming flag must not make this composer show Stop.
    function Probe() {
      const state = useMessageHandler(
        (handler) => { emit = handler as any; return () => {}; },
        session(),
        notifications,
        () => {},
      );
      streaming = state.streaming;
      return null;
    }

    const root = createRoot(container);
    mounted.push(root);
    await act(async () => root.render(createElement(Probe)));
    await act(async () => emit({ type: "session_updated", session: { sessionId: "someone-else", streaming: true } }));
    assert.equal(streaming, false);
  });
});
