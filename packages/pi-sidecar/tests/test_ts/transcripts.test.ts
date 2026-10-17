/**
 * Transcript recording (issue #922): JSONL session transcripts with full
 * tool-call loops, redaction, retention, and fail-soft writes.
 * Round-2 (#923 review): header-field + property-name redaction, created_at,
 * final_text, UTF-8 byte cap, ordered write chains + shutdown drain,
 * active-session retention exclusion, rejection fallback records.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions.js";
import {
  appendTurn,
  drainTranscriptWrites,
  enforceRetention,
  maybeEnforceRetention,
  queueTurn,
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
  it("redacts property names keyed by the credential (#923 review)", () => {
    const input = { toolResult: { "sk-SECRET-1234": "token-value" } };
    const out = redactStructured(input, REDACT) as Record<string, Record<string, unknown>>;
    assert.ok(!("sk-SECRET-1234" in out.toolResult), "credential-bearing key must not survive");
    assert.equal(Object.keys(out.toolResult)[0], "[REDACTED]");
    assert.equal(out.toolResult["[REDACTED]"], "token-value", "value preserved");
  });
  it("preserves a __proto__ own property from JSON payloads (#923 review)", () => {
    // JSON.parse creates an OWN __proto__ property (unlike an object literal);
    // the transcript must not silently drop it.
    const input = JSON.parse('{"a":1,"__proto__":{"x":"v"}}');
    const out = redactStructured(input, (v) => v) as Record<string, unknown>;
    assert.ok(Object.prototype.hasOwnProperty.call(out, "__proto__"), "__proto__ own property preserved");
    // Object literals cannot express an own __proto__ property (the key would
    // set the prototype), so verify the value and the JSON round-trip instead.
    const protoProp = (out as { __proto__: { x?: string } }).__proto__;
    assert.equal(protoProp?.x, "v", "own __proto__ value preserved");
    assert.ok(JSON.stringify(out).includes('"__proto__"'), "serialized record keeps the field");
  });
  it("handles circular references", () => {
    const circular: Record<string, unknown> = { name: "x" };
    circular.self = circular;
    const out = redactStructured({ circular }, (v) => v) as Record<string, unknown>;
    assert.equal((out.circular as Record<string, unknown>).self, "[circular]");
  });
  it("replaces binary values with a placeholder", () => {
    const out = redactStructured({ buf: new Uint8Array([1, 2, 3]) }, (v) => v) as Record<string, unknown>;
    assert.equal(out.buf, "[binary omitted]");
  });
  it("serializes toJSON objects (Date)", () => {
    const out = redactStructured({ when: new Date(0) }, (v) => v) as Record<string, unknown>;
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
        { role: "assistant", content: [{ type: "toolCall", toolCall: { toolCallId: "tc1", toolName: "bash", arguments: { command: "echo sk-SECRET-1234" } } }] },
        { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "sk-SECRET-1234 done" }] },
      ],
      usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.001, cost_partial: false },
      stopReason: "end_turn",
      finalText: "done — sk-SECRET-1234 redacted",
      redact: REDACT,
    });
    const lines = readFileSync(join(dir, "s1.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].type, "session_header");
    assert.equal(lines[0].session_id, "s1");
    assert.equal(lines[0].provider, "rits");
    assert.ok(lines[0].created_at, "header carries created_at (#923 review)");
    assert.ok(!Number.isNaN(Date.parse(lines[0].created_at)), "created_at is ISO");
    assert.ok(lines[0].system_prompt.includes("[REDACTED]"), "system prompt redacted");
    assert.deepEqual(lines[0].custom_tools, ["fetch_page"]);
    assert.equal(lines[1].type, "turn");
    assert.equal(lines[1].turn_number, 1);
    assert.equal(lines[1].messages.length, 3);
    assert.equal(lines[1].messages[1].content[0].toolCall.toolName, "bash", "tool call preserved");
    assert.ok(!JSON.stringify(lines[1]).includes("sk-SECRET-1234"), "turn fully redacted");
    assert.equal(lines[1].final_text, "done — [REDACTED] redacted", "final_text present and redacted (#923 review)");
    assert.equal(lines[1].stop_reason, "end_turn");
    assert.equal(lines[1].usage.cost_usd, 0.001);
  });

  it("redacts every caller-supplied header field (#923 review)", async () => {
    await writeSessionHeader({
      sessionId: "s-sec",
      provider: "p-sk-SECRET-1234",
      model: "m-sk-SECRET-1234",
      systemPrompt: undefined,
      cwd: "/tmp/sk-SECRET-1234",
      customTools: ["tool-sk-SECRET-1234"],
      redact: REDACT,
    });
    const raw = readFileSync(join(dir, "s-sec.jsonl"), "utf-8");
    assert.ok(!raw.includes("sk-SECRET-1234"), "no header field persists the credential");
    const header = JSON.parse(raw.trim());
    assert.equal(header.provider, "p-[REDACTED]");
    assert.equal(header.model, "m-[REDACTED]");
    assert.equal(header.cwd, "/tmp/[REDACTED]");
    assert.deepEqual(header.custom_tools, ["tool-[REDACTED]"]);
  });

  it("swallows write failures — a broken directory never throws", async () => {
    process.env.PI_SIDECAR_TRANSCRIPTS_DIR = join(dir, "file-blocks-path");
    writeFileSync(process.env.PI_SIDECAR_TRANSCRIPTS_DIR, "not a directory");
    await writeSessionHeader({ sessionId: "s2", provider: "p", model: "m", redact: REDACT });
    await appendTurn({ sessionId: "s2", turnNumber: 1, messages: [], usage: {}, redact: REDACT });
    // reaching here means both failures were swallowed
  });

  it("bounds record size in UTF-8 bytes — non-ASCII content (#923 review)", async () => {
    // 3-byte chars: 3M chars = 9 MB > 8 MiB cap while the character count
    // (3M) stays well under an 8M-character threshold.
    await appendTurn({
      sessionId: "s-utf8",
      turnNumber: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "€".repeat(3 * 1024 * 1024) }] }],
      usage: {},
      redact: (v) => v,
    });
    const raw = readFileSync(join(dir, "s-utf8.jsonl"), "utf-8");
    assert.ok(Buffer.byteLength(raw, "utf-8") < 1024, "multibyte record replaced with a bounded placeholder");
    const parsed = JSON.parse(raw.trim());
    assert.equal(parsed.note, "record over size cap omitted");
    assert.equal(parsed.session_id, "s-utf8");
    assert.equal(parsed.turn_number, 1);
  });

  it("replaces oversized headers with the bounded placeholder too (#923 review)", async () => {
    await writeSessionHeader({
      sessionId: "s-big-header",
      provider: "p",
      model: "m",
      systemPrompt: "€".repeat(3 * 1024 * 1024), // 3-byte chars → 9 MB > 8 MiB cap
      redact: (v) => v,
    });
    const raw = readFileSync(join(dir, "s-big-header.jsonl"), "utf-8");
    assert.ok(Buffer.byteLength(raw, "utf-8") < 1024, "oversized header replaced");
    const parsed = JSON.parse(raw.trim());
    assert.equal(parsed.type, "session_header");
    assert.equal(parsed.note, "record over size cap omitted");
  });

  it("chains queued turns in turn order (#923 review)", async () => {
    // Queue three turns back-to-back with no await between them: the
    // per-session chain must serialize them as 1, 2, 3 regardless of
    // payload size or scheduling.
    for (let i = 1; i <= 3; i++) {
      queueTurn({
        sessionId: "s-order",
        turnNumber: i,
        messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(100_000 * i) }] }],
        usage: {},
        redact: (v) => v,
      });
    }
    await drainTranscriptWrites();
    const lines = readFileSync(join(dir, "s-order.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.turn_number), [1, 2, 3], "strict turn order");
  });

  it("drainTranscriptWrites waits for queued turns (#923 review)", async () => {
    queueTurn({ sessionId: "s-drain", turnNumber: 1, messages: [], usage: {}, redact: (v) => v });
    await drainTranscriptWrites();
    assert.ok(existsSync(join(dir, "s-drain.jsonl")), "record is on disk when drain resolves");
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
    utimesSync(oldPath, tenDaysAgo, tenDaysAgo);
    utimesSync(freshPath, now, now);
    await enforceRetention();
    assert.ok(!existsSync(oldPath), "old file removed");
    assert.ok(existsSync(freshPath), "fresh file kept");
  });

  it("never removes an active session's transcript (#923 review)", async () => {
    process.env.PI_SIDECAR_TRANSCRIPTS_MAX_AGE_DAYS = "7";
    const activePath = join(dir, "live-session.jsonl");
    const closedPath = join(dir, "closed-session.jsonl");
    writeFileSync(activePath, "data");
    writeFileSync(closedPath, "data");
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(activePath, tenDaysAgo, tenDaysAgo);
    utimesSync(closedPath, tenDaysAgo, tenDaysAgo);
    await enforceRetention(new Set(["live-session"]));
    assert.ok(existsSync(activePath), "active session transcript survives its own age");
    assert.ok(!existsSync(closedPath), "closed session transcript pruned");
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

  it("maybeEnforceRetention throttles to one scan per interval (#923 review)", async () => {
    process.env.PI_SIDECAR_TRANSCRIPTS_MAX_AGE_DAYS = "7";
    const firstPath = join(dir, "first-old.jsonl");
    const secondPath = join(dir, "second-old.jsonl");
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    writeFileSync(firstPath, "data");
    utimesSync(firstPath, tenDaysAgo, tenDaysAgo);
    maybeEnforceRetention(new Set());
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(!existsSync(firstPath), "first scan ran");
    // Second old file + immediate second call: throttled, must NOT be removed.
    writeFileSync(secondPath, "data");
    utimesSync(secondPath, tenDaysAgo, tenDaysAgo);
    maybeEnforceRetention(new Set());
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(existsSync(secondPath), "second scan throttled within the interval");
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
  function emittingStore(id = "s-e2e"): { store: InstanceType<typeof SessionStore>; id: string } {
    const store = new SessionStore();
    let emit: (event: unknown) => void = () => {};
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
    await drainTranscriptWrites();
    // Fixture sessions get a lazy header on the first recorded turn (#935) —
    // same well-formed header-then-turn shape as real create() sessions.
    const record = lastRecord(file);
    assert.equal(record.type, "turn");
    assert.equal(record.turn_number, 1);
    assert.equal(record.messages.length, 4, "full message array persisted");
    // Redaction itself is unit-covered above; the fixture session's redactor
    // is identity by design — this asserts the wiring passes entry.redact
    // through to the writer, which for real sessions is the API-key redactor.
    assert.equal(record.messages[1].content[0].toolCall.toolName, "bash");
    assert.equal(record.final_text, "ran it", "final_text carries the assembled response (#923 review)");
    assert.equal(record.stop_reason, "end_turn");
    assert.equal(record.usage.input, 15, "usage aggregated across assistant messages")
    assert.equal(record.usage.output, 6, "documented usage field names (#923 review)");
    // second prompt → turn_number 2 appended to the same file
    await store.prompt(id, "again");
    await waitForFile(file);
    await drainTranscriptWrites();
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    assert.equal(lines.length, 3, "lazy header + one line per turn");
    assert.equal(JSON.parse(lines[2]!).turn_number, 2);
  });

  it("enabled: a rejected prompt still leaves a turn record (#923 review)", async () => {
    process.env.RECORD_TRANSCRIPTS = "1";
    const store = new SessionStore();
    let emit: (event: unknown) => void = () => {};
    const id = "s-reject";
    (store as any).putSessionFixture(
      id,
      {
        subscribe: (cb: (event: unknown) => void) => {
          emit = cb;
          return () => {};
        },
        prompt: async () => {
          // Partial text, then a rejection with NO agent_end event.
          emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial answer" } });
          throw new Error("provider exploded mid-turn");
        },
        dispose: () => {},
        abort: async () => {},
      },
      "/tmp/job-reject",
      true,
    );
    const result = await store.prompt(id, "hello");
    assert.ok(result.error, "structured partial result returned");
    await drainTranscriptWrites();
    const file = join(dir, "s-reject.jsonl");
    assert.ok(existsSync(file), "rejection fallback record written");
    const record = lastRecord(file);
    assert.equal(record.type, "turn");
    assert.equal(record.turn_number, 1, "assigned turn number retained");
    assert.equal(record.stop_reason, "error");
    assert.equal(record.final_text, "partial answer", "partial output retained");
    assert.equal(record.messages.length, 1, "fallback carries the submitted user prompt (#923 review)");
    assert.equal(record.messages[0].content[0].text, "hello");
    assert.ok(JSON.stringify(record.errors).includes("provider exploded mid-turn"), "rejection error retained");
    assert.equal(record.errors[0], "provider exploded mid-turn", "rejection error leads the combined list");
    assert.equal(record.usage.input, 0, "documented usage names on the fallback path too");
  });

  it("enabled: multi-message responses get separator-matching final_text (#923 review)", async () => {
    process.env.RECORD_TRANSCRIPTS = "1";
    const store = new SessionStore();
    let emit: (event: unknown) => void = () => {};
    const id = "s-multi";
    (store as any).putSessionFixture(
      id,
      {
        subscribe: (cb: (event: unknown) => void) => { emit = cb; return () => {}; },
        prompt: async () => {
          emit({ type: "message_start", message: { role: "assistant" } });
          emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "part one" } });
          emit({ type: "message_start", message: { role: "assistant" } });
          emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "part two" } });
          emit({
            type: "agent_end",
            messages: [
              { role: "user", content: [{ type: "text", text: "hi" }] },
              { role: "assistant", content: [{ type: "text", text: "part one" }], usage: { input: 3, output: 2 }, stopReason: "end_turn" },
              { role: "assistant", content: [{ type: "text", text: "part two" }], usage: { input: 3, output: 2 }, stopReason: "end_turn" },
            ],
          });
        },
        dispose: () => {},
        abort: async () => {},
      },
      "/tmp/job-multi",
      true,
    );
    const result = await store.prompt(id, "hi");
    assert.equal(result.text, "part one\n\npart two", "boundary separator applied to the response");
    await drainTranscriptWrites();
    const record = lastRecord(join(dir, "s-multi.jsonl"));
    assert.equal(record.final_text, "part one\n\npart two", "transcript final_text matches the returned text exactly");
  });

  it("enabled: completed turns with error events keep the errors array (#923 review)", async () => {
    process.env.RECORD_TRANSCRIPTS = "1";
    const store = new SessionStore();
    let emit: (event: unknown) => void = () => {};
    const id = "s-errmsg";
    (store as any).putSessionFixture(
      id,
      {
        subscribe: (cb: (event: unknown) => void) => { emit = cb; return () => {}; },
        prompt: async () => {
          emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "best effort" } });
          emit({
            type: "agent_end",
            messages: [
              { role: "user", content: [{ type: "text", text: "hi" }] },
              { role: "assistant", content: [{ type: "text", text: "best effort" }], usage: { input: 3, output: 2 }, stopReason: "error", errorMessage: "tool timeout" },
            ],
          });
        },
        dispose: () => {},
        abort: async () => {},
      },
      "/tmp/job-errmsg",
      true,
    );
    const result = await store.prompt(id, "hi");
    assert.ok(result.error, "caller sees the error");
    await drainTranscriptWrites();
    const record = lastRecord(join(dir, "s-errmsg.jsonl"));
    assert.ok(JSON.stringify(record.errors).includes("tool timeout"), "collected SDK errors retained in the turn record");
    assert.equal(record.stop_reason, "error");
  });

  it("enabled: store.create() writes the session header (real create path, #923 review)", async () => {
    process.env.RECORD_TRANSCRIPTS = "1";
    const prevOffline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = "1";
    const agentDir = mkdtempSync(join(tmpdir(), "sidecar-agent-hdr-923-"));
    const sessionCwd = mkdtempSync(join(tmpdir(), "sidecar-cwd-hdr-923-"));
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "acme-hdr-923": {
            baseUrl: "http://127.0.0.1:9/v1",
            api: "openai-completions",
            apiKey: "test-key-hdr-923", // pragma: allowlist secret — synthetic test credential
            models: [{ id: "acme-hdr-model", name: "Acme Hdr Model" }],
          },
        },
      }),
    );
    const store = new SessionStore({ agentDir });
    try {
      const sessionId = await store.create({
        provider: "acme-hdr-923",
        model: "acme-hdr-model",
        systemPrompt: "transcript header e2e",
        cwd: sessionCwd,
      });
      assert.ok(sessionId, "create() returned a session id");
      const file = join(dir, `${sessionId}.jsonl`);
      assert.ok(await waitForFile(file), "header written by the real create() path");
      const header = JSON.parse(readFileSync(file, "utf-8").trim());
      assert.equal(header.type, "session_header");
      assert.equal(header.session_id, sessionId);
      assert.equal(header.provider, "acme-hdr-923");
      assert.equal(header.model, "acme-hdr-model");
      assert.equal(header.system_prompt, "transcript header e2e");
      assert.ok(header.created_at, "created_at present");
    } finally {
      await store.disposeAll();
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(sessionCwd, { recursive: true, force: true });
      if (prevOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = prevOffline;
    }
  });

  it("enabled: disposeAll drains pending turn writes (#923 review)", async () => {
    process.env.RECORD_TRANSCRIPTS = "1";
    const { store, id } = emittingStore("s-drain-e2e");
    await store.prompt(id, "run the tool");
    // Do NOT wait for the file here — disposeAll must drain the write chain.
    await store.disposeAll();
    const file = join(dir, "s-drain-e2e.jsonl");
    assert.ok(existsSync(file), "queued turn survived shutdown via drain");
  });
});

describe("runtime recording override (#935)", () => {
  const ENV_KEYS = ["RECORD_TRANSCRIPTS", "PI_SIDECAR_TRANSCRIPTS_DIR"] as const;
  let dir: string;
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    dir = tempTranscriptsDir();
    process.env.PI_SIDECAR_TRANSCRIPTS_DIR = dir;
  });
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    rmSync(dir, { recursive: true, force: true });
  });

  it("override wins over env in both directions; recordingState reports source", () => {
    const store = new SessionStore();
    assert.deepEqual(store.recordingState(), { enabled: false, source: "env" }, "off, env, by default");
    store.setRecordingOverride(true);
    assert.equal(store.isRecordingEnabled(), true, "override true beats env unset");
    assert.deepEqual(store.recordingState(), { enabled: true, source: "override" });
    process.env.RECORD_TRANSCRIPTS = "1";
    store.setRecordingOverride(false);
    assert.equal(store.isRecordingEnabled(), false, "override false beats env on");
    assert.deepEqual(store.recordingState(), { enabled: false, source: "override" });
  });

  it("reset restores the env default", () => {
    const store = new SessionStore();
    process.env.RECORD_TRANSCRIPTS = "1";
    store.setRecordingOverride(false);
    store.clearRecordingOverride();
    assert.deepEqual(store.recordingState(), { enabled: true, source: "env" });
  });

  it("clearing without an override set is a no-op", () => {
    const store = new SessionStore();
    store.clearRecordingOverride(); // must not throw
    assert.deepEqual(store.recordingState(), { enabled: false, source: "env" });
  });

  it("override state is per store instance, not module-global (Qodo 26046bd3)", () => {
    const a = new SessionStore();
    const b = new SessionStore();
    a.setRecordingOverride(true);
    assert.deepEqual(a.recordingState(), { enabled: true, source: "override" });
    assert.deepEqual(b.recordingState(), { enabled: false, source: "env" }, "store b unaffected by store a's override");
    a.clearRecordingOverride();
    assert.deepEqual(b.recordingState(), { enabled: false, source: "env" }, "still env-governed after a resets");
  });

  it("writeSessionHeader reports whether the line appended (Qodo 5ab0db39 contract)", async () => {
    const ok = await writeSessionHeader({ sessionId: "s-bool-ok", provider: "p", model: "m", redact: REDACT });
    assert.equal(ok, true, "successful append reports true");
    // A path whose parent is a regular file: mkdir fails, the write is
    // swallowed, and the return must be false so callers retry later.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a dir");
    process.env.PI_SIDECAR_TRANSCRIPTS_DIR = join(blocker, "sub");
    const failed = await writeSessionHeader({ sessionId: "s-bool-fail", provider: "p", model: "m", redact: REDACT });
    assert.equal(failed, false, "swallowed failure reports false");
  });

  it("a failed header write skips the turn — the transcript stays header-first (Qodo 7dad2203)", async () => {
    const store = new SessionStore();
    let emit: (event: unknown) => void = () => {};
    const id = "s-hdr-fail";
    (store as any).putSessionFixture(
      id,
      {
        subscribe: (cb: (event: unknown) => void) => {
          emit = cb;
          return () => {};
        },
        prompt: async () => {
          emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } });
          emit({
            type: "agent_end",
            messages: [
              { role: "user", content: [{ type: "text", text: "hi" }] },
              { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 3, output: 1 }, stopReason: "end_turn" },
            ],
          });
        },
        dispose: () => {},
        abort: async () => {},
      },
      "/tmp/hdr-fail",
      true,
    );
    store.setRecordingOverride(true);
    // Break the transcripts dir: its parent is a regular file, so mkdir and
    // every append fail. The lazy header fire AND the inline turn-slot retry
    // both fail → the turn is skipped, no file is created.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a dir");
    process.env.PI_SIDECAR_TRANSCRIPTS_DIR = join(blocker, "sub");
    await store.prompt(id, "hi");
    await drainTranscriptWrites();
    assert.ok(!existsSync(join(blocker, "sub", "s-hdr-fail.jsonl")), "no file when the header cannot be written");

    // Repair the dir: the next recorded prompt retries the header inline and
    // the file comes back HEADER-FIRST — never turn → header → turn.
    rmSync(blocker);
    process.env.PI_SIDECAR_TRANSCRIPTS_DIR = dir;
    await store.prompt(id, "again");
    await drainTranscriptWrites();
    const file = join(dir, "s-hdr-fail.jsonl");
    assert.ok(existsSync(file), "file written after repair");
    const lines = readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines[0].type, "session_header", "header is the first line after recovery");
    assert.equal(lines[lines.length - 1].type, "turn");
    assert.equal(lines.filter((l) => l.type === "session_header").length, 1, "exactly one header");
    await store.disposeAll();
  });

  it("enabling mid-session writes the header lazily before the first recorded turn", async () => {
    // Session prompts once with recording off (zero I/O), then recording is
    // enabled at runtime: the next prompt must produce header-then-turn, in
    // that order, with turn numbering starting at 1.
    const store = new SessionStore();
    let emit: (event: unknown) => void = () => {};
    const id = "s-mid-toggle";
    (store as any).putSessionFixture(
      id,
      {
        subscribe: (cb: (event: unknown) => void) => {
          emit = cb;
          return () => {};
        },
        prompt: async () => {
          emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } });
          emit({
            type: "agent_end",
            messages: [
              { role: "user", content: [{ type: "text", text: "hi" }] },
              { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 3, output: 1 }, stopReason: "end_turn" },
            ],
          });
        },
        dispose: () => {},
        abort: async () => {},
      },
      "/tmp/mid-toggle",
      true,
    );
    await store.prompt(id, "hi");
    assert.equal(readdirSyncSafe(dir).length, 0, "disabled: zero I/O");

    store.setRecordingOverride(true);
    await store.prompt(id, "again");
    const file = join(dir, "s-mid-toggle.jsonl");
    assert.ok(await waitForFileLazy(file), "turn written after enabling");
    await drainTranscriptWrites();
    const lines = readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].type, "session_header", "lazy header precedes first recorded turn");
    assert.equal(lines[0].session_id, "s-mid-toggle");
    assert.ok(
      Date.parse(lines[0].created_at) < Date.parse(lines[1].timestamp),
      "lazy header stamps the session's real creation time, not the first recorded turn's (Qodo 8597d8f7)",
    );
    assert.equal(lines[1].type, "turn");
    assert.equal(lines[1].turn_number, 1, "first recorded turn is turn 1 — disabled prompts do not consume numbers");

    // Disabling again stops later turns.
    store.setRecordingOverride(false);
    await store.prompt(id, "third");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const linesAfter = readFileSync(file, "utf-8").trim().split("\n");
    assert.equal(linesAfter.length, 2, "no further turns after disabling");

    // Re-enabling and prompting again must not queue a second header: the
    // synchronous headerPending flag guarantees at-most-one header regardless
    // of fs timing (Qodo 14c6e560).
    store.setRecordingOverride(true);
    await store.prompt(id, "fourth");
    await drainTranscriptWrites();
    const linesFinal = readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(linesFinal.filter((l) => l.type === "session_header").length, 1, "exactly one session_header, no duplicates");
    assert.equal(linesFinal.length, 3, "header + two recorded turns");
    assert.equal(linesFinal[2].turn_number, 2);
    await store.disposeAll();
  });
});

async function waitForFileLazy(path: string, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/** Last JSONL record in a transcript file (fixture files: lazy header + turns). */
function lastRecord(file: string): Record<string, any> {
  const lines = readFileSync(file, "utf-8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]!);
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
