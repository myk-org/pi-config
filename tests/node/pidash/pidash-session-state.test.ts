import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyEventToViewState,
  clearPendingUiRequests,
  createPidashSessionState,
  dismissPendingUiRequest,
  forwardBrowserUiResponse,
  isInteractiveUiRequest,
  processPiPendingUiEvent,
  recordPendingUiRequest,
  sendSessionSnapshot,
  snapshotPendingUiRequests,
  updatePidashSession,
} from "../../../scripts/pidash-session-state.ts";

function registration(overrides: Record<string, unknown> = {}) {
  return {
    type: "register",
    pid: 42,
    sessionId: "42:/project",
    cwd: "/project",
    activity: "working",
    activitySequence: 3,
    streaming: true,
    ...overrides,
  };
}

describe("pidash session registration", () => {
  it("retains prompt state during a reconnect", () => {
    const updates: object[] = [];
    const state = createPidashSessionState(event => updates.push(event));
    const firstSocket = {};
    const replacementSocket = {};

    state.register(firstSocket, registration());
    state.register(replacementSocket, registration({
      activity: "waiting_for_input",
      activityBeforePrompt: "idle",
    }));

    const session = state.sessions.get("42:/project")?.session;
    assert.equal(session?.streaming, true);
    assert.equal(session?.activity, "waiting_for_input");
    assert.equal(session?.activityBeforePrompt, "idle");
    assert.equal(updates.length, 2);
  });

  it("ignores an old socket closing after its replacement connects", () => {
    const updates: any[] = [];
    const state = createPidashSessionState(event => updates.push(event));
    const oldSocket = {};
    const replacementSocket = {};
    const client = state.register(oldSocket, registration());
    state.register(replacementSocket, registration({
      activity: "waiting_for_input",
      activityBeforePrompt: "working",
    }));

    state.disconnect(client, oldSocket, "close");

    assert.equal(client.ws, replacementSocket);
    assert.equal(client.session.active, true);
    assert.equal(client.session.activity, "waiting_for_input");
    assert.equal(client.session.activityBeforePrompt, "working");
    assert.equal(updates.length, 2);
    assert.equal(updates.some(update => update.type === "session_updated"), false);
  });

  it("preserves explicit active-model reasoning capability", () => {
    const state = createPidashSessionState(() => {});
    const capable = state.register({}, registration({ sessionId: "capable", reasoning: true }));
    const incapable = state.register({}, registration({ sessionId: "incapable", reasoning: false }));
    const unknown = state.register({}, registration({ sessionId: "unknown" }));

    assert.equal(capable.session.reasoning, true);
    assert.equal(incapable.session.reasoning, false);
    assert.equal(unknown.session.reasoning, undefined);
    updatePidashSession(capable.session, { reasoning: false });
    assert.equal(capable.session.reasoning, false);
    updatePidashSession(incapable.session, { reasoning: true });
    assert.equal(incapable.session.reasoning, true);
  });

  it("preserves exact Trail savings and absent or zero semantics", () => {
    const state = createPidashSessionState(() => {});
    const absent = state.register({}, registration({ sessionId: "absent" }));
    const zero = state.register({}, registration({ sessionId: "zero", trailTokenSavings: 0 }));
    const exact = state.register({}, registration({ sessionId: "exact", trailTokenSavings: 1_098_359 }));
    const invalid = state.register({}, registration({ sessionId: "invalid", trailTokenSavings: -1 }));

    assert.equal(absent.session.trailTokenSavings, undefined);
    assert.equal(zero.session.trailTokenSavings, 0);
    assert.equal(exact.session.trailTokenSavings, 1_098_359);
    assert.equal(invalid.session.trailTokenSavings, undefined);
    updatePidashSession(exact.session, { trailTokenSavings: 2_000_001 });
    assert.equal(exact.session.trailTokenSavings, 2_000_001);
    updatePidashSession(exact.session, { trailTokenSavings: -1 });
    assert.equal(exact.session.trailTokenSavings, 2_000_001);
  });

  it("resets session-scoped model state on a session switch payload", () => {
    const state = createPidashSessionState(() => {});
    const client = state.register({}, registration({ reasoning: true, trailTokenSavings: 700 }));

    updatePidashSession(client.session, { reasoning: false, trailTokenSavings: 0 });

    assert.equal(client.session.reasoning, false);
    assert.equal(client.session.trailTokenSavings, 0);
  });

  it("broadcasts an inactive update after an error cleanup", () => {
    const updates: any[] = [];
    const state = createPidashSessionState(event => updates.push(event));
    const socket = {};
    const client = state.register(socket, registration());

    state.disconnect(client, socket, "error");
    state.disconnect(client, socket, "close");

    assert.equal(client.session.active, false);
    assert.equal(client.session.streaming, false);
    assert.deepEqual(updates.at(-1), { type: "session_updated", session: client.session });
  });
});

describe("pending UI requests (#1331)", () => {
  function liveClient(sessionId = "42:/project") {
    const state = createPidashSessionState(() => {});
    const socket = {};
    const client = state.register(socket, registration({ sessionId }));
    client.replaying = false;
    return { state, socket, client };
  }

  function uiRequest(id: string, method = "select", title = "Pick one") {
    const parsed = { type: "extension_ui_request", id, method, title, options: ["A", "B"] };
    return { parsed, raw: JSON.stringify(parsed) };
  }

  it("recognizes interactive select, confirm, input request payloads", () => {
    assert.equal(isInteractiveUiRequest({ type: "extension_ui_request", id: "q1", method: "select" }), true);
    assert.equal(isInteractiveUiRequest({ type: "extension_ui_request", id: "q2", method: "confirm" }), true);
    assert.equal(isInteractiveUiRequest({ type: "extension_ui_request", id: "q3", method: "input" }), true);
    assert.equal(isInteractiveUiRequest({ type: "extension_ui_request", id: "q4", method: "notify" }), false);
    assert.equal(isInteractiveUiRequest({ type: "extension_ui_request", id: "", method: "select" }), false);
    assert.equal(isInteractiveUiRequest({ type: "message_start", id: "q5", method: "select" }), false);
  });

  it("records live interactive extension_ui_request prompts", () => {
    const { client } = liveClient();
    const { parsed, raw } = uiRequest("ask-1", "select");

    assert.equal(recordPendingUiRequest(client, parsed, raw), true);
    assert.deepEqual(snapshotPendingUiRequests(client), [raw]);
  });

  it("ignores extension_ui_request prompts while replaying", () => {
    const { client } = liveClient();
    client.replaying = true;
    const { parsed, raw } = uiRequest("ask-replay", "confirm");

    assert.equal(recordPendingUiRequest(client, parsed, raw), false);
    assert.deepEqual(snapshotPendingUiRequests(client), []);
  });

  it("ignores non-interactive extension_ui_request methods", () => {
    const { client } = liveClient();
    const { parsed, raw } = uiRequest("ask-notify", "notify");

    assert.equal(recordPendingUiRequest(client, parsed, raw), false);
    assert.deepEqual(snapshotPendingUiRequests(client), []);
  });

  it("removes a pending prompt when dismissed by id", () => {
    const { client } = liveClient();
    const first = uiRequest("ask-1", "select");
    const second = uiRequest("ask-2", "input");
    recordPendingUiRequest(client, first.parsed, first.raw);
    recordPendingUiRequest(client, second.parsed, second.raw);

    assert.equal(dismissPendingUiRequest(client, "ask-1"), true);
    assert.equal(dismissPendingUiRequest(client, "ask-missing"), false);
    assert.deepEqual(snapshotPendingUiRequests(client), [second.raw]);
  });

  it("clears all pending prompts on explicit clear", () => {
    const { client } = liveClient();
    const req = uiRequest("ask-1", "confirm");
    recordPendingUiRequest(client, req.parsed, req.raw);

    assert.equal(clearPendingUiRequests(client), 1);
    assert.deepEqual(snapshotPendingUiRequests(client), []);
  });

  it("clears pending prompts when the active socket disconnects", () => {
    const { state, socket, client } = liveClient();
    const req = uiRequest("ask-1", "select");
    recordPendingUiRequest(client, req.parsed, req.raw);

    state.disconnect(client, socket, "close");

    assert.deepEqual(snapshotPendingUiRequests(client), []);
  });

  it("keeps pending prompts when a stale socket disconnects", () => {
    const state = createPidashSessionState(() => {});
    const oldSocket = {};
    const newSocket = {};
    const client = state.register(oldSocket, registration());
    state.register(newSocket, registration());
    client.replaying = false;
    const req = uiRequest("ask-live", "input");
    recordPendingUiRequest(client, req.parsed, req.raw);

    state.disconnect(client, oldSocket, "error");

    assert.deepEqual(snapshotPendingUiRequests(client), [req.raw]);
  });

  it("preserves insertion order in snapshots", () => {
    const { client } = liveClient();
    const r1 = uiRequest("ask-1", "select");
    const r2 = uiRequest("ask-2", "confirm");
    const r3 = uiRequest("ask-3", "input");
    recordPendingUiRequest(client, r1.parsed, r1.raw);
    recordPendingUiRequest(client, r2.parsed, r2.raw);
    recordPendingUiRequest(client, r3.parsed, r3.raw);

    assert.deepEqual(snapshotPendingUiRequests(client), [r1.raw, r2.raw, r3.raw]);
  });

  it("evicts the oldest pending prompt when capacity is exceeded", () => {
    const { client } = liveClient();
    const r1 = uiRequest("ask-1", "select");
    const r2 = uiRequest("ask-2", "confirm");
    const r3 = uiRequest("ask-3", "input");
    recordPendingUiRequest(client, r1.parsed, r1.raw, 2);
    recordPendingUiRequest(client, r2.parsed, r2.raw, 2);
    recordPendingUiRequest(client, r3.parsed, r3.raw, 2);

    assert.deepEqual(snapshotPendingUiRequests(client), [r2.raw, r3.raw]);
  });
});

describe("pidash server pending UI wiring (#1331)", () => {
  function liveClient(sessionId = "42:/project") {
    const state = createPidashSessionState(() => {});
    const sentToPi: string[] = [];
    const socket = { send: (msg: string) => sentToPi.push(msg) };
    const client = state.register(socket, registration({ sessionId }));
    client.replaying = false;
    return { client, sentToPi };
  }

  function uiRequest(id: string, method = "select", title = "Pick one") {
    const parsed = { type: "extension_ui_request", id, method, title, options: ["A", "B"] };
    return { parsed, raw: JSON.stringify(parsed) };
  }

  it("sends a single session_snapshot frame containing messages and pending UI requests to a watcher", () => {
    const { client } = liveClient();
    applyEventToViewState(client, { type: "message_start", message: { role: "user", content: "hi" } });
    const req = uiRequest("ask-replay", "select");
    recordPendingUiRequest(client, req.parsed, req.raw);

    const frames: string[] = [];
    const result = sendSessionSnapshot({ send: (msg) => frames.push(msg) }, client);

    assert.deepEqual(result, { messageCount: 1, pendingCount: 1 });
    assert.equal(frames.length, 1);
    const snapshot = JSON.parse(frames[0]);
    assert.equal(snapshot.type, "session_snapshot");
    assert.equal(snapshot.sessionId, client.session.sessionId);
    assert.equal(snapshot.messages.length, 1);
    assert.equal(snapshot.messages[0].role, "user");
    assert.equal(snapshot.messages[0].text, "hi");
    assert.deepEqual(snapshot.pendingUiRequests, [req.parsed]);
  });

  it("reports zero pending requests when snapshotting a client with no open prompts", () => {
    const { client } = liveClient();
    const frames: string[] = [];
    const result = sendSessionSnapshot({ send: (msg) => frames.push(msg) }, client);

    assert.deepEqual(result, { messageCount: 0, pendingCount: 0 });
    assert.equal(frames.length, 1);
    const snapshot = JSON.parse(frames[0]);
    assert.equal(snapshot.type, "session_snapshot");
    assert.deepEqual(snapshot.messages, []);
    assert.deepEqual(snapshot.pendingUiRequests, []);
  });

  it("records a live interactive extension_ui_request in pendingUiRequests and viewState", () => {
    const { client } = liveClient();
    const req = uiRequest("ask-live", "confirm");

    const action = processPiPendingUiEvent(client, req.parsed, req.raw, () => {});

    assert.equal(action, "recorded");
    assert.deepEqual(snapshotPendingUiRequests(client), [req.raw]);
    assert.equal(client.viewState.messages.length, 1);
    assert.equal(client.viewState.messages[0].className, "ask|ask-live|confirm|Yes|||No");
  });

  it("fans out a live extension_ui_request to session watchers", () => {
    const { client } = liveClient("s-fanout");
    const req = uiRequest("ask-fanout", "input");
    const watched: Array<[string, object | string]> = [];

    processPiPendingUiEvent(client, req.parsed, req.raw, (sid, ev) => watched.push([sid, ev]));

    assert.deepEqual(watched, [["s-fanout", req.raw]]);
  });

  it("dismisses a recorded prompt when ui-dismiss arrives from pi", () => {
    const { client } = liveClient();
    const req = uiRequest("ask-dismiss", "select");
    processPiPendingUiEvent(client, req.parsed, req.raw, () => {});

    const dismiss = { type: "ui-dismiss", id: "ask-dismiss" };
    const dismissRaw = JSON.stringify(dismiss);
    const action = processPiPendingUiEvent(client, dismiss, dismissRaw, () => {});

    assert.equal(action, "dismissed");
    assert.deepEqual(snapshotPendingUiRequests(client), []);
    assert.equal(client.viewState.messages[0].className, "ask-answered|ask-dismiss");
  });

  it("forwards ui-dismiss events and marks matching viewState prompts answered", () => {
    const { client } = liveClient("s-buf");
    const req = uiRequest("ask-buf", "select");
    processPiPendingUiEvent(client, req.parsed, req.raw, () => {});

    const dismiss = { type: "ui-dismiss", id: "ask-buf" };
    const dismissRaw = JSON.stringify(dismiss);
    const watched: Array<[string, object | string]> = [];

    processPiPendingUiEvent(client, dismiss, dismissRaw, (sid, ev) => watched.push([sid, ev]));

    assert.equal(client.viewState.messages[0].className, "ask-answered|ask-buf");
    assert.deepEqual(watched, [["s-buf", dismissRaw]]);
  });

  it("ignores interactive prompts received while client is replaying", () => {
    const { client } = liveClient();
    client.replaying = true;
    const req = uiRequest("ask-during-replay", "select");

    const action = processPiPendingUiEvent(client, req.parsed, req.raw, () => {});

    assert.equal(action, null);
    assert.deepEqual(snapshotPendingUiRequests(client), []);
    assert.deepEqual(client.viewState.messages, []);
  });

  it("forwards extension_ui_response to the pi socket", () => {
    const { client, sentToPi } = liveClient();
    const response = forwardBrowserUiResponse(client, {
      type: "extension_ui_response",
      sessionId: client.session.sessionId,
      id: "ask-resp",
      value: "Option A",
    });

    assert.deepEqual(response, { type: "extension_ui_response", id: "ask-resp", value: "Option A" });
    assert.deepEqual(sentToPi, [JSON.stringify(response)]);
  });

  it("preserves pending prompts after forwarding extension_ui_response until ui-dismiss arrives", () => {
    const { client, sentToPi } = liveClient();
    const req = uiRequest("ask-reject", "select");
    processPiPendingUiEvent(client, req.parsed, req.raw, () => {});

    // Simulate a browser response that Pi rejects or has not yet accepted
    forwardBrowserUiResponse(client, {
      type: "extension_ui_response",
      sessionId: client.session.sessionId,
      id: "ask-reject",
      value: "Invalid",
    });

    assert.equal(sentToPi.length, 1);
    assert.deepEqual(snapshotPendingUiRequests(client), [req.raw]);

    // Only Pi's authoritative ui-dismiss clears the pending prompt
    const dismiss = { type: "ui-dismiss", id: "ask-reject" };
    processPiPendingUiEvent(client, dismiss, JSON.stringify(dismiss), () => {});
    assert.deepEqual(snapshotPendingUiRequests(client), []);
  });

  it("skips forwarding extension_ui_response when pi socket is missing", () => {
    const { client } = liveClient();
    client.ws = null;

    const response = forwardBrowserUiResponse(client, {
      type: "extension_ui_response",
      sessionId: client.session.sessionId,
      id: "ask-offline",
      confirmed: true,
    });

    assert.equal(response, null);
  });
});
