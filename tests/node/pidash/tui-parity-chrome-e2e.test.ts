/**
 * #1481 — Real headless Chrome E2E verification against real `scripts/pidash-server.ts`
 * and built `extensions/pidash/pidash-ui/dist/` at 1280×800 and 1440×900 viewports.
 *
 * Gracefully skips when Chrome/Chromium or the built UI bundle is absent (e.g. minimal CI).
 * Set `PIDASH_E2E_SCREENSHOT_DIR=<dir>` to persist PNG captures for visual inspection.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { makeTempDir } from "../helpers/temp-dirs.js";

function findChromeBinary(): string | null {
  for (const bin of ["google-chrome", "chromium", "chromium-browser"]) {
    const res = spawnSync("which", [bin], { encoding: "utf-8" });
    if (res.status === 0 && res.stdout.trim()) return res.stdout.trim();
  }
  return null;
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolvePort(port));
      } else {
        srv.close(() => reject(new Error("failed to allocate free port")));
      }
    });
  });
}

async function waitForHttp(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

class CdpClient {
  private ws: WebSocket;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString("utf-8"));
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolveCmd, rejectCmd) => {
      this.pending.set(id, { resolve: resolveCmd, reject: rejectCmd });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evalJs<T = any>(expression: string): Promise<T> {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res?.exceptionDetails) {
      throw new Error(`Browser JS exception: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res?.result?.value as T;
  }

  async waitForText(snippet: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const text = await this.evalJs<string>("document.body ? document.body.innerText : ''");
      if (text && text.includes(snippet)) return;
      await new Promise((r) => setTimeout(r, 120));
    }
    const lastText = await this.evalJs<string>("document.body ? document.body.innerText : ''");
    throw new Error(`Timed out waiting for text ${JSON.stringify(snippet)}. Visible text:\n${lastText.slice(0, 600)}`);
  }

  async clickButtonContaining(label: string): Promise<void> {
    const clicked = await this.evalJs<boolean>(`(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const target = btns.find((b) => (b.textContent || "").includes(${JSON.stringify(label)}));
      if (!target) return false;
      target.click();
      return true;
    })()`);
    assert.equal(clicked, true, `expected button containing ${JSON.stringify(label)}`);
  }

  async clickButtonByTitle(title: string): Promise<void> {
    const clicked = await this.evalJs<boolean>(`(() => {
      const target = document.querySelector('button[title=' + JSON.stringify(${JSON.stringify(title)}) + ']');
      if (!target) return false;
      target.click();
      return true;
    })()`);
    assert.equal(clicked, true, `expected button with title ${JSON.stringify(title)}`);
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await new Promise((r) => setTimeout(r, 150));
  }

  async capturePng(outPath: string): Promise<void> {
    await new Promise((r) => setTimeout(r, 200));
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(outPath, Buffer.from(data, "base64"));
  }

  close(): void {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

async function connectCdp(cdpPort: number): Promise<CdpClient> {
  await waitForHttp(`http://127.0.0.1:${cdpPort}/json/list`, 15_000);
  const pages = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()) as Array<{
    type: string;
    webSocketDebuggerUrl?: string;
  }>;
  const page = pages.find((p) => p.type === "page" && p.webSocketDebuggerUrl);
  assert.ok(page?.webSocketDebuggerUrl, "Chrome page CDP WebSocket URL");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  const cdp = new CdpClient(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  return cdp;
}

describe("PiDash TUI parity real headless Chrome E2E (#1481)", () => {
  it("verifies PiDash parity panels in headless Chrome across 1280x800, 1440x900 viewports", async (t) => {
    const chromeBin = findChromeBinary();
    const uiIndex = resolve("extensions/pidash/pidash-ui/dist/index.html");
    if (!chromeBin || !existsSync(uiIndex)) {
      t.skip("requires local Chrome/Chromium and built pidash-ui/dist");
      return;
    }

    const tmpDir = makeTempDir("pidash-chrome-e2e-");
    const serverPort = await findFreePort();
    const cdpPort = await findFreePort();
    const screenshotDir = process.env.PIDASH_E2E_SCREENSHOT_DIR
      ? resolve(process.env.PIDASH_E2E_SCREENSHOT_DIR)
      : null;
    if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });

    let serverProc: ChildProcess | null = null;
    let chromeProc: ChildProcess | null = null;
    let piWs: WebSocket | null = null;
    let cdp: CdpClient | null = null;

    const longMcpErr = `MCP_E2E_ERR_${"E".repeat(260)}_TAIL_OK`;
    const longMcpOut = `MCP_E2E_OUT_${"O".repeat(1100)}_TAIL_OK`;

    let tasksState = [
      {
        id: "1",
        subject: "Approve production deploy",
        description: "Verify staging smoke checklist before production release sign-off",
        status: "pending",
        assignee: "user",
        blockedBy: ["2"],
      },
      {
        id: "2",
        subject: "Run backend schema migration",
        description: "Execute migration v12 on staging database",
        status: "in_progress",
        assignee: "llm",
        activeForm: "Running migration v12",
        blockedBy: [],
      },
      {
        id: "3",
        subject: "Rotate staging API key",
        description: "Replaced key in secrets manager",
        status: "completed",
        assignee: "user",
        completedBy: "user",
        completionNote: "Rotated cleanly with 30d TTL",
        blockedBy: [],
      },
    ];

    try {
      const tsxBin = resolve("node_modules/.bin/tsx");
      serverProc = spawn(tsxBin, [resolve("scripts/pidash-server.ts")], {
        env: { ...process.env, PI_PIDASH_PORT: String(serverPort) },
        stdio: "ignore",
      });
      await waitForHttp(`http://127.0.0.1:${serverPort}/health`, 15_000);

      // Connect a real Pi session over WebSocket to the live pidash-server
      piWs = new WebSocket(`ws://127.0.0.1:${serverPort}/ws/pi`);
      await new Promise<void>((res, rej) => {
        piWs!.once("open", () => res());
        piWs!.once("error", rej);
      });

      const sendPi = (obj: Record<string, unknown>) => piWs!.send(JSON.stringify(obj));
      const sessionId = "e2e-session-1481";
      sendPi({
        type: "register",
        sessionId,
        cwd: resolve("."),
        branch: "fix/issue-1481-pidash-tui-parity",
        gitDirty: false,
        model: "Gemini 4 Neon",
        name: "Gemini 4 Neon",
        comsProject: "pi-config",
        comsName: "peer-1481-pidash-parity",
        startedAt: new Date().toISOString(),
        activity: "idle",
        activitySequence: 1,
        streaming: false,
      });
      sendPi({ type: "replay_complete" });

      piWs.on("message", (raw) => {
        const msg = JSON.parse(raw.toString("utf-8"));
        if (msg.type !== "pidash-command") return;
        if (msg.command === "tasks-list") {
          sendPi({ type: "tasks-list", tasks: tasksState });
        } else if (msg.command === "task-op" && msg.op === "complete") {
          const target = tasksState.find((item) => item.id === msg.taskId);
          if (target) {
            target.status = "completed";
            (target as any).completedBy = "user";
            if (msg.completionNote) (target as any).completionNote = msg.completionNote;
            sendPi({ type: "task-op-result", op: "complete", taskId: msg.taskId, requestId: msg.requestId, ok: true });
            sendPi({ type: "tasks-list", tasks: tasksState });
          } else {
            sendPi({ type: "task-op-result", op: "complete", taskId: msg.taskId, requestId: msg.requestId, ok: false, error: "Not found" });
          }
        } else if (msg.command === "coms-peers") {
          const allPeers = [
            { name: "peer-1479-pidash-data", project: "pi-config", purpose: "No hidden data", model: "gemini-4-neon", busy: true, queueDepth: 1, contextUsedPct: 42, supervised: true },
            { name: "other-proj-peer", project: "rootcoz", purpose: "CI triage", model: "claude", busy: false, queueDepth: 0, contextUsedPct: 18, supervised: false },
          ];
          const peers = msg.scope === "all" ? allPeers : allPeers.filter((p) => p.project === "pi-config");
          sendPi({
            type: "coms-peers",
            scope: msg.scope === "all" ? "all" : "project",
            ownProject: "pi-config",
            self: { name: "peer-1481-pidash-parity", project: "pi-config", purpose: "TUI parity" },
            peers,
            allPeers,
            requestId: msg.requestId,
          });
        } else if (msg.command === "coms-queue") {
          sendPi({
            type: "coms-queue",
            active: true,
            items: [
              { id: "msg-e2e-001", msg_id: "msg-e2e-001", sender_name: "feature-manager", prompt: "Verify PiDash TUI parity E2E", status: "processing" },
            ],
          });
        } else if (msg.command === "memory-status") {
          sendPi({
            type: "memory-status",
            usagePct: 48,
            topics: [
              { name: "pidash", entryCount: 6, hotness: 9, newestEntry: "2026-11-27" },
              { name: "coms", entryCount: 4, hotness: 7, newestEntry: "2026-11-27" },
            ],
            report: "# Project Memory [48%]\n- [lesson] Keep PiDash panels untruncated with Copy buttons",
          });
        } else if (msg.command === "memory-dream") {
          sendPi({
            type: "memory-dream-result",
            requestId: msg.requestId,
            ok: true,
            id: "dream-e2e-1",
            message: "Started background memory consolidation (job dream-e2e-1).",
          });
        } else if (msg.command === "mcp-list") {
          sendPi({
            type: "mcp-list",
            servers: [{ name: "jira", status: "error", tools: 12, error: longMcpErr }],
            raw: `RAW_MCP_${"R".repeat(240)}_END`,
          });
          sendPi({
            type: "mcp-op-result",
            op: "login",
            server: "jira",
            ok: true,
            output: longMcpOut,
          });
        }
      });

      const chromeProfile = join(tmpDir, "chrome-profile");
      mkdirSync(chromeProfile, { recursive: true });
      chromeProc = spawn(
        chromeBin,
        [
          "--headless=new",
          "--disable-gpu",
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--renderer-process-limit=1",
          "--disable-extensions",
          "--disable-background-networking",
          "--disable-sync",
          "--mute-audio",
          `--remote-debugging-port=${cdpPort}`,
          `--user-data-dir=${chromeProfile}`,
          "--window-size=1280,800",
          "about:blank",
        ],
        { stdio: "ignore" },
      );

      cdp = await connectCdp(cdpPort);
      await cdp.setViewport(1280, 800);
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${serverPort}/` });

      // 1. Sidebar Coms section shows comsName instead of model name "Gemini 4 Neon"
      await cdp.waitForText("peer-1481-pidash-parity", 10_000);
      await cdp.evalJs(`(() => {
        const rows = Array.from(document.querySelectorAll("div"));
        const peerRow = rows.find((el) => el.textContent && el.textContent.includes("peer-1481-pidash-parity") && el.className.includes("cursor-pointer"));
        if (peerRow) peerRow.click();
      })()`);

      // Open the right-side drawer via InfoBar Tasks icon button
      await cdp.clickButtonByTitle("Tasks panel");
      await cdp.waitForText("Approve production deploy", 8_000);

      // Verify [you]/[llm] badges, Mine [you] count, expandable details, blockedBy link
      await cdp.waitForText("Mine [you]");
      await cdp.clickButtonContaining("Approve production deploy");
      await cdp.waitForText("Verify staging smoke checklist before production release sign-off");
      await cdp.clickButtonContaining("#2");
      await cdp.waitForText("Execute migration v12 on staging database");

      const overflow1280 = await cdp.evalJs<boolean>(
        "document.documentElement.scrollWidth > window.innerWidth",
      );
      assert.equal(overflow1280, false, "zero horizontal overflow at 1280x800 (Tasks)");
      if (screenshotDir) await cdp.capturePng(join(screenshotDir, "tasks-1280x800.png"));

      // Switch to 1440x900 and verify zero overflow
      await cdp.setViewport(1440, 900);
      const overflow1440 = await cdp.evalJs<boolean>(
        "document.documentElement.scrollWidth > window.innerWidth",
      );
      assert.equal(overflow1440, false, "zero horizontal overflow at 1440x900 (Tasks)");
      if (screenshotDir) await cdp.capturePng(join(screenshotDir, "tasks-1440x900.png"));

      // Back to 1280x800 for Coms, Memory, MCP tabs
      await cdp.setViewport(1280, 800);

      // Coms tab
      await cdp.clickButtonContaining("Coms");
      await cdp.waitForText("peer-1479-pidash-data", 8_000);
      await cdp.waitForText("Inbound Queue (1)", 8_000);
      await cdp.clickButtonContaining("All projects");
      await cdp.waitForText("other-proj-peer", 8_000);
      if (screenshotDir) await cdp.capturePng(join(screenshotDir, "coms-1280x800.png"));

      // Memory tab
      await cdp.clickButtonContaining("Memory");
      await cdp.waitForText("Situation report", 8_000);
      await cdp.waitForText("Dream", 8_000);
      if (screenshotDir) await cdp.capturePng(join(screenshotDir, "memory-1280x800.png"));

      // MCP tab: verify >200 char error and >1000 char output NOT truncated
      await cdp.clickButtonContaining("MCP");
      await cdp.waitForText("Error details", 8_000);
      await cdp.clickButtonContaining("Error details");
      await cdp.waitForText(longMcpErr, 8_000);
      await cdp.waitForText(longMcpOut, 8_000);
      if (screenshotDir) await cdp.capturePng(join(screenshotDir, "mcp-1280x800.png"));
    } finally {
      cdp?.close();
      try { piWs?.close(); } catch { /* ignore */ }
      try { chromeProc?.kill("SIGTERM"); } catch { /* ignore */ }
      try { serverProc?.kill("SIGTERM"); } catch { /* ignore */ }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
