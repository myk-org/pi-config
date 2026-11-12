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
  WORKLOAD_SOURCES_SYMBOL,
  clearWorkloadSources,
  publishedWorkloadSources,
  publishWorkloadSources,
} from "../../../extensions/shared/workload-bridge.ts";
import { collectWorkload } from "../../../extensions/coms/coms-workload.ts";

const agent = (id: string) => ({ id, agent: "worker", task: "t", status: "running", startedAt: 1 });
const cron = (id: string) => ({ id, scope: "session", description: "d", task: "t", createdAt: 1 });

const clear = (): void => {
  delete (globalThis as Record<symbol, unknown>)[WORKLOAD_SOURCES_SYMBOL];
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
    clearWorkloadSources();
    assert.equal(publishedWorkloadSources(), null);
  });

  it("rejects a malformed publication instead of trusting it", () => {
    (globalThis as Record<symbol, unknown>)[WORKLOAD_SOURCES_SYMBOL] = { agents: "nope" };
    assert.equal(publishedWorkloadSources(), null);
  });
});
