import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { createLoggerCore } from "../../../extensions/shared/logger-core.mjs";

let home: string | undefined;
const previousHome = process.env.HOME;
const previousLevel = process.env.PI_LOG_ADAPTER_PARITY;

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousLevel === undefined) delete process.env.PI_LOG_ADAPTER_PARITY;
  else process.env.PI_LOG_ADAPTER_PARITY = previousLevel;
  delete process.env.__PI_CONFIG_SESSION_ID;
  delete (globalThis as any).__piConfigSessionId;
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

async function adapters(level: "debug" | "info") {
  home ??= mkdtempSync(join(tmpdir(), "pi-logger-core-"));
  process.env.HOME = home;
  process.env.PI_LOG_ADAPTER_PARITY = level;

  const file = await import("../../../extensions/shared/file-logger.ts");
  const extension = await import("../../../extensions/shared/logger.ts");
  const standalone = await import("../../../extensions/shared/install-logger.mjs");
  file.clearLogLevelCache();
  file.setGlobalSessionId("parity-session");

  return {
    extension: extension.createLogger("adapter_parity", "parity"),
    standalone: standalone.createLogger("adapter_parity", "parity"),
    extensionPath: file.getPiLogPath("adapter_parity")!,
    standalonePath: join(home, ".pi/logs/adapter_parity/install.log"),
  };
}

const normalize = (body: string) => body.replace(/^\S+ /, "").replace(/\\n\s+at .*$/, "");

it("adapters produce identical canonical formatting", async () => {
  const logs = await adapters("info");
  const args = ["hello\nworld", { count: 2 }, new Error("failed\ncleanly")] as const;

  logs.extension.error(...args);
  logs.standalone.error(...args);

  const extensionBody = normalize(readFileSync(logs.extensionPath, "utf8"));
  const standaloneBody = normalize(readFileSync(logs.standalonePath, "utf8"));
  assert.equal(extensionBody, standaloneBody);
  assert.match(extensionBody, /^\[error\] \[parity\] hello\\nworld \{"count":2\} Error: failed\\ncleanly\\n {4}at /);
  assert.equal(extensionBody.split("\n").length, 2);
});

it("info level writes info and filters debug for each adapter", async () => {
  const logs = await adapters("info");

  logs.extension.debug("debug message");
  logs.extension.info("info message");
  logs.standalone.debug("debug message");
  logs.standalone.info("info message");

  for (const path of [logs.extensionPath, logs.standalonePath]) {
    const body = readFileSync(path, "utf8");
    assert.match(body, /\[info\] \[parity\] info message/);
    assert.doesNotMatch(body, /debug message/);
  }
});

it("isDebugEnabled reports the configured level for each adapter", async () => {
  const infoLogs = await adapters("info");
  assert.equal(infoLogs.extension.isDebugEnabled(), false);
  assert.equal(infoLogs.standalone.isDebugEnabled(), false);

  const debugLogs = await adapters("debug");
  assert.equal(debugLogs.extension.isDebugEnabled(), true);
  assert.equal(debugLogs.standalone.isDebugEnabled(), true);
});

it("canonical logger swallows destination failures", () => {
  const log = createLoggerCore("test", undefined, {
    isLevelEnabled: () => true,
    write: () => { throw new Error("unwritable"); },
  });
  assert.doesNotThrow(() => log.error("safe"));
});
