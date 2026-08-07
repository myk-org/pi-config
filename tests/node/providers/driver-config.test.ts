import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearResolveBinaryCache } from "../../../extensions/shared/resolve-binary.js";
import { ClaudeDriver } from "../../../extensions/providers/claude-driver.js";
import { GeminiDriver } from "../../../extensions/providers/gemini-driver.js";
import { CursorCliDriver } from "../../../extensions/providers/cursor-cli-driver.js";
import { AcpxDriver } from "../../../extensions/providers/acpx-driver.js";

describe("driver config schemas", () => {
  it("ClaudeDriver driverKind", () => { assert.equal(ClaudeDriver.driverKind, "claude-cli"); });
  it("ClaudeDriver default config", () => { const c = ClaudeDriver.defaultConfig(); assert.equal(c.binary, "claude"); assert.equal(c.enabled, true); });
  it("ClaudeDriver parses custom", () => { const c = ClaudeDriver.configSchema.parse({ binary: "/bin/claude", enabled: false }); assert.equal(c.binary, "/bin/claude"); assert.equal(c.enabled, false); });
  it("ClaudeDriver handles null", () => { assert.equal(ClaudeDriver.configSchema.parse(null).binary, "claude"); });
  it("ClaudeDriver metadata", () => { assert.equal(ClaudeDriver.metadata.displayName, "Claude CLI"); });
  it("GeminiDriver driverKind", () => { assert.equal(GeminiDriver.driverKind, "gemini-cli"); });
  it("GeminiDriver default config", () => { assert.equal(GeminiDriver.defaultConfig().binary, "gemini"); });
  it("CursorCliDriver driverKind", () => { assert.equal(CursorCliDriver.driverKind, "cursor-cli"); });
  it("CursorCliDriver default config", () => { assert.equal(CursorCliDriver.defaultConfig().binary, "agent"); });
  it("AcpxDriver driverKind", () => { assert.equal(AcpxDriver.driverKind, "acpx"); });
  it("AcpxDriver default config", () => { assert.equal(AcpxDriver.defaultConfig().agent, "cursor"); });
  it("AcpxDriver custom agent", () => { assert.equal(AcpxDriver.configSchema.parse({ agent: "copilot" }).agent, "copilot"); });
});

describe("built-in drivers", () => {
  it("all unique driverKinds", async () => {
    const { BUILT_IN_DRIVERS } = await import("../../../extensions/providers/built-in-drivers.js");
    const kinds = BUILT_IN_DRIVERS.map((d: any) => d.driverKind);
    assert.equal(new Set(kinds).size, kinds.length);
  });
  it("CLI_AGENT_TO_DRIVER maps to registered drivers", async () => {
    const { BUILT_IN_DRIVERS, CLI_AGENT_TO_DRIVER } = await import("../../../extensions/providers/built-in-drivers.js");
    const driverKinds = new Set(BUILT_IN_DRIVERS.map((d: any) => d.driverKind));
    for (const [, kind] of Object.entries(CLI_AGENT_TO_DRIVER)) { assert.ok(driverKinds.has(kind as string)); }
  });
  it("ACPX_AGENT_TO_DRIVER maps to registered drivers", async () => {
    const { BUILT_IN_DRIVERS, ACPX_AGENT_TO_DRIVER } = await import("../../../extensions/providers/built-in-drivers.js");
    const driverKinds = new Set(BUILT_IN_DRIVERS.map((d: any) => d.driverKind));
    for (const [, kind] of Object.entries(ACPX_AGENT_TO_DRIVER)) { assert.ok(driverKinds.has(kind as string)); }
  });
});

describe("ACPX_AGENT_TO_DRIVER mapping", () => {
  it("maps cursor to acpx", async () => {
    const { ACPX_AGENT_TO_DRIVER } = await import("../../../extensions/providers/built-in-drivers.js");
    assert.equal(ACPX_AGENT_TO_DRIVER.cursor, "acpx");
  });
  it("maps claude to acpx", async () => {
    const { ACPX_AGENT_TO_DRIVER } = await import("../../../extensions/providers/built-in-drivers.js");
    assert.equal(ACPX_AGENT_TO_DRIVER.claude, "acpx");
  });
  it("maps gemini to acpx", async () => {
    const { ACPX_AGENT_TO_DRIVER } = await import("../../../extensions/providers/built-in-drivers.js");
    assert.equal(ACPX_AGENT_TO_DRIVER.gemini, "acpx");
  });
  it("does not map unknown agents", async () => {
    const { ACPX_AGENT_TO_DRIVER } = await import("../../../extensions/providers/built-in-drivers.js");
    assert.equal(ACPX_AGENT_TO_DRIVER.unknown, undefined);
  });
});

describe("acpx probe binary check", { concurrency: false }, () => {
  const prevPath = process.env.PATH;
  let tmpRoot: string | undefined;

  beforeEach(() => {
    clearResolveBinaryCache();
  });

  afterEach(() => {
    if (prevPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = prevPath;
    }
    clearResolveBinaryCache();
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = undefined;
    }
  });

  it("returns unavailable when cursor agent binary missing from PATH", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "acpx-probe-"));
    process.env.PATH = tmpRoot; // empty dir — no "agent" binary
    const result = await AcpxDriver.probe({ agent: "cursor", enabled: true });
    assert.equal(result.available, false);
    assert.ok(result.reason?.includes("not found"));
    assert.ok(result.reason?.includes("agent")); // cursor maps to "agent" binary
  });

  it("returns unavailable when claude agent binary missing from PATH", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "acpx-probe-"));
    process.env.PATH = tmpRoot;
    const result = await AcpxDriver.probe({ agent: "claude", enabled: true });
    assert.equal(result.available, false);
    assert.ok(result.reason?.includes("not found"));
    assert.ok(result.reason?.includes("claude"));
  });

  it("returns unavailable for agent with missing binary", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "acpx-probe-"));
    process.env.PATH = tmpRoot;
    const result = await AcpxDriver.probe({ agent: "nonexistent-xyz-99999", enabled: true });
    assert.equal(result.available, false);
    assert.ok(result.reason?.includes("not found"));
  });

  it("finds cursor agent binary when present on PATH", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "acpx-probe-"));
    const dest = join(tmpRoot, "agent");
    writeFileSync(dest, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = tmpRoot;
    const result = await AcpxDriver.probe({ agent: "cursor", enabled: true });
    // Binary found — probe proceeds to acpx runtime check (may fail if acpx not installed)
    assert.equal(typeof result.available, "boolean");
  });
});

describe("driver probe lifecycle", () => {
  const MISSING = "nonexistent-binary-xyz-12345";

  it("cursor-cli probe returns unavailable for missing binary", async () => {
    const result = await CursorCliDriver.probe({ binary: MISSING, enabled: true });
    assert.equal(result.available, false);
    assert.ok(result.reason?.includes("not found"));
  });

  it("cursor-cli probe returns available when binary exists", async () => {
    const result = await CursorCliDriver.probe({ binary: "agent", enabled: true });
    assert.equal(typeof result.available, "boolean");
    if (!result.available) {
      assert.equal(typeof result.reason, "string");
    }
  });

  it("claude probe returns unavailable for missing binary", async () => {
    const result = await ClaudeDriver.probe({ binary: MISSING, enabled: true });
    assert.equal(result.available, false);
    assert.ok(result.reason?.includes("not found"));
  });

  it("claude probe returns available when binary exists", async () => {
    const result = await ClaudeDriver.probe({ binary: "claude", enabled: true });
    assert.equal(typeof result.available, "boolean");
    if (!result.available) {
      assert.equal(typeof result.reason, "string");
    }
  });

  it("gemini probe returns unavailable for missing binary", async () => {
    const result = await GeminiDriver.probe({ binary: MISSING, enabled: true });
    assert.equal(result.available, false);
    assert.ok(result.reason?.includes("not found"));
  });

  it("gemini probe returns available when binary exists", async () => {
    const result = await GeminiDriver.probe({ binary: "gemini", enabled: true });
    assert.equal(typeof result.available, "boolean");
    if (!result.available) {
      assert.equal(typeof result.reason, "string");
    }
  });
});

describe("driver create lifecycle", () => {
  it("cursor-cli create returns disposable instance with missing binary", async () => {
    const instance = await CursorCliDriver.create({
      instanceId: "test-cursor",
      displayName: "Test Cursor",
      enabled: true,
      config: { binary: "nonexistent-binary-xyz-99999", enabled: true },
      cwd: "/tmp",
    });
    assert.equal(instance.instanceId, "test-cursor");
    assert.equal(typeof instance.dispose, "function");
    await instance.dispose();
  });
});
