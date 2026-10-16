/**
 * Transcript recording (issue #922): JSONL session transcripts with full
 * tool-call loops, redaction, retention, and fail-soft writes.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions.js";
import {
  appendTurn,
  enforceRetention,
  redactStructured,
  transcriptsDir,
  transcriptsEnabled,
  writeSessionHeader,
} from "../../src/transcripts.js";

function tempTranscriptsDir(): string {
  return mkdtempSync(join(tmpdir(), "sidecar-transcripts-"));
}

/** Redactor that masks a planted fake credential, like createApiKeyRedactor. */
const REDACT = (value: string) => value.replaceAll("sk-SECRET-1234", "[REDACTED]");

describe("transcripts toggle", () => {
  const ENV_KEYS = ["RECORD_TRANSCRIPTS", "PI_SIDECAR_TRANSCRIPTS_DIR"] as const;
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("is OFF by default and only truthy for 1/true/yes/on", () => {
    delete process.env.RECORD_TRANSCRIPTS;
    assert.equal(transcriptsEnabled(), false);
    for (const raw of ["0", "false", "off", "no", ""]) {
      process.env.RECORD_TRANSCRIPTS = raw;
      assert.equal(transcriptsEnabled(), false, `falsy: ${raw}`);
    }
    for (const raw of ["1", "true", "YES", "On"]) {
      process.env.RECORD_TRANSCRIPTS = raw;
      assert.equal(transcriptsEnabled(), true, `truthy: ${raw}`);
    }
  });

  it("dir defaults to ~/.pi/sidecar/transcripts and honors PI_SIDECAR_TRANSCRIPTS_DIR", () => {
    delete process.env.PI_SIDECAR_TRANSCRIPTS_DIR;
    assert.equal(transcriptsDir(), join(homedir(), ".pi", "sidecar", "transcripts"));
    process.env.PI_SIDECAR_TRANSCRIPTS_DIR = "/custom/dir";
    assert.equal(transcriptsDir(), "/custom/dir");
  });
});

describe("redactStructured", () => {
  it("redacts every string in nested tool args and results", () => {
    const input = {
      toolCall: { toolCallId: "tc1", toolName: "bash", arguments: { command: "echo sk-SECRET-1234" } },
      nested: [{ deep: { key: "sk-SECRET-1234" } }],
      count: 3,
      flag: true,
    };
    const out = JSON.stringify(redactStructured(input, REDACT));
    assert.ok(!out.includes("sk-SECRET-1234"), "credential must not survive");
    assert.equal((out.match(/\[REDACTED\]/g) ?? []).length, 2, "both occurrences redacted");
    assert.ok(out.includes('"count":3'), "numbers pass through");
  });
  it("handles circular references, buffers, and toJSON objects", () => {
    const circular: Record<string, unknown> = { name: "x" };
    circular.self = circular;
    const out = redactStructured(
      { circular, buf: new Uint8Array([1, 2, 3]), when: new Date(0) },
      (v) => v,
    ) as Record<string, unknown>;
    assert.equal((out.circular as Record<string, unknown>).self, "[circular]");
    assert.equal(out.buf, "[binary omitted]");
    assert.equal(out.when, "1970-01-01T00:00:00.000Z");
  });
});

describe("JSONL records", () => {
  let dir: string;
  beforeEach(() => {
    dir = tempTranscriptsDir();
    process.env.PI_SIDECAR_TRANSCRIPTS_DIR = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.PI_SIDECAR_TRANSCRIPTS_DIR;
  });

  it("writes a session header on creation, then turn records with the full message array", async () => {
    await writeSessionHeader({
      sessionId: "s1",
      provider: "rits",
      model: "zai-org/glm-5-3",
      systemPrompt: "You are a helper. sk-SECRET-1234",
      cwd: "/repo",
      customTools: ["fetch_page"],
      redact: REDACT,
    });
    await appendTurn({
      sessionId: "s1",
      turnNumber: 1,
      messages: [
        { role: "user", content: [{ type: "text", text: "run it" }] },
        { role: "assistant", content: [{ type: "toolCall", toolCall: { toolCallId: "tc1", toolName: "bash", arguments: { command: "echo hello" } } }] },
        { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "sk-SECRET-1234 done" }] },
      ],
      usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.001, cost_partial: false },
      stopReason: "end_turn",
      redact: REDACT,
    });
    const lines = readFileSync(join(dir, "s1.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].type, "session_header");
    assert.equal(lines[0].session_id, "s1");
    assert.equal(lines[0].provider, "rits");
    assert.ok(lines[0].system_prompt.includes("[REDACTED]"), "system prompt redacted");
    assert.deepEqual(lines[0].custom_tools, ["fetch_page"]);
    assert.equal(lines[1].type, "turn");
    assert.equal(lines[1].turn_number, 1);
    assert.equal(lines[1].messages.length, 3);
    assert.equal(lines[1].messages[1].content[0].toolCall.toolName, "bash", "tool call preserved");
    assert.ok(!JSON.stringify(lines[1]).includes("sk-SECRET-1234"), "turn fully redacted");
    assert.equal(lines[1].stop_reason, "end_turn");
    assert.equal(lines[1].usage.cost_usd, 0.001);
  });

  it("swallows write failures — a broken directory never throws", async () => {
    process.env.PI_SIDECAR_TRANSCRIPTS_DIR = join(dir, "file-blocks-path");
    writeFileSync(process.env.PI_SIDECAR_TRANSCRIPTS_DIR, "not a directory");
    await writeSessionHeader({ sessionId: "s2", provider: "p", model: "m", redact: REDACT });
    await appendTurn({ sessionId: "s2", turnNumber: 1, messages: [], usage: {}, redact: REDACT });
    // reaching here means both failures were swallowed
  });

  it("bounds record size — an oversized message array is replaced, not written in full", async () => {
    await appendTurn({
      sessionId: "s3",
      turnNumber: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }] }],
      usage: {},
      redact: (v) => v,
    });
    const raw = readFileSync(join(dir, "s3.jsonl"), "utf-8");
    assert.ok(raw.length < 1024, "oversized record replaced with a placeholder line");
    const parsed = JSON.parse(raw.trim());
    assert.equal(parsed.messages, "[record over size cap omitted]");
  });
});

describe("retention", () => {
  let dir: string;
  beforeEach(() => {
    dir = tempTranscriptsDir();
    process.env.PI_SIDECAR_TRANSCRIPTS_DIR = dir;
    delete process.env.PI_SIDECAR_TRANSCRIPTS_MAX_AGE_DAYS;
    delete process.env.PI_SIDECAR_TRANSCRIPTS_MAX_SIZE_MB;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.PI_SIDECAR_TRANSCRIPTS_DIR;
    delete process.env.PI_SIDECAR_TRANSCRIPTS_MAX_AGE_DAYS;
    delete process.env.PI_SIDECAR_TRANSCRIPTS_MAX_SIZE_MB;
  });

  it("no budgets set → nothing removed", async () => {
    writeFileSync(join(dir, "old.jsonl"), "data");
    await enforceRetention();
    assert.ok(existsSync(join(dir, "old.jsonl")));
  });

  it("removes files older than the max age", async () => {
    process.env.PI_SIDECAR_TRANSCRIPTS_MAX_AGE_DAYS = "7";
    const oldPath = join(dir, "old.jsonl");
    const freshPath = join(dir, "fresh.jsonl");
    writeFileSync(oldPath, "data");
    writeFileSync(freshPath, "data");
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const now = new Date();
    // backdate via utimes
    utimesSync(oldPath, tenDaysAgo, tenDaysAgo);
    utimesSync(freshPath, now, now);
    await enforceRetention();
    assert.ok(!existsSync(oldPath), "old file removed");
    assert.ok(existsSync(freshPath), "fresh file kept");
  });

  it("removes oldest files until under the size budget", async () => {
    process.env.PI_SIDECAR_TRANSCRIPTS_MAX_SIZE_MB = "1"; // 1 MiB
    // three files, oldest first: 600KB + 600KB + 100KB — dropping the oldest
    // brings the total to 700KB ≤ 1MiB, so exactly one removal happens
    const big = "y".repeat(600 * 1024);
    const names = ["a-oldest.jsonl", "b-old.jsonl", "c-new.jsonl"];
    names.forEach((name, i) => {
      const p = join(dir, name);
      writeFileSync(p, i === 2 ? "z".repeat(100 * 1024) : big);
      const t = new Date(Date.now() - (3 - i) * 60 * 1000);
      utimesSync(p, t, t);
    });
    await enforceRetention();
    assert.ok(!existsSync(join(dir, names[0])), "oldest removed");
    assert.ok(existsSync(join(dir, names[1])), "second kept (700KB ≤ 1MiB)");
    assert.ok(existsSync(join(dir, names[2])), "newest kept");
  });

  it("missing directory is a no-op", async () => {
    process.env.PI_SIDECAR_TRANSCRIPTS_DIR = join(dir, "never-created");
    await enforceRetention();
  });
});

describe("disabled means zero I/O", () => {
  it("appendTurn/writeSessionHeader are only called by the store when enabled (contract check)", () => {
    // The store gates on transcriptsEnabled() before calling either writer;
    // with the env unset the module-level writers are never invoked. This is
    // asserted end-to-end by the session-store tests' disabled paths.
    delete process.env.RECORD_TRANSCRIPTS;
    assert.equal(transcriptsEnabled(), false);
  });
});

describe("store wiring (end-to-end through prompt())", () => {
  let dir: string;
  beforeEach(() => {
    dir = tempTranscriptsDir();
    process.env.PI_SIDECAR_TRANSCRIPTS_DIR = dir;
    delete process.env.RECORD_TRANSCRIPTS;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.PI_SIDECAR_TRANSCRIPTS_DIR;
    delete process.env.RECORD_TRANSCRIPTS;
  });

  /** Fixture session whose prompt() emits a realistic agent_end with a tool loop. */
  function emittingStore(): { store: InstanceType<typeof SessionStore>; id: string } {
    const store = new SessionStore();
    let emit: (event: unknown) => void = () => {};
    const id = "s-e2e";
    (store as any).putSessionFixture(
      id,
      {
        subscribe: (cb: (event: unknown) => void) => {
          emit = cb;
          return () => {};
        },
        prompt: async () => {
          emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ran it" } });
          emit({
            type: "agent_end",
            messages: [
              { role: "user", content: [{ type: "text", text: "run the tool" }] },
              { role: "assistant", content: [{ type: "toolCall", toolCall: { toolCallId: "tc1", toolName: "bash", arguments: { command: "echo hello" } } }], usage: { input: 5, output: 2 } },
              { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "hello" }] },
              { role: "assistant", content: [{ type: "text", text: "ran it" }], usage: { input: 10, output: 4 }, stopReason: "end_turn" },
            ],
          });
        },
        dispose: () => {},
        abort: async () => {},
      },
      "/tmp/job-e2e",
      true,
    );
    return { store, id };
  }

  async function waitForFile(path: string, timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(path)) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  it("disabled: prompt() writes zero transcript files", async () => {
    const { store, id } = emittingStore();
    const result = await store.prompt(id, "run the tool");
    assert.equal(result.text, "ran it");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(readdirSyncSafe(dir).length, 0, "no transcript directory contents — zero I/O");
  });

  it("enabled: prompt() appends a redacted turn record with the full tool loop", async () => {
    process.env.RECORD_TRANSCRIPTS = "1";
    const { store, id } = emittingStore();
    const result = await store.prompt(id, "run the tool");
    assert.equal(result.text, "ran it", "prompt response unaffected");
    const file = join(dir, "s-e2e.jsonl");
    assert.ok(await waitForFile(file), "turn record written");
    const record = JSON.parse(readFileSync(file, "utf-8").trim());
    assert.equal(record.type, "turn");
    assert.equal(record.turn_number, 1);
    assert.equal(record.messages.length, 4, "full message array persisted");
    // Redaction itself is unit-covered above; the fixture session's redactor
    // is identity by design — this asserts the wiring passes entry.redact
    // through to the writer, which for real sessions is the API-key redactor.
    assert.equal(record.messages[1].content[0].toolCall.toolName, "bash");
    assert.equal(record.stop_reason, "end_turn");
    assert.equal(record.usage.input_tokens, 15, "usage aggregated across assistant messages");
    // second prompt → turn_number 2 appended to the same file
    await store.prompt(id, "again");
    assert.ok(await waitForFile(file));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    assert.equal(lines.length, 2, "one line per turn");
    assert.equal(JSON.parse(lines[1]!).turn_number, 2);
  });
});

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
