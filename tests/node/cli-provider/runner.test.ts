/**
 * Tests for runCliAgent process spawning (mocked via PATH fake binary).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCliAgent } from "../../../extensions/cli-provider/runner.js";
import { resolveCliTimeoutMs } from "../../../extensions/cli-provider/runner.js";

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

describe("resolveCliTimeoutMs", () => {
  it("returns undefined when omitted so turns have no default kill", () => {
    assert.equal(resolveCliTimeoutMs(undefined), undefined);
    assert.equal(resolveCliTimeoutMs(0), undefined);
    assert.equal(resolveCliTimeoutMs(-1), undefined);
  });

  it("keeps explicit positive timeoutMs", () => {
    assert.equal(resolveCliTimeoutMs(5_000), 5_000);
  });
});

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

  it("sets GEMINI_CLI_TRUST_WORKSPACE so headless gemini can connect project MCP", async () => {
    await withFakeBinary(
      "gemini",
      `#!/bin/sh
printf '%s' "$GEMINI_CLI_TRUST_WORKSPACE" > "$(dirname "$0")/seen-trust"
printf '%s\\n' '{"response":"ok","sessionId":"g1"}'
exit 0
`,
      async (binDir) => {
        await runCliAgent({
          agent: "gemini",
          model: "gemini-2.5-flash",
          cwd: process.cwd(),
          prompt: "hi",
          timeoutMs: 5000,
        });
        assert.equal(readFileSync(join(binDir, "seen-trust"), "utf8"), "true");
      },
    );
  });
});
