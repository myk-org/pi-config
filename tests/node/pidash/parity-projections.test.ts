/** #968 C/G pure projections — coms peers payload + settings editor parsing. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildComsPeersPayload, buildPidashComsPeersPayload } from "../../../extensions/coms/coms-shared.ts";
import { parseTypedSetting, displaySettingValue } from "../../../extensions/pidash/pidash-ui/src/lib/settings-edit.ts";

describe("buildComsPeersPayload", () => {
  it("projects live cards with defaults for missing live state", () => {
    const payload = buildComsPeersPayload(
      [
        { name: "alpha", purpose: "builds", model: "m1", color: "#fff", staleCount: 0 },
        { name: "beta", purpose: "", model: "m2", color: "#000", context_used_pct: 42, queue_depth: 2, busy: true, tasks_summary: "3/5", staleCount: 1 },
      ],
      { name: "me", purpose: "orchestrator", project: "pi-config" },
    );
    assert.equal(payload.self!.name, "me");
    assert.equal(payload.peers.length, 2);
    assert.deepEqual(payload.peers[0], { name: "alpha", purpose: "builds", model: "m1", busy: false, queueDepth: 0, contextUsedPct: 0, tasksSummary: null });
    assert.equal(payload.peers[1].busy, true);
    assert.equal(payload.peers[1].queueDepth, 2);
    assert.equal(payload.peers[1].contextUsedPct, 42);
    assert.equal(payload.peers[1].tasksSummary, "3/5");
  });

  it("null self yields null", () => {
    const payload = buildComsPeersPayload([], null);
    assert.equal(payload.self, null);
    assert.equal(payload.peers.length, 0);
  });
});

describe("buildPidashComsPeersPayload", () => {
  const sampleFixture = () => ({
    rows: [
      {
        project: "pi-config",
        name: "feature-manager",
        cwd: "/repo",
        purpose: "coord",
        model: "gemini-4-neon",
        endpoint: "/tmp/self.sock",
        busy: false,
        queueDepth: 0,
        contextUsedPct: 10,
      },
      {
        project: "pi-config",
        name: "peer-1481",
        cwd: "/repo/.worktrees/1481",
        purpose: "parity",
        model: "gemini-4-neon",
        endpoint: "/tmp/p1.sock",
        busy: true,
        queueDepth: 2,
        contextUsedPct: 45,
      },
      {
        project: "other-proj",
        name: "observer",
        cwd: "/other",
        purpose: "watch",
        model: "claude",
        endpoint: "/tmp/p2.sock",
        busy: false,
        queueDepth: 0,
        contextUsedPct: 5,
      },
    ],
    cards: [],
    supervisedKeys: new Set(["pi-config::peer-1481"]),
    self: { name: "feature-manager", project: "pi-config", endpoint: "/tmp/self.sock" },
    scope: "all" as const,
    ownProject: "pi-config",
  });

  it("marks only supervised peers as supervised", () => {
    const payload = buildPidashComsPeersPayload(sampleFixture());
    const other = payload.peers.find((p) => p.name === "observer");
    const sup = payload.peers.find((p) => p.name === "peer-1481");
    assert.equal(other?.supervised, false);
    assert.equal(sup?.supervised, true);
  });

  it("excludes self from projected peer rows", () => {
    const payload = buildPidashComsPeersPayload(sampleFixture());
    assert.equal(payload.peers.length, 2);
    assert.equal(payload.peers.some((p) => p.name === "feature-manager"), false);
  });

  it("preserves project metadata on projected peer rows", () => {
    const payload = buildPidashComsPeersPayload(sampleFixture());
    const other = payload.peers.find((p) => p.name === "observer");
    const sup = payload.peers.find((p) => p.name === "peer-1481");
    assert.equal(payload.scope, "all");
    assert.equal(other?.project, "other-proj");
    assert.equal(sup?.cwd, "/repo/.worktrees/1481");
  });
});

describe("parseTypedSetting", () => {
  const key = (t: string, extra: Record<string, unknown> = {}): any => ({ key: "k", description: "", type: t, default: null, group: "G", stored: undefined, ...extra });

  it("bool accepts true/false, rejects other text", () => {
    assert.deepEqual(parseTypedSetting("true", key("bool")), { value: true });
    assert.deepEqual(parseTypedSetting("false", key("bool")), { value: false });
    assert.ok(parseTypedSetting("yes", key("bool")).error);
  });

  it("bool_enable toggles like bool (settings-keys.json taxonomy)", () => {
    assert.deepEqual(parseTypedSetting("true", key("bool_enable")), { value: true });
    assert.deepEqual(parseTypedSetting("false", key("bool_enable")), { value: false });
    assert.ok(parseTypedSetting("yes", key("bool_enable")).error);
  });

  it("bool_or_string falls back to the raw string", () => {
    assert.deepEqual(parseTypedSetting("rits", key("bool_or_string")), { value: "rits" });
  });

  it("int parses and enforces min/max", () => {
    assert.deepEqual(parseTypedSetting("5", key("int", { min: 1, max: 10 })), { value: 5 });
    assert.ok(parseTypedSetting("0", key("int", { min: 1 })).error);
    assert.ok(parseTypedSetting("11", key("int", { max: 10 })).error);
    assert.ok(parseTypedSetting("abc", key("int")).error);
  });

  it("accepts 0 for allow_zero int keys", () => {
    assert.deepEqual(
      parseTypedSetting("0", key("int", { min: 20, max: 99, allow_zero: true })),
      { value: 0 },
    );
  });

  it("accepts in-range values for allow_zero int keys", () => {
    const def = key("int", { min: 20, max: 99, allow_zero: true });
    assert.deepEqual(parseTypedSetting("20", def), { value: 20 });
    assert.deepEqual(parseTypedSetting("99", def), { value: 99 });
  });

  it("rejects out-of-range values for allow_zero int keys", () => {
    const def = key("int", { min: 20, max: 99, allow_zero: true });
    assert.ok(parseTypedSetting("1", def).error);
    assert.ok(parseTypedSetting("19", def).error);
    assert.ok(parseTypedSetting("-1", def).error);
    assert.ok(parseTypedSetting("100", def).error);
  });

  it("int rejects trailing garbage instead of silently parsing a prefix", () => {
    // parseInt("12abc") === 12 — must be an error, not a silent 12 (Qodo R1)
    assert.ok(parseTypedSetting("12abc", key("int")).error);
    assert.ok(parseTypedSetting("1.5", key("int")).error);
    assert.deepEqual(parseTypedSetting("-3", key("int")), { value: -3 });
  });

  it("port parses an integer in range and rejects out-of-range or garbage", () => {
    const def = key("port");
    assert.deepEqual(parseTypedSetting("19190", def), { value: 19190 });
    assert.ok(parseTypedSetting("0", def).error);
    assert.ok(parseTypedSetting("70000", def).error);
    assert.ok(parseTypedSetting("19190abc", def).error);
  });

  it("agent_overrides parses a JSON object and rejects strings/arrays", () => {
    const def = key("agent_overrides");
    assert.deepEqual(
      parseTypedSetting('{"worker": {"model": "claude-opus-4-6"}}', def),
      { value: { worker: { model: "claude-opus-4-6" } } },
    );
    assert.ok(parseTypedSetting("worker=claude", def).error);
    assert.ok(parseTypedSetting('["worker"]', def).error);
    assert.ok(parseTypedSetting("{broken", def).error);
  });

  it("number accepts decimals", () => {
    assert.deepEqual(parseTypedSetting("1.5", key("number")), { value: 1.5 });
  });

  it("string_list splits and trims", () => {
    assert.deepEqual(parseTypedSetting("a, b ,,c", key("string_list")), { value: ["a", "b", "c"] });
  });

  it("enum rejects values outside the set", () => {
    assert.ok(parseTypedSetting("debug", key("string", { enum: ["debug", "info"] })).value === "debug");
    assert.ok(parseTypedSetting("nope", key("string", { enum: ["debug", "info"] })).error);
  });

  it("displaySettingValue formats arrays and undefined", () => {
    assert.equal(displaySettingValue(["a", "b"]), "a, b");
    assert.equal(displaySettingValue(undefined), "");
    assert.equal(displaySettingValue(true), "true");
  });
});
