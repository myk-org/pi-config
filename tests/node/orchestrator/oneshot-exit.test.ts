/**
 * Regression for #755: pi -p / --mode json must exit. Session extras skip
 * register and shutdown dream must not spawn — both keep the event loop alive.
 *
 * Production modules (pidiff/pidash/dreaming) import pi-tui / pi-coding-agent
 * and cannot load under node:test. This file (1) asserts those call sites
 * still use the skip helpers, (2) runs a child that hangs unless the helpers
 * skip keepalive.
 *
 * Run: npx tsx --test tests/node/orchestrator/oneshot-exit.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

const SKIP_REGISTER_FILES = [
  "extensions/pidiff/pidiff.ts",
  "extensions/pidash/pidash.ts",
  "extensions/pitasks/index.ts",
  "extensions/coms/index.ts",
];

describe("oneshot skip call sites", () => {
  it("session extras still skip register via isPiOneshotInvocation", () => {
    for (const rel of SKIP_REGISTER_FILES) {
      const src = readFileSync(path.join(repoRoot, rel), "utf8");
      assert.match(
        src,
        /if \(isPiOneshotInvocation\(\)\)/,
        `${rel} must skip register on oneshot`,
      );
      assert.match(
        src,
        /skip register: oneshot print\/json/,
        `${rel} must log the oneshot skip`,
      );
    }
  });

  it("dreaming shutdown uses shouldSkipOneshotShutdownDream", () => {
    const src = readFileSync(
      path.join(repoRoot, "extensions/orchestrator/dreaming.ts"),
      "utf8",
    );
    assert.match(src, /shouldSkipOneshotShutdownDream\(lastCtx\?\.mode\)/);
  });
});

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
