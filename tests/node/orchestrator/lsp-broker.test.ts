import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_INSTALL_RECIPES,
  LspManager,
  dismissLspInstallPermanently,
  findMissingBuiltinServerId,
  getLspBrokerSocketPath,
  isLspInstallDismissed,
  registerLsp,
  runLspServerInstall,
} from "../../../extensions/orchestrator/lsp.ts";
import { clearSettingsCache, setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.ts";
import { closeStateDb } from "../../../extensions/orchestrator/state-db.ts";

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

async function waitForPidExit(pid: number, maxWaitMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isPidAlive(pid);
}

/**
 * Lightweight mock stdio JSON-RPC 2.0 LSP server for broker tests.
 * Supports `--mode=normal|burst|crash` and `--log=<file>`.
 */
const MOCK_BROKER_LSP_SOURCE = `#!/usr/bin/env node
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

function makeDiags(text) {
  if (!text.includes("ERR")) return [];
  return [{
    range: { start: { line: 0, character: 2 }, end: { line: 0, character: 6 } },
    severity: 1,
    message: "Broker diagnostic from pid " + process.pid,
  }];
}

function handle(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { textDocumentSync: 1 } } });
    return;
  }
  if (msg.method === "textDocument/didOpen" || msg.method === "textDocument/didChange") {
    const uri = msg.method === "textDocument/didOpen" ? msg.params.textDocument.uri : msg.params.textDocument.uri;
    const version = msg.method === "textDocument/didOpen" ? msg.params.textDocument.version : msg.params.textDocument.version;
    const text = msg.method === "textDocument/didOpen" ? msg.params.textDocument.text : (msg.params.contentChanges?.[0]?.text ?? "");
    if (mode === "burst") {
      // Emit empty placeholder first, then real error 30ms later (exercises debounce coalescing)
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, version, diagnostics: [] } });
      setTimeout(() => {
        send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, version, diagnostics: makeDiags(text) } });
      }, 30);
      return;
    }
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, version, diagnostics: makeDiags(text) } });
    return;
  }
  if (msg.method === "shutdown") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
    return;
  }
  if (msg.method === "exit") {
    process.exit(0);
  }
}

process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const headerEnd = buf.indexOf(delim);
    if (headerEnd === -1) break;
    const header = buf.subarray(0, headerEnd).toString("ascii");
    const m = /^content-length:\\s*(\\d+)\\s*$/im.exec(header);
    if (!m) break;
    const len = Number.parseInt(m[1], 10);
    const start = headerEnd + 4;
    if (buf.byteLength < start + len) break;
    const body = buf.subarray(start, start + len).toString("utf8");
    buf = buf.subarray(start + len);
    handle(JSON.parse(body));
  }
});

setInterval(() => {}, 60_000);
`;

describe("shared per-worktree LSP broker (#1445)", () => {
  let suiteRoot: string;
  let mockServer: string;
  let testDir: string;
  let brokerRunDir: string;
  let globalSettingsFile: string;
  let prefsDbPath: string;
  let managers: LspManager[] = [];
  const savedEnv = new Map<string, string | undefined>();

  function setEnv(key: string, val: string | undefined) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }

  before(() => {
    suiteRoot = mkdtempSync(join(tmpdir(), "pi-lsp-brk-"));
    mockServer = join(suiteRoot, "mock-lsp.mjs");
    writeFileSync(mockServer, MOCK_BROKER_LSP_SOURCE, "utf8");
    chmodSync(mockServer, 0o755);
  });

  after(() => {
    rmSync(suiteRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    testDir = mkdtempSync(join(suiteRoot, "c-"));
    brokerRunDir = join(testDir, "run");
    globalSettingsFile = join(testDir, "global-settings.json");
    prefsDbPath = join(testDir, "prefs-state.db");
    setGlobalSettingsPath(globalSettingsFile);
    clearSettingsCache();
    managers = [];
    setEnv("PI_LSP_ENABLED", undefined);
    setEnv("PI_LSP_IN_SUBAGENTS", undefined);
    setEnv("PI_SUBAGENT_CHILD", undefined);
  });

  afterEach(async () => {
    for (const mgr of managers) {
      await mgr.shutdownBrokers();
      await mgr.shutdownAll();
    }
    managers = [];
    closeStateDb(prefsDbPath);
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

  it("creates a 0600 UNIX socket under the broker run directory", async () => {
    const wt = join(testDir, "wt1");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "a.ts"), "ERR\n");

    const mgr = new LspManager({ useBroker: true, brokerRunDir, timeoutMs: 3000, debounceMs: 10 });
    managers.push(mgr);
    const out = await mgr.getDiagnosticsForFile(wt, "a.ts", {
      typescript: { command: process.execPath, args: [mockServer, "--mode=normal"], extensions: [".ts"] },
    });
    assert.ok(out?.includes("Broker diagnostic from pid"));

    const sockPath = getLspBrokerSocketPath(wt, "typescript", brokerRunDir);
    assert.equal(existsSync(sockPath), true);
    const mode = statSync(sockPath).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("shares one warm LSP server process across separate clients in the same worktree", async () => {
    const wt = join(testDir, "wt-shared");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "a.ts"), "ERR\n");
    writeFileSync(join(wt, "b.ts"), "ERR\n");

    const overrides = {
      typescript: { command: process.execPath, args: [mockServer, "--mode=normal"], extensions: [".ts"] },
    };

    const mgr1 = new LspManager({ useBroker: true, brokerRunDir, timeoutMs: 3000, debounceMs: 10 });
    const mgr2 = new LspManager({ useBroker: true, brokerRunDir, timeoutMs: 3000, debounceMs: 10 });
    managers.push(mgr1, mgr2);

    const out1 = await mgr1.getDiagnosticsForFile(wt, "a.ts", overrides);
    const pong1 = await mgr1.pingBroker(wt, "typescript");
    const out2 = await mgr2.getDiagnosticsForFile(wt, "b.ts", overrides);
    const pong2 = await mgr2.pingBroker(wt, "typescript");

    assert.ok(out1?.includes("Broker diagnostic from pid"));
    assert.ok(out2?.includes("Broker diagnostic from pid"));
    assert.ok(pong1?.pid && pong1?.lspPid);
    assert.equal(pong2?.pid, pong1.pid);
    assert.equal(pong2?.lspPid, pong1.lspPid);
  });

  it("isolates LSP broker processes across separate worktree directories", async () => {
    const wt1 = join(testDir, "wt-a");
    const wt2 = join(testDir, "wt-b");
    mkdirSync(wt1, { recursive: true });
    mkdirSync(wt2, { recursive: true });
    writeFileSync(join(wt1, "a.ts"), "ERR\n");
    writeFileSync(join(wt2, "a.ts"), "ERR\n");

    const overrides = {
      typescript: { command: process.execPath, args: [mockServer, "--mode=normal"], extensions: [".ts"] },
    };
    const mgr = new LspManager({ useBroker: true, brokerRunDir, timeoutMs: 3000, debounceMs: 10 });
    managers.push(mgr);

    await mgr.getDiagnosticsForFile(wt1, "a.ts", overrides);
    await mgr.getDiagnosticsForFile(wt2, "a.ts", overrides);

    const pong1 = await mgr.pingBroker(wt1, "typescript");
    const pong2 = await mgr.pingBroker(wt2, "typescript");
    assert.ok(pong1?.pid && pong2?.pid);
    assert.notEqual(pong1.pid, pong2.pid);
    assert.notEqual(pong1.lspPid, pong2.lspPid);
  });

  it("deduplicates concurrent cold broker spawns via the atomic lockfile", async () => {
    const wt = join(testDir, "wt-race");
    const logFile = join(testDir, "spawn-count.log");
    mkdirSync(wt, { recursive: true });
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(wt, `f${i}.ts`), "ERR\n");
    }

    const overrides = {
      typescript: {
        command: process.execPath,
        args: [mockServer, "--mode=normal", `--log=${logFile}`],
        extensions: [".ts"],
      },
    };
    const clients = Array.from({ length: 4 }, () => {
      const m = new LspManager({ useBroker: true, brokerRunDir, timeoutMs: 4000, debounceMs: 10 });
      managers.push(m);
      return m;
    });

    const results = await Promise.all(
      clients.map((m, i) => m.getDiagnosticsForFile(wt, `f${i}.ts`, overrides)),
    );
    for (const r of results) {
      assert.ok(r?.includes("Broker diagnostic from pid"), `expected diagnostics, got: ${r}`);
    }

    const starts = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.event === "started");
    assert.equal(starts.length, 1, `expected exactly 1 LSP process spawn, got ${starts.length}`);
  });

  it("coalesces rapid publishDiagnostics bursts during the debounce window", async () => {
    const wt = join(testDir, "wt-debounce");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "burst.ts"), "ERR\n");

    const mgr = new LspManager({ useBroker: true, brokerRunDir, timeoutMs: 3000, debounceMs: 80 });
    managers.push(mgr);
    const out = await mgr.getDiagnosticsForFile(wt, "burst.ts", {
      typescript: { command: process.execPath, args: [mockServer, "--mode=burst"], extensions: [".ts"] },
    });

    assert.ok(out?.includes("Broker diagnostic from pid"), `expected debounced error diagnostic, got: ${out}`);
  });

  it("opens the broken-server circuit breaker after repeated crashes to stop restart loops", async () => {
    const wt = join(testDir, "wt-crash");
    const logFile = join(testDir, "crash.log");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "broken.ts"), "ERR\n");

    const overrides = {
      typescript: {
        command: process.execPath,
        args: [mockServer, "--mode=crash", `--log=${logFile}`],
        extensions: [".ts"],
      },
    };
    const mgr = new LspManager({ useBroker: true, brokerRunDir, timeoutMs: 2000, debounceMs: 10 });
    managers.push(mgr);

    await mgr.getDiagnosticsForFile(wt, "broken.ts", overrides);
    await mgr.getDiagnosticsForFile(wt, "broken.ts", overrides);
    // Third call must be short-circuited without spawning a third crashing child
    const thirdRes = await mgr.getDiagnosticsForFile(wt, "broken.ts", overrides);
    assert.equal(thirdRes, null);

    const starts = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.event === "started");
    assert.equal(starts.length, 2, `expected circuit breaker to halt after 2 crashes, got ${starts.length}`);
  });

  it("shuts down an idle broker automatically after idleTimeoutMs", async () => {
    const wt = join(testDir, "wt-idle");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "idle.ts"), "ERR\n");

    const mgr = new LspManager({
      useBroker: true,
      brokerRunDir,
      timeoutMs: 3000,
      idleTimeoutMs: 250,
      debounceMs: 10,
    });
    managers.push(mgr);

    await mgr.getDiagnosticsForFile(wt, "idle.ts", {
      typescript: { command: process.execPath, args: [mockServer, "--mode=normal"], extensions: [".ts"] },
    });
    const pong = await mgr.pingBroker(wt, "typescript");
    assert.ok(pong?.pid && pong?.lspPid);

    assert.equal(await waitForPidExit(pong.pid, 3000), true, "expected idle broker PID to exit");
    assert.equal(await waitForPidExit(pong.lspPid, 3000), true, "expected idle LSP child PID to exit");
  });

  it("serves editing subagents through the shared worktree broker by default", async () => {
    const wt = join(testDir, "wt-subagent");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "main.ts"), "ERR\n");
    writeFileSync(join(wt, "sub.ts"), "ERR\n");
    writeGlobalSettings({
      lsp_enabled: true,
      lsp_servers: {
        typescript: { command: process.execPath, args: [mockServer, "--mode=normal"], extensions: [".ts"] },
      },
    });

    const mainPi = createMockPi();
    const { manager: mainMgr } = registerLsp(mainPi.pi, {
      brokerRunDir,
      timeoutMs: 3000,
      debounceMs: 10,
      isSubagentChild: () => false,
    });
    managers.push(mainMgr);

    const subPi = createMockPi();
    const { manager: subMgr } = registerLsp(subPi.pi, {
      brokerRunDir,
      timeoutMs: 3000,
      debounceMs: 10,
      isSubagentChild: () => true,
    });
    managers.push(subMgr);

    const mainRes = await mainPi.fire(
      "tool_result",
      { toolName: "write", input: { path: "main.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
      { cwd: wt },
    );
    const subRes = await subPi.fire(
      "tool_result",
      { toolName: "edit", input: { path: "sub.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
      { cwd: wt },
    );

    const mainPong = await mainMgr.pingBroker(wt, "typescript");
    const subPong = await subMgr.pingBroker(wt, "typescript");
    assert.ok(mainRes?.content?.[1]?.text.includes("Broker diagnostic from pid"));
    assert.ok(subRes?.content?.[1]?.text.includes("Broker diagnostic from pid"));
    assert.equal(subPong?.lspPid, mainPong?.lspPid);

    // Subagent session_shutdown must NOT kill the shared broker used by main session
    await subPi.fire("session_shutdown", {}, { cwd: wt });
    const stillAlive = await mainMgr.pingBroker(wt, "typescript");
    assert.equal(stillAlive?.pid, mainPong?.pid);
  });

  // ── Lazy user-confirmed missing-server TUI install prompt ─────────

  describe("lazy missing-server install prompt", () => {
    it("pins typescript@6 in an isolated prefix in the TypeScript install recipe", () => {
      assert.equal(
        BUILTIN_INSTALL_RECIPES.typescript?.displayCmd,
        "npm install --prefix ~/.pi/lsp/ts-lsp typescript@6 typescript-language-server",
      );
    });

    it("installs typescript@6 into an isolated prefix without exposing tsc", async () => {
      const stubBinDir = join(testDir, "stub-npm-bin");
      const managedLspDir = join(testDir, "managed-lsp");
      const argvLog = join(testDir, "npm-argv.json");
      mkdirSync(stubBinDir, { recursive: true });
      const stubNpm = join(stubBinDir, "npm");
      writeFileSync(
        stubNpm,
        `#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv), "utf8");
const prefixIdx = argv.indexOf("--prefix");
if (prefixIdx >= 0 && argv[prefixIdx + 1]) {
  const binDir = path.join(argv[prefixIdx + 1], "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of ["typescript-language-server", "tsc"]) {
    const p = path.join(binDir, name);
    fs.writeFileSync(p, "#!/bin/sh\\nexit 0\\n", "utf8");
    fs.chmodSync(p, 0o755);
  }
}
`,
        "utf8",
      );
      chmodSync(stubNpm, 0o755);
      setEnv("PATH", process.env.PATH);

      const res = await runLspServerInstall(BUILTIN_INSTALL_RECIPES.typescript, stubBinDir, { managedLspDir });
      assert.deepEqual(res, { ok: true });

      const recorded = JSON.parse(readFileSync(argvLog, "utf8"));
      assert.deepEqual(recorded, [
        "install",
        "--prefix",
        join(managedLspDir, "ts-lsp"),
        "typescript@6",
        "typescript-language-server",
      ]);
      assert.equal(existsSync(join(managedLspDir, "bin", "typescript-language-server")), true);
      assert.equal(existsSync(join(managedLspDir, "bin", "tsc")), false);
    });

    it("returns a failure result when runLspServerInstall npm exits non-zero", async () => {
      const stubBinDir = join(testDir, "stub-npm-fail");
      const managedLspDir = join(testDir, "managed-lsp-fail");
      mkdirSync(stubBinDir, { recursive: true });
      const stubNpm = join(stubBinDir, "npm");
      writeFileSync(
        stubNpm,
        `#!/bin/sh\necho "simulated registry failure" >&2\nexit 1\n`,
        "utf8",
      );
      chmodSync(stubNpm, 0o755);

      const res = await runLspServerInstall(BUILTIN_INSTALL_RECIPES.typescript, stubBinDir, { managedLspDir });
      assert.equal(res.ok, false);
      assert.ok(res.error && res.error.includes("simulated registry failure"));
    });

    it("identifies a missing built-in server only when no binary or override matches", () => {
      assert.equal(findMissingBuiltinServerId(join(testDir, "app.py"), {}, ""), "python");
      assert.equal(findMissingBuiltinServerId(join(testDir, "app.ts"), {}, ""), "typescript");
      assert.equal(findMissingBuiltinServerId(join(testDir, "main.go"), {}, ""), "go");
      assert.equal(findMissingBuiltinServerId(join(testDir, "README.md"), {}, ""), null);
      assert.equal(
        findMissingBuiltinServerId(join(testDir, "app.py"), { python: { command: "x", extensions: [".py"] } }, ""),
        null,
      );
    });

    it("installs a missing server when confirmed in TUI then activates LSP immediately", async () => {
      const wt = join(testDir, "wt-install");
      const binDir = join(testDir, "bin");
      mkdirSync(wt, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(wt, "app.py"), "ERR\n");
      writeGlobalSettings({ lsp_enabled: true });

      let selectCalls = 0;
      let installCalls = 0;
      const notices: string[] = [];

      const { pi, fire } = createMockPi();
      const { manager } = registerLsp(pi, {
        brokerRunDir,
        envPath: binDir,
        timeoutMs: 3000,
        debounceMs: 10,
        installPrefsDbPath: prefsDbPath,
        installRunner: async (recipe) => {
          installCalls++;
          assert.equal(recipe.serverId, "python");
          // Simulate installer placing executable `basedpyright-langserver` on binDir
          const installedBin = join(binDir, "basedpyright-langserver");
          writeFileSync(installedBin, MOCK_BROKER_LSP_SOURCE, "utf8");
          chmodSync(installedBin, 0o755);
          return { ok: true };
        },
      });
      managers.push(manager);

      const res = await fire(
        "tool_result",
        { toolName: "write", input: { path: "app.py" }, isError: false, content: [{ type: "text", text: "ok" }] },
        {
          cwd: wt,
          hasUI: true,
          ui: {
            select: async (_title: string, choices: string[]) => {
              selectCalls++;
              return choices[0]; // Install basedpyright
            },
            notify: (msg: string) => notices.push(msg),
          },
        },
      );

      assert.equal(selectCalls, 1);
      assert.equal(installCalls, 1);
      assert.ok(notices.some((n) => n.includes("Installed basedpyright")));
      assert.ok(res?.content?.[1]?.text.includes("LSP diagnostics (python):"));
    });

    it("skips subsequent prompts in the same session when the user picks Not now", async () => {
      const wt = join(testDir, "wt-notnow");
      mkdirSync(wt, { recursive: true });
      writeFileSync(join(wt, "a.go"), "package main\n");
      writeGlobalSettings({ lsp_enabled: true });

      let selectCalls = 0;
      const { pi, fire } = createMockPi();
      const { manager } = registerLsp(pi, {
        brokerRunDir,
        envPath: "",
        installPrefsDbPath: prefsDbPath,
      });
      managers.push(manager);

      const ctx = {
        cwd: wt,
        hasUI: true,
        ui: {
          select: async (_title: string, choices: string[]) => {
            selectCalls++;
            return choices[1]; // Not now
          },
        },
      };

      const r1 = await fire(
        "tool_result",
        { toolName: "write", input: { path: "a.go" }, isError: false, content: [{ type: "text", text: "ok" }] },
        ctx,
      );
      const r2 = await fire(
        "tool_result",
        { toolName: "edit", input: { path: "a.go" }, isError: false, content: [{ type: "text", text: "ok" }] },
        ctx,
      );

      assert.equal(r1, undefined);
      assert.equal(r2, undefined);
      assert.equal(selectCalls, 1);
      assert.equal(isLspInstallDismissed("go", prefsDbPath), false);
    });

    it("persists Don't ask again in SQLite so future sessions never re-prompt", async () => {
      const wt = join(testDir, "wt-dismiss");
      mkdirSync(wt, { recursive: true });
      writeFileSync(join(wt, "a.go"), "package main\n");
      writeGlobalSettings({ lsp_enabled: true });

      let selectCalls = 0;
      const ctx = {
        cwd: wt,
        hasUI: true,
        ui: {
          select: async (_title: string, choices: string[]) => {
            selectCalls++;
            return choices[2]; // Don't ask again for gopls
          },
        },
      };

      // Session 1 dismisses permanently
      const s1 = createMockPi();
      const { manager: m1 } = registerLsp(s1.pi, {
        brokerRunDir,
        envPath: "",
        installPrefsDbPath: prefsDbPath,
      });
      managers.push(m1);
      await s1.fire(
        "tool_result",
        { toolName: "write", input: { path: "a.go" }, isError: false, content: [{ type: "text", text: "ok" }] },
        ctx,
      );
      assert.equal(selectCalls, 1);
      assert.equal(isLspInstallDismissed("go", prefsDbPath), true);

      // Fresh session 2 must NOT prompt
      const s2 = createMockPi();
      const { manager: m2 } = registerLsp(s2.pi, {
        brokerRunDir,
        envPath: "",
        installPrefsDbPath: prefsDbPath,
      });
      managers.push(m2);
      const r2 = await s2.fire(
        "tool_result",
        { toolName: "write", input: { path: "a.go" }, isError: false, content: [{ type: "text", text: "ok" }] },
        ctx,
      );
      assert.equal(r2, undefined);
      assert.equal(selectCalls, 1);
    });

    it("emits a non-blocking one-line hint once per server in headless sessions", async () => {
      const wt = join(testDir, "wt-headless");
      mkdirSync(wt, { recursive: true });
      writeFileSync(join(wt, "a.py"), "x = 1\n");
      writeGlobalSettings({ lsp_enabled: true });

      const { pi, fire } = createMockPi();
      const { manager } = registerLsp(pi, {
        brokerRunDir,
        envPath: "",
        installPrefsDbPath: prefsDbPath,
      });
      managers.push(manager);

      const r1 = await fire(
        "tool_result",
        { toolName: "write", input: { path: "a.py" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: wt, hasUI: false },
      );
      const r2 = await fire(
        "tool_result",
        { toolName: "edit", input: { path: "a.py" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: wt, hasUI: false },
      );

      assert.ok(r1?.content?.[1]?.text.includes("[LSP] basedpyright not found on PATH"));
      assert.equal(r2, undefined);
    });

    it("suppresses the headless hint when the server was permanently dismissed", async () => {
      const wt = join(testDir, "wt-headless-dismissed");
      mkdirSync(wt, { recursive: true });
      writeFileSync(join(wt, "a.py"), "x = 1\n");
      writeGlobalSettings({ lsp_enabled: true });
      dismissLspInstallPermanently("python", prefsDbPath);

      const { pi, fire } = createMockPi();
      const { manager } = registerLsp(pi, {
        brokerRunDir,
        envPath: "",
        installPrefsDbPath: prefsDbPath,
      });
      managers.push(manager);

      const res = await fire(
        "tool_result",
        { toolName: "write", input: { path: "a.py" }, isError: false, content: [{ type: "text", text: "ok" }] },
        { cwd: wt, hasUI: false },
      );
      assert.equal(res, undefined);
    });
  });
});
