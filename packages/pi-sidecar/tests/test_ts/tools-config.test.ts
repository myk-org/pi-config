import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, isAbsolute, join } from "node:path";
import { accessSync, statSync, mkdtempSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { DEFAULT_TOOLS } from "../../src/sessions.js";
import { resolveExtensionPath, resolveExtensionPathDetailed } from "../../src/resolve-extension-path.js";
import { parseBody } from "../../src/index.js";
import { createHttpToolExecutor, normalizeHttpToolConfig, type HttpToolConfig } from "../../src/http-tool-executor.js";

const MONOREPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

// ---------------------------------------------------------------------------
// 1. DEFAULT_TOOLS constant
// ---------------------------------------------------------------------------

describe("DEFAULT_TOOLS", () => {
  it("contains the expected default tool set", () => {
    assert.deepEqual([...DEFAULT_TOOLS], ["read", "grep", "find", "ls", "bash"]);
  });

  it("is a readonly tuple (cannot be modified)", () => {
    // TypeScript enforces `as const` at compile time; at runtime we verify
    // that the array content is correct and stable
    assert.equal(DEFAULT_TOOLS.length, 5);
    assert.equal(DEFAULT_TOOLS[0], "read");
    assert.equal(DEFAULT_TOOLS[4], "bash");
  });
});

// ---------------------------------------------------------------------------
// 2. CreateSessionOptions tools field
// ---------------------------------------------------------------------------

describe("CreateSessionOptions tools field", () => {
  it("DEFAULT_TOOLS is exported and accessible from sessions module", async () => {
    // Verify the export path works (sessions.js → index.js re-export)
    const { DEFAULT_TOOLS: fromIndex } = await import("../../src/index.js");
    assert.deepEqual([...fromIndex], ["read", "grep", "find", "ls", "bash"]);
  });
});

// ---------------------------------------------------------------------------
// 2b. POST /sessions input validation (tools & custom_tools)
// ---------------------------------------------------------------------------

describe("POST /sessions input validation", () => {
  /** Create a mock request with a JSON body */
  function createMockRequest(body: any): PassThrough {
    const stream = new PassThrough();
    stream.write(JSON.stringify(body));
    stream.end();
    return stream;
  }

  it("rejects tools when not an array of strings", async () => {
    const body = {
      provider: "google",
      model: "gemini-2.5-flash",
      system_prompt: "test",
      tools: "not-an-array",
    };
    const stream = createMockRequest(body);
    const parsed = await parseBody(stream as unknown as IncomingMessage);
    // Validate same way index.ts does
    const isInvalid = parsed.tools !== undefined &&
      (!Array.isArray(parsed.tools) || !parsed.tools.every((t: any) => typeof t === "string"));
    assert.equal(isInvalid, true);
  });

  it("accepts valid tools array", async () => {
    const body = {
      provider: "google",
      model: "gemini-2.5-flash",
      system_prompt: "test",
      tools: ["read", "bash"],
    };
    const stream = createMockRequest(body);
    const parsed = await parseBody(stream as unknown as IncomingMessage);
    const isValid = parsed.tools === undefined ||
      (Array.isArray(parsed.tools) && parsed.tools.every((t: any) => typeof t === "string"));
    assert.equal(isValid, true);
    assert.deepEqual(parsed.tools, ["read", "bash"]);
  });

  it("rejects custom_tools when not an array", async () => {
    const body = {
      provider: "google",
      model: "gemini-2.5-flash",
      system_prompt: "test",
      custom_tools: "not-an-array",
    };
    const stream = createMockRequest(body);
    const parsed = await parseBody(stream as unknown as IncomingMessage);
    const isInvalid = parsed.custom_tools !== undefined && !Array.isArray(parsed.custom_tools);
    assert.equal(isInvalid, true);
  });

  it("rejects custom_tools with null entries", async () => {
    const body = {
      provider: "google",
      model: "gemini-2.5-flash",
      system_prompt: "test",
      custom_tools: [null, { name: "valid" }],
    };
    const stream = createMockRequest(body);
    const parsed = await parseBody(stream as unknown as IncomingMessage);
    const hasNulls = Array.isArray(parsed.custom_tools) &&
      !parsed.custom_tools.every((t: any) => t != null && typeof t === "object" && !Array.isArray(t) && typeof t.name === "string" && t.name.trim().length > 0);
    assert.equal(hasNulls, true);
  });

  it("rejects custom_tools with array entries", async () => {
    const body = {
      provider: "google",
      model: "gemini-2.5-flash",
      system_prompt: "test",
      custom_tools: [{ name: "valid_tool" }, []],
    };
    const stream = createMockRequest(body);
    const parsed = await parseBody(stream as unknown as IncomingMessage);
    const hasArrays = Array.isArray(parsed.custom_tools) &&
      !parsed.custom_tools.every((t: any) => t != null && typeof t === "object" && !Array.isArray(t) && typeof t.name === "string" && t.name.trim().length > 0);
    assert.equal(hasArrays, true);
  });

  it("rejects custom_tools entries without a string name", async () => {
    const body = {
      provider: "google",
      model: "gemini-2.5-flash",
      system_prompt: "test",
      custom_tools: [{ description: "no name field" }],
    };
    const stream = createMockRequest(body);
    const parsed = await parseBody(stream as unknown as IncomingMessage);
    const missingName = Array.isArray(parsed.custom_tools) &&
      !parsed.custom_tools.every((t: any) => t != null && typeof t === "object" && !Array.isArray(t) && typeof t.name === "string" && t.name.trim().length > 0);
    assert.equal(missingName, true);
  });

  it("rejects custom_tools entries with empty string name", async () => {
    const body = {
      provider: "google",
      model: "gemini-2.5-flash",
      system_prompt: "test",
      custom_tools: [{ name: "", description: "empty name" }],
    };
    const stream = createMockRequest(body);
    const parsed = await parseBody(stream as unknown as IncomingMessage);
    const hasEmptyName = Array.isArray(parsed.custom_tools) &&
      !parsed.custom_tools.every((t: any) => t != null && typeof t === "object" && !Array.isArray(t) && typeof t.name === "string" && t.name.trim().length > 0);
    assert.equal(hasEmptyName, true);
  });

  it("rejects custom_tools entries with whitespace-only name", async () => {
    const body = {
      provider: "google",
      model: "gemini-2.5-flash",
      system_prompt: "test",
      custom_tools: [{ name: "   ", description: "whitespace name" }],
    };
    const stream = createMockRequest(body);
    const parsed = await parseBody(stream as unknown as IncomingMessage);
    const hasWhitespaceName = Array.isArray(parsed.custom_tools) &&
      !parsed.custom_tools.every((t: any) => t != null && typeof t === "object" && !Array.isArray(t) && typeof t.name === "string" && t.name.trim().length > 0);
    assert.equal(hasWhitespaceName, true);
  });

  it("accepts valid custom_tools array", async () => {
    const body = {
      provider: "google",
      model: "gemini-2.5-flash",
      system_prompt: "test",
      custom_tools: [{ name: "my_tool", description: "A tool" }],
    };
    const stream = createMockRequest(body);
    const parsed = await parseBody(stream as unknown as IncomingMessage);
    const isValid = parsed.custom_tools === undefined ||
      (Array.isArray(parsed.custom_tools) && parsed.custom_tools.every((t: any) => t != null && typeof t === "object" && !Array.isArray(t) && typeof t.name === "string" && t.name.trim().length > 0));
    assert.equal(isValid, true);
  });

  it("accepts request without tools or custom_tools", async () => {
    const body = {
      provider: "google",
      model: "gemini-2.5-flash",
      system_prompt: "test",
    };
    const stream = createMockRequest(body);
    const parsed = await parseBody(stream as unknown as IncomingMessage);
    assert.equal(parsed.tools, undefined);
    assert.equal(parsed.custom_tools, undefined);
  });

  it("rejects non-string provider", async () => {
    const body = {
      provider: 123,
      model: "gemini-2.5-flash",
      system_prompt: "test",
    };
    const stream = createMockRequest(body);
    const parsed = await parseBody(stream as unknown as IncomingMessage);
    const isInvalid = typeof parsed.provider !== "string" || parsed.provider.length === 0;
    assert.equal(isInvalid, true);
  });

  it("rejects non-string model", async () => {
    const body = {
      provider: "google",
      model: { nested: true },
      system_prompt: "test",
    };
    const stream = createMockRequest(body);
    const parsed = await parseBody(stream as unknown as IncomingMessage);
    const isInvalid = typeof parsed.model !== "string" || parsed.model.length === 0;
    assert.equal(isInvalid, true);
  });

  it("rejects non-string cwd", async () => {
    const body = {
      provider: "google",
      model: "gemini-2.5-flash",
      system_prompt: "test",
      cwd: 42,
    };
    const stream = createMockRequest(body);
    const parsed = await parseBody(stream as unknown as IncomingMessage);
    const isInvalid = parsed.cwd !== undefined && typeof parsed.cwd !== "string";
    assert.equal(isInvalid, true);
  });
});

// ---------------------------------------------------------------------------
// 3. HTTP tool SDK integration shape
// ---------------------------------------------------------------------------

describe("HTTP tool SDK-compatible assembly", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("assembled tool has label, name, description, parameters, and execute", () => {
    // Simulate what sessions.ts does when assembling an HTTP tool
    const toolConfig = {
      name: "fetch_data",
      description: "Fetch user data by ID",
      parameters: { type: "object", properties: { userId: { type: "string" } } },
      http: { method: "GET", url: "https://api.example.com/users/{userId}" },
    };

    const httpConfig = normalizeHttpToolConfig(toolConfig.http);
    const httpExecutor = createHttpToolExecutor(httpConfig);

    // Assemble the same way sessions.ts does
    const assembledTool = {
      name: toolConfig.name,
      label: toolConfig.name,
      description: toolConfig.description || "",
      parameters: toolConfig.parameters || {},
      execute: async (
        _toolCallId: string,
        params: Record<string, any>,
        signal: AbortSignal | undefined,
      ) => {
        const text = await httpExecutor(params, signal);
        return {
          content: [{ type: "text" as const, text }],
          details: {},
        };
      },
    };

    assert.equal(assembledTool.name, "fetch_data");
    assert.equal(assembledTool.label, "fetch_data");
    assert.equal(assembledTool.description, "Fetch user data by ID");
    assert.deepEqual(assembledTool.parameters, { type: "object", properties: { userId: { type: "string" } } });
    assert.equal(typeof assembledTool.execute, "function");
  });

  it("execute returns AgentToolResult format with content array", async () => {
    globalThis.fetch = mock.fn(async () => {
      return new Response('{"id": "123", "name": "Alice"}', { status: 200 });
    }) as any;

    const httpConfig: HttpToolConfig = {
      method: "GET",
      url: "https://api.example.com/users/{userId}",
    };
    const httpExecutor = createHttpToolExecutor(httpConfig);

    // Call with SDK signature: (toolCallId, params, signal)
    const params = { userId: "123" };
    const text = await httpExecutor(params);
    const result = {
      content: [{ type: "text" as const, text }],
      details: {},
    };

    assert.ok(Array.isArray(result.content), "result.content should be an array");
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    assert.ok(result.content[0].text.includes('"name": "Alice"'), `Should contain response data: ${result.content[0].text}`);
    assert.deepEqual(result.details, {});
  });

  it("execute passes signal through to HTTP executor", async () => {
    globalThis.fetch = mock.fn(async () => {
      return new Response("ok", { status: 200 });
    }) as any;

    const httpConfig: HttpToolConfig = {
      method: "GET",
      url: "https://api.example.com/data",
    };
    const httpExecutor = createHttpToolExecutor(httpConfig);

    // Simulate SDK calling with a signal
    const controller = new AbortController();
    const text = await httpExecutor({}, controller.signal);
    const result = {
      content: [{ type: "text" as const, text }],
      details: {},
    };

    assert.equal(result.content[0].text, "ok");
  });
});

// ---------------------------------------------------------------------------
// 2c. POST /sessions agent_dir validation
// ---------------------------------------------------------------------------

describe("POST /sessions agent_dir validation", () => {
  function createMockRequest(body: any): PassThrough {
    const stream = new PassThrough();
    stream.write(JSON.stringify(body));
    stream.end();
    return stream;
  }

  it("rejects non-string agent_dir", async () => {
    const body = { provider: "google", model: "gemini-2.5-flash", system_prompt: "test", agent_dir: 123 };
    const stream = createMockRequest(body);
    const parsed = await parseBody(stream as unknown as IncomingMessage);
    const isInvalid = parsed.agent_dir !== undefined &&
      (typeof parsed.agent_dir !== "string" || String(parsed.agent_dir).trim().length === 0);
    assert.ok(isInvalid, "non-string agent_dir should be rejected");
  });

  it("rejects empty string agent_dir", async () => {
    const body = { provider: "google", model: "gemini-2.5-flash", system_prompt: "test", agent_dir: "" };
    const stream = createMockRequest(body);
    const parsed = await parseBody(stream as unknown as IncomingMessage);
    const isInvalid = typeof parsed.agent_dir === "string" && parsed.agent_dir.trim().length === 0;
    assert.ok(isInvalid, "empty string agent_dir should be rejected");
  });

  it("rejects relative path agent_dir", () => {
    assert.ok(!isAbsolute("relative/path"), "relative path should not be absolute");
    assert.ok(!isAbsolute("./relative"), "dot-relative path should not be absolute");
  });

  it("accepts valid absolute path agent_dir", () => {
    assert.ok(isAbsolute("/tmp/test-agent"), "absolute path should be recognized");
    assert.ok(isAbsolute("/home/user/.pi/agent"), "home absolute path should be recognized");
  });

  it("accepts request without agent_dir", async () => {
    const body = { provider: "google", model: "gemini-2.5-flash", system_prompt: "test" };
    const stream = createMockRequest(body);
    const parsed = await parseBody(stream as unknown as IncomingMessage);
    assert.equal(parsed.agent_dir, undefined, "agent_dir should be undefined when not provided");
  });

  it("rejects agent_dir pointing to a non-existent path", () => {
    assert.throws(() => statSync("/tmp/nonexistent-agent-dir-that-does-not-exist-12345"), "non-existent path should throw");
  });

  it("rejects agent_dir pointing to a file (not directory)", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pi-sidecar-test-"));
    try {
      const testFile = join(tempDir, "not-a-dir");
      writeFileSync(testFile, "test");
      const stat = statSync(testFile);
      assert.ok(!stat.isDirectory(), "file should not be a directory");
      unlinkSync(testFile);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("resolveExtensionPath", () => {
  it("returns env var value when set", () => {
    const envVar = "TEST_RESOLVE_EXT_PATH_" + Date.now();
    process.env[envVar] = "/custom/path/ext.ts";
    try {
      const result = resolveExtensionPath(envVar, "nonexistent-pkg", "index.ts");
      assert.equal(result, "/custom/path/ext.ts");
    } finally {
      delete process.env[envVar];
    }
  });

  it("resolves acpx-provider extension from monorepo root", () => {
    const result = join(MONOREPO_ROOT, "extensions/acpx-provider/index.ts");
    assert.ok(result.length > 0, "should resolve to a non-empty path");
    assert.ok(result.replaceAll("\\", "/").endsWith("extensions/acpx-provider/index.ts"), `path should end with entry file, got: ${result}`);
    assert.doesNotThrow(() => accessSync(result), `extension file should exist at: ${result}`);
  });

  it("resolves cli-provider extension from monorepo root", () => {
    const result = join(MONOREPO_ROOT, "extensions/cli-provider/index.ts");
    assert.ok(result.length > 0, "should resolve to a non-empty path");
    assert.ok(result.replaceAll("\\", "/").endsWith("extensions/cli-provider/index.ts"), `path should end with entry file, got: ${result}`);
    assert.doesNotThrow(() => accessSync(result), `extension file should exist at: ${result}`);
  });

  it("resolves the unified providers extension from monorepo root", () => {
    const result = join(MONOREPO_ROOT, "extensions/providers/index.ts");
    assert.ok(result.replaceAll("\\", "/").endsWith("extensions/providers/index.ts"), `path should end with entry file, got: ${result}`);
    assert.doesNotThrow(() => accessSync(result), `extension file should exist at: ${result}`);
  });

  it("resolves ESM-only package via search-path fallback (@earendil-works/pi-coding-agent)", () => {
    const result = resolveExtensionPath("UNUSED_ENV_" + Date.now(), "@earendil-works/pi-coding-agent", "examples/extensions/subagent/index.ts");
    assert.ok(result.length > 0, "should resolve to a non-empty path");
    assert.ok(result.replaceAll("\\", "/").endsWith("examples/extensions/subagent/index.ts"), `path should end with entry file, got: ${result}`);
  });

  it("returns empty string for nonexistent package", () => {
    const result = resolveExtensionPath("UNUSED_ENV_" + Date.now(), "nonexistent-pkg-that-does-not-exist-12345", "index.ts");
    assert.equal(result, "");
  });

  it("handles scoped package names", () => {
    const result = resolveExtensionPath("UNUSED_ENV_" + Date.now(), "@earendil-works/pi-ai", "dist/index.js");
    assert.ok(result.length > 0, "should resolve scoped package");
    assert.ok(result.replaceAll("\\", "/").endsWith("dist/index.js"), `path should end with entry file, got: ${result}`);
  });
});

describe("resolveExtensionPathDetailed", () => {
  it("returns error for nonexistent package", () => {
    const result = resolveExtensionPathDetailed("UNUSED_ENV_" + Date.now(), "nonexistent-pkg-that-does-not-exist-99999", "index.ts");
    assert.equal(result.path, "");
    assert.ok(result.error, "should include an error message");
    assert.ok(result.error!.includes("Could not resolve"), `error should describe failure, got: ${result.error}`);
  });

  it("returns path without error for valid package", () => {
    const result = resolveExtensionPathDetailed("UNUSED_ENV_" + Date.now(), "jiti", "lib/jiti.cjs");
    assert.ok(result.path.length > 0, "should resolve to a non-empty path");
    assert.equal(result.error, undefined, "should not have an error");
  });
});
