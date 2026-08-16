import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Strip comments so console.* in docs/strings does not false-fail. */
function stripTsComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("file-logger", () => {
  const originals = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    PI_SESSION_ID: process.env.PI_SESSION_ID,
    __PI_PARENT_SESSION_ID: process.env.__PI_PARENT_SESSION_ID,
    PI_LOG_TEST_LOGGER_INFO: process.env.PI_LOG_TEST_LOGGER_INFO,
    PI_LOG_TEST_LOGGER_ERR: process.env.PI_LOG_TEST_LOGGER_ERR,
  };
  let tmpHome: string | undefined;
  let tmpFallbackBase: string | undefined;

  afterEach(() => {
    if (originals.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = originals.HOME;
    if (originals.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originals.USERPROFILE;
    if (originals.TMPDIR === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originals.TMPDIR;
    if (originals.TMP === undefined) delete process.env.TMP;
    else process.env.TMP = originals.TMP;
    if (originals.TEMP === undefined) delete process.env.TEMP;
    else process.env.TEMP = originals.TEMP;
    if (originals.PI_SESSION_ID === undefined) delete process.env.PI_SESSION_ID;
    else process.env.PI_SESSION_ID = originals.PI_SESSION_ID;
    if (originals.__PI_PARENT_SESSION_ID === undefined) {
      delete process.env.__PI_PARENT_SESSION_ID;
    } else {
      process.env.__PI_PARENT_SESSION_ID = originals.__PI_PARENT_SESSION_ID;
    }
    delete process.env.__PI_CONFIG_SESSION_ID;
    delete (globalThis as any).__piConfigSessionId;
    if (originals.PI_LOG_TEST_LOGGER_INFO === undefined) delete process.env.PI_LOG_TEST_LOGGER_INFO;
    else process.env.PI_LOG_TEST_LOGGER_INFO = originals.PI_LOG_TEST_LOGGER_INFO;
    if (originals.PI_LOG_TEST_LOGGER_ERR === undefined) delete process.env.PI_LOG_TEST_LOGGER_ERR;
    else process.env.PI_LOG_TEST_LOGGER_ERR = originals.PI_LOG_TEST_LOGGER_ERR;
    for (const dir of [tmpHome, tmpFallbackBase]) {
      if (!dir) continue;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    tmpHome = undefined;
    tmpFallbackBase = undefined;
  });

  it("writes cli-provider info lines to ~/.pi/logs", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "pi-file-log-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;

    const { fileLog, getPiLogPath, setGlobalSessionId } = await import(
      `../../../extensions/shared/file-logger.ts?t=${Date.now()}`
    );
    setGlobalSessionId("test-session");

    assert.equal(fileLog("cli-provider", "info", "cli-provider", "reaped session cursor/test"), true);
    const body = readFileSync(getPiLogPath("cli-provider"), "utf-8");
    assert.match(body, /\[info\] \[cli-provider\] reaped session cursor\/test/);
  });
  it("writes dreaming info lines to ~/.pi/logs", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "pi-file-log-dream-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;

    const { fileLog, getPiLogPath, setGlobalSessionId } = await import(
      `../../../extensions/shared/file-logger.ts?t=${Date.now() + 1}`
    );
    setGlobalSessionId("test-session");

    assert.equal(fileLog("dreaming", "info", "dreaming", "merged provenance for 2 entries"), true);
    const body = readFileSync(getPiLogPath("dreaming"), "utf-8");
    assert.match(body, /\[info\] \[dreaming\] merged provenance for 2 entries/);
  });
  it("collapses message and Error.stack newlines into one physical line", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "pi-file-log-nl-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;

    const { fileLog, getPiLogPath, setGlobalSessionId } = await import(
      `../../../extensions/shared/file-logger.ts?t=${Date.now() + 2}`
    );
    setGlobalSessionId("test-session");

    fileLog("cli-provider", "warn", "cli-provider", "a\nb\rc", new Error("x\ny"));
    const lines = readFileSync(getPiLogPath("cli-provider"), "utf-8")
      .trimEnd()
      .split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /a\\nb\\nc/);
    assert.match(lines[0]!, /x\\ny/);
  });

  it("getPiLogPath is pure (no mkdir)", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "pi-file-log-pure-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;

    const { getPiLogPath, getPiLogsDir } = await import(
      `../../../extensions/shared/file-logger.ts?t=${Date.now() + 3}`
    );

    // Without session ID: returns null
    delete process.env.__PI_CONFIG_SESSION_ID;
    delete process.env.__PI_PARENT_SESSION_ID;
    delete (globalThis as any).__piConfigSessionId;
    assert.equal(getPiLogPath("cli-provider"), null);

    // With globalThis session ID: per-session directory with main.log (no mkdir)
    (globalThis as any).__piConfigSessionId = "test-abc-123";
    assert.equal(getPiLogPath("cli-provider"), join(getPiLogsDir(), "cli-provider", "test-abc-123", "main.log"));
    delete (globalThis as any).__piConfigSessionId;

    // getPiLogPath returns correct path strings without side effects
  });

  it("falls back to isolated TMPDIR when home logs are not writable", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "pi-file-log-ro-"));
    tmpFallbackBase = mkdtempSync(join(tmpdir(), "pi-file-log-tmp-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    process.env.TMPDIR = tmpFallbackBase;
    process.env.TMP = tmpFallbackBase;
    process.env.TEMP = tmpFallbackBase;

    mkdirSync(join(tmpHome, ".pi"), { recursive: true });
    writeFileSync(join(tmpHome, ".pi", "logs"), "not-a-dir");

    const mod = await import(
      `../../../extensions/shared/file-logger.ts?t=${Date.now() + 4}`
    );
    mod.setGlobalSessionId("test-session");
    assert.equal(mod.fileLog("cli-provider", "error", "cli-provider", "fallback"), true);
    assert.ok(mod.getFileLogErrorCount() >= 1);
    assert.ok(mod.getLastFileLogError());

    const fallback = join(tmpFallbackBase, "pi-logs", "cli-provider.log");
    assert.match(readFileSync(fallback, "utf-8"), /fallback/);
  });

  it("recreates log dir after external delete (no stale mkdir cache)", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "pi-file-log-recreate-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;

    const { fileLog, getPiLogPath, setGlobalSessionId } = await import(
      `../../../extensions/shared/file-logger.ts?t=${Date.now() + 5}`
    );
    setGlobalSessionId("test-session");

    assert.equal(fileLog("cli-provider", "info", "cli-provider", "first"), true);
    const logPath = getPiLogPath("cli-provider");
    rmSync(join(tmpHome, ".pi", "logs"), { recursive: true, force: true });
    assert.equal(fileLog("cli-provider", "info", "cli-provider", "second"), true);
    const body = readFileSync(logPath, "utf-8");
    assert.match(body, /second/);
  });

  it("dreaming and cli-provider sources have no executable console.* ops calls", () => {
    const files = [
      join(REPO, "extensions/orchestrator/dreaming.ts"),
      join(REPO, "extensions/cli-provider/session-reaper.ts"),
      join(REPO, "extensions/cli-provider/discover.ts"),
      join(REPO, "extensions/cli-provider/index.ts"),
      join(REPO, "extensions/cli-provider/agents/cursor.ts"),
      join(REPO, "extensions/cli-provider/agents/claude.ts"),
      join(REPO, "extensions/cli-provider/agents/gemini.ts"),
    ];
    const consoleRe = /\bconsole\.(debug|log|info|warn|error)\s*\(/;
    for (const file of files) {
      const src = stripTsComments(readFileSync(file, "utf-8"));
      assert.equal(
        consoleRe.test(src),
        false,
        `${file} still uses console.* (chat leak)`,
      );
    }
  });

  it("createLogger returns debug/info/warn/error methods", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "pi-file-log-logger-api-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    delete process.env.__PI_PARENT_SESSION_ID;

    const { createLogger } = await import(
      `../../../extensions/shared/logger.ts?t=${Date.now() + 10}`
    );

    const log = createLogger("test_logger");
    assert.equal(typeof log.debug, "function");
    assert.equal(typeof log.info, "function");
    assert.equal(typeof log.warn, "function");
    assert.equal(typeof log.error, "function");
    assert.equal(typeof log.isDebugEnabled, "function");
    assert.equal(log.isDebugEnabled(), false);
  });

  it("createLogger info writes to log file", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "pi-file-log-logger-info-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    delete process.env.__PI_PARENT_SESSION_ID;
    process.env.PI_LOG_TEST_LOGGER_INFO = "debug";

    const mod = await import(
      `../../../extensions/shared/file-logger.ts?t=${Date.now() + 11}`
    );
    const { createLogger } = await import(
      `../../../extensions/shared/logger.ts?t=${Date.now() + 11}`
    );
    mod.setGlobalSessionId("test-logger-info");

    const log = createLogger("test_logger_info");
    log.info("hello", "world");

    const logPath = mod.getPiLogPath("test_logger_info");
    const body = readFileSync(logPath, "utf-8");
    assert.match(body, /\[info\] \[test_logger_info\] hello world/);
  });

  it("createLogger error preserves Error stack traces", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "pi-file-log-logger-err-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    delete process.env.__PI_PARENT_SESSION_ID;
    process.env.PI_LOG_TEST_LOGGER_ERR = "debug";

    const mod = await import(
      `../../../extensions/shared/file-logger.ts?t=${Date.now() + 12}`
    );
    const { createLogger } = await import(
      `../../../extensions/shared/logger.ts?t=${Date.now() + 12}`
    );
    mod.setGlobalSessionId("test-logger-err");

    const log = createLogger("test_logger_err");
    log.error("fail", new Error("boom"));

    const logPath = mod.getPiLogPath("test_logger_err");
    const body = readFileSync(logPath, "utf-8");
    assert.match(body, /\[error\] \[test_logger_err\] fail/);
    assert.match(body, /boom/);
    // Verify stack frames are present (not just the error message)
    assert.match(body, /Error: boom/);
    assert.match(body, /\\n\s+at /);  // Stack frames collapsed by fileLog's oneLine()
  });

  it("isLevelEnabled is false for debug at default info", async () => {
    const { isLevelEnabled } = await import(
      `../../../extensions/shared/file-logger.ts?t=${Date.now() + 13}`
    );
    assert.equal(isLevelEnabled("level_default_info", "debug"), false);
    assert.equal(isLevelEnabled("level_default_info", "info"), true);
  });

  it("isLevelEnabled honors PI_LOG env", async () => {
    process.env.PI_LOG_LEVEL_ENV_DBG = "debug";
    try {
      const { isLevelEnabled } = await import(
        `../../../extensions/shared/file-logger.ts?t=${Date.now() + 14}`
      );
      assert.equal(isLevelEnabled("level_env_dbg", "debug"), true);
    } finally {
      delete process.env.PI_LOG_LEVEL_ENV_DBG;
    }
  });

  it("isLevelEnabled is false when level is off", async () => {
    process.env.PI_LOG_LEVEL_ENV_OFF = "off";
    try {
      const { isLevelEnabled } = await import(
        `../../../extensions/shared/file-logger.ts?t=${Date.now() + 15}`
      );
      assert.equal(isLevelEnabled("level_env_off", "error"), false);
    } finally {
      delete process.env.PI_LOG_LEVEL_ENV_OFF;
    }
  });
});
