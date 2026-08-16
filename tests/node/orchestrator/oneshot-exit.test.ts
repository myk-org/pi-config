/**
 * Regression for #755: pi -p / --mode json must exit. If oneshot helpers
 * fail to skip keepalive, the child holds a timer and this test times out.
 *
 * Run: npx tsx --test tests/node/orchestrator/oneshot-exit.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

describe("oneshot process exit", () => {
  it("oneshot helpers drain the event loop (no keepalive)", async () => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(here, "oneshot-exit-child.ts")],
      {
        cwd: repoRoot,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const timeoutMs = 8000;
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null | "timeout";
    }>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: null, signal: "timeout" });
      }, timeoutMs);
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    assert.equal(result.signal, null, stderr || "child must exit, not hang");
    assert.equal(result.code, 0, stderr);
  });
});
