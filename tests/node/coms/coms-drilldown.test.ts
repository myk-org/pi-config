/**
 * #1084 — the peer drilldown: sections as rows, their items, and the Esc chain.
 *
 * Pure only: the renderers are TUI components the owner drives. What is pinned here is the data a
 * level shows and where Esc goes, so a keystroke bug cannot change what the owner reads.
 *
 * Run with: npx tsx --test tests/node/coms/coms-drilldown.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { backTarget, buildDrilldownRows, buildPeerInfoRow } from "../../../extensions/coms/coms-drilldown.js";
import type { DescribeResult } from "../../../extensions/coms/coms-describe.js";
import { formatTaskRowLine } from "../../../extensions/pitasks/tasks-view.js";

function answered(partial: {
  agents?: Array<Record<string, string>>;
  tasks?: Array<Record<string, unknown>>;
  crons?: Array<Record<string, string>>;
  truncated?: { agents?: number; tasks?: number; crons?: number };
}): DescribeResult {
  return {
    ok: true,
    detail: {
      agents: (partial.agents ?? []).map((agent) => ({
        id: "", name: "", state: "", elapsed: "", purpose: "", ...agent,
      })),
      tasks: (partial.tasks ?? []).map((task) => ({
        blockedBy: [], ...task,
      })),
      crons: (partial.crons ?? []).map((cron) => ({
        id: "", schedule: "", next: "", description: "", ...cron,
      })),
    } as any,
    truncated: partial.truncated ?? {},
  };
}

describe("buildDrilldownRows (#1084): sections carry their counts", () => {
  it("lists one row per non-empty section, in agents → tasks → crons order", () => {
    const rows = buildDrilldownRows(answered({
      agents: [{ id: "a1", name: "echo", state: "running", elapsed: "3s", purpose: "fix the bug" }],
      tasks: [{ id: "1", status: "pending", subject: "one" }, { id: "2", status: "in_progress", subject: "two" }],
      crons: [{ id: "c1", schedule: "every 24h", next: "in 24h", description: "fixture" }],
    }));
    assert.deepEqual(rows.map((row) => row.label), ["async agents (1)", "tasks (2)", "crons (1)"]);
    assert.deepEqual(rows.map((row) => row.section), ["agents", "tasks", "crons"]);
    assert.deepEqual(rows.map((row) => row.items.length), [1, 2, 1]);
  });

  it("omits a section with no entries", () => {
    const rows = buildDrilldownRows(answered({
      tasks: [{ id: "7", status: "pending", subject: "only me" }],
    }));
    assert.deepEqual(rows.map((row) => row.label), ["tasks (1)"]);
  });

  it("says nothing is active instead of showing three empty sections", () => {
    const rows = buildDrilldownRows(answered({}));
    assert.equal(rows.length, 1);
    assert.match(rows[0].label, /none active/);
    assert.equal(rows[0].section, undefined);
    // Enter still lands somewhere readable rather than on an empty list.
    assert.equal(rows[0].items.length, 1);
  });
});

describe("buildDrilldownRows (#1084): a peer that did not report", () => {
  for (const [reason, pattern] of [
    ["not-reported", /not reported/],
    ["timeout", /no reply within 2s/],
    ["malformed", /malformed reply/],
    ["oversize", /reply too large/],
  ] as const) {
    it(`shows the reason for ${reason} as its own row`, () => {
      const rows = buildDrilldownRows({ ok: false, reason });
      assert.equal(rows.length, 1);
      assert.match(rows[0].label, pattern);
      assert.equal(rows[0].section, undefined);
      assert.match(rows[0].items[0].detail[0][1], pattern);
    });
  }

  it("carries the local error code, sanitized, for a peer error", () => {
    const rows = buildDrilldownRows({ ok: false, reason: "peer-error", code: "\u001b[2Jboom" });
    assert.match(rows[0].label, /error: \[2Jboom|error: boom/);
    assert.equal(/\u001b/.test(rows[0].label), false);
  });
});

describe("drilldown items reuse the existing formatters (#1084)", () => {
  it("task rows are formatTaskRowLine, not a second definition", () => {
    const rows = buildDrilldownRows(answered({
      tasks: [{ id: "3", status: "in_progress", subject: "ship it", blockedBy: ["9"] }],
    }));
    const item = rows[0].items[0];
    assert.equal(item.row, formatTaskRowLine({ id: "3", status: "in_progress", subject: "ship it", blockedBy: ["9"] }));
    assert.match(item.row, /#3/);
    // Detail: exactly the fields the peer reported, `—` where it sent nothing.
    assert.deepEqual(item.detail, [
      ["Subject", "ship it"],
      ["Status", "in_progress"],
      ["Owner", "—"],
      ["Blocked by", "#9"],
      ["Description", "—"],
    ]);
  });

  it("shows owner and description when the peer reports them", () => {
    const rows = buildDrilldownRows(answered({
      tasks: [{ id: "4", status: "pending", subject: "s", owner: "python-expert", description: "why it exists" }],
    }));
    const detail = rows[0].items[0].detail;
    assert.deepEqual(detail.find(([label]) => label === "Owner"), ["Owner", "python-expert"]);
    assert.deepEqual(detail.find(([label]) => label === "Description"), ["Description", "why it exists"]);
  });

  it("agent rows keep the async-status columns: identity, state, elapsed, purpose", () => {
    const rows = buildDrilldownRows(answered({
      agents: [{ id: "a1", name: "echo", state: "running", elapsed: "1m2s", purpose: "sleep 240" }],
    }));
    const item = rows[0].items[0];
    assert.equal(item.row, "echo (a1)  running  1m2s  sleep 240");
    assert.deepEqual(item.detail.map(([label]) => label), ["Agent", "State", "Elapsed", "Purpose"]);
  });

  it("cron rows keep schedule → next → description", () => {
    const rows = buildDrilldownRows(answered({
      crons: [{ id: "c1", schedule: "every 24h", next: "in 24h", description: "fixture: display only" }],
    }));
    const item = rows[0].items[0];
    assert.equal(item.row, "c1  every 24h  in 24h  fixture: display only");
    assert.deepEqual(item.detail, [
      ["Schedule", "every 24h"],
      ["Next run", "in 24h"],
      ["Description", "fixture: display only"],
    ]);
  });
});

describe("drilldown rows are sanitized at the render boundary (#1084)", () => {
  it("strips ANSI the peer put in its own fields", () => {
    const rows = buildDrilldownRows(answered({
      agents: [{ id: "a1", name: "echo", state: "\u001b[2Jrunning", elapsed: "1s", purpose: "hi\u0007there" }],
      tasks: [{ id: "5", status: "\u001b]0;title\u0007pending", subject: "sub\u001b[31mject" }],
      crons: [{ id: "c1", schedule: "every 1h", next: "soon", description: "\u001b[8mhidden" }],
    }));
    const text = JSON.stringify(rows);
    assert.equal(/\u001b|\u0007/.test(text), false);
    assert.match(rows[0].items[0].row, /running/);
    assert.match(rows[1].items[0].row, /pending/);
  });

  it("appends a truncated marker instead of hiding the cut", () => {
    const rows = buildDrilldownRows(answered({
      tasks: [{ id: "1", status: "pending", subject: "one" }],
      truncated: { tasks: 49 },
    }));
    assert.equal(rows[0].items.length, 2);
    assert.match(rows[0].items[1].row, /49 more/);
  });
});

describe("backTarget (#1084): Esc walks back one level", () => {
  it("section → peer sections → peer list → nothing", () => {
    const items = { level: "items", peer: "worker", section: "tasks" } as const;
    const sections = backTarget(items);
    assert.deepEqual(sections, { level: "sections", peer: "worker" });
    const peers = backTarget(sections!);
    assert.deepEqual(peers, { level: "peers" });
    assert.equal(backTarget(peers!), null);
  });
});

describe("buildPeerInfoRow (#1084 finding 2): the identity the drilldown lost", () => {
  const peer = {
    name: "worker",
    project: "repo",
    cwd: "/repo/.worktrees/x",
    purpose: "builds things",
    pid: 4242,
    endpoint: "/tmp/worker.sock",
    busy: true,
    queueDepth: 2,
    contextUsedPct: 18.6,
    origin: "slash",
    createdBy: null,
    workload: { agents: 2, tasks: 3, crons: 1 },
    heartbeatAgeSeconds: 4,
  };

  it("is a single item carrying every registry field", () => {
    const row = buildPeerInfoRow(peer);
    assert.equal(row.label, "peer info");
    assert.equal(row.items.length, 1);
    const pairs = new Map(row.items[0].detail);
    assert.equal(pairs.get("Name"), "worker");
    assert.equal(pairs.get("Project"), "repo");
    assert.equal(pairs.get("cwd"), "/repo/.worktrees/x");
    assert.equal(pairs.get("Purpose"), "builds things");
    assert.equal(pairs.get("Socket"), "/tmp/worker.sock");
    assert.equal(pairs.get("Heartbeat"), "4s ago");
    assert.equal(pairs.get("pid"), "4242");
    // The workload line is the same suffix the peer row shows.
    assert.equal(pairs.get("Workload"), "⏳2 ☰3 ⏰1");
    assert.match(String(pairs.get("State")), /busy · queue 2 · ctx 19%/);
    assert.match(String(pairs.get("Created by")), /user · via \/coms start/);
  });

  it("renders `—`/unknown instead of dropping an absent field", () => {
    const pairs = new Map(buildPeerInfoRow({ name: "n", project: "p", busy: false }).items[0].detail);
    assert.equal(pairs.get("cwd"), "—");
    assert.equal(pairs.get("Purpose"), "—");
    assert.equal(pairs.get("Socket"), "—");
    assert.equal(pairs.get("pid"), "—");
    assert.equal(pairs.get("Heartbeat"), "unknown");
    assert.equal(pairs.get("Workload"), "unknown");
    assert.equal(pairs.get("Created by"), "unknown (no record)");
  });

  it("sanitizes what the registry took from a peer", () => {
    const row = buildPeerInfoRow({
      name: "\u001b[2Jworker", project: "p", cwd: "/tmp/\u0007x", purpose: "hi\u001b]0;t\u0007", busy: false,
    });
    assert.equal(/[\u001b\u0007]/.test(JSON.stringify(row)), false);
  });
});

describe("row identity survives truncation and duplicates (#1084 finding 5)", () => {
  const long = "task-id-that-is-far-longer-than-forty-characters-";
  it("keeps two ids that differ only after the 40th char selectable", () => {
    const rows = buildDrilldownRows(answered({
      tasks: [
        { id: `${long}a`, status: "pending", subject: "first" },
        { id: `${long}b`, status: "pending", subject: "second" },
      ],
    }));
    const [first, second] = rows[0].items;
    assert.notEqual(first.id, second.id);
    assert.equal(first.detail[0][1], "first");
    assert.equal(second.detail[0][1], "second");
  });

  it("keeps a duplicated reported id independently selectable", () => {
    const rows = buildDrilldownRows(answered({
      crons: [
        { id: "dup", schedule: "every 1h", next: "in 1h", description: "one" },
        { id: "dup", schedule: "every 2h", next: "in 2h", description: "two" },
      ],
    }));
    const [first, second] = rows[0].items;
    assert.notEqual(first.id, second.id);
    assert.match(first.row, /every 1h/);
    assert.match(second.row, /every 2h/);
  });
});
