/**
 * The session hub is what makes `supportsImages` reach a chat client (Qodo
 * b5276464). If it drops or fails to clear the flag, the Discord image guard
 * silently goes inert or keeps the previous model's capability.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPidashSessionState, modelInfoPayload, supportsImagesFor, updatePidashSession } from "../../../scripts/pidash-session-state.ts";

const noopWs = { send: () => {}, readyState: 1 };

function makeHub() {
  return createPidashSessionState(() => {}) as any;
}

describe("session hub image modality", () => {
  it("carries supportsImages from registration", () => {
    const hub = makeHub();
    hub.register(noopWs, { sessionId: "s1", pid: 1, cwd: "/tmp/p", model: "glm", supportsImages: false });
    assert.equal(hub.sessions.get("s1")?.session.supportsImages, false);
  });

  it("leaves the capability undefined when the model did not report it", () => {
    const hub = makeHub();
    hub.register(noopWs, { sessionId: "s1", pid: 1, cwd: "/tmp/p", model: "glm" });
    assert.equal(hub.sessions.get("s1")?.session.supportsImages, undefined);
  });

  it("clears the flag when the model changes to text-only", () => {
    // The hub owns the capability only; `session.model` is updated by the daemon
    // (pidash-server's update_info handler), so it is not asserted here.
    const session: any = { sessionId: "s1", model: "deepseek", supportsImages: true };
    updatePidashSession(session, { type: "update_info", supportsImages: false });
    assert.equal(session.supportsImages, false, "a text-only model must not inherit true");
  });

  it("ignores a non-boolean value instead of trusting it", () => {
    const session: any = { sessionId: "s1", supportsImages: true };
    updatePidashSession(session, { type: "update_info", supportsImages: "yes" });
    assert.equal(session.supportsImages, true);
  });
});

describe("image modality producer (Qodo 24f50129)", () => {
  it("derives the capability from the model's input list", () => {
    assert.equal(supportsImagesFor({ input: ["text", "image"] }), true);
    assert.equal(supportsImagesFor({ input: ["text"] }), false);
    assert.equal(supportsImagesFor({}), false, "no input list means no image support");
    assert.equal(supportsImagesFor(null), false);
    assert.equal(supportsImagesFor(undefined), false);
  });
});

describe("model payload producer on session switch (Qodo 24f50129)", () => {
  it("builds every model field a switch must carry", () => {
    const payload = modelInfoPayload({ name: "GLM 5.3", input: ["text"], reasoning: true, contextWindow: 262144 });
    assert.deepEqual(payload, { model: "GLM 5.3", supportsImages: false, reasoning: true, contextWindow: 262144 });
  });

  it("falls back to the model id and reports no image support without a list", () => {
    const payload = modelInfoPayload({ id: "plain-model" });
    assert.deepEqual(payload, { model: "plain-model", supportsImages: false, reasoning: false, contextWindow: 0 });
  });

  it("handles a switch with no model at all", () => {
    assert.deepEqual(modelInfoPayload(null), { model: "", supportsImages: false, reasoning: false, contextWindow: 0 });
  });
});
