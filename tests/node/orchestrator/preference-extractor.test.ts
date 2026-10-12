/**
 * Preference extractor registration path tests (Qodo round 2, PR #916).
 * Run: npx tsx --test tests/node/orchestrator/preference-extractor.test.ts
 *
 * Covers: tracked async writes (cooldown stamped only after a write lands),
 * rejected writes retry on the next message, and pending writes drained on
 * session_shutdown.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerPreferenceExtractor } from "../../../extensions/orchestrator/preference-extractor.js";
import { entryHash, loadScores } from "../../../extensions/orchestrator/memory-scoring.js";

interface Harness {
  pi: any;
  emit: (event: string, data: any) => Promise<void>;
  shutdown: () => Promise<void>;
}

const harnesses: Harness[] = [];

function makeHarness(cwd: string): Harness {
  const originalChildMarker = process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_CHILD;
  const handlers = new Map<string, Function[]>();
  const pi: any = {
    on(event: string, fn: Function) {
      const list = handlers.get(event) || [];
      list.push(fn);
      handlers.set(event, list);
    },
  };
  const h: Harness = {
    pi,
    async emit(event, data) {
      for (const fn of handlers.get(event) || []) {
        await fn(data, { cwd, sessionManager: { getSessionId: () => "test-session" } });
      }
    },
    async shutdown() {
      for (const fn of handlers.get("session_shutdown") || []) {
        await fn(undefined, { cwd });
      }
    },
  };
  harnesses.push(h);
  (h as any)._restore = () => {
    if (originalChildMarker === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = originalChildMarker;
  };
  return h;
}

function topicLines(cwd: string, file: string): string[] {
  const p = path.join(cwd, ".pi", "memory", "topics", file);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf-8").split("\n").filter((l) => l.startsWith("- ["));
}

async function settle(ms = 300): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("registerPreferenceExtractor — tracked writes, cooldown, shutdown drain (Qodo round 2, PR #916)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pref-extractor-"));
  });

  afterEach(async () => {
    // Drain anything pending so the next test starts from a settled state
    for (const h of harnesses.splice(0)) {
      try { await h.shutdown(); } catch { /* ignore */ }
      (h as any)._restore();
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("writes an extracted preference to the topic file", async () => {
    const h = makeHarness(cwd);
    registerPreferenceExtractor(h.pi);
    await h.emit("input", { text: "Going forward I always want uv run for every Python command" });
    await settle();
    const lines = topicLines(cwd, "preferences.md");
    assert.equal(lines.length, 1, "preference must land in the topic file");
    assert.match(lines[0]!, /uv run/);
  });

  it("stamps the cooldown only after a successful write — duplicate input does not reinforce", async () => {
    const h = makeHarness(cwd);
    registerPreferenceExtractor(h.pi);
    const text = "From now on I always want timezone labels in UTC";
    await h.emit("input", { text });
    await settle();
    const hash = entryHash(`- [preference] ${text}`);
    assert.equal(loadScores(cwd).entries[hash]?.evidenceCount, 1, "first write lands");

    // Same input again within the cooldown — no reinforcement may happen
    await h.emit("input", { text });
    await settle();
    assert.equal(loadScores(cwd).entries[hash]?.evidenceCount, 1, "cooldown must suppress re-extraction");
  });

  it("does not stamp the cooldown when the write is rejected — a retried input succeeds once the blocker is gone", async () => {
    const h = makeHarness(cwd);
    registerPreferenceExtractor(h.pi);

    // Seed a conflicting non-pinned rule so the first extraction attempt is
    // rejected by the conflict gate
    const topicsDir = path.join(cwd, ".pi", "memory", "topics");
    fs.mkdirSync(topicsDir, { recursive: true });
    fs.writeFileSync(
      path.join(topicsDir, "preferences.md"),
      "# Preferences\n\n- [preference] Never use tabs for indentation, spaces only\n",
    );

    const text = "From now on it is fine to use tabs for indentation";
    await h.emit("input", { text });
    await settle();
    // First attempt was rejected by the conflict gate — nothing written
    assert.equal(
      topicLines(cwd, "preferences.md").filter((l) => l.includes("fine to use tabs")).length,
      0,
      "conflicting write must be rejected",
    );

    // Remove the blocker, then send the SAME input again: if the cooldown had
    // been stamped on the rejected write, this would be suppressed
    fs.writeFileSync(path.join(topicsDir, "preferences.md"), "# Preferences\n\n");
    await h.emit("input", { text });
    await settle();
    assert.equal(
      topicLines(cwd, "preferences.md").filter((l) => l.includes("fine to use tabs")).length,
      1,
      "rejected write must not suppress the retry",
    );
  });

  it("drains pending writes on session_shutdown", async () => {
    const h = makeHarness(cwd);
    registerPreferenceExtractor(h.pi);
    // Fire input and IMMEDIATELY shut down — the write is still pending
    await h.emit("input", { text: "Going forward I always want terse commit messages" });
    await h.shutdown();
    // The drain must have awaited the in-flight write
    const lines = topicLines(cwd, "preferences.md");
    assert.equal(lines.length, 1, "pending write must land before shutdown completes");
    assert.match(lines[0]!, /terse commit messages/);
  });
});
