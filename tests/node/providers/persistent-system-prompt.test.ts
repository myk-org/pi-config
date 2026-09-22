import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createAcpxAdapter } from "../../../extensions/providers/acpx-driver.js";
import { createClaudeAdapter } from "../../../extensions/providers/claude-driver.js";
import { createCursorAcpxAdapter } from "../../../extensions/providers/cursor-acpx-driver.js";
import { createCursorCliAdapter } from "../../../extensions/providers/cursor-cli-driver.js";
import { createGeminiAdapter } from "../../../extensions/providers/gemini-driver.js";
import { clearLogLevelCache, getPiLogPath, setGlobalSessionId } from "../../../extensions/shared/file-logger.js";

function fakeCli(fn: (binary: string, output: string, args: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "persistent-prompt-"));
  const binary = join(dir, "agent");
  const output = join(dir, "prompts");
  const args = join(dir, "args");
  const count = join(dir, "count");
  writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$ARGS_OUTPUT"\ncat >> "$PROMPT_OUTPUT"\nn=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)\nn=$((n+1)); echo "$n" > "$COUNT_FILE"\nprintf '{"type":"result","session_id":"session-%s","result":"ok"}\\n' "$n"\n`, { mode: 0o755 });
  chmodSync(binary, 0o755);
  const previous = { ARGS_OUTPUT: process.env.ARGS_OUTPUT, COUNT_FILE: process.env.COUNT_FILE, HOME: process.env.HOME, PROMPT_OUTPUT: process.env.PROMPT_OUTPUT };
  process.env.ARGS_OUTPUT = args;
  process.env.COUNT_FILE = count;
  process.env.HOME = dir;
  process.env.PROMPT_OUTPUT = output;
  return fn(binary, output, args).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
}

describe("persistent provider system prompts", () => {
  for (const [name, create] of [
    ["Claude", createClaudeAdapter],
    ["Gemini", createGeminiAdapter],
    ["Cursor", createCursorCliAdapter],
  ] as const) {
    it(`${name} CLI applies a prompt change in a new external session`, async () => {
      await fakeCli(async (binary, output) => {
        const adapter = create({ binary, enabled: true }, process.cwd(), "test");
        let handle = await adapter.startSession({ model: "default", systemPrompt: "first-system", cwd: process.cwd() });
        await adapter.sendTurn(handle, "one");
        handle = await adapter.startSession({ model: "default", systemPrompt: "second-system", cwd: process.cwd() });
        await adapter.sendTurn(handle, "two");
        const prompts = readFileSync(output, "utf8");
        assert.match(prompts, /first-system/);
        assert.match(prompts, /second-system/);
      });
    });

    it(`${name} CLI removes a prompt in a new external session`, async () => {
      await fakeCli(async (binary, output, args) => {
        const adapter = create({ binary, enabled: true }, process.cwd(), "test");
        let handle = await adapter.startSession({ model: "default", systemPrompt: "first-system", cwd: process.cwd() });
        await adapter.sendTurn(handle, "one");
        handle = await adapter.startSession({ model: "default", cwd: process.cwd() });
        const result = await adapter.sendTurn(handle, "plain-prompt");
        const invocations = readFileSync(args, "utf8").trim().split("\n");
        assert.equal(readFileSync(output, "utf8").trim().endsWith("plain-prompt"), true);
        assert.doesNotMatch(invocations[1], /session-1/, `${name} must not resume the prompted session after removal`);
        assert.equal(result.sessionId, "session-2", `${name} must persist a fresh external session identity`);
      });
    });
  }

  for (const [name, domain, create] of [
    ["Claude", "claude-driver", createClaudeAdapter],
    ["Gemini", "gemini-driver", createGeminiAdapter],
    ["Cursor", "cursor-cli-driver", createCursorCliAdapter],
  ] as const) {
    it(`${name} CLI logs safe start-session context`, async () => {
      await fakeCli(async (binary) => {
        const envKey = `PI_LOG_${domain.toUpperCase().replaceAll("-", "_")}`;
        const previous = process.env[envKey];
        process.env[envKey] = "debug";
        clearLogLevelCache();
        setGlobalSessionId(`start-log-${domain}`);
        try {
          const adapter = create({ binary, enabled: true }, process.cwd(), "test");
          await adapter.startSession({ model: "logged-model", systemPrompt: "secret-prompt", cwd: process.cwd() });
          const body = readFileSync(getPiLogPath(domain)!, "utf8");
          assert.match(body, /starting CLI session/);
          assert.match(body, /"model":"logged-model"/);
          assert.match(body, /"cwd":"[^"]+"/);
          assert.match(body, /"hasSystemPrompt":true/);
          assert.doesNotMatch(body, /secret-prompt/);
        } finally {
          if (previous === undefined) delete process.env[envKey]; else process.env[envKey] = previous;
          clearLogLevelCache();
        }
      });
    });
  }

  it("CLI fallback without an explicit system prompt does not inject undefined", async () => {
    await fakeCli(async (binary, output) => {
      const adapter = createCursorCliAdapter({ binary, enabled: true }, process.cwd(), "test");
      const handle = await adapter.startSession({ model: "default", cwd: process.cwd() });
      await adapter.sendTurn(handle, "plain-prompt");
      assert.equal(readFileSync(output, "utf8").trim(), "plain-prompt");
    });
  });

  for (const [name, create] of [
    ["generic ACPX", createAcpxAdapter],
    ["Cursor ACPX", createCursorAcpxAdapter],
  ] as const) {
    it(`${name} recreates a session for a prompt change`, async () => {
      const ensured: any[] = [];
      const closed: any[] = [];
      const runtime = {
        ensureSession: async (options: any) => { ensured.push(options); return { id: ensured.length }; },
        close: async (options: any) => { closed.push(options); },
        startTurn: () => ({ events: (async function* () {})(), result: Promise.resolve({ status: "completed", stopReason: "end_turn" }) }),
        getStatus: async () => ({}),
      } as any;
      const adapter = create({ agent: "cursor", enabled: true }, process.cwd(), runtime);
      let handle = await adapter.startSession({ model: "default", systemPrompt: "first-system", cwd: process.cwd() });
      await adapter.sendTurn(handle, "one");
      handle = await adapter.startSession({ model: "default", systemPrompt: "second-system", cwd: process.cwd() });
      await adapter.sendTurn(handle, "two");
      assert.equal(closed.length, 1);
      assert.equal(ensured[1].sessionOptions.systemPrompt, "second-system");
    });

    it(`${name} recreates a session for prompt removal`, async () => {
      const ensured: any[] = [];
      const closed: any[] = [];
      const runtime = {
        ensureSession: async (options: any) => { ensured.push(options); return { id: ensured.length }; },
        close: async (options: any) => { closed.push(options); },
        startTurn: () => ({ events: (async function* () {})(), result: Promise.resolve({ status: "completed", stopReason: "end_turn" }) }),
        getStatus: async () => ({}),
      } as any;
      const adapter = create({ agent: "cursor", enabled: true }, process.cwd(), runtime);
      let handle = await adapter.startSession({ model: "default", systemPrompt: "first-system", cwd: process.cwd() });
      await adapter.sendTurn(handle, "one");
      handle = await adapter.startSession({ model: "default", cwd: process.cwd() });
      await adapter.sendTurn(handle, "two");
      assert.equal(closed.length, 1);
      assert.equal(ensured[1].sessionOptions, undefined);
    });
  }

  for (const [name, create] of [
    ["Claude", createClaudeAdapter],
    ["Gemini", createGeminiAdapter],
    ["Cursor", createCursorCliAdapter],
  ] as const) {
    it(`${name} CLI retries a failed prompt application`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "failed-prompt-"));
      const binary = join(dir, "agent");
      const output = join(dir, "prompts");
      const count = join(dir, "count");
      writeFileSync(binary, `#!/bin/sh\ncat >> "$PROMPT_OUTPUT"\nn=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)\nn=$((n+1)); echo "$n" > "$COUNT_FILE"\nif [ "$n" -eq 1 ]; then exit 1; fi\nprintf '%s\\n' '{"type":"result","session_id":"session-1","result":"ok"}'\n`, { mode: 0o755 });
      const previousOutput = process.env.PROMPT_OUTPUT;
      const previousCount = process.env.COUNT_FILE;
      process.env.PROMPT_OUTPUT = output;
      process.env.COUNT_FILE = count;
      try {
        const adapter = create({ binary, enabled: true }, process.cwd(), "test");
        const handle = await adapter.startSession({ model: "default", systemPrompt: "retry-system", cwd: process.cwd() });
        await assert.rejects(adapter.sendTurn(handle, "one"));
        await adapter.sendTurn(handle, "two");
        assert.equal(readFileSync(output, "utf8").match(/retry-system/g)?.length, 2);
      } finally {
        if (previousOutput === undefined) delete process.env.PROMPT_OUTPUT; else process.env.PROMPT_OUTPUT = previousOutput;
        if (previousCount === undefined) delete process.env.COUNT_FILE; else process.env.COUNT_FILE = previousCount;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  for (const [name, create] of [
    ["generic ACPX", createAcpxAdapter],
    ["Cursor ACPX", createCursorAcpxAdapter],
  ] as const) {
    it(`${name} uses the latest prompt when starts overlap`, async () => {
      const ensured: any[] = [];
      const closed: any[] = [];
      const turns: any[] = [];
      let releaseFirst!: (handle: any) => void;
      const first = new Promise<any>((resolve) => { releaseFirst = resolve; });
      const runtime = {
        ensureSession: (options: any) => {
          ensured.push(options);
          return ensured.length === 1 ? first : Promise.resolve({ id: ensured.length });
        },
        close: async (options: any) => { closed.push(options); },
        startTurn: (options: any) => {
          turns.push(options);
          return { events: (async function* () {})(), result: Promise.resolve({ status: "completed", stopReason: "end_turn" }) };
        },
        getStatus: async () => ({}),
      } as any;
      const adapter = create({ agent: "cursor", enabled: true }, process.cwd(), runtime);
      const startA = adapter.startSession({ model: "default", systemPrompt: "prompt-A", cwd: process.cwd() });
      await new Promise(resolve => setImmediate(resolve));
      const startB = adapter.startSession({ model: "default", systemPrompt: "prompt-B", cwd: process.cwd() });
      releaseFirst({ id: 1 });
      const [, handleB] = await Promise.all([startA, startB]);
      await adapter.sendTurn(handleB, "turn");
      assert.deepEqual(ensured.map(options => options.sessionOptions.systemPrompt), ["prompt-A", "prompt-B"]);
      assert.equal(closed[0].handle.id, 1);
      assert.equal(turns[0].handle.id, 2);
    });
  }

  for (const [name, create] of [
    ["generic ACPX", createAcpxAdapter],
    ["Cursor ACPX", createCursorAcpxAdapter],
  ] as const) {
    it(`${name} serializes overlapping replacements behind a live handle`, async () => {
      const ensured: any[] = [];
      const closed: any[] = [];
      const turns: any[] = [];
      const live = new Set<any>();
      let releaseCloseA!: () => void;
      const closeA = new Promise<void>((resolve) => { releaseCloseA = resolve; });
      const runtime = {
        ensureSession: async (options: any) => {
          ensured.push(options);
          const handle = { id: options.sessionOptions.systemPrompt };
          live.add(handle);
          return handle;
        },
        close: async (options: any) => {
          closed.push(options);
          if (options.handle.id === "prompt-A") await closeA;
          live.delete(options.handle);
        },
        startTurn: (options: any) => {
          turns.push(options);
          return { events: (async function* () {})(), result: Promise.resolve({ status: "completed", stopReason: "end_turn" }) };
        },
        getStatus: async () => ({}),
      } as any;
      const adapter = create({ agent: "cursor", enabled: true }, process.cwd(), runtime);
      const handleA = await adapter.startSession({ model: "default", systemPrompt: "prompt-A", cwd: process.cwd() });
      await adapter.sendTurn(handleA, "turn-A");

      const startB = adapter.startSession({ model: "default", systemPrompt: "prompt-B", cwd: process.cwd() });
      await new Promise(resolve => setImmediate(resolve));
      const startC = adapter.startSession({ model: "default", systemPrompt: "prompt-C", cwd: process.cwd() });
      await new Promise(resolve => setImmediate(resolve));
      releaseCloseA();
      const [, handleC] = await Promise.all([startB, startC]);
      await adapter.sendTurn(handleC, "turn-C");
      await adapter.startSession({ model: "default", systemPrompt: "prompt-C", cwd: process.cwd() });

      assert.deepEqual(ensured.map(options => options.sessionOptions.systemPrompt), ["prompt-A", "prompt-B", "prompt-C"]);
      assert.deepEqual(closed.map(options => options.handle.id), ["prompt-A", "prompt-B"]);
      assert.deepEqual([...live].map(handle => handle.id), ["prompt-C"]);
      assert.equal(turns.at(-1).handle.id, "prompt-C");
      assert.equal(ensured.length, 3, "completed queue cleanup must not delete a newer operation");
    });

    it(`${name} continues replacement after a queued failure`, async () => {
      let attempts = 0;
      const runtime = {
        ensureSession: async (options: any) => {
          if (++attempts === 1) throw new Error("create failed");
          return { id: options.sessionOptions.systemPrompt };
        },
        close: async () => {},
        startTurn: (options: any) => ({ events: (async function* () {})(), result: Promise.resolve({ status: "completed", stopReason: "end_turn" }) }),
        getStatus: async () => ({}),
      } as any;
      const adapter = create({ agent: "cursor", enabled: true }, process.cwd(), runtime);
      await assert.rejects(adapter.startSession({ model: "default", systemPrompt: "prompt-B", cwd: process.cwd() }), /create failed/);
      const handle = await adapter.startSession({ model: "default", systemPrompt: "prompt-C", cwd: process.cwd() });
      await adapter.sendTurn(handle, "turn-C");
      assert.equal(attempts, 2);
    });

    it(`${name} disposal waits for queued replacement work`, async () => {
      let releaseCreate!: () => void;
      const createPending = new Promise<void>((resolve) => { releaseCreate = resolve; });
      const closed: any[] = [];
      const runtime = {
        ensureSession: async () => { await createPending; return { id: "prompt-A" }; },
        close: async (options: any) => { closed.push(options); },
        startTurn: () => ({ events: (async function* () {})(), result: Promise.resolve({ status: "completed", stopReason: "end_turn" }) }),
        getStatus: async () => ({}),
      } as any;
      const adapter = create({ agent: "cursor", enabled: true }, process.cwd(), runtime);
      const start = adapter.startSession({ model: "default", systemPrompt: "prompt-A", cwd: process.cwd() });
      await new Promise(resolve => setImmediate(resolve));
      const dispose = adapter.stopAll();
      releaseCreate();
      const handle = await start;
      await dispose;
      assert.deepEqual(closed.map(options => options.handle.id), ["prompt-A"]);
      assert.equal(adapter.hasSession(handle.sessionId), false);
    });
  }

  it("Cursor ACPX retries a failed prompt application", async () => {
    const ensured: any[] = [];
    let turns = 0;
    const runtime = {
      ensureSession: async (options: any) => { ensured.push(options); return { id: ensured.length }; },
      close: async () => {},
      startTurn: () => ({
        events: (async function* () {})(),
        result: Promise.resolve(++turns === 1 ? { status: "failed", error: { message: "no" } } : { status: "completed", stopReason: "end_turn" }),
      }),
      getStatus: async () => ({}),
    } as any;
    const adapter = createCursorAcpxAdapter({ agent: "cursor", enabled: true }, process.cwd(), runtime);
    const handle = await adapter.startSession({ model: "default", systemPrompt: "retry-system", cwd: process.cwd() });
    await assert.rejects(adapter.sendTurn(handle, "one"));
    await adapter.sendTurn(handle, "two");
    assert.equal(ensured.length, 1, "failed application must remain pending on the same prompted handle");
  });

  it("generic ACPX replaces an unprompted discovery handle before its first turn", async () => {
    const initialHandle = { id: "discovery" };
    const ensured: any[] = [];
    const closed: any[] = [];
    const runtime = {
      ensureSession: async (options: any) => { ensured.push(options); return { id: ensured.length }; },
      close: async (options: any) => { closed.push(options); },
      startTurn: () => ({ events: (async function* () {})(), result: Promise.resolve({ status: "completed", stopReason: "end_turn" }) }),
      getStatus: async () => ({}),
    } as any;
    const adapter = createAcpxAdapter({ agent: "cursor", enabled: true }, process.cwd(), runtime, initialHandle as any);
    const handle = await adapter.startSession({ model: "default", systemPrompt: "first-system", cwd: process.cwd() });
    await adapter.sendTurn(handle, "one");
    assert.equal(closed[0].handle, initialHandle);
    assert.equal(ensured[0].sessionOptions.systemPrompt, "first-system");
  });
});
