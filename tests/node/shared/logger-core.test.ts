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

it("extension and standalone adapters share canonical formatting and filtering", async () => {
  home = mkdtempSync(join(tmpdir(), "pi-logger-core-"));
  process.env.HOME = home;
  process.env.PI_LOG_ADAPTER_PARITY = "info";

  const file = await import(`../../../extensions/shared/file-logger.ts?t=${Date.now()}`);
  const extension = await import(`../../../extensions/shared/logger.ts?t=${Date.now()}`);
  const standalone = await import(`../../../extensions/shared/install-logger.mjs?t=${Date.now()}`);
  file.setGlobalSessionId("parity-session");

  const args = ["hello\nworld", { count: 2 }, new Error("failed\ncleanly")] as const;
  const extensionLog = extension.createLogger("adapter_parity", "parity");
  const standaloneLog = standalone.createLogger("adapter_parity", "parity");
  extensionLog.debug("filtered");
  standaloneLog.debug("filtered");
  extensionLog.error(...args);
  standaloneLog.error(...args);

  const normalize = (body: string) => body.replace(/^\S+ /, "").replace(/\\n\s+at .*$/, "");
  const extensionBody = readFileSync(file.getPiLogPath("adapter_parity"), "utf8");
  const standaloneBody = readFileSync(join(home, ".pi/logs/adapter_parity/install.log"), "utf8");
  assert.equal(normalize(extensionBody), normalize(standaloneBody));
  assert.doesNotMatch(extensionBody, /filtered/);
  assert.equal(extensionLog.isDebugEnabled(), standaloneLog.isDebugEnabled());
});

it("canonical logger swallows destination failures", () => {
  const log = createLoggerCore("test", undefined, {
    isLevelEnabled: () => true,
    write: () => { throw new Error("unwritable"); },
  });
  assert.doesNotThrow(() => log.error("safe"));
});
