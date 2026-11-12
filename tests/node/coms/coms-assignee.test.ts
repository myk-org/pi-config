/**
 * #1090 — the peer's `☰n` is agent work in flight, so the owner's tasks must not inflate it, while
 * the drilldown still lists them (tagged) so they are visible rather than hidden.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collectWorkload,
  toDescribeDetail,
  workloadSectionLines,
  type PeerWorkloadDetail,
  type WorkloadTask,
} from "../../../extensions/coms/coms-workload.js";
import { buildDrilldownRows } from "../../../extensions/coms/coms-drilldown.js";
import { formatTaskRowLine } from "../../../extensions/pitasks/tasks-view.js";

const peerTask = (over: Partial<WorkloadTask> = {}): WorkloadTask => ({
  id: "1",
  status: "pending",
  subject: "do the thing",
  blockedBy: [],
  ...over,
});

const detail = (over: Partial<PeerWorkloadDetail> = {}): PeerWorkloadDetail => ({
  agents: [],
  tasks: [],
  crons: [],
  ...over,
});

describe("the peer count excludes the owner's tasks (#1090)", () => {
  it("counts agent tasks only, while keeping the owner's rows in the payload", () => {
    const { counts, active } = collectWorkload(
      [],
      [peerTask({ id: "1" }), peerTask({ id: "2", assignee: "user" })],
      [],
    );
    assert.equal(counts.tasks, 1, "☰n is agent work in flight");
    assert.deepEqual(active.tasks.map((task) => task.id), ["1", "2"], "the owner's task is still reported");
  });

  it("reports zero when the only open task belongs to the owner", () => {
    const { counts } = collectWorkload([], [peerTask({ id: "2", assignee: "user" })], []);
    assert.equal(counts.tasks, 0);
  });

  it("carries the assignee through the describe projection", () => {
    const projected = toDescribeDetail({
      agents: [],
      tasks: [peerTask({ id: "2", assignee: "user" })],
      crons: [],
    });
    assert.equal(projected.tasks[0].assignee, "user");
  });
});

describe("the drilldown shows the owner's task, tagged (#1090)", () => {
  it("renders [you] in the workload section rows", () => {
    const lines = workloadSectionLines(
      detail({ tasks: [{ id: "2", status: "pending", subject: "run the Discord test", blockedBy: [], assignee: "user" }] }),
    );
    assert.deepEqual(lines, ["tasks (1)", `  ${formatTaskRowLine({ id: "2", status: "pending", subject: "run the Discord test", blockedBy: [], assignee: "user" })}`]);
    assert.match(lines[1], /\[you\] run the Discord test/);
  });

  it("renders [you] in the drilldown item rows too", () => {
    const rows = buildDrilldownRows({
      ok: true,
      detail: detail({ tasks: [{ id: "2", status: "pending", subject: "run the Discord test", blockedBy: [], assignee: "user" }] }),
      truncated: {},
    });
    const tasksSection = rows.find((row) => row.section === "tasks");
    assert.ok(tasksSection);
    assert.match(tasksSection.items[0].row, /\[you\] run the Discord test/);
  });

  it("treats a peer that sends no assignee as the agent's task", () => {
    const rows = buildDrilldownRows({
      ok: true,
      detail: detail({ tasks: [{ id: "3", status: "pending", subject: "agent step", blockedBy: [] }] }),
      truncated: {},
    });
    assert.match(rows.find((row) => row.section === "tasks")?.items[0].row ?? "", /\[llm\] agent step/);
  });
});
