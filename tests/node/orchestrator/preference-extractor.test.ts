/**
 * Preference extractor candidate-queue tests (issue #961).
 * Run: npx tsx --test tests/node/orchestrator/preference-extractor.test.ts
 *
 * The extractor no longer lands memories directly — regex matches fire on
 * PHRASE, not meaning, so candidates go to
 * .pi/memory/preference-candidates.jsonl (full sentence, source session)
 * for dreaming review. Questions, one-off grants, and task-scoped
 * instructions are filtered before queueing.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerPreferenceExtractor, readPreferenceCandidates } from "../../../extensions/orchestrator/preference-extractor.js";

interface Harness {
  pi: any;
  emit: (event: string, data: any) => Promise<void>;
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

describe("registerPreferenceExtractor — candidate queue, no direct writes (issue #961)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pref-extractor-"));
  });

  afterEach(() => {
    for (const h of harnesses.splice(0)) {
      (h as any)._restore();
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("queues an extracted preference as a candidate — NOT in the topic file", async () => {
    const h = makeHarness(cwd);
    registerPreferenceExtractor(h.pi);
    await h.emit("input", { text: "Going forward I always want uv run for every Python command" });
    const candidates = readPreferenceCandidates(cwd);
    assert.equal(candidates.length, 1, "candidate must be queued");
    assert.match(candidates[0]!.text, /uv run/);
    assert.equal(candidates[0]!.sourceSession, "test-session");
    assert.ok(candidates[0]!.timestamp, "candidate carries a timestamp");
    assert.equal(
      topicLines(cwd, "preferences.md").length,
      0,
      "extractor must never write topic files directly",
    );
  });

  it("does not re-queue the same text — exact dedup against the queue file", async () => {
    const h = makeHarness(cwd);
    registerPreferenceExtractor(h.pi);
    const text = "From now on I always want timezone labels in UTC";
    await h.emit("input", { text });
    await h.emit("input", { text });
    assert.equal(readPreferenceCandidates(cwd).length, 1, "duplicate must not queue twice");
  });

  it("does not queue task-scoped instructions (issue #961)", async () => {
    const h = makeHarness(cwd);
    registerPreferenceExtractor(h.pi);
    await h.emit("input", {
      text: "Once everything is done I want an html report of the results please",
    });
    await h.emit("input", {
      text: "When bumping to 2.0.0 I always want the vendor dir dropped first",
    });
    await h.emit("input", { text: "For this report I always prefer to have a summary table" });
    assert.equal(
      readPreferenceCandidates(cwd).length,
      0,
      "task-scoped instructions must not queue",
    );
  });

  it("does not queue one-off grants or questions", async () => {
    const h = makeHarness(cwd);
    registerPreferenceExtractor(h.pi);
    await h.emit("input", { text: "You can merge this PR, I always trust your judgment here" });
    await h.emit("input", { text: "Do I always need to run the linter before committing?" });
    assert.equal(readPreferenceCandidates(cwd).length, 0, "grants and questions must not queue");
  });

  it("keeps the FULL sentence — no mid-sentence cutoff at 100 chars (issue #961)", async () => {
    const h = makeHarness(cwd);
    registerPreferenceExtractor(h.pi);
    const long =
      "For dashboards I prefer compact cards over tables with lots of padding and borders everywhere around them";
    assert.ok(long.length > 100, "fixture must exceed the old 100-char cap");
    await h.emit("input", { text: long });
    const candidates = readPreferenceCandidates(cwd);
    assert.equal(candidates.length, 1);
    assert.ok(
      candidates[0]!.text.length > 100,
      "candidate must carry the full thought, not a truncated half-sentence",
    );
  });

  it("skips slash commands and short messages", async () => {
    const h = makeHarness(cwd);
    registerPreferenceExtractor(h.pi);
    await h.emit("input", { text: "/remember I always want tests run before merging anything" });
    await h.emit("input", { text: "I prefer tabs" }); // < MIN_MESSAGE_LENGTH (20)
    assert.equal(readPreferenceCandidates(cwd).length, 0);
  });

  it("queues at most 3 candidates per message and caps the file", async () => {
    const h = makeHarness(cwd);
    registerPreferenceExtractor(h.pi);
    await h.emit("input", {
      text: "I prefer tabs. I prefer spaces. I prefer semicolons. I prefer no semicolons. I prefer dark mode.",
    });
    assert.equal(readPreferenceCandidates(cwd).length, 3, "extractPreferences caps at 3 per message");
  });
});
