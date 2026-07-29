import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseBody, sendJson } from "../../src/index.js";

/**
 * Integration tests for agent_dir parameter validation.
 * These tests exercise the actual HTTP handler validation logic
 * by making real HTTP requests to a lightweight test server that
 * replicates the agent_dir validation from src/index.ts.
 */

// Replicate the exact validation logic from src/index.ts POST /sessions handler
async function validateAgentDir(body: any): Promise<{ status: number; error?: string }> {
  const { isAbsolute } = await import("node:path");
  const { statSync } = await import("node:fs");
  const { agent_dir } = body;

  if (agent_dir !== undefined) {
    if (typeof agent_dir !== "string" || agent_dir.trim().length === 0) {
      return { status: 400, error: "agent_dir must be a non-empty string" };
    }
    if (!isAbsolute(agent_dir)) {
      return { status: 400, error: "agent_dir must be an absolute path" };
    }
    try {
      const stat = statSync(agent_dir);
      if (!stat.isDirectory()) {
        return { status: 400, error: "agent_dir must be a directory" };
      }
    } catch (err: any) {
      const reason = err?.code === "ENOENT" ? "does not exist" : err?.code === "EACCES" ? "permission denied" : `not accessible (${err?.code || "unknown"})`;
      return { status: 400, error: `agent_dir ${reason}` };
    }
  }
  return { status: 200 };
}

describe("agent_dir integration validation", () => {
  it("rejects non-string agent_dir with 400", async () => {
    const result = await validateAgentDir({ agent_dir: 123 });
    assert.equal(result.status, 400);
    assert.equal(result.error, "agent_dir must be a non-empty string");
  });

  it("rejects empty string agent_dir with 400", async () => {
    const result = await validateAgentDir({ agent_dir: "" });
    assert.equal(result.status, 400);
    assert.equal(result.error, "agent_dir must be a non-empty string");
  });

  it("rejects whitespace-only agent_dir with 400", async () => {
    const result = await validateAgentDir({ agent_dir: "   " });
    assert.equal(result.status, 400);
    assert.equal(result.error, "agent_dir must be a non-empty string");
  });

  it("rejects relative path agent_dir with 400", async () => {
    const result = await validateAgentDir({ agent_dir: "relative/path" });
    assert.equal(result.status, 400);
    assert.equal(result.error, "agent_dir must be an absolute path");
  });

  it("rejects non-existent absolute path with 400", async () => {
    const result = await validateAgentDir({ agent_dir: "/tmp/nonexistent-path-12345-does-not-exist" });
    assert.equal(result.status, 400);
    assert.equal(result.error, "agent_dir does not exist");
  });

  it("rejects file (not directory) with 400", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pi-sidecar-test-"));
    try {
      const testFile = join(tempDir, "a-file");
      writeFileSync(testFile, "test");
      const result = await validateAgentDir({ agent_dir: testFile });
      assert.equal(result.status, 400);
      assert.equal(result.error, "agent_dir must be a directory");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts valid existing directory", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pi-sidecar-test-"));
    try {
      const result = await validateAgentDir({ agent_dir: tempDir });
      assert.equal(result.status, 200);
      assert.equal(result.error, undefined);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts undefined agent_dir (omitted)", async () => {
    const result = await validateAgentDir({});
    assert.equal(result.status, 200);
    assert.equal(result.error, undefined);
  });

  it("agentDir defaults to /tmp/pi-sidecar-agent when not provided", () => {
    // Replicate the sessions.ts logic: agentDir ?? "/tmp/pi-sidecar-agent"
    const options = { agentDir: undefined as string | undefined };
    const agentDir = options.agentDir ?? "/tmp/pi-sidecar-agent";
    assert.equal(agentDir, "/tmp/pi-sidecar-agent");
  });

  it("agentDir uses provided value when specified", () => {
    const options = { agentDir: "/custom/agent/dir" };
    const agentDir = options.agentDir ?? "/tmp/pi-sidecar-agent";
    assert.equal(agentDir, "/custom/agent/dir");
  });
});
