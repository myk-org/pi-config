import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerAsyncAgents } from "../../../extensions/orchestrator/async-agents.js";
import { createLogger } from "../../../extensions/shared/logger.js";

const log = createLogger("async-kill-origin-test");

/** Agent-written: minimal registerAsyncAgents harness capturing commands, events and deliveries. */
function harness() {
  log.debug("create_harness");
  const cwd = mkdtempSync(join(tmpdir(), "async-kill-origin-"));
  const handlers = new Map<string, Array<(event: unknown, ctx: any) => void>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const events = new EventEmitter();
  const messages: any[] = [];
  const previousSetInterval = global.setInterval;
  global.setInterval = (() => ({ unref() {}, [Symbol.toPrimitive]: () => 0 })) as typeof setInterval;
  const pi = {
    on(event: string, handler: (event: unknown, ctx: any) => void) {
      const list = handlers.get(event);
      if (list) list.push(handler); else handlers.set(event, [handler]);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, command); },
    sendMessage(message: any) { messages.push(message); },
    events,
  };
  const api = registerAsyncAgents(pi as any, () => {}, {
    spawnProcess: () => Object.assign(new EventEmitter(), { stderr: { pipe() {} } }),
    discoverAgents: () => ({ agents: [{ name: "worker" }], sources: [] }),
  });
  const ctx = {
    cwd,
    hasUI: true,
    ui: { theme: { fg: (_: string, value: string) => value }, custom: async () => null, notify() {} },
    sessionManager: { getCwd: () => cwd, getSessionId: () => "test" },
  };
  handlers.get("session_start")![0]({}, ctx);
  const spawn = (options: Record<string, unknown> = {}) => api.spawnAsyncAgent("worker", "do the thing", cwd, [{ name: "worker" } as any], options);
  const statusJson = (id: string) => JSON.parse(readFileSync(join(cwd, ".pi", "tmp", id, "status.json"), "utf8"));
  const writeStatus = (id: string, patch: Record<string, unknown>) => {
    const path = join(cwd, ".pi", "tmp", id, "status.json");
    const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    writeFileSync(path, JSON.stringify({ ...existing, ...patch }), { mode: 0o600 });
  };
  // A running job's partial text lives only in output.log — status.json gets an `output`
  // key written to it only on the completion path, and job.output is undefined until then.
  // Seeded as real JSONL events, because that is what the worker actually writes: seeding
  // plain text produced a test that passed while the delivery shipped raw event JSON.
  const writeWorkerLog = (id: string, text: string) => {
    const lines = text.split("\n").filter((l) => l.trim());
    const jsonl = lines.map((line) =>
      line.startsWith("{")
        ? line
        : JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `${line}\n` } }),
    );
    writeFileSync(join(cwd, ".pi", "tmp", id, "output.log"), `${jsonl.join("\n")}\n`, { mode: 0o600 });
  };
  return { cwd, api, commands, ctx, events, messages, spawn, statusJson, writeStatus, writeWorkerLog, restore: () => { global.setInterval = previousSetInterval; rmSync(cwd, { recursive: true, force: true }); } };
}

describe("async kill origin attribution (issue #816)", () => {
  it("attributes a user kill to the user in status.json and delivery", () => {
    const h = harness();
    try {
      const job = h.spawn();
      const res = h.api.killAsyncAgent(job.id, "user");
      log.debug("kill_origin_case", { origin: "user", killed: res.killed });
      assert.deepEqual(res.killed, ["worker"]);
      assert.equal(h.statusJson(job.id).killOrigin, "user");
      assert.equal(h.statusJson(job.id).output, "Killed by user");
      assert.match(h.messages[0].content, /Killed by user/);
    } finally { h.restore(); }
  });

  it("attributes an orchestrator (subagent tool) kill to the orchestrator", () => {
    const h = harness();
    try {
      const job = h.spawn();
      h.api.killAsyncAgent(job.id, "orchestrator");
      log.debug("kill_origin_case", { origin: "orchestrator" });
      assert.equal(h.statusJson(job.id).killOrigin, "orchestrator");
      assert.equal(h.statusJson(job.id).output, "Killed by orchestrator");
      assert.match(h.messages[0].content, /Killed by orchestrator/);
      assert.doesNotMatch(h.messages[0].content, /Killed by user/);
    } finally { h.restore(); }
  });

  it("attributes a pitasks RPC stop to the task system", async () => {
    const h = harness();
    try {
      const job = h.spawn();
      const reply = new Promise<any>((resolve) => h.events.once("subagents:rpc:stop:reply:stop-1", resolve));
      h.events.emit("subagents:rpc:stop", { requestId: "stop-1", agentId: job.id });
      assert.equal((await reply).success, true);
      log.debug("kill_origin_case", { origin: "task-system", via: "subagents:rpc:stop" });
      assert.equal(h.statusJson(job.id).killOrigin, "task-system");
      assert.equal(h.statusJson(job.id).output, "Killed by task system");
      assert.match(h.messages[0].content, /Killed by task system/);
    } finally { h.restore(); }
  });

  it("attributes a pidash browser kill to the user", () => {
    const h = harness();
    try {
      const job = h.spawn();
      h.events.emit("pidash:async-kill", job.id);
      log.debug("kill_origin_case", { origin: "user", via: "pidash:async-kill" });
      assert.equal(h.statusJson(job.id).killOrigin, "user");
      assert.equal(h.statusJson(job.id).output, "Killed by user");
    } finally { h.restore(); }
  });

  it("no longer registers the /async-kill command", () => {
    const h = harness();
    try {
      assert.equal(h.commands.has("async-kill"), false);
      log.debug("kill_origin_case", { origin: "user", via: "removed /async-kill" });
    } finally { h.restore(); }
  });

  it("keeps the kill label in the delivery even when the agent produced output", () => {
    const h = harness();
    try {
      const job = h.spawn();
      h.api.killAsyncAgent(job.id, "orchestrator");
      log.debug("kill_origin_case", { origin: "orchestrator", withPriorOutput: true });
      assert.match(h.messages[0].content, /Killed by orchestrator/);
    } finally { h.restore(); }
  });

  it("preserves partial worker output below the kill label", () => {
    const h = harness();
    try {
      const job = h.spawn();
      // Seeded where a live job actually keeps it: output.log. The earlier version of this
      // test seeded status.json's `output`, which a running job never has — so it passed
      // while the real kill path delivered the label and nothing else.
      h.writeWorkerLog(job.id, "partial findings from the agent");
      h.api.killAsyncAgent(job.id, "task-system");
      const status = h.statusJson(job.id);
      assert.equal(status.output, "Killed by task system\npartial findings from the agent");
      assert.ok(
        status.output.indexOf("Killed by task system") < status.output.indexOf("partial findings from the agent"),
        "the label comes first, with prior output below it",
      );
      assert.equal(status.killOrigin, "task-system");
      // The delivery must carry the agent's text too, not just the label — an earlier
      // version preserved it on disk while the in-memory output stayed empty, so the AI
      // received the kill label alone.
      assert.match(h.messages[0].content, /Killed by task system/);
      assert.match(
        h.messages[0].content,
        /partial findings from the agent/,
        "the delivery must include the partial output the worker had produced",
      );
    } finally { h.restore(); }
  });

  it("recovers readable work from output.log, not raw event JSON", () => {
    const h = harness();
    try {
      const job = h.spawn();
      // Seed the raw event stream a killed worker leaves behind, including JSON the
      // parser must drop. The agent's actual work must survive; the noise must not.
      h.writeWorkerLog(job.id, "");
      writeFileSync(
        join(h.cwd, ".pi", "tmp", job.id, "output.log"),
        [
          JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "→ bash echo MARKER > partial.txt\n" } }),
          JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "echo MARKER > partial.txt" } }),
          JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "✓ MARKER\n" } }),
          JSON.stringify({ type: "token_usage", input: 10, output: 4, cacheRead: 0, cacheWrite: 0 }),
          JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", partial: '{"cmd":"' } }),
        ].join("\n"),
        { mode: 0o600 },
      );
      h.api.killAsyncAgent(job.id, "user");
      const delivered = String(h.messages[0].content);
      log.debug("kill_origin_case", { origin: "user", rawJsonl: true });
      assert.match(delivered, /MARKER/, "the work the agent actually did must reach the AI");
      assert.match(delivered, /echo MARKER > partial\.txt/, "the tool call must reach the AI");
      assert.ok(
        !/token_usage|toolcall_delta|"cacheRead"/.test(delivered),
        "raw event JSON must not be shipped to the AI",
      );
    } finally { h.restore(); }
  });

  it("keeps streamed word fragments intact instead of splitting them on newlines", () => {
    const h = harness();
    try {
      const job = h.spawn();
      // A worker streams one word across two text_delta events. Joining the parsed
      // values with "\n" turned "Hel" + "lo" into "Hel\nlo", corrupting the recovered
      // text of every killed agent; consecutive deltas must be concatenated verbatim.
      writeFileSync(
        join(h.cwd, ".pi", "tmp", job.id, "output.log"),
        [
          JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hel" } }),
          JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo" } }),
          JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " world" } }),
        ].join("\n"),
        { mode: 0o600 },
      );
      h.api.killAsyncAgent(job.id, "user");
      const delivered = String(h.messages[0].content);
      log.debug("kill_origin_case", { origin: "user", fragments: true });
      assert.match(delivered, /Hello world/, "consecutive text deltas must be joined without a separator");
    } finally { h.restore(); }
  });

  it("reads only a bounded tail of an unbounded output.log", () => {
    const h = harness();
    try {
      const job = h.spawn();
      // The runner appends output with no size cap, so recovery must not read the whole
      // file to keep a short tail. Pad past the 256 KiB tail bound with a single record
      // and assert the newest content still survives.
      const filler = "z".repeat(300 * 1024);
      writeFileSync(
        join(h.cwd, ".pi", "tmp", job.id, "output.log"),
        [
          JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `OLD ${filler}\n` } }),
          JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "NEWMARKER\n" } }),
        ].join("\n"),
        { mode: 0o600 },
      );
      h.api.killAsyncAgent(job.id, "user");
      const delivered = String(h.messages[0].content);
      log.debug("kill_origin_case", { origin: "user", boundedTail: true });
      assert.match(delivered, /NEWMARKER/, "the newest output must survive a bounded tail read");
    } finally { h.restore(); }
  });

  it("keeps a complete event that happens to start exactly at the tail boundary", () => {
    // Regression: the tail read discarded everything through the first newline
    // unconditionally, so when the offset landed exactly on a record boundary the one
    // complete event it held was thrown away. The first record fills the tail so the
    // read begins precisely at its first byte.
    const h = harness();
    try {
      const job = h.spawn();
      const TAIL = 256 * 1024;
      const boundaryMarker = "BOUNDARYMARKER";
      const bigRec = JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "old ".repeat(200_000) },
      }) + "\n";
      const boundaryRec = JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: `${boundaryMarker}\n` },
      }) + "\n";
      // boundaryRec + blank lines == exactly TAIL bytes, so the 256 KiB tail is precisely
      // this record followed by padding, and the byte before it is a newline.
      const content = bigRec + "\n".repeat(50) + boundaryRec + "\n".repeat(TAIL - boundaryRec.length);
      const tailStart = content.length - TAIL;
      assert.equal(content[tailStart], "{", "test setup: the tail starts at the record's first byte");
      assert.equal(content[tailStart - 1], "\n", "test setup: the preceding byte ends a record");
      writeFileSync(join(h.cwd, ".pi", "tmp", job.id, "output.log"), content, { mode: 0o600 });

      h.api.killAsyncAgent(job.id, "user");
      const delivered = String(h.messages[0].content);
      log.debug("kill_origin_case", { origin: "user", tailBoundary: true });
      assert.match(delivered, new RegExp(boundaryMarker),
        "a complete event starting at the tail boundary must not be discarded");
    } finally { h.restore(); }
  });

  it("recovers text from a final event larger than the whole tail", () => {
    // The sole surviving record spans the entire tail, so nothing parses. Its delta is
    // still intact up to the cut and must reach the delivery rather than the kill label
    // alone. The marker sits at the end so it survives the delivery budget's kept tail.
    const h = harness();
    try {
      const job = h.spawn();
      const giant = JSON.stringify({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: `${"y".repeat(300 * 1024)} GIANTMARKER`,
        },
      }) + "\n";
      writeFileSync(join(h.cwd, ".pi", "tmp", job.id, "output.log"), giant, { mode: 0o600 });

      h.api.killAsyncAgent(job.id, "user");
      const delivered = String(h.messages[0].content);
      log.debug("kill_origin_case", { origin: "user", oversizedTail: true });
      assert.match(delivered, /GIANTMARKER/,
        "an event spanning the tail boundary must still contribute its text");
    } finally { h.restore(); }
  });

  it("never recovers a complete non-text event the parser rejects", () => {
    // Regression: the truncated-record fallback ran on every unparsed line, so a complete
    // toolcall_delta — which parseAsyncOutputLine deliberately rejects — had its `delta`
    // lifted and the killed worker's raw tool arguments shipped as its output.
    const h = harness();
    try {
      const job = h.spawn();
      const rawArg = "RAWARGVALUE";
      writeFileSync(
        join(h.cwd, ".pi", "tmp", job.id, "output.log"),
        [
          JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "kept output\n" } }),
          JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: `{"command":"echo ${rawArg}"}` } }),
        ].join("\n"),
        { mode: 0o600 },
      );
      h.api.killAsyncAgent(job.id, "user");
      const delivered = String(h.messages[0].content);
      log.debug("kill_origin_case", { origin: "user", rejectedEvent: true });
      assert.match(delivered, /kept output/, "the real text event is still recovered");
      assert.ok(!delivered.includes(rawArg),
        "raw tool arguments from a rejected event must not appear in the delivery");
      assert.ok(!/toolcall_delta/.test(delivered), "rejected event JSON must not be shipped");
    } finally { h.restore(); }
  });

  it("does not promote quoted stderr to recovered agent output", () => {
    // Regression: the bare-fragment fallback accepted any unparsed line containing a quote,
    // so a diagnostic on stderr — which the runner writes into output.log — became output.
    const h = harness();
    try {
      const job = h.spawn();
      const diagnostic = "STDERBDIAGNOSTIC";
      writeFileSync(
        join(h.cwd, ".pi", "tmp", job.id, "output.log"),
        [
          JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "kept output\n" } }),
          `Error: cannot open "/tmp/${diagnostic}.sock": no such file or directory`,
        ].join("\n"),
        { mode: 0o600 },
      );
      h.api.killAsyncAgent(job.id, "user");
      const delivered = String(h.messages[0].content);
      log.debug("kill_origin_case", { origin: "user", stderrLine: true });
      assert.match(delivered, /kept output/, "the real text event is still recovered");
      assert.ok(!delivered.includes(diagnostic), "stderr must never appear as agent output");
    } finally { h.restore(); }
  });

  it("recovers a partial final text event from a small whole-file log", () => {
    // Regression: recovery was gated on the FIRST line of a bounded read, so the partial
    // final event a worker killed MID-WRITE leaves behind — the exact case recovery exists
    // for — was dropped whenever the log was read whole.
    const h = harness();
    try {
      const job = h.spawn();
      const partial = "MIDWRITEDELTA";
      writeFileSync(
        join(h.cwd, ".pi", "tmp", job.id, "output.log"),
        [
          JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "earlier complete line\n" } }),
          // Cut mid-value: the record never closed, exactly as a mid-write kill leaves it.
          `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"${partial}`,
        ].join("\n"),
        { mode: 0o600 },
      );
      h.api.killAsyncAgent(job.id, "user");
      const delivered = String(h.messages[0].content);
      log.debug("kill_origin_case", { origin: "user", partialFinalSmall: true });
      assert.match(delivered, /earlier complete line/, "complete events are still recovered");
      assert.match(delivered, new RegExp(partial),
        "a partial final text event must reach the delivery");
    } finally { h.restore(); }
  });

  it("recovers a partial final text event that follows complete records in a bounded tail", () => {
    const h = harness();
    try {
      const job = h.spawn();
      const TAIL = 256 * 1024;
      const partial = "TAILFINALDELTA";
      const bigRec = JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "old ".repeat(200_000) },
      }) + "\n";
      const content = bigRec + "\n".repeat(50) + "\n".repeat(TAIL - 60)
        + `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"${partial}`;
      assert.ok(content.length > TAIL, "test setup: the read is a bounded tail");
      writeFileSync(join(h.cwd, ".pi", "tmp", job.id, "output.log"), content, { mode: 0o600 });

      h.api.killAsyncAgent(job.id, "user");
      const delivered = String(h.messages[0].content);
      log.debug("kill_origin_case", { origin: "user", partialFinalTail: true });
      assert.match(delivered, new RegExp(partial),
        "a partial final text event must reach the delivery even after earlier records");
    } finally { h.restore(); }
  });

  it("does not lift a delta from a TRUNCATED non-text event", () => {
    // Guards the content check, not the position check: a tool-call update cut mid-write is
    // incomplete JSON too, so only the presence of the event's own type markers distinguishes
    // it from a partial assistant event.
    const h = harness();
    try {
      const job = h.spawn();
      const rawArg = "RAWARGVALUE";
      writeFileSync(
        join(h.cwd, ".pi", "tmp", job.id, "output.log"),
        [
          JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "kept output\n" } }),
          `{"type":"message_update","assistantMessageEvent":{"type":"toolcall_delta","delta":"{\\"command\\":\\"echo ${rawArg}`,
        ].join("\n"),
        { mode: 0o600 },
      );
      h.api.killAsyncAgent(job.id, "user");
      const delivered = String(h.messages[0].content);
      log.debug("kill_origin_case", { origin: "user", truncatedToolCall: true });
      assert.match(delivered, /kept output/, "the real text event is still recovered");
      assert.ok(!delivered.includes(rawArg),
        "a truncated tool-call update must not be lifted as agent text");
    } finally { h.restore(); }
  });

  it("keeps the newest partial output when it exceeds the delivery budget", () => {
    const h = harness();
    try {
      const job = h.spawn();
      // Chatty worker: far more output than the delivery budget. formatAsyncResultOutput
      // keeps the HEAD of its budget, so a tail kept by the recovery step and then
      // re-trimmed from the head would deliver the OLDEST lines and drop the ones
      // immediately before the kill — the context that explains the kill.
      const lines: string[] = [];
      for (let i = 0; i < 4000; i++) lines.push(`line ${i} ${"x".repeat(20)}`);
      h.writeWorkerLog(job.id, lines.join("\n"));
      h.api.killAsyncAgent(job.id, "user");
      const delivered = String(h.messages[0].content);
      const status = h.statusJson(job.id);
      log.debug("kill_origin_case", { origin: "user", chatty: true });
      assert.match(delivered, /earlier output truncated/);
      assert.match(
        delivered,
        /line 3999/,
        "the newest output must survive, not the oldest",
      );
      assert.ok(
        !/line 0 x/.test(delivered),
        "the oldest output must be the part dropped",
      );
      assert.ok(delivered.length <= 3200, `delivery must stay within budget, got ${delivered.length}`);
      // status.json and the delivered body must be the same string: the kill path writes
      // one composed value to both, and a second trim inside formatAsyncResultOutput would
      // silently make them diverge above the budget.
      const deliveredBody = delivered.slice(delivered.lastIndexOf("\n\n") + 2);
      assert.equal(
        status.output,
        deliveredBody,
        "status.json and the delivered body must be byte-identical",
      );
    } finally { h.restore(); }
  });

  it("truncates a very long partial worker output instead of delivering all of it", () => {
    const h = harness();
    try {
      const job = h.spawn();
      h.writeWorkerLog(job.id, "x".repeat(20000));
      h.api.killAsyncAgent(job.id, "user");
      const delivered = String(h.messages[0].content);
      assert.ok(delivered.length < 12000, `delivery must be capped, got ${delivered.length} chars`);
      assert.match(delivered, /earlier output truncated/);
    } finally { h.restore(); }
  });

  it("keeps the kill label on grouped jobs so group delivery carries attribution", () => {
    const h = harness();
    try {
      const job = h.spawn({ groupId: "group-886" });
      h.api.killAsyncAgent(job.id, "orchestrator");
      log.debug("kill_origin_case", { origin: "orchestrator", grouped: true });
      // Group delivery reads the in-memory job output, not status.json, so the label
      // has to live there too or the AI and pitasks lose attribution entirely.
      const delivered = h.messages.map((m: any) => String(m.content)).join("\n");
      assert.ok(h.messages.length > 0, "a completed group delivers its results");
      assert.match(delivered, /Killed by orchestrator/, "group delivery carries the kill origin in the body");
      // The group header must also name who killed it, matching the non-grouped header.
      assert.match(
        delivered,
        /## Async Agent Result: .* — Killed by orchestrator/,
        "the group header must carry the attribution suffix",
      );
    } finally { h.restore(); }
  });

  it("falls back to user attribution for an unrecognised runtime origin", () => {
    const h = harness();
    try {
      const job = h.spawn();
      h.api.killAsyncAgent(job.id, "definitely-not-an-origin" as any);
      log.debug("kill_origin_case", { origin: "invalid" });
      assert.equal(h.statusJson(job.id).killOrigin, "user");
      assert.equal(h.statusJson(job.id).output, "Killed by user");
    } finally { h.restore(); }
  });

  it("falls back to user attribution for an Object.prototype key", () => {
    const h = harness();
    try {
      const job = h.spawn();
      // `toString` and friends are truthy on a plain object literal, so a naive
      // lookup accepted them and made the label a function rather than a string.
      h.api.killAsyncAgent(job.id, "toString" as any);
      log.debug("kill_origin_case", { origin: "prototype-key" });
      const status = h.statusJson(job.id);
      assert.equal(status.killOrigin, "user");
      assert.equal(
        typeof status.output,
        "string",
        "the label must never be a function's source",
      );
      // Assert the label is line 1 rather than exact-equality on the whole string: a job
      // that produced output legitimately carries "<label>\n<partial>", so an exact match
      // only holds for a job with no output and stops describing real behaviour.
      assert.equal(status.output.split("\n")[0], "Killed by user");
      assert.ok(
        !status.output.includes("function"),
        "a prototype key must never leak a function's source",
      );
    } finally { h.restore(); }
  });
});
