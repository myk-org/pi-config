/**
 * Wiring tests for the cold-start default model restore (#753 / #901).
 *
 * Exercises registerModelRestoreOnSessionStart end-to-end through a fake pi
 * object: a wiring bug in the session_start handler (wrong reason forwarded,
 * broken setModel plumbing, wrong settings source) would otherwise reset the
 * model undetected — the pure-function tests in restore-default-model.test.ts
 * call restoreDefaultModelOnSessionStart directly.
 *
 * Run: npx tsx --test tests/node/providers/model-restore-wiring.test.ts
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerModelRestoreOnSessionStart } from "../../../extensions/providers/model-restore-wiring.js";
import { createLogger } from "../../../extensions/shared/logger.js";

const log = createLogger("model-restore-wiring-test");

type Handler = (event: any, ctx: any) => any;

const DEFAULT_PROVIDER = "foo";
const DEFAULT_MODEL = "foo-model";

function harness(argv: string[] = ["node", "pi"]) {
  const handlers = new Map<string, Handler>();
  const setModelCalls: Array<{ id: string; provider: string }> = [];
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    setModel: async (model: { id: string; provider: string }) => {
      setModelCalls.push({ id: model.id, provider: String(model.provider) });
      return true;
    },
  } as any;
  registerModelRestoreOnSessionStart(pi, { argv });
  log.debug("wiring harness registered", { handlerCount: handlers.size, argv });
  return { handlers, setModelCalls };
}

/** Registry whose find resolves the saved default. */
const registry = {
  find: (provider: string, id: string) => ({ id, provider }),
};

/** Poll until predicate holds or timeout (fire-and-forget restore). */
async function until(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      log.debug("until: predicate held", { elapsedMs: timeoutMs - (deadline - Date.now()) });
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const result = predicate();
  log.debug("until: deadline reached", { result, timeoutMs });
  return result;
}

/** Give a skipped (fire-and-forget) restore time to (not) act. */
async function settle(ms = 250): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  log.debug("settle complete", { ms });
}

describe("model-restore-wiring session_start (#901)", () => {
  let dir: string;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-model-restore-wiring-"));
    process.env.PI_CODING_AGENT_DIR = dir;
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      }),
    );
  });

  afterEach(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it("new keeps a selected model — setModel never called (#901 regression)", async () => {
    const { handlers, setModelCalls } = harness();
    handlers.get("session_start")!(
      { reason: "new" },
      {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: registry,
      },
    );
    await settle();
    assert.deepEqual(setModelCalls, []);
    log.debug("new keeps selection", {
      reason: "new",
      setModelCalls: setModelCalls.length,
    });
  });

  it("startup restores the default when current differs", async () => {
    const { handlers, setModelCalls } = harness();
    handlers.get("session_start")!(
      { reason: "startup" },
      {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: registry,
      },
    );
    assert.equal(
      await until(() => setModelCalls.length > 0),
      true,
      "setModel should have been called for startup",
    );
    assert.deepEqual(setModelCalls, [
      { id: DEFAULT_MODEL, provider: DEFAULT_PROVIDER },
    ]);
    log.debug("startup restored default", { setModelCalls });
  });

  it("resume restores the default when current differs", async () => {
    const { handlers, setModelCalls } = harness();
    handlers.get("session_start")!(
      { reason: "resume" },
      {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: registry,
      },
    );
    assert.equal(
      await until(() => setModelCalls.length > 0),
      true,
      "setModel should have been called for resume",
    );
    assert.deepEqual(setModelCalls, [
      { id: DEFAULT_MODEL, provider: DEFAULT_PROVIDER },
    ]);
    log.debug("resume restored default", { setModelCalls });
  });

  it("new with no selected model fills the empty selection with the default", async () => {
    const { handlers, setModelCalls } = harness();
    handlers.get("session_start")!(
      { reason: "new" },
      { model: undefined, modelRegistry: registry },
    );
    assert.equal(
      await until(() => setModelCalls.length > 0),
      true,
      "setModel should have been called to fill the empty selection",
    );
    assert.deepEqual(setModelCalls, [
      { id: DEFAULT_MODEL, provider: DEFAULT_PROVIDER },
    ]);
    log.debug("new filled empty selection", { setModelCalls });
  });

  it("new with --model in argv never calls setModel (CLI override)", async () => {
    const { handlers, setModelCalls } = harness([
      "node",
      "pi",
      "--model",
      "bar/bar-model",
    ]);
    handlers.get("session_start")!(
      { reason: "new" },
      {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: registry,
      },
    );
    await settle();
    assert.deepEqual(setModelCalls, []);
    log.debug("new argv override kept selection", {
      setModelCalls: setModelCalls.length,
    });
  });
});
