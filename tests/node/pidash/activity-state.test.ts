/** Pidash activity state protocol: Pi 0.84.4 prompt lifecycle events. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyActivityEvent,
  initialActivityState,
  shouldAcceptActivityEvent,
} from "../../../extensions/pidash/activity-state.ts";
import { sessionActivityDisplay } from "../../../extensions/pidash/pidash-ui/src/lib/activity-display.ts";

describe("pidash activity state", () => {
  it("enters prompt wait during active work", () => {
    let state = applyActivityEvent(initialActivityState(), { type: "agent_start", sequence: 1 });
    state = applyActivityEvent(state, { type: "ui_prompt_start", sequence: 2 });
    assert.equal(state.activity, "waiting_for_input");
    assert.equal(state.streaming, true);
  });

  it("restores active work after a prompt closes", () => {
    let state = applyActivityEvent(initialActivityState(), { type: "agent_start", sequence: 1 });
    state = applyActivityEvent(state, { type: "ui_prompt_start", sequence: 2 });
    state = applyActivityEvent(state, { type: "ui_prompt_end", sequence: 3 });
    assert.equal(state.activity, "working");
    assert.equal(state.streaming, true);
  });

  it("restores idle after a command prompt closes", () => {
    let state = applyActivityEvent(initialActivityState(), { type: "ui_prompt_start", sequence: 1 });
    state = applyActivityEvent(state, { type: "ui_prompt_end", sequence: 2 });
    assert.equal(state.activity, "idle");
    assert.equal(state.streaming, false);
  });

  it("becomes idle only when the agent ends", () => {
    let state = applyActivityEvent(initialActivityState(), { type: "agent_start", sequence: 1 });
    state = applyActivityEvent(state, { type: "agent_settled", sequence: 2 });
    assert.equal(state.activity, "working");
    assert.equal(state.streaming, false);
    state = applyActivityEvent(state, { type: "agent_end", sequence: 3 });
    assert.equal(state.activity, "idle");
  });

  it("rejects replayed activity events after a reconnect", () => {
    const current = { ...initialActivityState(), activity: "waiting_for_input" as const, sequence: 8 };
    assert.equal(shouldAcceptActivityEvent(current, { type: "agent_end", sequence: 7 }), false);
    assert.equal(shouldAcceptActivityEvent(current, { type: "agent_end", sequence: 9 }), true);
  });

  it("starts a replacement session idle so prior prompt wait cannot leak", () => {
    const previous = applyActivityEvent(initialActivityState(), { type: "ui_prompt_start", sequence: 1 });
    assert.equal(previous.activity, "waiting_for_input");
    const replacement = initialActivityState();
    assert.equal(replacement.activity, "idle");
    assert.equal(replacement.streaming, false);
  });
});

describe("pidash activity display", () => {
  it("labels prompt wait without an active-work animation or wording", () => {
    const wait = sessionActivityDisplay({ active: true, activity: "waiting_for_input" });
    assert.equal(wait.label, "waiting for input");
    assert.equal(wait.isWorking, false);
    assert.doesNotMatch(wait.indicatorClassName, /animate-pulse|animate-ping/);
  });

  it("labels active work", () => {
    assert.equal(sessionActivityDisplay({ active: true, activity: "working" }).label, "working");
  });

  it("labels active idle", () => {
    assert.equal(sessionActivityDisplay({ active: true, activity: "idle" }).label, "idle");
  });

  it("warns once for a repeated unknown activity", () => {
    type Bag = { __pidashUiLogs?: Array<{ level: string; msg: string }> };
    const bag = globalThis as Bag;
    bag.__pidashUiLogs = [];

    sessionActivityDisplay({ active: true, activity: "unknown" as any });
    sessionActivityDisplay({ active: true, activity: "unknown" as any });

    assert.deepEqual(bag.__pidashUiLogs, [{
      name: "pidash-ui",
      level: "warn",
      msg: "unknown session activity display: activity=unknown",
    }]);
  });
});
