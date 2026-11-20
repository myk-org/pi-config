/**
 * Verify O(N) single-pass replay_end folding, patchMessageById tail fast-path,
 * and rAF coalescing + flush-on-end for live streaming deltas (#1164).
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { createRoot, type Root } from "../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js";
import { patchMessageById, useMessageHandler } from "../../../extensions/pidash/pidash-ui/src/hooks/useMessageHandler.ts";
import type { ChatMessage } from "../../../extensions/pidash/pidash-ui/src/types.ts";
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

describe("patchMessageById", () => {
  it("updates tail or middle message without cloning unchanged items and returns same ref on miss", () => {
    const m1: ChatMessage = { id: "1", role: "user", text: "hi" };
    const m2: ChatMessage = { id: "2", role: "assistant", text: "he" };
    const arr = [m1, m2];

    const updatedTail = patchMessageById(arr, "2", (m) => ({ ...m, text: "hello" }));
    assert.notEqual(updatedTail, arr);
    assert.equal(updatedTail[0], m1, "unrelated item keeps identity");
    assert.equal(updatedTail[1].text, "hello");

    const updatedFirst = patchMessageById(arr, "1", (m) => ({ ...m, text: "hey" }));
    assert.equal(updatedFirst[0].text, "hey");
    assert.equal(updatedFirst[1], m2);

    assert.equal(patchMessageById(arr, "missing", (m) => m), arr);
  });
});

describe("useMessageHandler O(N) replay and rAF delta coalescing", () => {
  it("folds a multi-hundred-event replay in a single O(N) pass", async () => {
    const { container } = installReactDomShim();
    let emit: (ev: any) => void = () => {};
    let latestMessages: ChatMessage[] = [];
    let renderCount = 0;

    function Probe() {
      renderCount++;
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
    const rendersBeforeReplay = renderCount;

    await act(async () => {
      emit({ type: "replay_start" });
      emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
      emit({ type: "message_start", message: { role: "assistant" } });
      for (let i = 0; i < 200; i++) {
        emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "t" } });
      }
      for (let i = 0; i < 200; i++) {
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a" } });
      }
      emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "tc-1", args: { command: "ls" } });
      emit({ type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
      emit({ type: "message_end", message: { role: "assistant", model: "test-m" } });
      emit({ type: "replay_end" });
    });

    assert.equal(latestMessages.length, 5);
    assert.equal(latestMessages[0].role, "user");
    assert.equal(latestMessages[1].role, "thinking");
    assert.equal(latestMessages[1].text.length, 200);
    assert.equal(latestMessages[2].role, "assistant");
    assert.equal(latestMessages[2].text.length, 200);
    assert.equal(latestMessages[2].className, undefined);
    assert.equal(latestMessages[3].className, "tool-call");
    assert.equal(latestMessages[4].className, "tool-result");
    assert.ok(renderCount - rendersBeforeReplay <= 2, `expected <=2 renders for 405-event replay, got ${renderCount - rendersBeforeReplay}`);
  });

  it("coalesces live streaming deltas and flushes pending text before message_end", async () => {
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

    await act(async () => {
      emit({ type: "message_start", message: { role: "assistant" } });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hel" } });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo " } });
    });
    await act(async () => {
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } });
      emit({ type: "message_end", message: { role: "assistant" } });
    });

    assert.equal(latestMessages.length, 1);
    assert.equal(latestMessages[0].text, "hello world");
    assert.equal(latestMessages[0].className, undefined);
  });
});
