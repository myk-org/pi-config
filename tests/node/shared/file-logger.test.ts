import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

const REPO = join(import.meta.dirname, "../../..");

describe("file-logger", () => {
  const originals = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  let tmpHome: string | undefined;

  afterEach(() => {
    if (originals.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = originals.HOME;
    if (originals.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originals.USERPROFILE;
    if (tmpHome) {
      try {
        rmSync(tmpHome, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      tmpHome = undefined;
    }
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

  it("falls back to tmpdir when home logs are not writable", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "pi-file-log-ro-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;

    mkdirSync(join(tmpHome, ".pi"), { recursive: true });
    writeFileSync(join(tmpHome, ".pi", "logs"), "not-a-dir");

    const mod = await import(
      `../../../extensions/shared/file-logger.ts?t=${Date.now() + 4}`
    );
    assert.equal(mod.fileLog("cli-provider", "error", "cli-provider", "fallback"), true);
    assert.ok(mod.getFileLogErrorCount() >= 1);
    assert.ok(mod.getLastFileLogError());

    const fallback = join(tmpdir(), "pi-logs", "cli-provider.log");
    assert.match(readFileSync(fallback, "utf-8"), /fallback/);
  });

  it("dreaming and cli-provider sources do not call console.* for ops logs", () => {
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
      const src = readFileSync(file, "utf-8");
      assert.equal(
        consoleRe.test(src),
        false,
        `${file} still uses console.* (chat leak)`,
      );
    }
  });
});
