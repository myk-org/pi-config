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
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

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

  it("appends leveled one-line records under ~/.pi/logs", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "pi-file-log-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;

    const { cliProviderLog, dreamingLog, getPiLogPath, fileLog } = await import(
      `../../../extensions/shared/file-logger.ts?t=${Date.now()}`
    );

    assert.equal(cliProviderLog("info", "reaped session cursor/test"), true);
    assert.equal(
      cliProviderLog("error", "session reaper sweep failed", new Error("boom")),
      true,
    );
    assert.equal(dreamingLog("info", "merged provenance for 2 entries"), true);

    const cliPath = getPiLogPath("cli-provider");
    const dreamPath = getPiLogPath("dreaming");
    const cliBody = readFileSync(cliPath, "utf-8");
    const dreamBody = readFileSync(dreamPath, "utf-8");

    assert.match(cliBody, /\[info\] \[cli-provider\] reaped session cursor\/test/);
    assert.match(cliBody, /\[error\] \[cli-provider\] session reaper sweep failed/);
    assert.match(cliBody, /Error: boom/);
    assert.match(dreamBody, /\[info\] \[dreaming\] merged provenance for 2 entries/);

    const before = cliBody.trimEnd().split("\n").length;
    fileLog("cli-provider", "warn", "cli-provider", "a\nb\rc", new Error("x\ny"));
    const afterLines = readFileSync(cliPath, "utf-8").trimEnd().split("\n");
    assert.equal(afterLines.length, before + 1);
    assert.match(afterLines.at(-1)!, /a\\nb\\nc/);
    assert.match(afterLines.at(-1)!, /x\\ny/);
  });

  it("getPiLogPath is pure (no mkdir)", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "pi-file-log-pure-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;

    const { getPiLogPath, getPiLogsDir } = await import(
      `../../../extensions/shared/file-logger.ts?t=${Date.now() + 1}`
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
      `../../../extensions/shared/file-logger.ts?t=${Date.now() + 2}`
    );
    assert.equal(mod.fileLog("cli-provider", "error", "cli-provider", "fallback"), true);
    assert.ok(mod.getFileLogErrorCount() >= 1);
    assert.ok(mod.getLastFileLogError());

    const fallback = join(tmpdir(), "pi-logs", "cli-provider.log");
    const body = readFileSync(fallback, "utf-8");
    assert.match(body, /fallback/);
  });
});
