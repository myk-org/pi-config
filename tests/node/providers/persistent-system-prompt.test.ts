import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
        const previousEnvSessionId = process.env.__PI_CONFIG_SESSION_ID;
        const previousGlobalSessionId = globalThis.__piConfigSessionId;
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
          if (previousEnvSessionId === undefined) delete process.env.__PI_CONFIG_SESSION_ID;
          else process.env.__PI_CONFIG_SESSION_ID = previousEnvSessionId;
          if (previousGlobalSessionId === undefined) delete globalThis.__piConfigSessionId;
          else globalThis.__piConfigSessionId = previousGlobalSessionId;
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
      await assert.rejects(start, /disposed/);
      await dispose;
      assert.deepEqual(closed.map(options => options.handle.id), ["prompt-A"]);
    });
  }

  for (const [name, domain, create] of [
    ["generic ACPX", "acpx-driver", createAcpxAdapter],
    ["Cursor ACPX", "cursor-acpx-driver", createCursorAcpxAdapter],
  ] as const) {
    it(`${name} waits for an active turn before replacing its prompt`, async () => {
      let releaseResult!: () => void;
      const pendingResult = new Promise<void>((resolve) => { releaseResult = resolve; });
      const closed: any[] = [];
      const ensured: any[] = [];
      const turns: any[] = [];
      const runtime = {
        ensureSession: async (options: any) => {
          ensured.push(options);
          return { id: options.sessionOptions.systemPrompt };
        },
        close: async (options: any) => { closed.push(options); },
        startTurn: (options: any) => {
          turns.push(options);
          return {
            events: (async function* () {})(),
            result: pendingResult.then(() => ({ status: "completed", stopReason: "end_turn" })),
          };
        },
        getStatus: async () => ({}),
      } as any;
      const adapter = create({ agent: "cursor", enabled: true }, process.cwd(), runtime);
      const handle = await adapter.startSession({ model: "default", systemPrompt: "active-secret", cwd: process.cwd() });
      const turn = adapter.sendTurn(handle, "turn-secret");
      await new Promise(resolve => setImmediate(resolve));
      const replacement = adapter.startSession({ model: "default", systemPrompt: "replacement-secret", cwd: process.cwd() });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(closed.length, 0, "replacement must not close an active turn");
      releaseResult();
      await turn;
      const replacementHandle = await replacement;
      await adapter.sendTurn(replacementHandle, "next-turn");
      assert.deepEqual(closed.map(item => item.handle.id), ["active-secret"]);
      assert.equal(turns.at(-1).handle.id, "replacement-secret");
    });

    for (const closeFails of [false, true]) {
      it(`${name} stopSession invalidates a queued replacement when close ${closeFails ? "fails" : "succeeds"}`, async () => {
        let releaseReplacement!: () => void;
        const replacementPending = new Promise<void>((resolve) => { releaseReplacement = resolve; });
        const ensured: any[] = [];
        const closed: any[] = [];
        const runtime = {
          ensureSession: async (options: any) => {
            ensured.push(options);
            if (ensured.length === 2) await replacementPending;
            return { id: ensured.length };
          },
          close: async (options: any) => {
            closed.push(options);
            if (closeFails && options.reason === "session stop") throw new Error("close failed");
          },
          startTurn: () => ({ events: (async function* () {})(), result: Promise.resolve({ status: "completed", stopReason: "end_turn" }) }),
          getStatus: async () => ({}),
        } as any;
        const adapter = create({ agent: "cursor", enabled: true }, process.cwd(), runtime);
        const first = await adapter.startSession({ model: "default", systemPrompt: "first-secret", cwd: process.cwd() });
        const replacement = adapter.startSession({ model: "default", systemPrompt: "queued-secret", cwd: process.cwd() });
        await new Promise(resolve => setImmediate(resolve));
        const stop = adapter.stopSession(first);
        releaseReplacement();
        await assert.rejects(replacement, /stopped|generation/i);
        await stop;
        assert.equal(closed.filter(item => item.reason === "session invalidated during creation").length, 1);
        assert.equal(adapter.hasSession(first.sessionId), false);
        const fresh = await adapter.startSession({ model: "default", systemPrompt: "fresh-secret", cwd: process.cwd() });
        await adapter.sendTurn(fresh, "fresh-turn");
        assert.equal(ensured.length, 3, "stop must clear handle and prompt state");
      });
    }

    it(`${name} disposal drains accepted starts while rejecting later starts`, async () => {
      let releaseCreate!: () => void;
      const createPending = new Promise<void>((resolve) => { releaseCreate = resolve; });
      const created: any[] = [];
      const closed: any[] = [];
      const runtime = {
        ensureSession: async () => {
          await createPending;
          const handle = { id: created.length + 1 };
          created.push(handle);
          return handle;
        },
        close: async (options: any) => { closed.push(options.handle); },
        startTurn: () => ({ events: (async function* () {})(), result: Promise.resolve({ status: "completed", stopReason: "end_turn" }) }),
        getStatus: async () => ({}),
      } as any;
      const adapter = create({ agent: "cursor", enabled: true }, process.cwd(), runtime);
      const accepted = adapter.startSession({ model: "default", systemPrompt: "accepted-secret", cwd: process.cwd() });
      await new Promise(resolve => setImmediate(resolve));
      const dispose = adapter.stopAll();
      await assert.rejects(
        adapter.startSession({ model: "other", systemPrompt: "during-secret", cwd: process.cwd() }),
        /disposed/,
      );
      releaseCreate();
      await assert.rejects(accepted, /disposed/);
      await dispose;
      await assert.rejects(
        adapter.startSession({ model: "after", systemPrompt: "after-secret", cwd: process.cwd() }),
        /disposed/,
      );
      assert.deepEqual(closed, created);
      assert.equal(created.length, 1);
    });

    it(`${name} lifecycle logs safe queue context`, async () => {
      const envKey = `PI_LOG_${domain.toUpperCase().replaceAll("-", "_")}`;
      const previous = process.env[envKey];
      const previousEnvSessionId = process.env.__PI_CONFIG_SESSION_ID;
      const previousGlobalSessionId = globalThis.__piConfigSessionId;
      process.env[envKey] = "debug";
      clearLogLevelCache();
      setGlobalSessionId(`lifecycle-log-${domain}`);
      const runtime = {
        ensureSession: async () => ({ id: 1 }),
        close: async () => {},
        startTurn: () => ({ events: (async function* () {})(), result: Promise.resolve({ status: "completed", stopReason: "end_turn" }) }),
        getStatus: async () => ({}),
      } as any;
      try {
        const adapter = create({ agent: "cursor", enabled: true }, process.cwd(), runtime);
        const handle = await adapter.startSession({ model: "safe-model", systemPrompt: "ensure-secret", cwd: process.cwd() });
        await adapter.stopSession(handle);
        await adapter.startSession({ model: "other-model", systemPrompt: "stop-all-secret", cwd: process.cwd() });
        await adapter.stopAll();
        const body = readFileSync(getPiLogPath(domain)!, "utf8");
        assert.match(body, /ensuring ACPX handle/);
        assert.match(body, /stopping ACPX session/);
        assert.match(body, /stopping all ACPX sessions/);
        assert.match(body, /"model":"safe-model"/);
        assert.match(body, /"key":"[^" ]+"/);
        assert.match(body, /"replacement":false/);
        assert.match(body, /"queued":false/);
        assert.doesNotMatch(body, /ensure-secret|stop-all-secret/);
      } finally {
        if (previous === undefined) delete process.env[envKey]; else process.env[envKey] = previous;
        if (previousEnvSessionId === undefined) delete process.env.__PI_CONFIG_SESSION_ID;
        else process.env.__PI_CONFIG_SESSION_ID = previousEnvSessionId;
        if (previousGlobalSessionId === undefined) delete globalThis.__piConfigSessionId;
        else globalThis.__piConfigSessionId = previousGlobalSessionId;
        clearLogLevelCache();
      }
    });
  }

  for (const [name, domain, create] of [
    ["generic ACPX", "acpx-driver", createAcpxAdapter],
    ["Cursor ACPX", "cursor-acpx-driver", createCursorAcpxAdapter],
  ] as const) {
    for (const shutdown of ["stopSession", "stopAll"] as const) {
      it(`${name} ${shutdown} aborts a stuck turn before closing`, async () => {
        let aborted = false;
        const closed: any[] = [];
        const runtime = {
          ensureSession: async () => ({ id: 1 }),
          close: async (options: any) => { closed.push(options); },
          startTurn: ({ signal }: any) => ({
            events: (async function* () {
              await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
            })(),
            result: new Promise(resolve => signal.addEventListener("abort", () => {
              aborted = true;
              resolve({ status: "cancelled" });
            }, { once: true })),
          }),
          getStatus: async () => ({}),
        } as any;
        const adapter = create({ agent: "cursor", enabled: true }, process.cwd(), runtime);
        const handle = await adapter.startSession({ model: "default", cwd: process.cwd() });
        const turn = adapter.sendTurn(handle, "stuck-turn");
        await new Promise(resolve => setImmediate(resolve));
        await Promise.race([
          shutdown === "stopSession" ? adapter.stopSession(handle) : adapter.stopAll(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown timed out")), 250)),
        ]);
        await turn;
        assert.equal(aborted, true);
        assert.equal(closed.length, 1);
        assert.equal(adapter.hasSession(handle.sessionId), false);
      });
    }

    it(`${name} rejects pre-stop queued turns across 20 stop generations`, async () => {
      for (let iteration = 0; iteration < 20; iteration++) {
        const started: string[] = [];
        const ensured: any[] = [];
        const closed: any[] = [];
        const runtime = {
          ensureSession: async () => {
            const handle = { id: ensured.length + 1 };
            ensured.push(handle);
            return handle;
          },
          close: async (options: any) => { closed.push(options); },
          startTurn: ({ text, signal }: any) => {
            started.push(text);
            if (text !== "A") {
              return {
                events: (async function* () {})(),
                result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
              };
            }
            return {
              events: (async function* () {
                await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
              })(),
              result: new Promise(resolve => signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true })),
            };
          },
          getStatus: async () => ({}),
        } as any;
        const adapter = create({ agent: "cursor", enabled: true }, process.cwd(), runtime);
        const handle = await adapter.startSession({ model: "default", cwd: process.cwd() });
        const first = adapter.sendTurn(handle, "A");
        await new Promise(resolve => setImmediate(resolve));
        const queued = adapter.sendTurn(handle, "B");
        const queuedRejection = assert.rejects(queued, /stopped|generation/i);
        const stop = adapter.stopSession(handle);

        await Promise.race([
          Promise.all([first, queuedRejection, stop]),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`generation stop timed out at ${iteration}`)), 250)),
        ]);
        assert.deepEqual(started, ["A"]);
        assert.equal(closed.length, 1);

        const fresh = await adapter.startSession({ model: "default", cwd: process.cwd() });
        await adapter.sendTurn(fresh, "C");
        assert.deepEqual(started, ["A", "C"]);
        assert.equal(ensured.length, 2);
        await adapter.stopAll();
      }
    });

    it(`${name} clears stopping state after close failure`, async () => {
      let closes = 0;
      const started: string[] = [];
      const runtime = {
        ensureSession: async () => ({ id: closes + 1 }),
        close: async () => { if (++closes === 1) throw new Error("expected close failure"); },
        startTurn: ({ text }: any) => {
          started.push(text);
          return {
            events: (async function* () {})(),
            result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          };
        },
        getStatus: async () => ({}),
      } as any;
      const adapter = create({ agent: "cursor", enabled: true }, process.cwd(), runtime);
      const handle = await adapter.startSession({ model: "default", cwd: process.cwd() });
      await adapter.stopSession(handle);
      const fresh = await adapter.startSession({ model: "default", cwd: process.cwd() });
      await adapter.sendTurn(fresh, "fresh-after-failure");
      assert.deepEqual(started, ["fresh-after-failure"]);
      assert.equal(closes, 1);
      await adapter.stopAll();
    });

    it(`${name} promptly rejects a cancelled queued turn without starting it`, async () => {
      let releaseFirst!: () => void;
      const firstPending = new Promise<void>(resolve => { releaseFirst = resolve; });
      const prompts: string[] = [];
      const runtime = {
        ensureSession: async () => ({ id: 1 }),
        close: async () => {},
        startTurn: ({ text }: any) => {
          prompts.push(text);
          return {
            events: (async function* () {})(),
            result: text === "first"
              ? firstPending.then(() => ({ status: "completed", stopReason: "end_turn" }))
              : Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          };
        },
        getStatus: async () => ({}),
      } as any;
      const adapter = create({ agent: "cursor", enabled: true }, process.cwd(), runtime);
      const handle = await adapter.startSession({ model: "default", cwd: process.cwd() });
      const first = adapter.sendTurn(handle, "first");
      await new Promise(resolve => setImmediate(resolve));
      const controller = new AbortController();
      const second = adapter.sendTurn(handle, "cancelled", { signal: controller.signal });
      controller.abort();
      await Promise.race([
        assert.rejects(second, error => (error as Error).name === "AbortError"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("queued cancellation timed out")), 250)),
      ]);
      assert.deepEqual(prompts, ["first"]);
      releaseFirst();
      await first;
      await adapter.sendTurn(handle, "third");
      assert.deepEqual(prompts, ["first", "third"]);
    });

    for (const shutdown of ["stopSession", "stopAll"] as const) {
      it(`${name} ${shutdown} logs an unrecovered close failure as error`, async () => {
        const envKey = `PI_LOG_${domain.toUpperCase().replaceAll("-", "_")}`;
        const previous = {
          logLevel: process.env[envKey],
          parentSessionId: process.env.__PI_PARENT_SESSION_ID,
          sessionId: process.env.__PI_CONFIG_SESSION_ID,
          globalSessionId: globalThis.__piConfigSessionId,
        };
        process.env[envKey] = "debug";
        delete process.env.__PI_PARENT_SESSION_ID;
        clearLogLevelCache();
        setGlobalSessionId(`close-error-${domain}-${shutdown}-${randomUUID()}`);
        const logPath = getPiLogPath(domain)!;
        rmSync(logPath, { force: true });
        const runtime = {
          ensureSession: async () => ({ id: 1 }),
          close: async () => { throw shutdown === "stopSession" ? new Error("close failed safely") : "close failed safely"; },
          startTurn: () => ({ events: (async function* () {})(), result: Promise.resolve({ status: "completed", stopReason: "end_turn" }) }),
          getStatus: async () => ({}),
        } as any;
        try {
          const adapter = create({ agent: "cursor", enabled: true }, process.cwd(), runtime);
          const handle = await adapter.startSession({ model: "safe-model", systemPrompt: "close-secret", cwd: process.cwd() });
          if (shutdown === "stopSession") await adapter.stopSession(handle); else await adapter.stopAll();
          const body = readFileSync(logPath, "utf8");
          const closeFailureLines = body.split("\n").filter(line => line.includes("close failed"));
          assert.equal(closeFailureLines.length, 1);
          assert.match(closeFailureLines[0], /\[error\].*close failed/);
          assert.doesNotMatch(closeFailureLines[0], /\[warn\]/);
          assert.match(closeFailureLines[0], /(?:persistent-system-prompt\.test|(?:cursor-)?acpx-driver)\.ts:\d+:\d+/);
          assert.match(closeFailureLines[0], /"key":"[^" ]+"/);
          assert.doesNotMatch(body, /close-secret/);
        } finally {
          rmSync(logPath, { force: true });
          if (previous.logLevel === undefined) delete process.env[envKey]; else process.env[envKey] = previous.logLevel;
          if (previous.parentSessionId === undefined) delete process.env.__PI_PARENT_SESSION_ID;
          else process.env.__PI_PARENT_SESSION_ID = previous.parentSessionId;
          if (previous.sessionId === undefined) delete process.env.__PI_CONFIG_SESSION_ID;
          else process.env.__PI_CONFIG_SESSION_ID = previous.sessionId;
          if (previous.globalSessionId === undefined) delete globalThis.__piConfigSessionId;
          else globalThis.__piConfigSessionId = previous.globalSessionId;
          clearLogLevelCache();
        }
      });
    }
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
