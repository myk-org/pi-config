/**
 * Tests for JSONL state persistence module.
 * Run with: npx tsx --test tests/node/orchestrator/state-jsonl.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlStateStore, parseLastValidLine, createCachedStore } from "../../../extensions/orchestrator/state-jsonl.js";

interface TestState {
  counter: number;
  name: string;
  active: boolean;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "state-jsonl-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── 1. Basic read/write ──

describe("JsonlStateStore basic operations", () => {
  it("read returns null when file does not exist", () => {
    const store = new JsonlStateStore<TestState>(join(tmpDir, "state.jsonl"));
    assert.equal(store.read(), null);
  });

  it("write then read returns the written state", () => {
    const store = new JsonlStateStore<TestState>(join(tmpDir, "state.jsonl"));
    store.write({ counter: 1, name: "test", active: true });
    const state = store.read();
    assert.deepEqual(state, { counter: 1, name: "test", active: true });
  });

  it("multiple writes return the last state", () => {
    const store = new JsonlStateStore<TestState>(join(tmpDir, "state.jsonl"));
    store.write({ counter: 1, name: "first", active: true });
    store.write({ counter: 2, name: "second", active: false });
    store.write({ counter: 3, name: "third", active: true });
    const state = store.read();
    assert.deepEqual(state, { counter: 3, name: "third", active: true });
  });

  it("each write appends a line (not overwrite)", () => {
    const filePath = join(tmpDir, "state.jsonl");
    const store = new JsonlStateStore<TestState>(filePath);
    store.write({ counter: 1, name: "a", active: true });
    store.write({ counter: 2, name: "b", active: false });
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter(l => l.trim());
    assert.equal(lines.length, 2);
  });

  it("exists returns false when file does not exist", () => {
    const store = new JsonlStateStore<TestState>(join(tmpDir, "nope.jsonl"));
    assert.equal(store.exists(), false);
  });

  it("exists returns true after write", () => {
    const store = new JsonlStateStore<TestState>(join(tmpDir, "state.jsonl"));
    store.write({ counter: 1, name: "x", active: true });
    assert.equal(store.exists(), true);
  });

  it("path getter returns the file path", () => {
    const filePath = join(tmpDir, "my-state.jsonl");
    const store = new JsonlStateStore<TestState>(filePath);
    assert.equal(store.path, filePath);
  });
});

// ── 2. Crash recovery ──

describe("crash recovery (truncated/corrupt lines)", () => {
  it("handles truncated last line by falling back to previous valid line", () => {
    const filePath = join(tmpDir, "state.jsonl");
    // Write a valid line, then a truncated one
    writeFileSync(filePath, '{"counter":1,"name":"valid","active":true}\n');
    appendFileSync(filePath, '{"counter":2,"name":"trun');
    const store = new JsonlStateStore<TestState>(filePath);
    const state = store.read();
    assert.deepEqual(state, { counter: 1, name: "valid", active: true });
  });

  it("handles completely corrupt file by returning null", () => {
    const filePath = join(tmpDir, "state.jsonl");
    writeFileSync(filePath, "not json at all\nalso not json\n");
    const store = new JsonlStateStore<TestState>(filePath);
    assert.equal(store.read(), null);
  });

  it("handles empty file by returning null", () => {
    const filePath = join(tmpDir, "state.jsonl");
    writeFileSync(filePath, "");
    const store = new JsonlStateStore<TestState>(filePath);
    assert.equal(store.read(), null);
  });

  it("handles file with only whitespace by returning null", () => {
    const filePath = join(tmpDir, "state.jsonl");
    writeFileSync(filePath, "   \n  \n  ");
    const store = new JsonlStateStore<TestState>(filePath);
    assert.equal(store.read(), null);
  });

  it("recovers valid state from mix of valid and corrupt lines", () => {
    const filePath = join(tmpDir, "state.jsonl");
    writeFileSync(filePath, [
      '{"counter":1,"name":"first","active":true}',
      '{"counter":2,"name":"second","active":false}',
      'corrupt line here',
      '{"counter":3,"name":"th', // truncated
    ].join("\n") + "\n");
    const store = new JsonlStateStore<TestState>(filePath);
    const state = store.read();
    // Should return the last VALID line (counter:2), skipping corrupt and truncated
    assert.deepEqual(state, { counter: 2, name: "second", active: false });
  });
});

// ── 3. Compaction ──

describe("compaction", () => {
  it("compact rewrites file to single line", () => {
    const filePath = join(tmpDir, "state.jsonl");
    const store = new JsonlStateStore<TestState>(filePath);
    for (let i = 0; i < 10; i++) {
      store.write({ counter: i, name: `entry-${i}`, active: true });
    }
    const linesBefore = readFileSync(filePath, "utf-8").split("\n").filter(l => l.trim()).length;
    assert.equal(linesBefore, 10);

    store.compact();

    const linesAfter = readFileSync(filePath, "utf-8").split("\n").filter(l => l.trim()).length;
    assert.equal(linesAfter, 1);
    const state = store.read();
    assert.deepEqual(state, { counter: 9, name: "entry-9", active: true });
  });

  it("auto-compacts when threshold is reached", () => {
    const filePath = join(tmpDir, "state.jsonl");
    const store = new JsonlStateStore<TestState>(filePath, { compactThreshold: 5 });
    for (let i = 0; i < 6; i++) {
      store.write({ counter: i, name: `entry-${i}`, active: true });
    }
    // After 5+ lines, should have auto-compacted
    const lines = readFileSync(filePath, "utf-8").split("\n").filter(l => l.trim()).length;
    assert.ok(lines <= 2, `Expected <= 2 lines after compaction, got ${lines}`);
    const state = store.read();
    assert.equal(state?.counter, 5);
  });

  it("compact with no existing state is a no-op", () => {
    const filePath = join(tmpDir, "state.jsonl");
    const store = new JsonlStateStore<TestState>(filePath);
    // Should not throw
    store.compact();
    assert.equal(store.exists(), false);
  });
});

// ── 4. Directory creation ──

describe("directory creation", () => {
  it("creates parent directories on write", () => {
    const filePath = join(tmpDir, "deep", "nested", "dir", "state.jsonl");
    const store = new JsonlStateStore<TestState>(filePath);
    store.write({ counter: 1, name: "deep", active: true });
    assert.equal(store.exists(), true);
    assert.deepEqual(store.read(), { counter: 1, name: "deep", active: true });
  });
});

// ── 5. parseLastValidLine standalone ──

describe("parseLastValidLine", () => {
  it("returns null for empty string", () => {
    assert.equal(parseLastValidLine(""), null);
  });

  it("parses single valid line", () => {
    assert.deepEqual(parseLastValidLine('{"a":1}\n'), { a: 1 });
  });

  it("returns last valid line when multiple exist", () => {
    const raw = '{"a":1}\n{"a":2}\n{"a":3}\n';
    assert.deepEqual(parseLastValidLine(raw), { a: 3 });
  });

  it("skips trailing empty lines", () => {
    const raw = '{"a":1}\n\n\n';
    assert.deepEqual(parseLastValidLine(raw), { a: 1 });
  });

  it("falls back past truncated last line", () => {
    const raw = '{"a":1}\n{"a":2}\n{"a":3\n';
    assert.deepEqual(parseLastValidLine(raw), { a: 2 });
  });

  it("skips JSON primitives", () => {
    assert.equal(parseLastValidLine('"just a string"\n'), null);
    assert.equal(parseLastValidLine('42\n'), null);
    assert.equal(parseLastValidLine('true\n'), null);
    assert.equal(parseLastValidLine('null\n'), null);
  });

  it("skips JSON arrays", () => {
    assert.equal(parseLastValidLine('[1, 2, 3]\n'), null);
    assert.equal(parseLastValidLine('["a", "b"]\n'), null);
  });

  it("handles multi-line pretty-printed JSON as fallback", () => {
    // Multi-line JSON where NO individual line is valid JSON on its own —
    // only the full content parses. This is what happens when an LLM pretty-prints.
    const raw = '{\n  "entries": [\n    {\n      "category": "lesson",\n      "text": "test"\n    }\n  ]\n}\n';
    const result = parseLastValidLine<{ entries: Array<{ category: string; text: string }> }>(raw);
    assert.ok(result, "Should parse multi-line JSON");
    assert.equal(result!.entries.length, 1);
    assert.equal(result!.entries[0].text, "test");
  });
});

// ── 6. Multiple store instances for same file ──

describe("multiple store instances", () => {
  it("different instances reading same file see same state", () => {
    const filePath = join(tmpDir, "shared.jsonl");
    const store1 = new JsonlStateStore<TestState>(filePath);
    const store2 = new JsonlStateStore<TestState>(filePath);
    store1.write({ counter: 42, name: "shared", active: true });
    const state = store2.read();
    assert.deepEqual(state, { counter: 42, name: "shared", active: true });
  });
});

// ── 7. JsonlAppendLog ──

import { JsonlAppendLog } from "../../../extensions/orchestrator/state-jsonl.js";

interface TestLogEntry {
  event: string;
  count: number;
}

describe("JsonlAppendLog basic operations", () => {
  it("readAll returns empty array when file does not exist", () => {
    const log = new JsonlAppendLog<TestLogEntry>(join(tmpDir, "log.jsonl"));
    assert.deepEqual(log.readAll(), []);
  });

  it("append creates file and adds entry with seq and ts", () => {
    const log = new JsonlAppendLog<TestLogEntry>(join(tmpDir, "log.jsonl"));
    log.append({ event: "test", count: 1 });
    const entries = log.readAll();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].event, "test");
    assert.equal(entries[0].count, 1);
    assert.equal(entries[0].seq, 1);
    assert.ok(entries[0].ts);
  });

  it("multiple appends increment seq", () => {
    const log = new JsonlAppendLog<TestLogEntry>(join(tmpDir, "log.jsonl"));
    log.append({ event: "a", count: 1 });
    log.append({ event: "b", count: 2 });
    log.append({ event: "c", count: 3 });
    const entries = log.readAll();
    assert.equal(entries.length, 3);
    assert.equal(entries[0].seq, 1);
    assert.equal(entries[1].seq, 2);
    assert.equal(entries[2].seq, 3);
    assert.equal(entries[2].event, "c");
  });

  it("exists returns false before write, true after", () => {
    const log = new JsonlAppendLog<TestLogEntry>(join(tmpDir, "log.jsonl"));
    assert.equal(log.exists(), false);
    log.append({ event: "x", count: 0 });
    assert.equal(log.exists(), true);
  });

  it("path getter returns the file path", () => {
    const filePath = join(tmpDir, "my-log.jsonl");
    const log = new JsonlAppendLog<TestLogEntry>(filePath);
    assert.equal(log.path, filePath);
  });
});

describe("JsonlAppendLog size-based truncation", () => {
  it("truncates when file exceeds maxSizeBytes", () => {
    const filePath = join(tmpDir, "big-log.jsonl");
    // Use a very small maxSizeBytes to trigger truncation easily
    const log = new JsonlAppendLog<TestLogEntry>(filePath, {
      maxSizeBytes: 200,
      keepLines: 3,
    });
    // Each entry is ~60 bytes, so 5 entries > 200 bytes
    for (let i = 0; i < 10; i++) {
      log.append({ event: `event-${i}`, count: i });
    }
    const entries = log.readAll();
    assert.ok(entries.length <= 5, `Expected <= 5 entries after truncation, got ${entries.length}`);
    // Last entry should still be present
    const last = entries[entries.length - 1];
    assert.equal(last.event, "event-9");
  });
});

describe("JsonlAppendLog crash recovery", () => {
  it("skips corrupt lines in readAll", () => {
    const filePath = join(tmpDir, "corrupt-log.jsonl");
    writeFileSync(filePath, [
      '{"seq":1,"ts":"2024-01-01","event":"a","count":1}',
      'corrupt line',
      '{"seq":3,"ts":"2024-01-03","event":"c","count":3}',
    ].join("\n") + "\n");
    const log = new JsonlAppendLog<TestLogEntry>(filePath);
    const entries = log.readAll();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].event, "a");
    assert.equal(entries[1].event, "c");
  });
});

describe("JsonlAppendLog seq persistence across instances", () => {
  it("new instance continues seq from existing log", () => {
    const filePath = join(tmpDir, "seq-persist.jsonl");
    const log1 = new JsonlAppendLog<TestLogEntry>(filePath);
    log1.append({ event: "a", count: 1 });
    log1.append({ event: "b", count: 2 });
    log1.append({ event: "c", count: 3 });
    assert.equal(log1.readAll().length, 3);
    assert.equal(log1.readAll()[2].seq, 3);

    // Create a new instance (simulates process restart)
    const log2 = new JsonlAppendLog<TestLogEntry>(filePath);
    log2.append({ event: "d", count: 4 });

    const entries = log2.readAll();
    assert.equal(entries.length, 4);
    // seq should continue from 3, not restart at 1
    assert.equal(entries[3].seq, 4);
    assert.equal(entries[3].event, "d");
  });

  it("handles empty file gracefully", () => {
    const filePath = join(tmpDir, "seq-empty.jsonl");
    writeFileSync(filePath, "");
    const log = new JsonlAppendLog<TestLogEntry>(filePath);
    log.append({ event: "first", count: 1 });
    assert.equal(log.readAll()[0].seq, 1);
  });
});

describe("JsonlStateStore lineCount persistence across instances", () => {
  it("new instance initializes lineCount from existing file", () => {
    const filePath = join(tmpDir, "lc-persist.jsonl");
    // compactThreshold = 5 — write 4 lines, then create new instance + write 1 more = compact
    const store1 = new JsonlStateStore<TestState>(filePath, { compactThreshold: 5 });
    for (let i = 0; i < 4; i++) {
      store1.write({ counter: i, name: `entry-${i}`, active: true });
    }
    const linesBefore = readFileSync(filePath, "utf-8").split("\n").filter(l => l.trim()).length;
    assert.equal(linesBefore, 4);

    // New instance should know there are 4 lines already
    const store2 = new JsonlStateStore<TestState>(filePath, { compactThreshold: 5 });
    store2.write({ counter: 4, name: "entry-4", active: true });

    // Should have compacted (4 existing + 1 new = 5 >= threshold)
    const linesAfter = readFileSync(filePath, "utf-8").split("\n").filter(l => l.trim()).length;
    assert.equal(linesAfter, 1, "Should have compacted after reaching threshold across instances");
    assert.deepEqual(store2.read(), { counter: 4, name: "entry-4", active: true });
  });
});

describe("createCachedStore legacy migration", () => {
  it("migrates legacy JSON file to JSONL on first access", () => {
    const dir = join(tmpDir, "migrate-test");
    const legacyData = { value: 42, name: "legacy" };
    // Write legacy JSON file
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify(legacyData) + "\n");

    const store = createCachedStore<typeof legacyData>(dir, "state.jsonl", "state.json");
    const result = store.read();
    assert.deepEqual(result, legacyData);
    // Legacy file should be removed
    assert.equal(existsSync(join(dir, "state.json")), false);
    // JSONL file should exist
    assert.equal(existsSync(join(dir, "state.jsonl")), true);
  });

  it("retries migration when JSONL exists but is corrupt", () => {
    const dir = join(tmpDir, "migrate-corrupt");
    mkdirSync(dir, { recursive: true });
    // Write corrupt JSONL and valid legacy JSON
    writeFileSync(join(dir, "state.jsonl"), "corrupt\n");
    const legacyData = { value: 99 };
    writeFileSync(join(dir, "state.json"), JSON.stringify(legacyData) + "\n");

    const store = createCachedStore<typeof legacyData>(dir, "state.jsonl", "state.json");
    const result = store.read();
    assert.deepEqual(result, legacyData);
    assert.equal(existsSync(join(dir, "state.json")), false);
  });

  it("skips migration when JSONL has valid data", () => {
    const dir = join(tmpDir, "migrate-skip");
    mkdirSync(dir, { recursive: true });
    const jsonlData = { value: 1 };
    const legacyData = { value: 2 };
    writeFileSync(join(dir, "state.jsonl"), JSON.stringify(jsonlData) + "\n");
    writeFileSync(join(dir, "state.json"), JSON.stringify(legacyData) + "\n");

    const store = createCachedStore<typeof jsonlData>(dir, "state.jsonl", "state.json");
    const result = store.read();
    // Should use JSONL data, not legacy
    assert.deepEqual(result, jsonlData);
    // Legacy file should NOT be removed (migration skipped)
    assert.equal(existsSync(join(dir, "state.json")), true);
  });
});

describe("createCachedStore corrupt legacy migration", () => {
  it("handles corrupt legacy JSON without throwing", () => {
    const dir = join(tmpDir, "migrate-corrupt-legacy");
    mkdirSync(dir, { recursive: true });
    // Write corrupt legacy file
    writeFileSync(join(dir, "state.json"), "not valid json{{{");

    // Should not throw — migration fails silently, returns empty store
    const store = createCachedStore<{ value: number }>(dir, "state.jsonl", "state.json");
    assert.equal(store.read(), null);
    // Legacy file should still exist (migration failed)
    assert.equal(existsSync(join(dir, "state.json")), true);
  });

  it("does not retry migration after failure in same process", () => {
    const dir = join(tmpDir, "migrate-no-retry");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), "corrupt");

    // First call — migration fails
    createCachedStore<{ value: number }>(dir, "state.jsonl", "state.json");

    // Fix the legacy file
    writeFileSync(join(dir, "state.json"), JSON.stringify({ value: 42 }) + "\n");

    // Second call — should NOT retry migration (migrationFailed flag set)
    const store = createCachedStore<{ value: number }>(dir, "state.jsonl", "state.json");
    assert.equal(store.read(), null); // Still null — migration was not retried
    // Legacy file still exists
    assert.equal(existsSync(join(dir, "state.json")), true);
  });
});
