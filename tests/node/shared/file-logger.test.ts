import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  it("appends leveled lines under ~/.pi/logs without throwing", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "pi-file-log-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;

    const { cliProviderLog, dreamingLog, getPiLogPath } = await import(
      "../../../extensions/shared/file-logger.ts"
    );

    cliProviderLog("info", "reaped session cursor/test");
    cliProviderLog("error", "session reaper sweep failed", new Error("boom"));
    dreamingLog("info", "merged provenance for 2 entries");

    const cliPath = getPiLogPath("cli-provider");
    const dreamPath = getPiLogPath("dreaming");
    const cliBody = readFileSync(cliPath, "utf-8");
    const dreamBody = readFileSync(dreamPath, "utf-8");

    assert.match(cliBody, /\[info\] \[cli-provider\] reaped session cursor\/test/);
    assert.match(cliBody, /\[error\] \[cli-provider\] session reaper sweep failed/);
    assert.match(cliBody, /Error: boom/);
    assert.match(dreamBody, /\[info\] \[dreaming\] merged provenance for 2 entries/);
  });
});
