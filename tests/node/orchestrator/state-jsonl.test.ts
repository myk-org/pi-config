/**
 * Tests for JSONL state persistence module.
 * Run with: npx tsx --test tests/node/orchestrator/state-jsonl.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlStateStore, parseLastValidLine } from "../../../extensions/orchestrator/state-jsonl.js";

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
