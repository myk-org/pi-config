/**
 * Tests for global acpx runtime loader memoization and non-blocking root lookup.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearAcpxRuntimeCache,
  loadAcpxRuntime,
} from "../../../extensions/acpx-provider/load-runtime.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

describe("loadAcpxRuntime", () => {
  afterEach(() => {
    clearAcpxRuntimeCache();
  });

  it("memoizes successful resolution across calls", async () => {
    clearAcpxRuntimeCache();
    const a = loadAcpxRuntime();
    const b = loadAcpxRuntime();
    assert.equal(a, b);
    const mod = await a;
    assert.equal(typeof mod.createAcpRuntime, "function");
  });

  it("runs npm root -g asynchronously without blocking event loop timers (#1171)", async () => {
    clearAcpxRuntimeCache();
    const binDir = makeTempDir("acpx-npm-bin-");
    const prevPath = process.env.PATH;
    try {
      const npmBin = join(binDir, "npm");
      writeFileSync(
        npmBin,
        `#!/usr/bin/env sh\nsleep 0.08\nprintf '%s\\n' '${binDir}'\n`,
        "utf-8",
      );
      chmodSync(npmBin, 0o755);
      process.env.PATH = `${binDir}:${prevPath ?? ""}`;

      let timerFired = false;
      const runtimePromise = loadAcpxRuntime();
      const timerPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          timerFired = true;
          resolve();
        }, 10);
      });

      const [mod] = await Promise.all([runtimePromise, timerPromise]);
      assert.equal(timerFired, true);
      assert.equal(typeof mod.createAcpRuntime, "function");
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
