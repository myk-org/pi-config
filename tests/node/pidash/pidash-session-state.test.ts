import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPidashSessionState } from "../../../scripts/pidash-session-state.ts";

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
