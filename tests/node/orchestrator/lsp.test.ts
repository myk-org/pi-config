import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_INSTALL_RECIPES,
  BUILTIN_LSP_SERVERS,
  MAX_DIAGNOSTIC_LINES,
  LspManager,
  acquirePendingLspInstallClaim,
  claimPendingLspInstallRequest,
  clearPendingLspInstallRequest,
  clearPendingLspInstallRequestIfOwned,
  detectLanguageId,
  dismissLspInstallPermanently,
  encodeJsonRpcMessage,
  findExecutableOnPath,
  formatDiagnostics,
  isInteractiveTuiForLspPrompt,
  isLspInstallDismissed,
  listPendingLspInstallRequests,
  recordPendingLspInstallRequest,
  registerLsp,
  releasePendingLspInstallClaim,
  releasePendingLspInstallClaimsByOwner,
  renewPendingLspInstallClaim,
  resolveServerForFile,
  resolveTrustedLspEnabled,
  resolveTrustedLspServers,
  runLspServerInstall,
  type LspDiagnostic,
  type RegisterLspOptions,
} from "../../../extensions/orchestrator/lsp.ts";
import {
  SETTINGS_KEYS,
  clearSettingsCache,
  getSetting,
  parseSettingInput,
  setGlobalSettingsPath,
  validateSetting,
} from "../../../extensions/orchestrator/project-settings.ts";
import { registerSecretObfuscation } from "../../../extensions/orchestrator/secret-obfuscation.ts";
import { formatValue } from "../../../extensions/orchestrator/settings-tui-helpers.ts";
import { closeStateDb } from "../../../extensions/orchestrator/state-db.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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
    let currentEvent = event;
    let lastResult: any;
    for (const fn of handlers.get(name) ?? []) {
      const res = await fn(currentEvent, ctx);
      if (res !== undefined) {
        lastResult = res;
        if (name === "tool_result" && res.content !== undefined) {
          currentEvent = { ...currentEvent, content: res.content };
        }
      }
    }
    return lastResult;
  }
  return { pi, fire };
}

function registerDirectLsp(pi: any, opts: RegisterLspOptions = {}) {
  return registerLsp(pi, { useBroker: false, ...opts });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

async function waitForPidExit(pid: number, maxWaitMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isPidAlive(pid);
}

/**
 * Real Node stdio JSON-RPC 2.0 mock LSP server script.
 * Modes: normal | hang | crash | versionless-delayed | tag=<label>
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
const tag = getArg("--tag=", "");
const ignoreSigterm = args.includes("--ignore-sigterm");

if (ignoreSigterm) {
  process.on("SIGTERM", () => {});
}

function record(entry) {
  if (!logFile) return;
  fs.appendFileSync(logFile, JSON.stringify({ pid: process.pid, ...entry }) + "\\n", "utf8");
}

function send(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.from("Content-Length: " + body.byteLength + "\\r\\n\\r\\n", "ascii");
  process.stdout.write(Buffer.concat([header, body]));
}

record({ event: "started", mode, tag });

if (mode === "crash") {
  process.exit(1);
}

let buf = Buffer.alloc(0);
const delim = Buffer.from("\\r\\n\\r\\n", "ascii");

function diagnosticsForText(text) {
  const prefix = tag ? "[" + tag + "] " : "";
  if (text.includes("MANY_ERRORS")) {
    const diags = [];
    for (let i = 0; i < 25; i++) {
      diags.push({
        range: { start: { line: i, character: 0 }, end: { line: i, character: 5 } },
        severity: 1,
        message: prefix + "Error number " + (i + 1),
      });
    }
    return diags;
  }
  const diags = [];
  if (text.includes("SECRET_LEAK")) {
    const secretMatch = /SECRET_LEAK:(\\S+)/.exec(text);
    const leaked = secretMatch ? secretMatch[1] : "unknown";
    diags.push({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
      severity: 1,
      message: "Invalid literal " + leaked,
    });
  }
  if (text.includes("TYPE_ERROR")) {
    diags.push({
      range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } },
      severity: 1,
      message: prefix + "Type 'string' is not assignable\\nto type 'number'.",
    });
  }
  if (text.includes("UNUSED_WARN")) {
    diags.push({
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
      severity: 2,
      message: prefix + "'foo' is declared but never used.",
    });
  }
  if (text.includes("INFO_ONLY")) {
    diags.push({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 3,
      message: "Informational note that should be ignored",
    });
  }
  if (text.includes("OLD_ERR")) {
    diags.push({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      severity: 1,
      message: "STALE_EDIT_1_ERROR",
    });
  }
  if (text.includes("NEW_ERR")) {
    diags.push({
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
      severity: 1,
      message: "FRESH_EDIT_2_ERROR",
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
    const doc = msg.params.textDocument;
    record({ event: "didOpen", uri: doc.uri, version: doc.version, languageId: doc.languageId });
    if (mode === "versionless-omit-first") {
      if (doc.text.includes("OLD_ERR")) {
        return;
      }
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri: doc.uri, diagnostics: diagnosticsForText(doc.text) },
      });
      return;
    }
    if (mode === "versionless-delayed") {
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: { uri: doc.uri, diagnostics: diagnosticsForText(doc.text) },
        });
      }, 180);
      return;
    }
    if (mode === "versionless-late-old") {
      const delayMs = doc.text.includes("OLD_ERR") ? 280 : 20;
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: { uri: doc.uri, diagnostics: diagnosticsForText(doc.text) },
        });
      }, delayMs);
      return;
    }
    if (mode === "stale-versioned-then-unversioned") {
      if (doc.text.includes("OLD_ERR")) {
        // After the 120ms client timeout, send a stale versioned result followed by a stale unversioned result
        setTimeout(() => {
          send({
            jsonrpc: "2.0",
            method: "textDocument/publishDiagnostics",
            params: { uri: doc.uri, version: doc.version, diagnostics: diagnosticsForText(doc.text) },
          });
        }, 160);
        setTimeout(() => {
          send({
            jsonrpc: "2.0",
            method: "textDocument/publishDiagnostics",
            params: { uri: doc.uri, diagnostics: diagnosticsForText(doc.text) },
          });
        }, 230);
        return;
      }
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri: doc.uri, diagnostics: diagnosticsForText(doc.text) },
      });
      return;
    }
    if (mode === "mixed-versioned-unversioned") {
      if (doc.uri.endsWith("/versioned.ts")) {
        const delayMs = doc.text.includes("SLOW_VER") ? 180 : 0;
        setTimeout(() => {
          send({
            jsonrpc: "2.0",
            method: "textDocument/publishDiagnostics",
            params: { uri: doc.uri, version: doc.version, diagnostics: diagnosticsForText(doc.text) },
          });
        }, delayMs);
        return;
      }
      const delayMs = doc.text.includes("OLD_ERR") ? 280 : 20;
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: { uri: doc.uri, diagnostics: diagnosticsForText(doc.text) },
        });
      }, delayMs);
      return;
    }
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
    const uri = msg.params.textDocument.uri;
    const version = msg.params.textDocument.version;
    const text = msg.params.contentChanges?.[0]?.text ?? "";
    record({ event: "didChange", uri, version });
    if (mode === "versionless-delayed") {
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: { uri, diagnostics: diagnosticsForText(text) },
        });
      }, 260);
      return;
    }
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
    setEnv("PI_SECRET_OBFUSCATION", undefined);
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

  function writeGlobalSettings(settings: Record<string, unknown>) {
    writeFileSync(globalSettingsFile, JSON.stringify(settings, null, 2));
    clearSettingsCache();
  }

  function writeProjectSettings(settings: Record<string, unknown>) {
    mkdirSync(join(testDir, ".pi"), { recursive: true });
    writeFileSync(join(testDir, ".pi", "pi-config-settings.json"), JSON.stringify(settings, null, 2));
    clearSettingsCache();
  }

  // ── Settings schema & trust boundary ──────────────────────────────

  describe("settings schema", () => {
    it("declares lsp_enabled with default false in settings-keys.json", () => {
      assert.equal(SETTINGS_KEYS.lsp_enabled?.type, "bool");
      assert.equal(SETTINGS_KEYS.lsp_enabled?.default, false);
      assert.equal(SETTINGS_KEYS.lsp_enabled?.env, "PI_LSP_ENABLED");
      assert.equal(SETTINGS_KEYS.lsp_enabled?.group, "LSP");
    });

    it("declares lsp_servers with empty object default in settings-keys.json", () => {
      assert.equal(SETTINGS_KEYS.lsp_servers?.type, "lsp_servers");
      assert.deepEqual(SETTINGS_KEYS.lsp_servers?.default, {});
      assert.equal(SETTINGS_KEYS.lsp_servers?.group, "LSP");
    });

    it("resolves trusted lsp_enabled from PI_LSP_ENABLED env override", () => {
      assert.equal(resolveTrustedLspEnabled(), false);
      setEnv("PI_LSP_ENABLED", "true");
      clearSettingsCache();
      assert.equal(resolveTrustedLspEnabled(), true);
    });

    it("ignores project-scoped lsp_enabled when global settings leave it unset", () => {
      writeProjectSettings({ lsp_enabled: true });
      assert.equal(resolveTrustedLspEnabled(), false);
    });

    it("ignores project-scoped lsp_servers entries in favor of global settings", () => {
      writeProjectSettings({
        lsp_servers: { evil: { command: "./evil.sh", extensions: [".ts"] } },
      });
      assert.deepEqual(resolveTrustedLspServers(), {});
    });

    it("ignores conflicting project lsp settings in unified getSetting resolution", () => {
      writeGlobalSettings({
        lsp_enabled: false,
        lsp_servers: { go: { command: "gopls", extensions: [".go"] } },
      });
      writeProjectSettings({
        lsp_enabled: true,
        lsp_servers: { evil: { command: "./evil.sh", extensions: [".ts"] } },
      });
      assert.equal(getSetting(testDir, "lsp_enabled"), false);
      assert.deepEqual(getSetting(testDir, "lsp_servers"), {
        go: { command: "gopls", extensions: [".go"] },
      });
    });

    it("normalizes lsp_servers extensions in strict validation", () => {
      const valid = validateSetting("lsp_servers", {
        rust: { command: "rust-analyzer", args: ["--stdio"], extensions: ["RS", ".toml"] },
      });
      assert.equal(valid.ok, true);
      if (valid.ok) {
        assert.deepEqual(valid.value, {
          rust: { command: "rust-analyzer", args: ["--stdio"], extensions: [".rs", ".toml"] },
        });
      }
    });

    it("rejects malformed lsp_servers shapes in strict validation", () => {
      assert.equal(validateSetting("lsp_servers", ["not-an-object"]).ok, false);
      assert.equal(validateSetting("lsp_servers", { bad: { command: "", extensions: [".ts"] } }).ok, false);
      assert.equal(validateSetting("lsp_servers", { bad: { command: "foo", extensions: [] } }).ok, false);
      assert.equal(
        validateSetting("lsp_servers", { bad: { command: "foo", args: [123], extensions: [".ts"] } }).ok,
        false,
      );
    });

    it("preserves valid lsp_servers siblings in lenient validation", () => {
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

    it("parses JSON input for lsp_servers", () => {
      const parsed = parseSettingInput(
        "lsp_servers",
        JSON.stringify({ custom: { command: "my-lsp", extensions: [".xyz"] } }),
      );
      assert.equal(parsed.ok, true);
      assert.equal(parseSettingInput("lsp_servers", "not-json").ok, false);
    });

    it("formats lsp_servers counts for TUI display", () => {
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

    it("detects language IDs from file extensions", () => {
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

    it("rejects relative command paths or relative PATH entries to block repo binary hijacking", () => {
      const repoDir = join(testDir, "repo");
      mkdirSync(repoDir, { recursive: true });
      const repoBin = join(repoDir, "server");
      writeFileSync(repoBin, "#!/bin/sh\nexit 0\n");
      chmodSync(repoBin, 0o755);

      const prevCwd = process.cwd();
      try {
        process.chdir(repoDir);
        assert.equal(findExecutableOnPath("./server", ""), null);
        assert.equal(findExecutableOnPath("server", "."), null);
        assert.equal(findExecutableOnPath("repo/server", ""), null);
        assert.equal(findExecutableOnPath(repoBin, ""), repoBin);
      } finally {
        process.chdir(prevCwd);
      }
    });

    it("resolves built-in servers by PATH candidate priority", () => {
      const binDir = join(testDir, "bin");
      mkdirSync(binDir, { recursive: true });
      const fakePyright = join(binDir, "pyright-langserver");
      const fakeRuff = join(binDir, "ruff");
      for (const p of [fakePyright, fakeRuff]) {
        writeFileSync(p, "#!/bin/sh\nexit 0\n");
        chmodSync(p, 0o755);
      }

      const builtin = resolveServerForFile(join(testDir, "app.py"), {}, binDir);
      assert.deepEqual(builtin, {
        serverId: "python",
        command: fakePyright,
        args: ["--stdio"],
      });
      assert.equal(resolveServerForFile(join(testDir, "README.md"), {}, binDir), null);
      assert.ok(BUILTIN_LSP_SERVERS.some((s) => s.id === "typescript"));
      assert.ok(BUILTIN_LSP_SERVERS.some((s) => s.id === "python"));
      assert.ok(BUILTIN_LSP_SERVERS.some((s) => s.id === "go"));
    });

    it("prioritizes lsp_servers overrides over built-in server candidates", () => {
      const binDir = join(testDir, "bin");
      mkdirSync(binDir, { recursive: true });
      const fakePyright = join(binDir, "pyright-langserver");
      const fakeCustom = join(binDir, "custom-py-lsp");
      for (const p of [fakePyright, fakeCustom]) {
        writeFileSync(p, "#!/bin/sh\nexit 0\n");
        chmodSync(p, 0o755);
      }

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

      const missingOverride = resolveServerForFile(
        join(testDir, "app.py"),
        { python: { command: "does-not-exist", extensions: [".py"] } },
        binDir,
      );
      assert.equal(missingOverride, null);
    });

    it("formats errors before warnings while dropping info or hint diagnostics", () => {
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
      assert.equal(
        formatDiagnostics(
          [{ range: { start: { line: 0, character: 0 } }, severity: 3, message: "info" }],
          join(testDir, "a.ts"),
          testDir,
          "typescript",
        ),
        null,
      );
    });

    it("interprets omitted diagnostic severity as error per LSP specification", () => {
      const diags: LspDiagnostic[] = [
        { range: { start: { line: 3, character: 1 } }, severity: 2, message: "Minor warning" },
        { range: { start: { line: 1, character: 2 } }, message: "Severity omitted error" },
      ];
      const out = formatDiagnostics(diags, join(testDir, "a.ts"), testDir, "typescript");
      assert.equal(
        out,
        [
          "LSP diagnostics (typescript):",
          "a.ts:2:3 [error] Severity omitted error",
          "a.ts:4:2 [warning] Minor warning",
        ].join("\n"),
      );
    });

    it("caps formatted diagnostics at 20 lines with an omission summary", () => {
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
    it("does not spawn any server when lsp_enabled is false", async () => {
      const logFile = join(testDir, "lsp.log");
      writeGlobalSettings({
        lsp_enabled: false,
        lsp_servers: {
          typescript: {
            command: process.execPath,
            args: [mockServerScript, "--mode=normal", `--log=${logFile}`],
            extensions: [".ts"],
          },
        },
      });
      writeFileSync(join(testDir, "a.ts"), "const x: number = TYPE_ERROR;\n");

      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { timeoutMs: 1000 });
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

    it("leaves legacy project settings untouched when lsp_enabled is false", async () => {
      writeGlobalSettings({ lsp_enabled: false });
      const piDir = join(testDir, ".pi");
      mkdirSync(piDir, { recursive: true });
      const legacyFile = join(piDir, "pi-config-settings.jsonc");
      const targetJson = join(piDir, "pi-config-settings.json");
      writeFileSync(legacyFile, '{"lsp_enabled": true}\n', "utf8");
      writeFileSync(join(testDir, "a.ts"), "TYPE_ERROR\n");

      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { timeoutMs: 500 });
      activeManagers.push(manager);

      const res = await fire(
        "tool_result",
        { toolName: "write", input: { path: "a.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );

      assert.equal(res, undefined);
      assert.equal(existsSync(legacyFile), true);
      assert.equal(existsSync(targetJson), false);
    });

    it("refuses to spawn project-configured lsp_servers from an untrusted repo", async () => {
      const logFile = join(testDir, "evil.log");
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
      writeFileSync(join(testDir, "a.ts"), "TYPE_ERROR\n");

      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { timeoutMs: 1000, envPath: "" });
      activeManagers.push(manager);

      const res = await fire(
        "tool_result",
        { toolName: "write", input: { path: "a.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );

      assert.equal(res, undefined);
      assert.equal(manager.activeCount, 0);
      assert.equal(existsSync(logFile), false);
    });

    it("enables LSP for editing subagents by default when lsp_enabled is true", async () => {
      const logFile = join(testDir, "subagent.log");
      writeGlobalSettings({
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
      const { manager } = registerDirectLsp(pi, { timeoutMs: 1000, isSubagentChild: () => true });
      activeManagers.push(manager);

      const enabled = await fire(
        "tool_result",
        { toolName: "write", input: { path: "a.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      assert.ok(enabled?.content?.[1]?.text.includes("a.ts:3:5 [error]"));
    });

    it("skips LSP in subagent children when PI_LSP_IN_SUBAGENTS is explicitly false", async () => {
      writeGlobalSettings({
        lsp_enabled: true,
        lsp_servers: {
          typescript: {
            command: process.execPath,
            args: [mockServerScript, "--mode=normal"],
            extensions: [".ts"],
          },
        },
      });
      writeFileSync(join(testDir, "a.ts"), "const x = TYPE_ERROR;\n");
      setEnv("PI_LSP_IN_SUBAGENTS", "0");

      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { timeoutMs: 1000, isSubagentChild: () => true });
      activeManagers.push(manager);

      const skipped = await fire(
        "tool_result",
        { toolName: "write", input: { path: "a.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      assert.equal(skipped, undefined);
      assert.equal(manager.activeCount, 0);
    });

    it("lazily initializes on write, reuses the server for didChange edits, caps at 20 lines", async () => {
      const logFile = join(testDir, "normal.log");
      writeGlobalSettings({
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
      const { manager } = registerDirectLsp(pi, { timeoutMs: 1500 });
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

    it("enforces bounded timeout without blocking write when a server hangs", async () => {
      writeGlobalSettings({
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
      const { manager } = registerDirectLsp(pi, { timeoutMs: 200 });
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

    it("degrades fail-soft when the configured LSP binary is missing", async () => {
      writeGlobalSettings({
        lsp_enabled: true,
        lsp_servers: {
          typescript: {
            command: "nonexistent-lsp-binary-1445",
            extensions: [".ts"],
          },
        },
      });
      writeFileSync(join(testDir, "a.ts"), "TYPE_ERROR\n");

      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { timeoutMs: 500, envPath: "" });
      activeManagers.push(manager);

      const res = await fire(
        "tool_result",
        { toolName: "write", input: { path: "a.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      assert.equal(res, undefined);
      assert.equal(manager.activeCount, 0);
    });

    it("degrades fail-soft when the LSP child process crashes immediately", async () => {
      writeGlobalSettings({
        lsp_enabled: true,
        lsp_servers: {
          typescript: {
            command: process.execPath,
            args: [mockServerScript, "--mode=crash"],
            extensions: [".ts"],
          },
        },
      });
      writeFileSync(join(testDir, "a.ts"), "TYPE_ERROR\n");

      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { timeoutMs: 500 });
      activeManagers.push(manager);

      const res = await fire(
        "tool_result",
        { toolName: "edit", input: { path: "a.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      assert.equal(res, undefined);
      assert.equal(manager.activeCount, 0);
    });

    it("replaces an active pooled client when lsp_servers override changes mid-session", async () => {
      writeGlobalSettings({
        lsp_enabled: true,
        lsp_servers: {
          typescript: {
            command: process.execPath,
            args: [mockServerScript, "--mode=normal", "--tag=v1"],
            extensions: [".ts"],
          },
        },
      });
      writeFileSync(join(testDir, "swap.ts"), "TYPE_ERROR\n");

      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { timeoutMs: 1500 });
      activeManagers.push(manager);

      const res1 = await fire(
        "tool_result",
        { toolName: "write", input: { path: "swap.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      const pid1 = manager.getActivePids()[0];
      assert.ok(pid1);
      assert.ok(res1.content[1].text.includes("[v1]"));

      // Update override args while client is still active
      writeGlobalSettings({
        lsp_enabled: true,
        lsp_servers: {
          typescript: {
            command: process.execPath,
            args: [mockServerScript, "--mode=normal", "--tag=v2"],
            extensions: [".ts"],
          },
        },
      });

      const res2 = await fire(
        "tool_result",
        { toolName: "edit", input: { path: "swap.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      const pid2 = manager.getActivePids()[0];
      assert.ok(pid2);
      assert.notEqual(pid2, pid1);
      assert.ok(res2.content[1].text.includes("[v2]"));
      assert.equal(await waitForPidExit(pid1, 2000), true, "expected replaced LSP process to exit");
    });

    it("serializes concurrent edits across an override change without orphaning servers", async () => {
      writeGlobalSettings({
        lsp_enabled: true,
        lsp_servers: {
          typescript: {
            command: process.execPath,
            args: [mockServerScript, "--mode=normal", "--tag=v1"],
            extensions: [".ts"],
          },
        },
      });
      writeFileSync(join(testDir, "a.ts"), "TYPE_ERROR\n");
      writeFileSync(join(testDir, "b.ts"), "TYPE_ERROR\n");

      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { timeoutMs: 2000 });
      activeManagers.push(manager);

      await fire(
        "tool_result",
        { toolName: "write", input: { path: "a.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      const pid1 = manager.getActivePids()[0];
      assert.ok(pid1);

      writeGlobalSettings({
        lsp_enabled: true,
        lsp_servers: {
          typescript: {
            command: process.execPath,
            args: [mockServerScript, "--mode=normal", "--tag=v2"],
            extensions: [".ts"],
          },
        },
      });

      const [resA, resB] = await Promise.all([
        fire(
          "tool_result",
          { toolName: "edit", input: { path: "a.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
          { cwd: testDir },
        ),
        fire(
          "tool_result",
          { toolName: "write", input: { path: "b.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
          { cwd: testDir },
        ),
      ]);

      assert.ok(resA?.content?.[1]?.text.includes("[v2]"));
      assert.ok(resB?.content?.[1]?.text.includes("[v2]"));
      assert.equal(manager.activeCount, 1);
      const activePid = manager.getActivePids()[0];
      assert.ok(activePid && activePid !== pid1);
      assert.equal(await waitForPidExit(pid1, 2000), true);

      await fire("session_shutdown", {}, { cwd: testDir });
      assert.equal(manager.activeCount, 0);
      assert.equal(await waitForPidExit(activePid, 2000), true);
    });

    it("recovers current edit errors when an unversioned server omits the first publication", async () => {
      writeGlobalSettings({
        lsp_enabled: true,
        lsp_servers: {
          typescript: {
            command: process.execPath,
            args: [mockServerScript, "--mode=versionless-omit-first"],
            extensions: [".ts"],
          },
        },
      });
      const file = join(testDir, "omit.ts");
      writeFileSync(file, "OLD_ERR\n");

      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { timeoutMs: 250 });
      activeManagers.push(manager);

      const res1 = await fire(
        "tool_result",
        { toolName: "write", input: { path: "omit.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      assert.equal(res1, undefined);

      writeFileSync(file, "line1\nNEW_ERR\n");
      const res2 = await fire(
        "tool_result",
        { toolName: "edit", input: { path: "omit.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      assert.ok(res2?.content?.[1]?.text.includes("FRESH_EDIT_2_ERROR"));
    });

    it("resets an ambiguous unversioned client so a delayed prior publication cannot taint a later edit", async () => {
      writeGlobalSettings({
        lsp_enabled: true,
        lsp_servers: {
          typescript: {
            command: process.execPath,
            args: [mockServerScript, "--mode=versionless-late-old"],
            extensions: [".ts"],
          },
        },
      });
      const file = join(testDir, "late.ts");
      writeFileSync(file, "OLD_ERR\n");

      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { timeoutMs: 180 });
      activeManagers.push(manager);

      const res1 = await fire(
        "tool_result",
        { toolName: "write", input: { path: "late.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      assert.equal(res1, undefined);
      const oldPid = manager.getActivePids()[0];
      assert.ok(oldPid);

      (manager as any).timeoutMs = 800;
      writeFileSync(file, "line1\nNEW_ERR\n");
      const res2 = await fire(
        "tool_result",
        { toolName: "edit", input: { path: "late.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      assert.ok(res2?.content?.[1]?.text.includes("FRESH_EDIT_2_ERROR"));
      assert.ok(!res2.content[1].text.includes("STALE_EDIT_1_ERROR"));
      assert.equal(await waitForPidExit(oldPid, 2000), true);
    });

    it("preserves timeout ambiguity even if a late versioned publication arrives before the next edit", async () => {
      writeGlobalSettings({
        lsp_enabled: true,
        lsp_servers: {
          typescript: {
            command: process.execPath,
            args: [mockServerScript, "--mode=stale-versioned-then-unversioned"],
            extensions: [".ts"],
          },
        },
      });
      const file = join(testDir, "late-ver.ts");
      writeFileSync(file, "OLD_ERR\n");

      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { timeoutMs: 120 });
      activeManagers.push(manager);

      const timedOut = await fire(
        "tool_result",
        { toolName: "write", input: { path: "late-ver.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      assert.equal(timedOut, undefined);

      // Wait until the stale versioned publish (160ms) has been processed, before the stale unversioned publish (230ms)
      await new Promise((r) => setTimeout(r, 80));

      (manager as any).timeoutMs = 800;
      writeFileSync(file, "line1\nNEW_ERR\n");
      const nextRes = await fire(
        "tool_result",
        { toolName: "edit", input: { path: "late-ver.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      assert.ok(nextRes?.content?.[1]?.text.includes("FRESH_EDIT_2_ERROR"));
      assert.ok(!nextRes.content[1].text.includes("STALE_EDIT_1_ERROR"));
    });

    it("returns diagnostics for a versioned document on a mixed-mode server", async () => {
      writeGlobalSettings({
        lsp_enabled: true,
        lsp_servers: {
          typescript: {
            command: process.execPath,
            args: [mockServerScript, "--mode=mixed-versioned-unversioned"],
            extensions: [".ts"],
          },
        },
      });
      writeFileSync(join(testDir, "versioned.ts"), "TYPE_ERROR\n");

      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { timeoutMs: 1000 });
      activeManagers.push(manager);

      const verRes = await fire(
        "tool_result",
        { toolName: "write", input: { path: "versioned.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      assert.ok(verRes?.content?.[1]?.text.includes("versioned.ts:3:5 [error]"));
    });

    it("delivers fresh diagnostics after an unversioned document timeout on a mixed-mode server", async () => {
      writeGlobalSettings({
        lsp_enabled: true,
        lsp_servers: {
          typescript: {
            command: process.execPath,
            args: [mockServerScript, "--mode=mixed-versioned-unversioned"],
            extensions: [".ts"],
          },
        },
      });
      writeFileSync(join(testDir, "versioned.ts"), "TYPE_ERROR\n");
      const unversionedFile = join(testDir, "unversioned.ts");
      writeFileSync(unversionedFile, "OLD_ERR\n");

      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { timeoutMs: 180 });
      activeManagers.push(manager);

      await fire(
        "tool_result",
        { toolName: "write", input: { path: "versioned.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      const timedOut = await fire(
        "tool_result",
        { toolName: "write", input: { path: "unversioned.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      assert.equal(timedOut, undefined);

      (manager as any).timeoutMs = 800;
      writeFileSync(unversionedFile, "line1\nNEW_ERR\n");
      const recovered = await fire(
        "tool_result",
        { toolName: "edit", input: { path: "unversioned.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      assert.ok(recovered?.content?.[1]?.text.includes("FRESH_EDIT_2_ERROR"));
      assert.ok(!recovered.content[1].text.includes("STALE_EDIT_1_ERROR"));
    });

    it("terminates the replaced server process after a mixed-mode unversioned reset", async () => {
      writeGlobalSettings({
        lsp_enabled: true,
        lsp_servers: {
          typescript: {
            command: process.execPath,
            args: [mockServerScript, "--mode=mixed-versioned-unversioned"],
            extensions: [".ts"],
          },
        },
      });
      writeFileSync(join(testDir, "versioned.ts"), "TYPE_ERROR\n");
      const unversionedFile = join(testDir, "unversioned.ts");
      writeFileSync(unversionedFile, "OLD_ERR\n");

      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { timeoutMs: 180 });
      activeManagers.push(manager);

      await fire(
        "tool_result",
        { toolName: "write", input: { path: "versioned.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      await fire(
        "tool_result",
        { toolName: "write", input: { path: "unversioned.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      const oldPid = manager.getActivePids()[0];
      assert.ok(oldPid);

      (manager as any).timeoutMs = 800;
      writeFileSync(unversionedFile, "line1\nNEW_ERR\n");
      await fire(
        "tool_result",
        { toolName: "edit", input: { path: "unversioned.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      assert.equal(await waitForPidExit(oldPid, 2000), true);
    });

    it("preserves pending diagnostics for an unrelated file while resetting a timed-out unversioned file", async () => {
      const overrides = {
        typescript: {
          command: process.execPath,
          args: [mockServerScript, "--mode=mixed-versioned-unversioned"],
          extensions: [".ts"],
        },
      };
      const versionedFile = join(testDir, "versioned.ts");
      const unversionedFile = join(testDir, "unversioned.ts");
      writeFileSync(unversionedFile, "OLD_ERR\n");
      writeFileSync(versionedFile, "SLOW_VER\n// line 2\nconst x = TYPE_ERROR;\n");

      const sharedMgr = new LspManager({ timeoutMs: 120 });
      activeManagers.push(sharedMgr);
      const firstUnv = await sharedMgr.getDiagnosticsForFile(testDir, "unversioned.ts", overrides);
      assert.equal(firstUnv, null);

      (sharedMgr as any).timeoutMs = 800;
      writeFileSync(unversionedFile, "line1\nNEW_ERR\n");
      const versionedPromise = sharedMgr.getDiagnosticsForFile(testDir, "versioned.ts", overrides);
      const unversionedPromise = sharedMgr.getDiagnosticsForFile(testDir, "unversioned.ts", overrides);

      const [verDiag, unvDiag] = await Promise.all([versionedPromise, unversionedPromise]);
      assert.ok(verDiag?.includes("versioned.ts:3:5 [error]"), `expected versioned.ts diagnostics to survive, got: ${verDiag}`);
      assert.ok(unvDiag?.includes("FRESH_EDIT_2_ERROR"), `expected unversioned.ts fresh diagnostics after drain, got: ${unvDiag}`);
    });

    it("bounds overlapping unversioned reset teardown within the single per-edit timeout budget", async () => {
      const overrides = {
        typescript: {
          command: process.execPath,
          args: [mockServerScript, "--mode=hang", "--ignore-sigterm"],
          extensions: [".ts"],
        },
      };
      const file = join(testDir, "budget.ts");
      writeFileSync(file, "OLD_ERR\n");

      const manager = new LspManager({
        timeoutMs: 250,
        shutdownGraceMs: 500,
        killGraceMs: 400,
      });
      activeManagers.push(manager);

      // Start two overlapping edits simultaneously against a hung server that ignores SIGTERM
      const started = Date.now();
      const [r1, r2] = await Promise.all([
        manager.getDiagnosticsForFile(testDir, "budget.ts", overrides),
        manager.getDiagnosticsForFile(testDir, "budget.ts", overrides),
      ]);
      const elapsed = Date.now() - started;

      assert.equal(r1, null);
      assert.equal(r2, null);
      assert.ok(elapsed < 600, `expected overlapping reset to stay within 250ms budget (+jitter), got ${elapsed}ms`);
    });

    it("resets an unversioned client when two edits for the same file start simultaneously", async () => {
      writeGlobalSettings({
        lsp_enabled: true,
        lsp_servers: {
          typescript: {
            command: process.execPath,
            args: [mockServerScript, "--mode=versionless-delayed"],
            extensions: [".ts"],
          },
        },
      });
      const warmup = join(testDir, "warmup.ts");
      const target = join(testDir, "simultaneous.ts");
      writeFileSync(warmup, "TYPE_ERROR\n");

      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { timeoutMs: 1200 });
      activeManagers.push(manager);

      // Pre-warm the client so both simultaneous calls hit an already-active pooled client
      await fire(
        "tool_result",
        { toolName: "write", input: { path: "warmup.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      const warmPid = manager.getActivePids()[0];
      assert.ok(warmPid);

      // Start two checks for the exact same file back-to-back with zero intervening delay
      writeFileSync(target, "OLD_ERR\n");
      const edit1Promise = fire(
        "tool_result",
        { toolName: "write", input: { path: "simultaneous.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      writeFileSync(target, "line1\nNEW_ERR\n");
      const edit2Promise = fire(
        "tool_result",
        { toolName: "edit", input: { path: "simultaneous.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );

      const [res1, res2] = await Promise.all([edit1Promise, edit2Promise]);
      assert.equal(res1, undefined);
      assert.ok(res2?.content?.[1]?.text.includes("FRESH_EDIT_2_ERROR"));
      assert.ok(!res2.content[1].text.includes("STALE_EDIT_1_ERROR"));
      assert.equal(await waitForPidExit(warmPid, 2000), true);
    });

    it("drops stale unversioned publishDiagnostics from an earlier rapid edit", async () => {
      writeGlobalSettings({
        lsp_enabled: true,
        lsp_servers: {
          typescript: {
            command: process.execPath,
            args: [mockServerScript, "--mode=versionless-delayed"],
            extensions: [".ts"],
          },
        },
      });
      const file = join(testDir, "rapid.ts");

      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { timeoutMs: 1200 });
      activeManagers.push(manager);

      // Edit 1 (slow 180ms versionless publish) starts first
      writeFileSync(file, "OLD_ERR\n");
      const edit1Promise = fire(
        "tool_result",
        { toolName: "write", input: { path: "rapid.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );

      // Brief wait for initialize + didOpen, then send Edit 2 before Edit 1's publish returns
      await new Promise((r) => setTimeout(r, 120));
      writeFileSync(file, "line1\nNEW_ERR\n");
      const edit2Promise = fire(
        "tool_result",
        { toolName: "edit", input: { path: "rapid.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );

      const [res1, res2] = await Promise.all([edit1Promise, edit2Promise]);
      assert.equal(res1, undefined);
      assert.ok(res2?.content?.[1]?.text.includes("FRESH_EDIT_2_ERROR"), `expected fresh edit 2 diagnostics, got: ${res2?.content?.[1]?.text}`);
      assert.ok(!res2.content[1].text.includes("STALE_EDIT_1_ERROR"));
    });

    it("redacts secrets quoted in LSP diagnostics via secret-obfuscation hook ordering", async () => {
      const secretToken = "unit-test-secret-credential-value-1445"; // pragma: allowlist secret
      writeGlobalSettings({
        lsp_enabled: true,
        secret_obfuscation: true,
        lsp_servers: {
          typescript: {
            command: process.execPath,
            args: [mockServerScript, "--mode=normal"],
            extensions: [".ts"],
          },
        },
      });
      writeFileSync(join(testDir, "secret.ts"), `SECRET_LEAK:${secretToken}\n`);

      // Verify index.ts wires registerLsp BEFORE registerSecretObfuscation
      const indexSource = readFileSync(join(REPO_ROOT, "extensions", "orchestrator", "index.ts"), "utf8");
      const lspCallIdx = indexSource.indexOf("registerLsp(pi)");
      const secCallIdx = indexSource.indexOf("registerSecretObfuscation(pi)");
      assert.ok(lspCallIdx > 0 && secCallIdx > 0 && lspCallIdx < secCallIdx, "registerLsp must run before registerSecretObfuscation");

      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { timeoutMs: 1500 });
      activeManagers.push(manager);
      registerSecretObfuscation(pi, { env: { DEMO_API_TOKEN: secretToken }, homeDir: testDir });

      const res = await fire(
        "tool_result",
        {
          toolName: "write",
          input: { path: "secret.ts" },
          isError: false,
          content: [{ type: "text", text: "Successfully wrote secret.ts" }],
        },
        { cwd: testDir },
      );

      const fullText = res.content.map((c: any) => c.text ?? "").join("\n");
      assert.ok(fullText.includes("LSP diagnostics (typescript):"));
      assert.ok(!fullText.includes(secretToken), "secret token must be redacted from LSP diagnostics");
      assert.ok(/\$\$[A-Za-z0-9_]+\$\$/.test(fullText), `expected redaction placeholder in LSP diagnostics, got: ${fullText}`);
    });

    it("shuts down an idle server automatically after idleTimeoutMs", async () => {
      writeGlobalSettings({
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
      const { manager } = registerDirectLsp(pi, { timeoutMs: 2000, idleTimeoutMs: 250 });
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

    it("prevents a racing tool_result check from leaving an orphan server during session_shutdown", async () => {
      writeGlobalSettings({
        lsp_enabled: true,
        lsp_servers: {
          typescript: {
            command: process.execPath,
            args: [mockServerScript, "--mode=hang"],
            extensions: [".ts"],
          },
          other: {
            command: process.execPath,
            args: [mockServerScript, "--mode=normal"],
            extensions: [".other"],
          },
        },
      });
      writeFileSync(join(testDir, "hung.ts"), "TYPE_ERROR\n");
      writeFileSync(join(testDir, "late.other"), "TYPE_ERROR\n");

      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { timeoutMs: 150 });
      activeManagers.push(manager);

      await fire(
        "tool_result",
        { toolName: "write", input: { path: "hung.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      const hungPid = manager.getActivePids()[0];
      assert.ok(hungPid);

      // Start shutdown and concurrently fire a new tool_result for a different server
      const shutdownPromise = fire("session_shutdown", {}, { cwd: testDir });
      const lateResult = await fire(
        "tool_result",
        { toolName: "write", input: { path: "late.other" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: testDir },
      );
      await shutdownPromise;

      assert.equal(lateResult, undefined);
      assert.equal(manager.activeCount, 0);
      assert.equal(await waitForPidExit(hungPid, 3000), true);
    });

    it("leaves zero orphan child processes after session_shutdown", async () => {
      const logFile = join(testDir, "shutdown.log");
      writeGlobalSettings({
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
      const { manager } = registerDirectLsp(pi, { timeoutMs: 250 });
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
        const exited = await waitForPidExit(pid, 3000);
        assert.equal(exited, true, `expected child process ${pid} to exit after session_shutdown`);
      }

      const events = readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.ok(events.some((e) => e.event === "shutdown"), "expected graceful LSP shutdown request");
      assert.ok(events.some((e) => e.event === "exit"), "expected graceful LSP exit notification");
    });

    it("terminates SIGTERM-ignoring child servers when the parent process exits abruptly", async () => {
      const target = join(testDir, "abrupt.ts");
      writeFileSync(target, "TYPE_ERROR\n");
      const lspModuleUrl = new URL("../../../extensions/orchestrator/lsp.ts", import.meta.url).href;
      const runnerScript = join(testDir, "parent-exit-runner.mjs");
      writeFileSync(
        runnerScript,
        `import { LspManager } from ${JSON.stringify(lspModuleUrl)};
const manager = new LspManager({ timeoutMs: 2000 });
await manager.getDiagnosticsForFile(${JSON.stringify(testDir)}, "abrupt.ts", {
  typescript: {
    command: ${JSON.stringify(process.execPath)},
    args: [${JSON.stringify(mockServerScript)}, "--mode=normal", "--ignore-sigterm"],
    extensions: [".ts"],
  },
});
const pid = manager.getActivePids()[0];
process.stdout.write(String(pid) + "\\n");
process.exit(0);
`,
        "utf8",
      );

      const tsxBin = join(REPO_ROOT, "node_modules", ".bin", "tsx");
      const out = execFileSync(tsxBin, [runnerScript], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 15_000,
      }).trim();
      const childLspPid = Number.parseInt(out.split("\n").pop() ?? "", 10);
      assert.ok(Number.isInteger(childLspPid) && childLspPid > 0, `expected valid child PID, got: ${out}`);
      assert.equal(
        await waitForPidExit(childLspPid, 3000),
        true,
        `expected SIGTERM-ignoring LSP PID ${childLspPid} to terminate on abrupt parent exit`,
      );
    });
  });

  // ── Lazy missing-LSP RPC guard & cross-process TUI prompt forwarding (#1496) ──

  describe("lazy missing-LSP RPC guard and TUI prompt forwarding (#1496)", () => {
    let prefsDbPath: string;
    let prevComsSupervisedPeer: string | undefined;

    beforeEach(() => {
      prefsDbPath = join(testDir, "lsp-prefs.db");
      prevComsSupervisedPeer = process.env.PI_COMS_SUPERVISED_PEER;
      delete process.env.PI_COMS_SUPERVISED_PEER;
    });

    afterEach(async () => {
      for (const mgr of activeManagers) {
        await mgr.shutdownAll();
      }
      activeManagers = [];
      if (prevComsSupervisedPeer === undefined) delete process.env.PI_COMS_SUPERVISED_PEER;
      else process.env.PI_COMS_SUPERVISED_PEER = prevComsSupervisedPeer;
      closeStateDb(prefsDbPath);
    });

    it("returns false from isInteractiveTuiForLspPrompt when ctx.mode is rpc despite hasUI true", () => {
      const ctx = { hasUI: true, mode: "rpc", ui: { select: async () => undefined } };
      assert.equal(isInteractiveTuiForLspPrompt(ctx, false, {}), false);
    });

    it("returns false from isInteractiveTuiForLspPrompt when PI_COMS_SUPERVISED_PEER is 1", () => {
      const ctx = { hasUI: true, mode: "tui", ui: { select: async () => undefined } };
      assert.equal(isInteractiveTuiForLspPrompt(ctx, false, { PI_COMS_SUPERVISED_PEER: "1" }), false);
    });

    it("returns false from isInteractiveTuiForLspPrompt for subagent children", () => {
      const ctx = { hasUI: true, mode: "tui", ui: { select: async () => undefined } };
      assert.equal(isInteractiveTuiForLspPrompt(ctx, true, {}), false);
    });

    it("returns true from isInteractiveTuiForLspPrompt for interactive tui sessions", () => {
      const ctx = { hasUI: true, mode: "tui", ui: { select: async () => undefined } };
      assert.equal(isInteractiveTuiForLspPrompt(ctx, false, {}), true);
    });

    it("never calls ctx.ui.select in rpc mode on a missing LSP server", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      writeFileSync(join(testDir, "main.go"), "package main\n");

      let selectCalls = 0;
      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { envPath: "", installPrefsDbPath: prefsDbPath });
      activeManagers.push(manager);

      const res = await fire(
        "tool_result",
        { toolName: "write", input: { path: "main.go" }, isError: false, content: [{ type: "text", text: "ok" }] },
        {
          cwd: testDir,
          hasUI: true,
          mode: "rpc",
          ui: {
            select: async () => {
              selectCalls++;
              return "Not now";
            },
          },
        },
      );

      assert.equal(selectCalls, 0);
      assert.ok(res?.content?.[1]?.text.includes("[LSP] gopls not found on PATH"));
    });

    it("queues a deduplicated pending install request in SQLite for a missing server in rpc mode", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      writeFileSync(join(testDir, "a.go"), "package main\n");
      writeFileSync(join(testDir, "b.go"), "package main\n");

      const rpcCtx = {
        cwd: testDir,
        hasUI: true,
        mode: "rpc",
        ui: { select: async () => "Not now" },
      };

      const peer1 = createMockPi();
      const { manager: m1 } = registerDirectLsp(peer1.pi, { envPath: "", installPrefsDbPath: prefsDbPath });
      activeManagers.push(m1);
      await peer1.fire(
        "tool_result",
        { toolName: "write", input: { path: "a.go" }, isError: false, content: [{ type: "text", text: "ok" }] },
        rpcCtx,
      );

      const peer2 = createMockPi();
      const { manager: m2 } = registerDirectLsp(peer2.pi, { envPath: "", installPrefsDbPath: prefsDbPath });
      activeManagers.push(m2);
      await peer2.fire(
        "tool_result",
        { toolName: "write", input: { path: "b.go" }, isError: false, content: [{ type: "text", text: "ok" }] },
        rpcCtx,
      );

      const pending = listPendingLspInstallRequests(prefsDbPath);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].serverId, "go");
      assert.equal(pending[0].sourceRole, "rpc");
      assert.equal(pending[0].sourceCwd, testDir);
    });

    it("never calls ctx.ui.select in a supervised COMS peer on a missing LSP server", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      writeFileSync(join(testDir, "app.py"), "x = 1\n");
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      let selectCalls = 0;
      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { envPath: "", installPrefsDbPath: prefsDbPath });
      activeManagers.push(manager);

      const res = await fire(
        "tool_result",
        { toolName: "write", input: { path: "app.py" }, isError: false, content: [{ type: "text", text: "ok" }] },
        {
          cwd: testDir,
          hasUI: true,
          ui: {
            select: async () => {
              selectCalls++;
              return "Not now";
            },
          },
        },
      );

      assert.equal(selectCalls, 0);
      assert.ok(res?.content?.[1]?.text.includes("[LSP] basedpyright not found on PATH"));
    });

    it("records a pending install request with sourceRole coms-peer for a supervised COMS peer", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      writeFileSync(join(testDir, "app.py"), "x = 1\n");
      process.env.PI_COMS_SUPERVISED_PEER = "1";

      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { envPath: "", installPrefsDbPath: prefsDbPath });
      activeManagers.push(manager);

      await fire(
        "tool_result",
        { toolName: "write", input: { path: "app.py" }, isError: false, content: [{ type: "text", text: "ok" }] },
        {
          cwd: testDir,
          hasUI: true,
          ui: { select: async () => "Not now" },
        },
      );

      const pending = listPendingLspInstallRequests(prefsDbPath);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].serverId, "python");
      assert.equal(pending[0].sourceRole, "coms-peer");
    });

    it("records a pending install request with sourceRole subagent without blocking", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      writeFileSync(join(testDir, "worker.py"), "x = 1\n");
      setEnv("PI_SUBAGENT_CHILD", "1");

      let selectCalls = 0;
      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { envPath: "", installPrefsDbPath: prefsDbPath });
      activeManagers.push(manager);

      const res = await fire(
        "tool_result",
        { toolName: "write", input: { path: "worker.py" }, isError: false, content: [{ type: "text", text: "ok" }] },
        {
          cwd: testDir,
          hasUI: true,
          mode: "tui",
          ui: {
            select: async () => {
              selectCalls++;
              return "Not now";
            },
          },
        },
      );

      assert.equal(selectCalls, 0);
      assert.ok(res?.content?.[1]?.text.includes("[LSP] basedpyright not found on PATH"));
      const pending = listPendingLspInstallRequests(prefsDbPath);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].serverId, "python");
      assert.equal(pending[0].sourceRole, "subagent");
    });

    it("drains a deduplicated pending request from multiple peers on agent_end calling ctx.ui.select once", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      recordPendingLspInstallRequest("go", { sourceCwd: join(testDir, "peer-a"), sourceRole: "coms-peer" }, prefsDbPath);
      recordPendingLspInstallRequest("go", { sourceCwd: join(testDir, "peer-b"), sourceRole: "rpc" }, prefsDbPath);

      let selectCalls = 0;
      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { envPath: "", installPrefsDbPath: prefsDbPath });
      activeManagers.push(manager);

      await fire(
        "agent_end",
        {},
        {
          cwd: testDir,
          hasUI: true,
          mode: "tui",
          ui: {
            select: async (_title: string, choices: string[]) => {
              selectCalls++;
              return choices[1];
            },
          },
        },
      );

      assert.equal(selectCalls, 1);
      assert.deepEqual(listPendingLspInstallRequests(prefsDbPath), []);
    });

    it("drains a pending install request after a subagent tool_result", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      recordPendingLspInstallRequest("python", { sourceCwd: testDir, sourceRole: "subagent" }, prefsDbPath);

      let selectCalls = 0;
      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { envPath: "", installPrefsDbPath: prefsDbPath });
      activeManagers.push(manager);

      await fire(
        "tool_result",
        { toolName: "subagent", isError: false, content: [{ type: "text", text: "done" }] },
        {
          cwd: testDir,
          hasUI: true,
          mode: "tui",
          ui: {
            select: async (_title: string, choices: string[]) => {
              selectCalls++;
              return choices[1];
            },
          },
        },
      );

      assert.equal(selectCalls, 1);
      assert.deepEqual(listPendingLspInstallRequests(prefsDbPath), []);
    });

    it("clears a drained pending request from SQLite after choosing Install", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      const binDir = join(testDir, "bin");
      mkdirSync(binDir, { recursive: true });
      recordPendingLspInstallRequest("go", { sourceCwd: testDir, sourceRole: "coms-peer" }, prefsDbPath);

      let selectCalls = 0;
      let installCalls = 0;
      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, {
        envPath: binDir,
        installPrefsDbPath: prefsDbPath,
        installRunner: async (recipe) => {
          installCalls++;
          assert.equal(recipe.serverId, "go");
          const fakeGopls = join(binDir, "gopls");
          writeFileSync(fakeGopls, "#!/bin/sh\nexit 0\n", "utf8");
          chmodSync(fakeGopls, 0o755);
          return { ok: true };
        },
      });
      activeManagers.push(manager);

      await fire(
        "agent_end",
        {},
        {
          cwd: testDir,
          hasUI: true,
          mode: "tui",
          ui: {
            select: async (_title: string, choices: string[]) => {
              selectCalls++;
              return choices[0];
            },
            notify: () => {},
          },
        },
      );

      assert.equal(selectCalls, 1);
      assert.equal(installCalls, 1);
      assert.deepEqual(listPendingLspInstallRequests(prefsDbPath), []);
    });

    it("clears a drained pending request from SQLite after choosing Not now", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      recordPendingLspInstallRequest("go", { sourceCwd: testDir, sourceRole: "coms-peer" }, prefsDbPath);

      let selectCalls = 0;
      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { envPath: "", installPrefsDbPath: prefsDbPath });
      activeManagers.push(manager);

      await fire(
        "agent_end",
        {},
        {
          cwd: testDir,
          hasUI: true,
          mode: "tui",
          ui: {
            select: async (_title: string, choices: string[]) => {
              selectCalls++;
              return choices[1];
            },
          },
        },
      );

      assert.equal(selectCalls, 1);
      assert.deepEqual(listPendingLspInstallRequests(prefsDbPath), []);
      assert.equal(isLspInstallDismissed("go", prefsDbPath), false);
    });

    it("clears a drained pending request from SQLite after choosing Don't ask again", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      recordPendingLspInstallRequest("go", { sourceCwd: testDir, sourceRole: "coms-peer" }, prefsDbPath);

      let selectCalls = 0;
      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { envPath: "", installPrefsDbPath: prefsDbPath });
      activeManagers.push(manager);

      await fire(
        "agent_end",
        {},
        {
          cwd: testDir,
          hasUI: true,
          mode: "tui",
          ui: {
            select: async (_title: string, choices: string[]) => {
              selectCalls++;
              return choices[2];
            },
          },
        },
      );

      assert.equal(selectCalls, 1);
      assert.deepEqual(listPendingLspInstallRequests(prefsDbPath), []);
      assert.equal(isLspInstallDismissed("go", prefsDbPath), true);
    });

    it("skips ctx.ui.select for a drained pending request when the binary is already on PATH", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      const binDir = join(testDir, "installed-bin");
      mkdirSync(binDir, { recursive: true });
      const fakeGopls = join(binDir, "gopls");
      writeFileSync(fakeGopls, "#!/bin/sh\nexit 0\n", "utf8");
      chmodSync(fakeGopls, 0o755);
      recordPendingLspInstallRequest("go", { sourceCwd: testDir, sourceRole: "rpc" }, prefsDbPath);

      let selectCalls = 0;
      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { envPath: binDir, installPrefsDbPath: prefsDbPath });
      activeManagers.push(manager);

      await fire(
        "agent_end",
        {},
        {
          cwd: testDir,
          hasUI: true,
          mode: "tui",
          ui: {
            select: async () => {
              selectCalls++;
              return "Not now";
            },
          },
        },
      );

      assert.equal(selectCalls, 0);
      assert.deepEqual(listPendingLspInstallRequests(prefsDbPath), []);
    });

    it("skips ctx.ui.select for a drained pending request when previously dismissed", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      dismissLspInstallPermanently("go", prefsDbPath);
      recordPendingLspInstallRequest("go", { sourceCwd: testDir, sourceRole: "rpc" }, prefsDbPath);

      let selectCalls = 0;
      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { envPath: "", installPrefsDbPath: prefsDbPath });
      activeManagers.push(manager);

      await fire(
        "agent_end",
        {},
        {
          cwd: testDir,
          hasUI: true,
          mode: "tui",
          ui: {
            select: async () => {
              selectCalls++;
              return "Not now";
            },
          },
        },
      );

      assert.equal(selectCalls, 0);
      assert.deepEqual(listPendingLspInstallRequests(prefsDbPath), []);
    });

    it("removes a pending install request via clearPendingLspInstallRequest", () => {
      recordPendingLspInstallRequest("go", { sourceCwd: testDir, sourceRole: "rpc" }, prefsDbPath);
      assert.equal(listPendingLspInstallRequests(prefsDbPath).length, 1);
      clearPendingLspInstallRequest("go", prefsDbPath);
      assert.deepEqual(listPendingLspInstallRequests(prefsDbPath), []);
    });

    it("ignores pending install requests in interactive TUI when lsp_enabled is false", async () => {
      writeGlobalSettings({ lsp_enabled: false });
      recordPendingLspInstallRequest("go", { sourceCwd: testDir, sourceRole: "rpc" }, prefsDbPath);

      let selectCalls = 0;
      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, { envPath: "", installPrefsDbPath: prefsDbPath });
      activeManagers.push(manager);

      await fire(
        "agent_end",
        {},
        {
          cwd: testDir,
          hasUI: true,
          mode: "tui",
          ui: {
            select: async () => {
              selectCalls++;
              return "Not now";
            },
          },
        },
      );

      assert.equal(selectCalls, 0);
      assert.equal(listPendingLspInstallRequests(prefsDbPath).length, 1);
    });

    async function waitForCondition(predicate: () => boolean, maxWaitMs = 2000, pollMs = 15): Promise<boolean> {
      const deadline = Date.now() + maxWaitMs;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, pollMs));
      }
      return predicate();
    }

    it("automatically prompts an idle TUI when a separate peer process queues a pending request", async () => {
      writeGlobalSettings({ lsp_enabled: true });

      let selectCalls = 0;
      const ctx = {
        cwd: testDir,
        hasUI: true,
        mode: "tui",
        isIdle: () => true,
        ui: {
          select: async (_title: string, choices: string[]) => {
            selectCalls++;
            return choices[1];
          },
        },
      };

      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, {
        envPath: "",
        installPrefsDbPath: prefsDbPath,
        pendingPollIntervalMs: 25,
      });
      activeManagers.push(manager);

      await fire("agent_end", {}, ctx);
      assert.equal(selectCalls, 0);

      const lspModuleUrl = new URL("../../../extensions/orchestrator/lsp.ts", import.meta.url).href;
      const peerScript = join(testDir, "peer-record-pending.mjs");
      writeFileSync(
        peerScript,
        `import { recordPendingLspInstallRequest } from ${JSON.stringify(lspModuleUrl)};
recordPendingLspInstallRequest(
  "typescript",
  { sourceCwd: ${JSON.stringify(testDir)}, sourceRole: "coms-peer" },
  ${JSON.stringify(prefsDbPath)},
);
`,
        "utf8",
      );

      execFileSync(join(REPO_ROOT, "node_modules", ".bin", "tsx"), [peerScript], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 15_000,
      });

      const drained = await waitForCondition(
        () => selectCalls === 1 && listPendingLspInstallRequests(prefsDbPath).length === 0,
        2000,
      );
      assert.equal(drained, true);
      assert.equal(selectCalls, 1);
      assert.deepEqual(listPendingLspInstallRequests(prefsDbPath), []);
    });

    it("defers idle pending polling while TUI reports busy", async () => {
      writeGlobalSettings({ lsp_enabled: true });

      let busy = true;
      let selectCalls = 0;
      const ctx = {
        cwd: testDir,
        hasUI: true,
        mode: "tui",
        isIdle: () => busy === false,
        ui: {
          select: async (_title: string, choices: string[]) => {
            selectCalls++;
            return choices[1];
          },
        },
      };

      const { pi, fire } = createMockPi();
      const { manager } = registerDirectLsp(pi, {
        envPath: "",
        installPrefsDbPath: prefsDbPath,
        pendingPollIntervalMs: 20,
      });
      activeManagers.push(manager);

      await fire("session_start", {}, ctx);
      recordPendingLspInstallRequest("go", { sourceCwd: testDir, sourceRole: "coms-peer" }, prefsDbPath);

      await new Promise((r) => setTimeout(r, 70));
      assert.equal(selectCalls, 0);

      busy = false;
      const drained = await waitForCondition(
        () => selectCalls === 1 && listPendingLspInstallRequests(prefsDbPath).length === 0,
        1000,
      );
      assert.equal(drained, true);
      assert.equal(selectCalls, 1);
    });

    it("claims a pending install atomically across concurrent TUI drainers", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      recordPendingLspInstallRequest("typescript", { sourceCwd: testDir, sourceRole: "coms-peer" }, prefsDbPath);

      let tui1SelectCalls = 0;
      let tui2SelectCalls = 0;
      let resolveTui1Select!: (choice: string) => void;
      let markTui1PromptOpen!: () => void;
      const tui1PromptOpen = new Promise<void>((resolve) => {
        markTui1PromptOpen = resolve;
      });
      const tui1SelectPromise = new Promise<string>((resolve) => {
        resolveTui1Select = resolve;
      });

      const tui1 = createMockPi();
      const { manager: m1 } = registerDirectLsp(tui1.pi, {
        envPath: "",
        installPrefsDbPath: prefsDbPath,
        pendingPollIntervalMs: 0,
      });
      activeManagers.push(m1);

      const tui2 = createMockPi();
      const { manager: m2 } = registerDirectLsp(tui2.pi, {
        envPath: "",
        installPrefsDbPath: prefsDbPath,
        pendingPollIntervalMs: 0,
      });
      activeManagers.push(m2);

      const ctx1 = {
        cwd: testDir,
        hasUI: true,
        mode: "tui",
        ui: {
          select: async () => {
            tui1SelectCalls++;
            markTui1PromptOpen();
            return tui1SelectPromise;
          },
        },
      };
      const ctx2 = {
        cwd: testDir,
        hasUI: true,
        mode: "tui",
        ui: {
          select: async () => {
            tui2SelectCalls++;
            return "Not now";
          },
        },
      };

      const tui1Drain = tui1.fire("agent_end", {}, ctx1);
      await tui1PromptOpen;
      await tui2.fire("agent_end", {}, ctx2);

      resolveTui1Select("Not now");
      await tui1Drain;

      assert.equal(tui1SelectCalls, 1);
      assert.equal(tui2SelectCalls, 0);
      assert.deepEqual(listPendingLspInstallRequests(prefsDbPath), []);
    });

    it("allows another owner to claim a pending request after claim TTL expires", () => {
      recordPendingLspInstallRequest("python", { sourceCwd: testDir, sourceRole: "rpc" }, prefsDbPath);

      assert.equal(claimPendingLspInstallRequest("python", "owner-a", prefsDbPath, 1000, 10_000), true);
      assert.equal(claimPendingLspInstallRequest("python", "owner-b", prefsDbPath, 1000, 10_500), false);
      assert.equal(claimPendingLspInstallRequest("python", "owner-b", prefsDbPath, 1000, 11_000), true);
    });

    it("releases a single pending claim for immediate re-claim via releasePendingLspInstallClaim", () => {
      recordPendingLspInstallRequest("python", { sourceCwd: testDir, sourceRole: "rpc" }, prefsDbPath);

      assert.equal(claimPendingLspInstallRequest("python", "owner-a", prefsDbPath, 1000, 10_000), true);
      releasePendingLspInstallClaim("python", "owner-other", prefsDbPath);
      assert.equal(claimPendingLspInstallRequest("python", "owner-b", prefsDbPath, 1000, 10_100), false);
      releasePendingLspInstallClaim("python", "owner-a", prefsDbPath);
      assert.equal(claimPendingLspInstallRequest("python", "owner-b", prefsDbPath, 1000, 10_100), true);
    });

    it("releases all pending claims for an owner via releasePendingLspInstallClaimsByOwner", () => {
      recordPendingLspInstallRequest("python", { sourceCwd: testDir, sourceRole: "rpc" }, prefsDbPath);
      recordPendingLspInstallRequest("go", { sourceCwd: testDir, sourceRole: "rpc" }, prefsDbPath);

      assert.equal(claimPendingLspInstallRequest("python", "owner-a", prefsDbPath, 1000, 10_000), true);
      assert.equal(claimPendingLspInstallRequest("go", "owner-a", prefsDbPath, 1000, 10_000), true);
      releasePendingLspInstallClaimsByOwner("owner-a", prefsDbPath);
      assert.equal(claimPendingLspInstallRequest("python", "owner-b", prefsDbPath, 1000, 10_100), true);
      assert.equal(claimPendingLspInstallRequest("go", "owner-b", prefsDbPath, 1000, 10_100), true);
    });

    it("keeps a pending claim held while installRunner executes despite peer re-queues", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      recordPendingLspInstallRequest("typescript", { sourceCwd: testDir, sourceRole: "coms-peer" }, prefsDbPath);

      let markInstallStarted!: () => void;
      let finishInstall!: (res: { ok: boolean }) => void;
      const installStarted = new Promise<void>((resolve) => {
        markInstallStarted = resolve;
      });
      const installPromise = new Promise<{ ok: boolean }>((resolve) => {
        finishInstall = resolve;
      });

      let tui1InstallCalls = 0;
      let tui2SelectCalls = 0;
      let tui2InstallCalls = 0;

      const tui1 = createMockPi();
      const { manager: m1 } = registerDirectLsp(tui1.pi, {
        envPath: "",
        installPrefsDbPath: prefsDbPath,
        pendingPollIntervalMs: 0,
        verifyInstalled: () => "/fake/bin/typescript-language-server",
        installRunner: async () => {
          tui1InstallCalls++;
          markInstallStarted();
          return installPromise;
        },
      });
      activeManagers.push(m1);

      const tui2 = createMockPi();
      const { manager: m2 } = registerDirectLsp(tui2.pi, {
        envPath: "",
        installPrefsDbPath: prefsDbPath,
        pendingPollIntervalMs: 0,
        installRunner: async () => {
          tui2InstallCalls++;
          return { ok: true };
        },
      });
      activeManagers.push(m2);

      const ctx1 = {
        cwd: testDir,
        hasUI: true,
        mode: "tui",
        ui: {
          select: async (_title: string, choices: string[]) => choices[0],
          notify: () => {},
        },
      };
      const ctx2 = {
        cwd: testDir,
        hasUI: true,
        mode: "tui",
        ui: {
          select: async (_title: string, choices: string[]) => {
            tui2SelectCalls++;
            return choices[0];
          },
          notify: () => {},
        },
      };

      const tui1Drain = tui1.fire("agent_end", {}, ctx1);
      await installStarted;

      recordPendingLspInstallRequest(
        "typescript",
        { sourceCwd: join(testDir, "peer"), sourceRole: "coms-peer" },
        prefsDbPath,
      );
      await tui2.fire("agent_end", {}, ctx2);

      assert.equal(tui1InstallCalls, 1);
      assert.equal(tui2SelectCalls, 0);
      assert.equal(tui2InstallCalls, 0);

      finishInstall({ ok: true });
      await tui1Drain;

      assert.deepEqual(listPendingLspInstallRequests(prefsDbPath), []);
    });

    it("releases active pending claims on session_shutdown for immediate recovery by another TUI", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      recordPendingLspInstallRequest("go", { sourceCwd: testDir, sourceRole: "rpc" }, prefsDbPath);

      let markTui1PromptOpen!: () => void;
      let resolveTui1Select!: (choice: string) => void;
      const tui1PromptOpen = new Promise<void>((resolve) => {
        markTui1PromptOpen = resolve;
      });
      const tui1SelectPromise = new Promise<string>((resolve) => {
        resolveTui1Select = resolve;
      });

      const tui1 = createMockPi();
      const { manager: m1 } = registerDirectLsp(tui1.pi, {
        envPath: "",
        installPrefsDbPath: prefsDbPath,
        pendingPollIntervalMs: 0,
      });
      activeManagers.push(m1);

      let tui2SelectCalls = 0;
      const tui2 = createMockPi();
      const { manager: m2 } = registerDirectLsp(tui2.pi, {
        envPath: "",
        installPrefsDbPath: prefsDbPath,
        pendingPollIntervalMs: 0,
      });
      activeManagers.push(m2);

      const ctx1 = {
        cwd: testDir,
        hasUI: true,
        mode: "tui",
        ui: {
          select: async () => {
            markTui1PromptOpen();
            return tui1SelectPromise;
          },
        },
      };
      const ctx2 = {
        cwd: testDir,
        hasUI: true,
        mode: "tui",
        ui: {
          select: async (_title: string, choices: string[]) => {
            tui2SelectCalls++;
            return choices[1];
          },
        },
      };

      const tui1Drain = tui1.fire("agent_end", {}, ctx1);
      await tui1PromptOpen;
      await tui1.fire("session_shutdown", {}, ctx1);
      resolveTui1Select("Not now");
      await tui1Drain;

      await tui2.fire("agent_end", {}, ctx2);

      assert.equal(tui2SelectCalls, 1);
      assert.deepEqual(listPendingLspInstallRequests(prefsDbPath), []);
    });

    it("preserves a pending request for another TUI when ctx.ui.select throws", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      recordPendingLspInstallRequest("python", { sourceCwd: testDir, sourceRole: "rpc" }, prefsDbPath);

      const tui1 = createMockPi();
      const { manager: m1 } = registerDirectLsp(tui1.pi, {
        envPath: "",
        installPrefsDbPath: prefsDbPath,
        pendingPollIntervalMs: 0,
      });
      activeManagers.push(m1);

      let tui2SelectCalls = 0;
      const tui2 = createMockPi();
      const { manager: m2 } = registerDirectLsp(tui2.pi, {
        envPath: "",
        installPrefsDbPath: prefsDbPath,
        pendingPollIntervalMs: 0,
      });
      activeManagers.push(m2);

      await tui1.fire(
        "agent_end",
        {},
        {
          cwd: testDir,
          hasUI: true,
          mode: "tui",
          ui: {
            select: async () => {
              throw new Error("ui disconnected");
            },
          },
        },
      );

      assert.deepEqual(
        listPendingLspInstallRequests(prefsDbPath).map((r) => r.serverId),
        ["python"],
      );

      await tui2.fire(
        "agent_end",
        {},
        {
          cwd: testDir,
          hasUI: true,
          mode: "tui",
          ui: {
            select: async (_title: string, choices: string[]) => {
              tui2SelectCalls++;
              return choices[1];
            },
          },
        },
      );

      assert.equal(tui2SelectCalls, 1);
      assert.deepEqual(listPendingLspInstallRequests(prefsDbPath), []);
    });

    it("respects retry backoff within the same session after ctx.ui.select throws", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      recordPendingLspInstallRequest("python", { sourceCwd: testDir, sourceRole: "rpc" }, prefsDbPath);

      let selectCalls = 0;
      const tui1 = createMockPi();
      const { manager } = registerDirectLsp(tui1.pi, {
        envPath: "",
        installPrefsDbPath: prefsDbPath,
        pendingPollIntervalMs: 0,
        promptErrorBackoffMs: 80,
      });
      activeManagers.push(manager);

      const ctx = {
        cwd: testDir,
        hasUI: true,
        mode: "tui",
        ui: {
          select: async (_title: string, choices: string[]) => {
            selectCalls++;
            if (selectCalls === 1) throw new Error("ui disconnected");
            return choices[1];
          },
        },
      };

      await tui1.fire("agent_end", {}, ctx);
      assert.equal(selectCalls, 1);

      await tui1.fire("agent_end", {}, ctx);
      assert.equal(selectCalls, 1);

      await new Promise((r) => setTimeout(r, 100));

      await tui1.fire("agent_end", {}, ctx);
      assert.equal(selectCalls, 2);
      assert.deepEqual(listPendingLspInstallRequests(prefsDbPath), []);
    });

    it("atomically claims direct TUI edits so concurrent TUI drainers cannot race", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      writeFileSync(join(testDir, "direct.go"), "package main\n");

      assert.equal(acquirePendingLspInstallClaim("unknown-server", "owner-a", {}, prefsDbPath), false);
      assert.equal(acquirePendingLspInstallClaim("go", "owner-a", { sourceCwd: testDir, sourceRole: "tui" }, prefsDbPath, 5000, 10_000), true);
      assert.equal(acquirePendingLspInstallClaim("go", "owner-b", { sourceCwd: testDir, sourceRole: "tui" }, prefsDbPath, 5000, 10_100), false);
      assert.equal(clearPendingLspInstallRequestIfOwned("go", "owner-b", prefsDbPath), false);
      assert.equal(clearPendingLspInstallRequestIfOwned("go", "owner-a", prefsDbPath), true);

      let markPromptOpen!: () => void;
      let resolveSelect!: (choice: string) => void;
      const promptOpen = new Promise<void>((r) => {
        markPromptOpen = r;
      });
      const selectPromise = new Promise<string>((r) => {
        resolveSelect = r;
      });

      let tui1Selects = 0;
      let tui2Selects = 0;

      const tui1 = createMockPi();
      const { manager: m1 } = registerDirectLsp(tui1.pi, {
        envPath: "",
        installPrefsDbPath: prefsDbPath,
        pendingPollIntervalMs: 0,
      });
      activeManagers.push(m1);

      const tui2 = createMockPi();
      const { manager: m2 } = registerDirectLsp(tui2.pi, {
        envPath: "",
        installPrefsDbPath: prefsDbPath,
        pendingPollIntervalMs: 0,
      });
      activeManagers.push(m2);

      const ctx1 = {
        cwd: testDir,
        hasUI: true,
        mode: "tui",
        ui: {
          select: async () => {
            tui1Selects++;
            markPromptOpen();
            return selectPromise;
          },
        },
      };
      const ctx2 = {
        cwd: testDir,
        hasUI: true,
        mode: "tui",
        ui: {
          select: async (_title: string, choices: string[]) => {
            tui2Selects++;
            return choices[1];
          },
        },
      };

      const directEdit = tui1.fire(
        "tool_result",
        { toolName: "write", input: { path: "direct.go" }, isError: false, content: [{ type: "text", text: "ok" }] },
        ctx1,
      );
      await promptOpen;
      await tui2.fire("agent_end", {}, ctx2);
      await tui2.fire(
        "tool_result",
        { toolName: "write", input: { path: "direct.go" }, isError: false, content: [{ type: "text", text: "ok" }] },
        ctx2,
      );

      resolveSelect("Not now");
      await directEdit;

      assert.equal(tui1Selects, 1);
      assert.equal(tui2Selects, 0);
      assert.deepEqual(listPendingLspInstallRequests(prefsDbPath), []);
    });

    it("renews claim lease during long prompt so another TUI cannot steal it past TTL", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      recordPendingLspInstallRequest("go", { sourceCwd: testDir, sourceRole: "rpc" }, prefsDbPath);

      let markPromptOpen!: () => void;
      let resolveSelect!: (choice: string) => void;
      const promptOpen = new Promise<void>((r) => {
        markPromptOpen = r;
      });
      const selectPromise = new Promise<string>((r) => {
        resolveSelect = r;
      });

      const tui1 = createMockPi();
      const { manager: m1 } = registerDirectLsp(tui1.pi, {
        envPath: "",
        installPrefsDbPath: prefsDbPath,
        pendingPollIntervalMs: 0,
        pendingClaimTtlMs: 60,
      });
      activeManagers.push(m1);

      const drain1 = tui1.fire(
        "agent_end",
        {},
        {
          cwd: testDir,
          hasUI: true,
          mode: "tui",
          ui: {
            select: async () => {
              markPromptOpen();
              return selectPromise;
            },
          },
        },
      );
      await promptOpen;
      await new Promise((r) => setTimeout(r, 110));
      assert.equal(claimPendingLspInstallRequest("go", "intruder", prefsDbPath, 60), false);
      resolveSelect("Not now");
      await drain1;
      assert.deepEqual(listPendingLspInstallRequests(prefsDbPath), []);
    });

    it("aborts install without deleting row when claim ownership is lost during prompt", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      recordPendingLspInstallRequest("python", { sourceCwd: testDir, sourceRole: "rpc" }, prefsDbPath);

      let markPromptOpen!: () => void;
      let resolveSelect!: (choice: string) => void;
      const promptOpen = new Promise<void>((r) => {
        markPromptOpen = r;
      });
      const selectPromise = new Promise<string>((r) => {
        resolveSelect = r;
      });

      let installCalls = 0;
      const tui = createMockPi();
      const { manager } = registerDirectLsp(tui.pi, {
        envPath: "",
        installPrefsDbPath: prefsDbPath,
        pendingPollIntervalMs: 0,
        pendingClaimTtlMs: 0,
        installRunner: async () => {
          installCalls++;
          return { ok: true };
        },
      });
      activeManagers.push(manager);

      const drain = tui.fire(
        "agent_end",
        {},
        {
          cwd: testDir,
          hasUI: true,
          mode: "tui",
          ui: {
            select: async (_title: string, choices: string[]) => {
              markPromptOpen();
              const chosen = await selectPromise;
              return chosen === "install" ? choices[0] : choices[1];
            },
            notify: () => {},
          },
        },
      );
      await promptOpen;
      // Steal ownership while prompt is open (ttlMs = 0)
      assert.equal(claimPendingLspInstallRequest("python", "new-owner", prefsDbPath, 0), true);
      assert.equal(renewPendingLspInstallClaim("python", "stale-owner", prefsDbPath), false);
      assert.equal(renewPendingLspInstallClaim("python", "new-owner", prefsDbPath), true);

      resolveSelect("install");
      await drain;

      assert.equal(installCalls, 0);
      assert.deepEqual(
        listPendingLspInstallRequests(prefsDbPath).map((r) => r.serverId),
        ["python"],
      );
      // Row is still owned by new-owner
      assert.equal(claimPendingLspInstallRequest("python", "third-owner", prefsDbPath, 60_000), false);
    });

    it("retains in-flight installer claims across session_shutdown so another TUI cannot start a second installer", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      recordPendingLspInstallRequest("typescript", { sourceCwd: testDir, sourceRole: "coms-peer" }, prefsDbPath);
      recordPendingLspInstallRequest("go", { sourceCwd: testDir, sourceRole: "coms-peer" }, prefsDbPath);

      // Direct helper check for excludeServerIds
      assert.equal(claimPendingLspInstallRequest("go", "owner-x", prefsDbPath, 60_000), true);
      assert.equal(claimPendingLspInstallRequest("typescript", "owner-x", prefsDbPath, 60_000), true);
      releasePendingLspInstallClaimsByOwner("owner-x", prefsDbPath, new Set(["typescript"]));
      assert.equal(claimPendingLspInstallRequest("go", "owner-y", prefsDbPath, 60_000), true);
      assert.equal(claimPendingLspInstallRequest("typescript", "owner-y", prefsDbPath, 60_000), false);
      releasePendingLspInstallClaim("go", "owner-y", prefsDbPath);
      releasePendingLspInstallClaim("typescript", "owner-x", prefsDbPath);

      let markInstallStarted!: () => void;
      let finishInstall!: (res: { ok: boolean }) => void;
      const installStarted = new Promise<void>((r) => {
        markInstallStarted = r;
      });
      const installPromise = new Promise<{ ok: boolean }>((r) => {
        finishInstall = r;
      });

      let tui2Selects = 0;
      const tui1 = createMockPi();
      const { manager: m1 } = registerDirectLsp(tui1.pi, {
        envPath: "",
        installPrefsDbPath: prefsDbPath,
        pendingPollIntervalMs: 0,
        pendingClaimTtlMs: 60,
        verifyInstalled: () => "/fake/bin/typescript-language-server",
        installRunner: async () => {
          markInstallStarted();
          return installPromise;
        },
      });
      activeManagers.push(m1);

      const tui2 = createMockPi();
      const { manager: m2 } = registerDirectLsp(tui2.pi, {
        envPath: "",
        installPrefsDbPath: prefsDbPath,
        pendingPollIntervalMs: 0,
      });
      activeManagers.push(m2);

      // Clear go so only typescript runs in this drain
      clearPendingLspInstallRequest("go", prefsDbPath);

      const tui1Drain = tui1.fire(
        "agent_end",
        {},
        {
          cwd: testDir,
          hasUI: true,
          mode: "tui",
          ui: {
            select: async (_title: string, choices: string[]) => choices[0],
            notify: () => {},
          },
        },
      );
      await installStarted;

      // Shut down tui1 while installer is still running and wait longer than TTL
      await tui1.fire("session_shutdown", {}, { cwd: testDir });
      await new Promise((r) => setTimeout(r, 90));

      await tui2.fire(
        "agent_end",
        {},
        {
          cwd: testDir,
          hasUI: true,
          mode: "tui",
          ui: {
            select: async (_title: string, choices: string[]) => {
              tui2Selects++;
              return choices[1];
            },
          },
        },
      );
      assert.equal(tui2Selects, 0);

      finishInstall({ ok: true });
      await tui1Drain;
      assert.deepEqual(listPendingLspInstallRequests(prefsDbPath), []);
    });

    it("retains pending request while releasing claim on failed installRunner", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      recordPendingLspInstallRequest("go", { sourceCwd: testDir, sourceRole: "rpc" }, prefsDbPath);

      let tui1Selects = 0;
      const tui1 = createMockPi();
      const { manager: m1 } = registerDirectLsp(tui1.pi, {
        envPath: "",
        installPrefsDbPath: prefsDbPath,
        pendingPollIntervalMs: 0,
        promptErrorBackoffMs: 60,
        verifyInstalled: () => null,
        installRunner: async () => {
          throw new Error("network down");
        },
      });
      activeManagers.push(m1);

      const ctx1 = {
        cwd: testDir,
        hasUI: true,
        mode: "tui",
        ui: {
          select: async (_title: string, choices: string[]) => {
            tui1Selects++;
            return choices[0];
          },
          notify: () => {},
        },
      };

      await tui1.fire("agent_end", {}, ctx1);
      assert.equal(tui1Selects, 1);
      assert.deepEqual(
        listPendingLspInstallRequests(prefsDbPath).map((r) => r.serverId),
        ["go"],
      );
      // Another owner can immediately claim it
      assert.equal(claimPendingLspInstallRequest("go", "other-tui", prefsDbPath, 60_000), true);
      releasePendingLspInstallClaim("go", "other-tui", prefsDbPath);
      // Local backoff suppresses immediate retry in tui1
      await tui1.fire("agent_end", {}, ctx1);
      assert.equal(tui1Selects, 1);
    });

    it("retains pending request with retry backoff when installed binary is unverified", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      recordPendingLspInstallRequest("go", { sourceCwd: testDir, sourceRole: "rpc" }, prefsDbPath);

      let tui1Selects = 0;
      let attempt = 0;
      const tui1 = createMockPi();
      const { manager: m1 } = registerDirectLsp(tui1.pi, {
        envPath: "",
        installPrefsDbPath: prefsDbPath,
        pendingPollIntervalMs: 0,
        promptErrorBackoffMs: 60,
        verifyInstalled: () => (attempt >= 2 ? "/fake/bin/gopls" : null),
        installRunner: async () => {
          attempt++;
          return { ok: true };
        },
      });
      activeManagers.push(m1);

      const ctx1 = {
        cwd: testDir,
        hasUI: true,
        mode: "tui",
        ui: {
          select: async (_title: string, choices: string[]) => {
            tui1Selects++;
            return choices[0];
          },
          notify: () => {},
        },
      };

      // Attempt 1: installRunner returns ok, verifyInstalled returns null -> row retained, backoff active
      await tui1.fire("agent_end", {}, ctx1);
      assert.equal(tui1Selects, 1);
      assert.deepEqual(
        listPendingLspInstallRequests(prefsDbPath).map((r) => r.serverId),
        ["go"],
      );
      // Local backoff suppresses immediate retry
      await tui1.fire("agent_end", {}, ctx1);
      assert.equal(tui1Selects, 1);

      // Attempt 2 after backoff: installRunner returns ok, binary verified -> row cleared
      await new Promise((r) => setTimeout(r, 80));
      await tui1.fire("agent_end", {}, ctx1);
      assert.equal(tui1Selects, 2);
      assert.deepEqual(listPendingLspInstallRequests(prefsDbPath), []);
    });

    it("rejects concurrent runLspServerInstall calls while the per-server lock is held", async () => {
      const binDir = join(testDir, "fake-bin");
      const managedDir = join(testDir, "managed-lsp");
      mkdirSync(binDir, { recursive: true });
      const markerFile = join(testDir, "npm-started");
      const fakeNpm = join(binDir, "npm");
      writeFileSync(
        fakeNpm,
        `#!${process.execPath}\n` +
          `const fs = require("node:fs");\n` +
          `fs.writeFileSync(${JSON.stringify(markerFile)}, "started");\n` +
          `setTimeout(() => {}, 60_000);\n`,
        "utf8",
      );
      chmodSync(fakeNpm, 0o755);

      const ac = new AbortController();
      const firstPromise = runLspServerInstall(BUILTIN_INSTALL_RECIPES.typescript, binDir, {
        managedLspDir: managedDir,
        signal: ac.signal,
      });
      try {
        const deadline = Date.now() + 3000;
        while (!existsSync(markerFile) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.equal(existsSync(markerFile), true);

        const secondRes = await runLspServerInstall(BUILTIN_INSTALL_RECIPES.typescript, binDir, {
          managedLspDir: managedDir,
        });
        assert.equal(secondRes.ok, false);
        assert.equal(secondRes.error, "Another LSP installation is already in progress");
      } finally {
        ac.abort();
        await firstPromise;
      }
      assert.equal(existsSync(join(managedDir, ".install-typescript.lock")), false);
    });

    it("returns an aborted failure from runLspServerInstall when AbortSignal is aborted", async () => {
      const binDir = join(testDir, "fake-bin");
      const managedDir = join(testDir, "managed-lsp");
      mkdirSync(binDir, { recursive: true });
      const markerFile = join(testDir, "npm-started");
      const fakeNpm = join(binDir, "npm");
      writeFileSync(
        fakeNpm,
        `#!${process.execPath}\n` +
          `const fs = require("node:fs");\n` +
          `fs.writeFileSync(${JSON.stringify(markerFile)}, "started");\n` +
          `setTimeout(() => {}, 60_000);\n`,
        "utf8",
      );
      chmodSync(fakeNpm, 0o755);

      // Already-aborted signal short-circuits immediately before spawning installer
      const preAborted = new AbortController();
      preAborted.abort();
      const preRes = await runLspServerInstall(BUILTIN_INSTALL_RECIPES.typescript, binDir, {
        managedLspDir: managedDir,
        signal: preAborted.signal,
      });
      assert.equal(preRes.ok, false);
      assert.equal(preRes.error, "Install aborted");
      assert.equal(existsSync(markerFile), false);

      // Aborting an in-flight install terminates it cleanly and releases lock
      const ac = new AbortController();
      const livePromise = runLspServerInstall(BUILTIN_INSTALL_RECIPES.typescript, binDir, {
        managedLspDir: managedDir,
        signal: ac.signal,
      });
      try {
        const deadline = Date.now() + 3000;
        while (!existsSync(markerFile) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.equal(existsSync(markerFile), true);
        ac.abort();
      } finally {
        ac.abort();
      }
      const liveRes = await livePromise;
      assert.equal(liveRes.ok, false);
      assert.equal(liveRes.error, "Install aborted");
      assert.equal(existsSync(join(managedDir, ".install-typescript.lock")), false);
    });

    it("terminates installer descendant writers before releasing the per-server lock on abort", async () => {
      setEnv("PATH", process.env.PATH);
      const stubBinDir = join(testDir, "stub-bin");
      const fastBinDir = join(testDir, "fast-bin");
      const managedLspDir = join(testDir, "managed-lsp");
      mkdirSync(stubBinDir, { recursive: true });
      mkdirSync(fastBinDir, { recursive: true });
      mkdirSync(managedLspDir, { recursive: true });

      const childPidFile = join(testDir, "descendant.pid");
      const destLogFile = join(managedLspDir, "dest.log");
      const shQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const childScript = [
        'const fs = require("node:fs");',
        "const [pidFile, logFile] = process.argv.slice(1);",
        'const tmp = pidFile + ".tmp";',
        "fs.writeFileSync(tmp, String(process.pid));",
        "fs.renameSync(tmp, pidFile);",
        'fs.appendFileSync(logFile, "tick\\n");',
        'setInterval(() => fs.appendFileSync(logFile, "tick\\n"), 15);',
      ].join(" ");

      const stubNpm = join(stubBinDir, "npm");
      writeFileSync(
        stubNpm,
        `#!/bin/sh\n` +
          `${shQuote(process.execPath)} -e ${shQuote(childScript)} ${shQuote(childPidFile)} ${shQuote(destLogFile)} </dev/null >/dev/null 2>&1 &\n` +
          `sleep 30\n`,
        "utf8",
      );
      chmodSync(stubNpm, 0o755);

      const fastNpm = join(fastBinDir, "npm");
      writeFileSync(fastNpm, "#!/bin/sh\nexit 0\n", "utf8");
      chmodSync(fastNpm, 0o755);

      const ac = new AbortController();
      const installPromise = runLspServerInstall(BUILTIN_INSTALL_RECIPES.typescript, stubBinDir, {
        managedLspDir,
        signal: ac.signal,
      });

      let childPid = 0;
      try {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          if (existsSync(childPidFile) && existsSync(destLogFile)) {
            const parsedPid = Number.parseInt(readFileSync(childPidFile, "utf8").trim(), 10);
            const lines = readFileSync(destLogFile, "utf8").split("\n").filter(Boolean);
            if (Number.isInteger(parsedPid) && parsedPid > 0 && lines.length >= 1) {
              childPid = parsedPid;
              break;
            }
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.ok(childPid > 0, "expected descendant writer subprocess to record its PID and write to destLogFile");

        ac.abort();
        const res = await installPromise;
        assert.equal(res.ok, false);

        const snapshotAfterAbort = readFileSync(destLogFile, "utf8");
        const secondRes = await runLspServerInstall(BUILTIN_INSTALL_RECIPES.typescript, fastBinDir, {
          managedLspDir,
        });
        assert.equal(secondRes.ok, true, "expected per-server lock to be released immediately after abort settles");

        await new Promise((r) => setTimeout(r, 150));
        assert.equal(
          readFileSync(destLogFile, "utf8"),
          snapshotAfterAbort,
          "expected zero additional writes to destLogFile after aborted install settled",
        );
        assert.equal(isPidAlive(childPid), false, `expected descendant writer PID ${childPid} to be terminated`);
      } finally {
        ac.abort();
        await installPromise.catch(() => {});
        if (!childPid && existsSync(childPidFile)) {
          const parsedPid = Number.parseInt(readFileSync(childPidFile, "utf8").trim(), 10);
          if (Number.isInteger(parsedPid) && parsedPid > 0) childPid = parsedPid;
        }
        if (childPid > 0 && isPidAlive(childPid)) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            // Already exited
          }
        }
      }
    });

    it("aborts the installRunner AbortSignal when claim renewal fails mid-install", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      recordPendingLspInstallRequest("python", { sourceCwd: testDir, sourceRole: "rpc" }, prefsDbPath);

      let markInstallStarted!: () => void;
      const installStarted = new Promise<void>((r) => {
        markInstallStarted = r;
      });
      let receivedSignal: AbortSignal | undefined;
      let abortedSeen = false;

      const tui = createMockPi();
      const { manager } = registerDirectLsp(tui.pi, {
        envPath: "",
        installPrefsDbPath: prefsDbPath,
        pendingPollIntervalMs: 0,
        pendingClaimTtlMs: 30,
        promptErrorBackoffMs: 40,
        verifyInstalled: () => "/fake/bin/basedpyright-langserver",
        installRunner: async (_recipe, opts) => {
          receivedSignal = opts?.signal;
          markInstallStarted();
          await new Promise<void>((resolve) => {
            if (opts?.signal?.aborted) {
              abortedSeen = true;
              resolve();
              return;
            }
            opts?.signal?.addEventListener(
              "abort",
              () => {
                abortedSeen = true;
                resolve();
              },
              { once: true },
            );
          });
          return { ok: false, error: "Install aborted" };
        },
      });
      activeManagers.push(manager);

      const drain = tui.fire(
        "agent_end",
        {},
        {
          cwd: testDir,
          hasUI: true,
          mode: "tui",
          ui: {
            select: async (_title: string, choices: string[]) => choices[0],
            notify: () => {},
          },
        },
      );
      await installStarted;

      // Steal claim ownership while install is running (ttlMs = 0 simulates takeover)
      assert.equal(claimPendingLspInstallRequest("python", "new-owner", prefsDbPath, 0), true);
      await drain;

      assert.ok(receivedSignal, "installRunner should receive AbortSignal");
      assert.equal(abortedSeen, true, "installRunner signal should be aborted on lease renewal failure");
    });

    it("preserves pending row on post-install ownership loss without notifying success or marking promptedThisSession", async () => {
      writeGlobalSettings({ lsp_enabled: true });
      recordPendingLspInstallRequest("python", { sourceCwd: testDir, sourceRole: "rpc" }, prefsDbPath);

      const notifications: Array<{ msg: string; level: string }> = [];
      let selectCount = 0;
      let installAttempts = 0;

      const tui = createMockPi();
      const { manager } = registerDirectLsp(tui.pi, {
        envPath: "",
        installPrefsDbPath: prefsDbPath,
        pendingPollIntervalMs: 0,
        pendingClaimTtlMs: 60_000,
        promptErrorBackoffMs: 0,
        verifyInstalled: () => "/fake/bin/basedpyright-langserver",
        installRunner: async () => {
          installAttempts++;
          if (installAttempts === 1) {
            // Simulate ownership takeover right before runner returns ok: true
            assert.equal(claimPendingLspInstallRequest("python", "new-owner", prefsDbPath, 0), true);
          }
          return { ok: true };
        },
      });
      activeManagers.push(manager);

      const ctx = {
        cwd: testDir,
        hasUI: true,
        mode: "tui",
        ui: {
          select: async (_title: string, choices: string[]) => {
            selectCount++;
            return choices[0];
          },
          notify: (msg: string, level: string) => notifications.push({ msg, level }),
        },
      };

      await tui.fire("agent_end", {}, ctx);

      assert.equal(selectCount, 1);
      assert.equal(
        notifications.some((n) => n.msg.includes("Installed ")),
        false,
        "must not notify install success after losing ownership",
      );
      assert.deepEqual(
        listPendingLspInstallRequests(prefsDbPath).map((r) => r.serverId),
        ["python"],
      );
      // New owner's claim must remain untouched
      assert.equal(claimPendingLspInstallRequest("python", "third-owner", prefsDbPath, 60_000), false);

      // Releasing the other owner's claim lets this session prompt again (promptedThisSession was not set)
      releasePendingLspInstallClaim("python", "new-owner", prefsDbPath);
      await tui.fire("agent_end", {}, ctx);
      assert.equal(selectCount, 2);
      assert.deepEqual(listPendingLspInstallRequests(prefsDbPath), []);
    });
  });
});
