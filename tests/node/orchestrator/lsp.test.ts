import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_LSP_SERVERS,
  MAX_DIAGNOSTIC_LINES,
  LspManager,
  detectLanguageId,
  encodeJsonRpcMessage,
  findExecutableOnPath,
  formatDiagnostics,
  registerLsp,
  resolveServerForFile,
  type LspDiagnostic,
} from "../../../extensions/orchestrator/lsp.ts";
import {
  SETTINGS_KEYS,
  clearSettingsCache,
  getSetting,
  parseSettingInput,
  setGlobalSettingsPath,
  validateSetting,
} from "../../../extensions/orchestrator/project-settings.ts";
import { formatValue } from "../../../extensions/orchestrator/settings-tui-helpers.ts";

type Handler = (event: any, ctx: any) => any;

function createMockPi() {
  const handlers = new Map<string, Handler[]>();
  const pi: any = {
    on(name: string, fn: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
      return () => {
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
  };
  async function fire(name: string, event: any, ctx: any) {
    let lastResult: any;
    for (const fn of handlers.get(name) ?? []) {
      const res = await fn(event, ctx);
      if (res !== undefined) lastResult = res;
    }
    return lastResult;
  }
  return { pi, fire };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

async function waitForPidExit(pid: number, maxWaitMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isPidAlive(pid);
}

/**
 * Real Node stdio JSON-RPC 2.0 mock LSP server script.
 * Controlled via CLI args: `--mode=<normal|hang|crash|hang-after-init>` and `--log=<path>`.
 */
const MOCK_LSP_SERVER_SOURCE = `#!/usr/bin/env node
import * as fs from "node:fs";

const args = process.argv.slice(2);
const getArg = (prefix, fallback = "") => {
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};

const mode = getArg("--mode=", "normal");
const logFile = getArg("--log=", "");

function record(entry) {
  if (!logFile) return;
  fs.appendFileSync(logFile, JSON.stringify({ pid: process.pid, ...entry }) + "\\n", "utf8");
}

function send(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.from("Content-Length: " + body.byteLength + "\\r\\n\\r\\n", "ascii");
  process.stdout.write(Buffer.concat([header, body]));
}

record({ event: "started", mode });

if (mode === "crash") {
  process.exit(1);
}

let buf = Buffer.alloc(0);
const delim = Buffer.from("\\r\\n\\r\\n", "ascii");

function diagnosticsForText(text) {
  if (text.includes("MANY_ERRORS")) {
    const diags = [];
    for (let i = 0; i < 25; i++) {
      diags.push({
        range: { start: { line: i, character: 0 }, end: { line: i, character: 5 } },
        severity: 1,
        message: "Error number " + (i + 1),
      });
    }
    return diags;
  }
  const diags = [];
  if (text.includes("TYPE_ERROR")) {
    diags.push({
      range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } },
      severity: 1,
      message: "Type 'string' is not assignable\\nto type 'number'.",
    });
  }
  if (text.includes("UNUSED_WARN")) {
    diags.push({
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
      severity: 2,
      message: "'foo' is declared but never used.",
    });
  }
  if (text.includes("INFO_ONLY")) {
    diags.push({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 3,
      message: "Informational note that should be ignored",
    });
  }
  return diags;
}

function handleMessage(msg) {
  record({ event: "recv", method: msg.method ?? null, id: msg.id ?? null });

  if (mode === "hang") {
    return;
  }

  if (msg.method === "initialize") {
    // Exercise server-to-client request handling before replying to initialize
    send({ jsonrpc: "2.0", id: 9001, method: "workspace/configuration", params: { items: [{ section: "mock" }] } });
    send({ jsonrpc: "2.0", id: 9002, method: "window/workDoneProgress/create", params: { token: "t1" } });
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { capabilities: { textDocumentSync: 1 } },
    });
    return;
  }

  if (msg.method === "initialized") {
    return;
  }

  if (msg.method === "textDocument/didOpen") {
    if (mode === "hang-after-init") return;
    const doc = msg.params.textDocument;
    record({ event: "didOpen", uri: doc.uri, version: doc.version, languageId: doc.languageId });
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: doc.uri,
        version: doc.version,
        diagnostics: diagnosticsForText(doc.text),
      },
    });
    return;
  }

  if (msg.method === "textDocument/didChange") {
    if (mode === "hang-after-init") return;
    const uri = msg.params.textDocument.uri;
    const version = msg.params.textDocument.version;
    const text = msg.params.contentChanges?.[0]?.text ?? "";
    record({ event: "didChange", uri, version });
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri,
        version,
        diagnostics: diagnosticsForText(text),
      },
    });
    return;
  }

  if (msg.method === "shutdown") {
    record({ event: "shutdown" });
    send({ jsonrpc: "2.0", id: msg.id, result: null });
    return;
  }

  if (msg.method === "exit") {
    record({ event: "exit" });
    process.exit(0);
  }
}

process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const headerEnd = buf.indexOf(delim);
    if (headerEnd === -1) break;
    const header = buf.subarray(0, headerEnd).toString("ascii");
    const match = /^content-length:\\s*(\\d+)\\s*$/im.exec(header);
    if (!match) break;
    const len = Number.parseInt(match[1], 10);
    const start = headerEnd + 4;
    if (buf.byteLength < start + len) break;
    const body = buf.subarray(start, start + len).toString("utf8");
    buf = buf.subarray(start + len);
    handleMessage(JSON.parse(body));
  }
});

// Keep process alive in hang modes
setInterval(() => {}, 60_000);
`;

describe("LSP diagnostics integration (#1445)", () => {
  let suiteRoot: string;
  let mockServerScript: string;
  let testDir: string;
  let globalSettingsFile: string;
  let activeManagers: LspManager[] = [];
  const savedEnv = new Map<string, string | undefined>();

  function setEnv(key: string, val: string | undefined) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }

  before(() => {
    suiteRoot = mkdtempSync(join(tmpdir(), "pi-lsp-suite-"));
    mockServerScript = join(suiteRoot, "mock-lsp-server.mjs");
    writeFileSync(mockServerScript, MOCK_LSP_SERVER_SOURCE, "utf8");
    chmodSync(mockServerScript, 0o755);
  });

  after(() => {
    rmSync(suiteRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    testDir = mkdtempSync(join(suiteRoot, "case-"));
    globalSettingsFile = join(testDir, "global-settings.json");
    setGlobalSettingsPath(globalSettingsFile);
    clearSettingsCache();
    activeManagers = [];
    setEnv("PI_LSP_ENABLED", undefined);
    setEnv("PI_LSP_IN_SUBAGENTS", undefined);
    setEnv("PI_SUBAGENT_CHILD", undefined);
  });

  afterEach(async () => {
    for (const mgr of activeManagers) {
      await mgr.shutdownAll();
    }
    activeManagers = [];
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    savedEnv.clear();
    setGlobalSettingsPath(null);
    clearSettingsCache();
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeProjectSettings(settings: Record<string, unknown>) {
    mkdirSync(join(testDir, ".pi"), { recursive: true });
    writeFileSync(join(testDir, ".pi", "pi-config-settings.json"), JSON.stringify(settings, null, 2));
    clearSettingsCache();
  }

  // ── Settings schema & validation ──────────────────────────────────

  describe("settings schema & validation", () => {
    it("declares lsp_enabled (default false) and lsp_servers (default {}) in settings-keys.json", () => {
      assert.equal(SETTINGS_KEYS.lsp_enabled?.type, "bool");
      assert.equal(SETTINGS_KEYS.lsp_enabled?.default, false);
      assert.equal(SETTINGS_KEYS.lsp_enabled?.env, "PI_LSP_ENABLED");
      assert.equal(SETTINGS_KEYS.lsp_enabled?.group, "LSP");

      assert.equal(SETTINGS_KEYS.lsp_servers?.type, "lsp_servers");
      assert.deepEqual(SETTINGS_KEYS.lsp_servers?.default, {});
      assert.equal(SETTINGS_KEYS.lsp_servers?.group, "LSP");
    });

    it("resolves lsp_enabled via PI_LSP_ENABLED env override and defaults to false", () => {
      assert.equal(getSetting(testDir, "lsp_enabled"), false);
      setEnv("PI_LSP_ENABLED", "true");
      clearSettingsCache();
      assert.equal(getSetting(testDir, "lsp_enabled"), true);
    });

    it("validates and normalizes lsp_servers entries in strict and lenient modes", () => {
      const valid = validateSetting("lsp_servers", {
        rust: { command: "rust-analyzer", args: ["--stdio"], extensions: ["RS", ".toml"] },
      });
      assert.equal(valid.ok, true);
      if (valid.ok) {
        assert.deepEqual(valid.value, {
          rust: { command: "rust-analyzer", args: ["--stdio"], extensions: [".rs", ".toml"] },
        });
      }

      assert.equal(validateSetting("lsp_servers", ["not-an-object"]).ok, false);
      assert.equal(validateSetting("lsp_servers", { bad: { command: "", extensions: [".ts"] } }).ok, false);
      assert.equal(validateSetting("lsp_servers", { bad: { command: "foo", extensions: [] } }).ok, false);
      assert.equal(
        validateSetting("lsp_servers", { bad: { command: "foo", args: [123], extensions: [".ts"] } }).ok,
        false,
      );

      // Lenient mode preserves valid siblings when one entry is malformed
      const lenient = validateSetting(
        "lsp_servers",
        {
          bad: { command: "", extensions: [".ts"] },
          good: { command: "gopls", extensions: [".go"] },
        },
        { mode: "lenient" },
      );
      assert.equal(lenient.ok, true);
      if (lenient.ok) {
        assert.deepEqual(lenient.value, { good: { command: "gopls", extensions: [".go"] } });
      }
    });

    it("parses JSON input and formats lsp_servers values for TUI display", () => {
      const parsed = parseSettingInput(
        "lsp_servers",
        JSON.stringify({ custom: { command: "my-lsp", extensions: [".xyz"] } }),
      );
      assert.equal(parsed.ok, true);
      assert.equal(parseSettingInput("lsp_servers", "not-json").ok, false);

      assert.equal(formatValue("lsp_servers", {}, SETTINGS_KEYS.lsp_servers), "(none)");
      assert.equal(
        formatValue("lsp_servers", { a: { command: "x", extensions: [".x"] } }, SETTINGS_KEYS.lsp_servers),
        "1 server(s)",
      );
    });
  });

  // ── Pure helpers ──────────────────────────────────────────────────

  describe("pure helpers", () => {
    it("encodes UTF-8 JSON-RPC Content-Length using byte length", () => {
      const buf = encodeJsonRpcMessage({ jsonrpc: "2.0", method: "test", params: { text: "héllo 🚀" } });
      const raw = buf.toString("utf8");
      const [header, body] = raw.split("\r\n\r\n");
      assert.equal(header, `Content-Length: ${Buffer.byteLength(body, "utf8")}`);
      assert.notEqual(Buffer.byteLength(body, "utf8"), body.length);
    });

    it("detects language IDs for TS/JS, Python, Go, and fallback extensions", () => {
      assert.equal(detectLanguageId("src/app.ts"), "typescript");
      assert.equal(detectLanguageId("src/view.tsx"), "typescriptreact");
      assert.equal(detectLanguageId("src/index.js"), "javascript");
      assert.equal(detectLanguageId("pkg/mod.py"), "python");
      assert.equal(detectLanguageId("cmd/main.go"), "go");
      assert.equal(detectLanguageId("lib/a.rs"), "rust");
      assert.equal(detectLanguageId("Makefile"), "plaintext");
    });

    it("finds only executable files on PATH without spawning shells", () => {
      const binDir = join(testDir, "bin");
      mkdirSync(binDir, { recursive: true });
      const execBin = join(binDir, "fake-lsp");
      const nonExec = join(binDir, "not-exec");
      writeFileSync(execBin, "#!/bin/sh\nexit 0\n");
      chmodSync(execBin, 0o755);
      writeFileSync(nonExec, "plain text");
      chmodSync(nonExec, 0o644);

      assert.equal(findExecutableOnPath("fake-lsp", binDir), execBin);
      assert.equal(findExecutableOnPath("not-exec", binDir), null);
      assert.equal(findExecutableOnPath("missing-bin", binDir), null);
      assert.equal(findExecutableOnPath(execBin, ""), execBin);
    });

    it("resolves built-in servers on PATH and prioritizes lsp_servers overrides", () => {
      const binDir = join(testDir, "bin");
      mkdirSync(binDir, { recursive: true });
      const fakePyright = join(binDir, "pyright-langserver");
      const fakeRuff = join(binDir, "ruff");
      const fakeCustom = join(binDir, "custom-py-lsp");
      for (const p of [fakePyright, fakeRuff, fakeCustom]) {
        writeFileSync(p, "#!/bin/sh\nexit 0\n");
        chmodSync(p, 0o755);
      }

      // Built-in priority: pyright-langserver beats ruff when basedpyright is absent
      const builtin = resolveServerForFile(join(testDir, "app.py"), {}, binDir);
      assert.deepEqual(builtin, {
        serverId: "python",
        command: fakePyright,
        args: ["--stdio"],
      });

      // User override beats built-in
      const overridden = resolveServerForFile(
        join(testDir, "app.py"),
        { python: { command: "custom-py-lsp", args: ["--fast"], extensions: [".py"] } },
        binDir,
      );
      assert.deepEqual(overridden, {
        serverId: "python",
        command: fakeCustom,
        args: ["--fast"],
      });

      // Overriding a built-in id with a missing binary does not fall back to the built-in
      const missingOverride = resolveServerForFile(
        join(testDir, "app.py"),
        { python: { command: "does-not-exist", extensions: [".py"] } },
        binDir,
      );
      assert.equal(missingOverride, null);

      assert.equal(resolveServerForFile(join(testDir, "README.md"), {}, binDir), null);
      assert.ok(BUILTIN_LSP_SERVERS.some((s) => s.id === "typescript"));
      assert.ok(BUILTIN_LSP_SERVERS.some((s) => s.id === "python"));
      assert.ok(BUILTIN_LSP_SERVERS.some((s) => s.id === "go"));
    });

    it("formats error/warning diagnostics sorted errors-first, drops info/hint, and caps at 20 lines", () => {
      const diags: LspDiagnostic[] = [
        { range: { start: { line: 4, character: 2 } }, severity: 2, message: "Unused var" },
        { range: { start: { line: 1, character: 0 } }, severity: 3, message: "Info ignored" },
        { range: { start: { line: 0, character: 0 } }, severity: 4, message: "Hint ignored" },
        { range: { start: { line: 9, character: 3 } }, severity: 1, message: "Type\n  mismatch" },
      ];
      const out = formatDiagnostics(diags, join(testDir, "src", "a.ts"), testDir, "typescript");
      assert.equal(
        out,
        [
          "LSP diagnostics (typescript):",
          "src/a.ts:10:4 [error] Type mismatch",
          "src/a.ts:5:3 [warning] Unused var",
        ].join("\n"),
      );

      // Clean / info-only returns null
      assert.equal(
        formatDiagnostics([{ range: { start: { line: 0, character: 0 } }, severity: 3, message: "info" }], join(testDir, "a.ts"), testDir, "typescript"),
        null,
      );

      // Cap at 20 lines
      const many: LspDiagnostic[] = Array.from({ length: 25 }, (_, i) => ({
        range: { start: { line: i, character: 0 } },
        severity: 1,
        message: `Err ${i + 1}`,
      }));
      const capped = formatDiagnostics(many, join(testDir, "a.ts"), testDir, "typescript", MAX_DIAGNOSTIC_LINES)!;
      const diagLines = capped.split("\n").filter((l) => l.includes("[error]"));
      assert.equal(diagLines.length, 20);
      assert.ok(capped.includes("... and 5 more diagnostic(s)"));
    });
  });

  // ── End-to-end mock stdio LSP child server tests ──────────────────

  describe("mock stdio JSON-RPC LSP lifecycle", () => {
    it("does not spawn any server when lsp_enabled is false (default)", async () => {
      const logFile = join(testDir, "lsp.log");
      writeProjectSettings({
        lsp_enabled: false,
        lsp_servers: {
          typescript: {
            command: process.execPath,
            args: [mockServerScript, "--mode=normal", `--log=${logFile}`],
            extensions: [".ts"],
          },
        },
      });
      const target = join(testDir, "a.ts");
      writeFileSync(target, "const x: number = TYPE_ERROR;\n");

      const { pi, fire } = createMockPi();
      const { manager } = registerLsp(pi, { timeoutMs: 1000 });
      activeManagers.push(manager);

      const res = await fire(
        "tool_result",
        {
          toolName: "write",
          input: { path: "a.ts" },
          isError: false,
          content: [{ type: "text", text: "Wrote a.ts" }],
        },
        { cwd: testDir },
      );

      assert.equal(res, undefined);
      assert.equal(manager.activeCount, 0);
      assert.equal(existsSync(logFile), false);
    });

    it("skips LSP in subagent children unless PI_LSP_IN_SUBAGENTS=1", async () => {
      const logFile = join(testDir, "subagent.log");
      writeProjectSettings({
        lsp_enabled: true,
        lsp_servers: {
          typescript: {
            command: process.execPath,
            args: [mockServerScript, "--mode=normal", `--log=${logFile}`],
            extensions: [".ts"],
          },
        },
      });
      writeFileSync(join(testDir, "a.ts"), "const x = TYPE_ERROR;\n");

      const { pi, fire } = createMockPi();
      const { manager } = registerLsp(pi, { timeoutMs: 1000, isSubagentChild: () => true });
      activeManagers.push(manager);

      const skipped = await fire(
        "tool_result",
        { toolName: "write", input: { path: "a.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      assert.equal(skipped, undefined);
      assert.equal(manager.activeCount, 0);

      setEnv("PI_LSP_IN_SUBAGENTS", "1");
      const optedIn = await fire(
        "tool_result",
        { toolName: "write", input: { path: "a.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      assert.ok(optedIn?.content?.[1]?.text.includes("a.ts:3:5 [error]"));
    });

    it("lazily starts server on write, runs initialize -> didOpen -> didChange -> publishDiagnostics, and caps at 20 lines", async () => {
      const logFile = join(testDir, "normal.log");
      writeProjectSettings({
        lsp_enabled: true,
        lsp_servers: {
          typescript: {
            command: process.execPath,
            args: [mockServerScript, "--mode=normal", `--log=${logFile}`],
            extensions: [".ts"],
          },
        },
      });
      const file = join(testDir, "app.ts");
      writeFileSync(file, "const foo = 1;\n// line 2\nconst x = TYPE_ERROR + UNUSED_WARN + INFO_ONLY;\n");

      const { pi, fire } = createMockPi();
      const { manager } = registerLsp(pi, { timeoutMs: 1500 });
      activeManagers.push(manager);

      // 1. First write triggers lazy start -> initialize -> didOpen
      const res1 = await fire(
        "tool_result",
        {
          toolName: "write",
          input: { path: "app.ts" },
          isError: false,
          content: [{ type: "text", text: "Successfully wrote app.ts" }],
        },
        { cwd: testDir },
      );

      assert.equal(manager.activeCount, 1);
      const firstPid = manager.getActivePids()[0];
      assert.ok(firstPid && firstPid > 0);
      assert.equal(res1.content.length, 2);
      const diagText1: string = res1.content[1].text;
      assert.ok(diagText1.includes("LSP diagnostics (typescript):"));
      assert.ok(diagText1.includes("app.ts:3:5 [error] Type 'string' is not assignable to type 'number'."));
      assert.ok(diagText1.includes("app.ts:1:7 [warning] 'foo' is declared but never used."));
      assert.ok(!diagText1.includes("Informational note"));

      // 2. Subsequent edit reuses the same server process and sends didChange (version 2)
      writeFileSync(file, "MANY_ERRORS\n");
      const res2 = await fire(
        "tool_result",
        {
          toolName: "edit",
          input: { path: "app.ts" },
          isError: false,
          content: [{ type: "text", text: "Successfully edited app.ts" }],
        },
        { cwd: testDir },
      );

      assert.equal(manager.activeCount, 1);
      assert.equal(manager.getActivePids()[0], firstPid);
      const diagText2: string = res2.content[1].text;
      const errLines = diagText2.split("\n").filter((l) => l.includes("[error]"));
      assert.equal(errLines.length, 20);
      assert.ok(diagText2.includes("... and 5 more diagnostic(s)"));

      // 3. Clean edit returns undefined (zero noise appended)
      writeFileSync(file, "export const ok = 42;\n");
      const res3 = await fire(
        "tool_result",
        {
          toolName: "edit",
          input: { path: "app.ts" },
          isError: false,
          content: [{ type: "text", text: "Successfully edited app.ts" }],
        },
        { cwd: testDir },
      );
      assert.equal(res3, undefined);

      // Verify JSON-RPC sequence recorded by mock server
      const events = readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(events.filter((e) => e.event === "started").length, 1);
      assert.equal(events.filter((e) => e.method === "initialize").length, 1);
      assert.equal(events.filter((e) => e.method === "initialized").length, 1);
      assert.equal(events.filter((e) => e.event === "didOpen" && e.version === 1).length, 1);
      assert.equal(events.filter((e) => e.event === "didChange" && e.version === 2).length, 1);
      assert.equal(events.filter((e) => e.event === "didChange" && e.version === 3).length, 1);
    });

    it("enforces bounded timeout when mock server hangs and never blocks write/edit", async () => {
      writeProjectSettings({
        lsp_enabled: true,
        lsp_servers: {
          typescript: {
            command: process.execPath,
            args: [mockServerScript, "--mode=hang"],
            extensions: [".ts"],
          },
        },
      });
      writeFileSync(join(testDir, "hung.ts"), "TYPE_ERROR\n");

      const { pi, fire } = createMockPi();
      const { manager } = registerLsp(pi, { timeoutMs: 200 });
      activeManagers.push(manager);

      const started = Date.now();
      const res = await fire(
        "tool_result",
        {
          toolName: "write",
          input: { path: "hung.ts" },
          isError: false,
          content: [{ type: "text", text: "Wrote hung.ts" }],
        },
        { cwd: testDir },
      );
      const elapsed = Date.now() - started;

      assert.equal(res, undefined);
      assert.ok(elapsed >= 150 && elapsed < 1200, `expected bounded timeout around 200ms, got ${elapsed}ms`);
    });

    it("degrades fail-soft on missing binary and crashed server without failing write/edit", async () => {
      // 1. Missing binary
      writeProjectSettings({
        lsp_enabled: true,
        lsp_servers: {
          typescript: {
            command: "nonexistent-lsp-binary-1445",
            extensions: [".ts"],
          },
        },
      });
      writeFileSync(join(testDir, "a.ts"), "TYPE_ERROR\n");

      const { pi: pi1, fire: fire1 } = createMockPi();
      const { manager: mgr1 } = registerLsp(pi1, { timeoutMs: 500, envPath: "" });
      activeManagers.push(mgr1);

      const missingRes = await fire1(
        "tool_result",
        { toolName: "write", input: { path: "a.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      assert.equal(missingRes, undefined);
      assert.equal(mgr1.activeCount, 0);

      // 2. Crashing server
      writeProjectSettings({
        lsp_enabled: true,
        lsp_servers: {
          typescript: {
            command: process.execPath,
            args: [mockServerScript, "--mode=crash"],
            extensions: [".ts"],
          },
        },
      });

      const { pi: pi2, fire: fire2 } = createMockPi();
      const { manager: mgr2 } = registerLsp(pi2, { timeoutMs: 500 });
      activeManagers.push(mgr2);

      const crashRes = await fire2(
        "tool_result",
        { toolName: "edit", input: { path: "a.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      assert.equal(crashRes, undefined);
      assert.equal(mgr2.activeCount, 0);
    });

    it("shuts down idle server automatically after idleTimeoutMs", async () => {
      writeProjectSettings({
        lsp_enabled: true,
        lsp_servers: {
          typescript: {
            command: process.execPath,
            args: [mockServerScript, "--mode=normal"],
            extensions: [".ts"],
          },
        },
      });
      writeFileSync(join(testDir, "idle.ts"), "TYPE_ERROR\n");

      const { pi, fire } = createMockPi();
      const { manager } = registerLsp(pi, { timeoutMs: 2000, idleTimeoutMs: 250 });
      activeManagers.push(manager);

      await fire(
        "tool_result",
        { toolName: "write", input: { path: "idle.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      const pid = manager.getActivePids()[0];
      assert.ok(pid && isPidAlive(pid));

      const exited = await waitForPidExit(pid, 3000);
      assert.equal(exited, true, `expected idle LSP process ${pid} to exit`);
      assert.equal(manager.activeCount, 0);
    });

    it("sends shutdown/exit and leaves zero orphan child processes on session_shutdown", async () => {
      const logFile = join(testDir, "shutdown.log");
      writeProjectSettings({
        lsp_enabled: true,
        lsp_servers: {
          typescript: {
            command: process.execPath,
            args: [mockServerScript, "--mode=normal", `--log=${logFile}`],
            extensions: [".ts"],
          },
          hung: {
            command: process.execPath,
            args: [mockServerScript, "--mode=hang"],
            extensions: [".hung"],
          },
        },
      });
      writeFileSync(join(testDir, "clean.ts"), "TYPE_ERROR\n");
      writeFileSync(join(testDir, "stuck.hung"), "hello\n");

      const { pi, fire } = createMockPi();
      const { manager } = registerLsp(pi, { timeoutMs: 250 });
      activeManagers.push(manager);

      await fire(
        "tool_result",
        { toolName: "write", input: { path: "clean.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      await fire(
        "tool_result",
        { toolName: "write", input: { path: "stuck.hung" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );

      const pids = manager.getActivePids();
      assert.equal(pids.length, 2);
      for (const pid of pids) {
        assert.equal(isPidAlive(pid), true);
      }

      await fire("session_shutdown", {}, { cwd: testDir });

      assert.equal(manager.activeCount, 0);
      for (const pid of pids) {
        const exited = await waitForPidExit(pid, 2000);
        assert.equal(exited, true, `expected child process ${pid} to exit after session_shutdown`);
      }

      const events = readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.ok(events.some((e) => e.event === "shutdown"), "expected graceful LSP shutdown request");
      assert.ok(events.some((e) => e.event === "exit"), "expected graceful LSP exit notification");
    });
  });
});
