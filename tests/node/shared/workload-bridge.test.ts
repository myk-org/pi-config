/**
 * The coms workload-source bridge (#1083).
 *
 * A peer reports its OWN workload: the orchestrator owns async agents and crons — session crons
 * exist only in that process's memory — so coms reads them through this bridge instead of
 * scanning files. Publishing, overwriting and clearing must all behave, because a stale or
 * absent bridge decides between a real count and `unknown`.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BRIDGE_SESSION_KEY,
  SESSION_BRIDGE_SYMBOL,
  publishedWorkloadSources,
  publishWorkloadSources,
  resetSessionBridge,
  resolveBridgeSessionKey,
} from "../../../extensions/shared/session-bridge.ts";
import { collectWorkload, toDescribeDetail } from "../../../extensions/coms/coms-workload.ts";

const agent = (id: string) => ({ id, agent: "worker", task: "t", status: "running", startedAt: 1 });
const cron = (id: string) => ({ id, scope: "session", description: "d", task: "t", createdAt: 1 });

const clear = (): void => {
  resetSessionBridge({ all: true });
};

describe("workload sources bridge", () => {
  beforeEach(clear);

  it("returns null before the orchestrator publishes", () => {
    assert.equal(publishedWorkloadSources(), null);
  });

  it("publishes getters that read live state", () => {
    let agents = [agent("a1")];
    publishWorkloadSources({ agents: () => agents, crons: () => [cron("session:c1")] });
    const sources = publishedWorkloadSources();
    assert.equal(sources?.agents().length, 1);
    assert.equal(sources?.crons()[0].id, "session:c1");

    agents = [agent("a1"), agent("a2")];
    assert.equal(publishedWorkloadSources()?.agents().length, 2, "the getter must follow the live list");
  });

  it("a later publish replaces the previous sources", () => {
    publishWorkloadSources({ agents: () => [agent("a1")], crons: () => [] });
    publishWorkloadSources({ agents: () => [], crons: () => [cron("session:c2")] });
    const sources = publishedWorkloadSources();
    assert.deepEqual(sources?.agents(), []);
    assert.equal(sources?.crons()[0].id, "session:c2");
  });

  it("a session switch republishes the sources", () => {
    // Session 1: one agent, no crons. What the orchestrator publishes at registration.
    publishWorkloadSources({ agents: () => [agent("a1")], crons: () => [] });
    const first = publishedWorkloadSources()!;
    assert.deepEqual(collectWorkload(first.agents(), [], first.crons()).counts.agents, 1);

    // Session switch: the orchestrator's session_start handler publishes again.
    publishWorkloadSources({ agents: () => [], crons: () => [cron("session:c2")] });
    assert.equal(publishedWorkloadSources()!.crons()[0].id, "session:c2");
  });

  it("the next collect after a switch sees the new session", () => {
    publishWorkloadSources({ agents: () => [agent("a1")], crons: () => [] });
    publishWorkloadSources({ agents: () => [], crons: () => [cron("session:c2")] });
    // Reading through the live getters must see session 2, not a captured map from session 1.
    const sources = publishedWorkloadSources()!;
    assert.deepEqual(collectWorkload(sources.agents(), [], sources.crons()).counts, { agents: 0, tasks: 0, crons: 1 });
  });

  it("clears on shutdown, so a torn-down runtime cannot answer a describe", () => {
    publishWorkloadSources({ agents: () => [agent("a1")], crons: () => [] });
    assert.notEqual(publishedWorkloadSources(), null);
    resetSessionBridge({ slot: "workload" });
    assert.equal(publishedWorkloadSources(), null);
  });

  it("rejects a malformed publication instead of trusting it", () => {
    (globalThis as Record<symbol, unknown>)[SESSION_BRIDGE_SYMBOL] = { agents: "nope" };
    assert.equal(publishedWorkloadSources(), null);

    (globalThis as Record<symbol, unknown>)[SESSION_BRIDGE_SYMBOL] = new Map([
      [DEFAULT_BRIDGE_SESSION_KEY, { workload: { agents: "nope" } }],
    ]);
    assert.equal(publishedWorkloadSources(), null);
  });

  it("preserves optional taskId on published workload agents without exposing it on wire detail", () => {
    publishWorkloadSources({
      agents: () => [{ ...agent("a1"), taskId: "590" }],
      crons: () => [],
    });
    const sources = publishedWorkloadSources()!;
    assert.equal(sources.agents()[0].taskId, "590");
    const { active } = collectWorkload(sources.agents(), [], sources.crons());
    const wire = toDescribeDetail(active, 10_000);
    assert.equal("taskId" in wire.agents[0], false);
  });

  it("isolates workload sources between concurrent sessions", () => {
    const first = { agents: () => [agent("a1")], crons: () => [] };
    const second = { agents: () => [agent("b1")], crons: () => [cron("session:b")] };
    publishWorkloadSources(first, "sess-1");
    publishWorkloadSources(second, "sess-2");

    assert.equal(publishedWorkloadSources("sess-1")?.agents()[0].id, "a1");
    assert.equal(publishedWorkloadSources("sess-2")?.agents()[0].id, "b1");
  });

  it("never substitutes a sole default or named entry for a mismatched session key", () => {
    publishWorkloadSources({ agents: () => [agent("def")], crons: () => [] });
    assert.equal(publishedWorkloadSources("sess-explicit"), null);

    resetSessionBridge({ slot: "workload" });
    publishWorkloadSources({ agents: () => [agent("named")], crons: () => [] }, "sess-only");
    assert.equal(publishedWorkloadSources(), null);
    assert.equal(publishedWorkloadSources("sess-other"), null);
  });

  it("ignores a stale unregister handle after a session republishes", () => {
    const first = { agents: () => [agent("a1")], crons: () => [] };
    const replaced = { agents: () => [agent("a2")], crons: () => [] };
    const unregFirst = publishWorkloadSources(first, "sess-1");
    publishWorkloadSources(replaced, "sess-1");
    unregFirst();
    assert.equal(publishedWorkloadSources("sess-1")?.agents()[0].id, "a2");
  });

  it("preserves sibling sessions when clearing one session", () => {
    publishWorkloadSources({ agents: () => [agent("a1")], crons: () => [] }, "sess-1");
    publishWorkloadSources({ agents: () => [agent("b1")], crons: () => [] }, "sess-2");
    resetSessionBridge({ sessionKey: "sess-1", slot: "workload" });
    assert.equal(publishedWorkloadSources("sess-1"), null);
    assert.equal(publishedWorkloadSources("sess-2")?.agents()[0].id, "b1");
  });

  it("resolves trimmed session IDs from ExtensionContext via resolveBridgeSessionKey", () => {
    assert.equal(
      resolveBridgeSessionKey({ sessionManager: { getSessionId: () => "  sess-42  " } }),
      "sess-42",
    );
  });

  it("falls back to DEFAULT_BRIDGE_SESSION_KEY when ExtensionContext lacks a usable session ID", () => {
    assert.equal(resolveBridgeSessionKey(undefined), DEFAULT_BRIDGE_SESSION_KEY);
    assert.equal(resolveBridgeSessionKey({}), DEFAULT_BRIDGE_SESSION_KEY);
    assert.equal(resolveBridgeSessionKey({ sessionManager: { getSessionId: () => "   " } }), DEFAULT_BRIDGE_SESSION_KEY);
    assert.equal(resolveBridgeSessionKey({ sessionManager: { getSessionId: () => 123 } }), DEFAULT_BRIDGE_SESSION_KEY);
    assert.equal(
      resolveBridgeSessionKey({
        sessionManager: {
          getSessionId: () => {
            throw new Error("boom");
          },
        },
      }),
      DEFAULT_BRIDGE_SESSION_KEY,
    );
  });
});
