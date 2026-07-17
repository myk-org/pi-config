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

    const { cliProviderLog, getPiLogPath } = await import(
      `../../../extensions/shared/file-logger.ts?t=${Date.now()}`
    );

    assert.equal(cliProviderLog("info", "reaped session cursor/test"), true);
    const body = readFileSync(getPiLogPath("cli-provider"), "utf-8");
    assert.match(body, /\[info\] \[cli-provider\] reaped session cursor\/test/);
  });

  it("writes dreaming info lines to ~/.pi/logs", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "pi-file-log-dream-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;

    const { dreamingLog, getPiLogPath } = await import(
      `../../../extensions/shared/file-logger.ts?t=${Date.now() + 1}`
    );

    assert.equal(dreamingLog("info", "merged provenance for 2 entries"), true);
    const body = readFileSync(getPiLogPath("dreaming"), "utf-8");
    assert.match(body, /\[info\] \[dreaming\] merged provenance for 2 entries/);
  });

  it("collapses message and Error.stack newlines into one physical line", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "pi-file-log-nl-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;

    const { fileLog, getPiLogPath } = await import(
      `../../../extensions/shared/file-logger.ts?t=${Date.now() + 2}`
    );

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

    const p = getPiLogPath("cli-provider");
    assert.equal(p, join(getPiLogsDir(), "cli-provider.log"));
    assert.equal(existsSync(join(tmpHome, ".pi", "logs")), false);
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

    const { fileLog, getPiLogPath } = await import(
      `../../../extensions/shared/file-logger.ts?t=${Date.now() + 5}`
    );

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
});
