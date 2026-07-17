/**
 * Tests for runCliAgent process spawning (mocked via PATH fake binary).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCliAgent } from "../../../extensions/cli-provider/runner.js";

function withFakeBinary(
  name: string,
  scriptBody: string,
  fn: (binDir: string) => Promise<void>,
): Promise<void> {
  const binDir = mkdtempSync(join(tmpdir(), "cli-runner-bin-"));
  const prevPath = process.env.PATH;
  try {
    const script = join(binDir, name);
    writeFileSync(script, scriptBody, { mode: 0o755 });
    chmodSync(script, 0o755);
    process.env.PATH = `${binDir}:${prevPath || ""}`;
    return fn(binDir).finally(() => {
      process.env.PATH = prevPath;
      rmSync(binDir, { recursive: true, force: true });
    });
  } catch (e) {
    process.env.PATH = prevPath;
    rmSync(binDir, { recursive: true, force: true });
    throw e;
  }
}

describe("runCliAgent", () => {
  it("resolves text on success with stream-json stdout", async () => {
    await withFakeBinary(
      "agent",
      `#!/bin/sh
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"hello-live"}]}}'
printf '%s\\n' '{"type":"result","session_id":"sess-1"}'
exit 0
`,
      async () => {
        const events: string[] = [];
        const result = await runCliAgent({
          agent: "cursor",
          model: "composer-2",
          cwd: process.cwd(),
          prompt: "hi",
          timeoutMs: 5000,
          onEvent: (ev) => {
            if (ev.kind === "text_delta") events.push(ev.text);
          },
        });
        assert.equal(result.text, "hello-live");
        assert.equal(result.sessionId, "sess-1");
        assert.equal(result.exitCode, 0);
        assert.ok(events.join("").includes("hello-live"));
      },
    );
  });

  it("rejects on non-zero exit with empty stdout", async () => {
    await withFakeBinary(
      "agent",
      `#!/bin/sh
echo boom >&2
exit 1
`,
      async () => {
        await assert.rejects(
          () =>
            runCliAgent({
              agent: "cursor",
              model: "composer-2",
              cwd: process.cwd(),
              prompt: "hi",
              timeoutMs: 5000,
            }),
          /exited 1/,
        );
      },
    );
  });

  it("rejects when signal already aborted", async () => {
    await withFakeBinary(
      "agent",
      `#!/bin/sh
exit 0
`,
      async () => {
        const ac = new AbortController();
        ac.abort();
        await assert.rejects(
          () =>
            runCliAgent({
              agent: "cursor",
              model: "composer-2",
              cwd: process.cwd(),
              prompt: "hi",
              signal: ac.signal,
              timeoutMs: 5000,
            }),
          /CLI call aborted/,
        );
      },
    );
  });
});
