/**
 * The helper's promise: a test process leaves nothing behind, including when it exits without
 * reaching `after()` (a killed child, a crash). That path is invisible to a normal suite run, so
 * it is exercised by a child process whose test body creates a dir and calls process.exit() —
 * which skips the harness teardown, leaving the exit handler as the only thing that can clean up.
 *
 * The child registers a real `it()` on purpose: with no test registered the harness runs `after()`
 * at exit anyway, and the assertion would pass with or without the exit handler (verified: it did).
 */
import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function runChildExpectingSignal(script: string): string {
  try {
    return execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: HERE,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e: any) {
    // The child kills itself with SIGTERM: a non-zero status is the expected outcome.
    return String(e?.stdout ?? "").trim();
  }
}

it("removes the run root when a process is terminated by SIGTERM", () => {
  // The child records its run root in a marker file: stdout is not flushed before SIGTERM kills
  // it, and the node:test reporter owns stdout anyway.
  const marker = path.join(os.tmpdir(), `pi-temp-dirs-test-${process.pid}.txt`);
  const script = `
    import { writeFileSync } from "node:fs";
    import { it } from "node:test";
    import { makeTempDir, TEST_RUN_ROOT } from "./temp-dirs.ts";
    it("gets terminated", () => {
      makeTempDir("sigterm-exit-");
      writeFileSync(${JSON.stringify(marker)}, TEST_RUN_ROOT);
      process.kill(process.pid, "SIGTERM");
      setTimeout(() => {}, 1000); // stay alive until the signal lands
    });
  `;
  runChildExpectingSignal(script);
  const runRoot = fs.existsSync(marker) ? fs.readFileSync(marker, "utf-8").trim() : "";
  fs.rmSync(marker, { force: true });
  assert.ok(runRoot.includes("run-"), `child reported its run root: ${runRoot}`);
  assert.equal(fs.existsSync(runRoot), false, "run root must not survive SIGTERM");
});

it("removes the run root when a process exits inside a test, before after()", () => {
  const script = `
    import { it } from "node:test";
    import { makeTempDir, TEST_RUN_ROOT } from "./temp-dirs.ts";
    it("exits hard", () => {
      makeTempDir("abrupt-exit-");
      console.log(TEST_RUN_ROOT);
      process.exit(0);
    });
  `;
  const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: HERE,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const runRoot = out.split("\n").pop() ?? "";
  assert.ok(runRoot.includes("run-"), `child reported its run root: ${out}`);
  assert.equal(fs.existsSync(runRoot), false, "run root must not survive an abrupt exit");
});
