/**
 * mcpc connect / register behavior.
 * Run: npx tsx --test tests/node/orchestrator/mcpc.test.ts
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  connectMcpc,
  mcpcConfigPath,
  registerMcpc,
  setMcpcExecFile,
} from "../../../extensions/orchestrator/mcpc.js";

const originalHome = process.env.HOME;
const originalArgv = process.argv.slice();

afterEach(() => {
  setMcpcExecFile(undefined);
  process.argv = originalArgv.slice();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpc-test-"));
  process.env.HOME = dir;
  return dir;
}

function writeMcpJson(home: string): string {
  const dir = path.join(home, ".pi", "pi-config");
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, "mcp.json");
  fs.writeFileSync(configPath, '{"mcpServers":{}}');
  return configPath;
}

function mockPi(): {
  pi: ExtensionAPI;
  commands: Map<string, { handler: (args: string, ctx: any) => Promise<void> }>;
  sessionStarts: Array<(event: unknown, ctx: unknown) => Promise<void> | void>;
} {
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const sessionStarts: Array<(event: unknown, ctx: unknown) => Promise<void> | void> = [];
  const pi = {
    registerCommand: (name: string, def: { handler: (args: string, ctx: any) => Promise<void> }) => {
      commands.set(name, def);
    },
    on: (event: string, fn: (event: unknown, ctx: unknown) => Promise<void> | void) => {
      if (event === "session_start") sessionStarts.push(fn);
    },
  };
  return { pi: pi as unknown as ExtensionAPI, commands, sessionStarts };
}

function uiCtx() {
  const notes: Array<{ message: string; level: string }> = [];
  return {
    notes,
    ctx: {
      hasUI: true,
      ui: {
        notify: (message: string, level: string) => {
          notes.push({ message, level });
        },
      },
    },
  };
}

describe("mcpcConfigPath", () => {
  it("joins HOME with .pi/pi-config/mcp.json", () => {
    const home = tmpHome();
    assert.equal(mcpcConfigPath(), path.join(home, ".pi", "pi-config", "mcp.json"));
  });
});

describe("connectMcpc", () => {
  it("skips when mcp.json is missing", async () => {
    const home = tmpHome();
    let called = 0;
    setMcpcExecFile(async () => {
      called += 1;
      return { stdout: "", stderr: "" };
    });
    const result = await connectMcpc();
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.match(result.message, /No MCP config/);
    assert.ok(result.message.includes(path.join(home, ".pi", "pi-config", "mcp.json")));
    assert.equal(called, 0);
  });

  it("runs mcpc connect with --stdio on success", async () => {
    const home = tmpHome();
    const configPath = writeMcpJson(home);
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    setMcpcExecFile(async (file, args) => {
      calls.push({ file, args });
      return { stdout: "connected 2 servers", stderr: "" };
    });
    const result = await connectMcpc();
    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.equal(result.message, "connected 2 servers");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, "mcpc");
    assert.deepEqual(calls[0].args, ["connect", configPath, "--stdio"]);
  });

  it("returns ENOENT guidance when mcpc is missing", async () => {
    tmpHome();
    writeMcpJson(process.env.HOME!);
    setMcpcExecFile(async () => {
      const err = Object.assign(new Error("spawn mcpc ENOENT"), { code: "ENOENT" });
      throw err;
    });
    const result = await connectMcpc();
    assert.equal(result.ok, false);
    assert.equal(result.skipped, false);
    assert.match(result.message, /mcpc not on PATH/);
    assert.match(result.message, /@apify\/mcpc/);
  });

  it("returns timeout message when the subprocess is killed", async () => {
    tmpHome();
    writeMcpJson(process.env.HOME!);
    setMcpcExecFile(async () => {
      const err = Object.assign(new Error("killed"), { killed: true });
      throw err;
    });
    const result = await connectMcpc();
    assert.equal(result.ok, false);
    assert.match(result.message, /timed out after 120s/);
  });
});

describe("registerMcpc", () => {
  it("registers /mcpc and a session_start handler", () => {
    const { pi, commands, sessionStarts } = mockPi();
    registerMcpc(pi);
    assert.equal(commands.has("mcpc"), true);
    assert.equal(sessionStarts.length, 1);
  });

  it("ignores unknown /mcpc args without connecting", async () => {
    tmpHome();
    writeMcpJson(process.env.HOME!);
    let called = 0;
    setMcpcExecFile(async () => {
      called += 1;
      return { stdout: "", stderr: "" };
    });
    const { pi, commands } = mockPi();
    registerMcpc(pi);
    const { ctx, notes } = uiCtx();
    await commands.get("mcpc")!.handler("status", ctx);
    assert.equal(called, 0);
    assert.equal(notes[0]?.message, "Usage: /mcpc connect");
  });

  it("runs connect for /mcpc with empty args", async () => {
    tmpHome();
    writeMcpJson(process.env.HOME!);
    setMcpcExecFile(async () => ({ stdout: "ok", stderr: "" }));
    const { pi, commands } = mockPi();
    registerMcpc(pi);
    const { ctx, notes } = uiCtx();
    await commands.get("mcpc")!.handler("", ctx);
    assert.equal(notes[0]?.message, "ok");
  });

  it("runs connect for /mcpc connect", async () => {
    tmpHome();
    writeMcpJson(process.env.HOME!);
    setMcpcExecFile(async () => ({ stdout: "ok-connect", stderr: "" }));
    const { pi, commands } = mockPi();
    registerMcpc(pi);
    const { ctx, notes } = uiCtx();
    await commands.get("mcpc")!.handler("connect", ctx);
    assert.equal(notes[0]?.message, "ok-connect");
  });

  it("skips auto-connect when session_start reason is not startup", async () => {
    tmpHome();
    writeMcpJson(process.env.HOME!);
    let called = 0;
    setMcpcExecFile(async () => {
      called += 1;
      return { stdout: "", stderr: "" };
    });
    const { pi, sessionStarts } = mockPi();
    registerMcpc(pi);
    await sessionStarts[0]({ reason: "reload" }, {});
    assert.equal(called, 0);
  });

  it("skips auto-connect on oneshot startup", async () => {
    tmpHome();
    writeMcpJson(process.env.HOME!);
    process.argv = [process.execPath, "pi", "-p"];
    let called = 0;
    setMcpcExecFile(async () => {
      called += 1;
      return { stdout: "", stderr: "" };
    });
    const { pi, sessionStarts } = mockPi();
    registerMcpc(pi);
    await sessionStarts[0]({ reason: "startup" }, {});
    assert.equal(called, 0);
  });

  it("auto-connects on interactive startup", async () => {
    tmpHome();
    writeMcpJson(process.env.HOME!);
    process.argv = [process.execPath, "pi"];
    let called = 0;
    setMcpcExecFile(async () => {
      called += 1;
      return { stdout: "auto", stderr: "" };
    });
    const { pi, sessionStarts } = mockPi();
    registerMcpc(pi);
    await sessionStarts[0]({ reason: "startup" }, {});
    assert.equal(called, 1);
  });
});
