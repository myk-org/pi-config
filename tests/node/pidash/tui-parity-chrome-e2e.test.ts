/**
 * #1481 — Real headless Chrome E2E verification against real `scripts/pidash-server.ts`
 * and built `extensions/pidash/pidash-ui/dist/` at 1280×800 and 1440×900 viewports.
 *
 * Set `PIDASH_REQUIRE_E2E=1` to fail (instead of skipping) when Chrome/Chromium or the
 * built UI bundle is absent. Screenshots always write to `PIDASH_E2E_SCREENSHOT_DIR` or
 * `.pi/tmp/pidash-e2e-screenshots` by default.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { makeFileTempDir } from "../helpers/temp-dirs.js";

const VIEWPORTS: ReadonlyArray<readonly [number, number]> = [
  [1280, 800],
  [1440, 900],
];

const LONG_MCP_ERR = `MCP_E2E_ERR_${"E".repeat(260)}_TAIL_OK`;
const LONG_MCP_OUT = `MCP_E2E_OUT_${"O".repeat(1100)}_TAIL_OK`;

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
    throw new Error(
      `Timed out waiting for text ${JSON.stringify(snippet)}. Visible text:\n${lastText.slice(0, 600)}`,
    );
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
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
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

async function assertZeroOverflowAndCapture(
  cdp: CdpClient,
  screenshotDir: string,
  panelSlug: string,
): Promise<void> {
  try {
    for (const [width, height] of VIEWPORTS) {
      await cdp.setViewport(width, height);
      const { scrollWidth, innerWidth } = await cdp.evalJs<{ scrollWidth: number; innerWidth: number }>(
        "({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })",
      );
      assert.ok(
        scrollWidth <= innerWidth,
        `expected zero horizontal overflow on ${panelSlug} at ${width}x${height} (scrollWidth=${scrollWidth}, innerWidth=${innerWidth})`,
      );

      const outPath = join(screenshotDir, `${panelSlug}-${width}x${height}.png`);
      await cdp.capturePng(outPath);
      assert.ok(existsSync(outPath), `expected screenshot file ${outPath} to exist`);
      const size = statSync(outPath).size;
      assert.ok(size > 0, `expected screenshot file ${outPath} to be non-empty (got ${size} bytes)`);
    }
  } finally {
    await cdp.setViewport(1280, 800);
  }
}

type DrawerTabLabel = "Tasks" | "Coms" | "Memory" | "MCP";

interface PidashChromeFixture {
  cdp: CdpClient;
  screenshotDir: string;
  openPanel: (tabLabel: DrawerTabLabel) => Promise<void>;
  close: () => void;
}

async function createPidashChromeFixture(chromeBin: string): Promise<PidashChromeFixture> {
  const tmpDir = makeFileTempDir("pidash-chrome-e2e-");
  const screenshotDir = process.env.PIDASH_E2E_SCREENSHOT_DIR
    ? resolve(process.env.PIDASH_E2E_SCREENSHOT_DIR)
    : resolve(".pi/tmp/pidash-e2e-screenshots");
  mkdirSync(screenshotDir, { recursive: true });

  const serverPort = await findFreePort();
  const cdpPort = await findFreePort();

  let serverProc: ChildProcess | null = null;
  let chromeProc: ChildProcess | null = null;
  let piWs: WebSocket | null = null;
  let cdp: CdpClient | null = null;

  const close = () => {
    cdp?.close();
    try {
      piWs?.close();
    } catch {
      /* ignore */
    }
    try {
      chromeProc?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    try {
      serverProc?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  };

  const tasksState = [
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
    sendPi({
      type: "register",
      sessionId: "e2e-session-1481",
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
          sendPi({
            type: "task-op-result",
            op: "complete",
            taskId: msg.taskId,
            requestId: msg.requestId,
            ok: false,
            error: "Not found",
          });
        }
      } else if (msg.command === "coms-peers") {
        const allPeers = [
          {
            name: "peer-1479-pidash-data",
            project: "pi-config",
            purpose: "No hidden data",
            model: "gemini-4-neon",
            busy: true,
            queueDepth: 1,
            contextUsedPct: 42,
            supervised: true,
          },
          {
            name: "other-proj-peer",
            project: "rootcoz",
            purpose: "CI triage",
            model: "claude",
            busy: false,
            queueDepth: 0,
            contextUsedPct: 18,
            supervised: false,
          },
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
            {
              id: "msg-e2e-001",
              msg_id: "msg-e2e-001",
              sender_name: "feature-manager",
              prompt: "Verify PiDash TUI parity E2E",
              status: "processing",
            },
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
          servers: [{ name: "jira", status: "error", tools: 12, error: LONG_MCP_ERR }],
          raw: `RAW_MCP_${"R".repeat(240)}_END`,
        });
        sendPi({
          type: "mcp-op-result",
          op: "login",
          server: "jira",
          ok: true,
          output: LONG_MCP_OUT,
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

    // Select the registered session in the sidebar (shows comsName instead of model name)
    await cdp.waitForText("peer-1481-pidash-parity", 10_000);
    await cdp.evalJs(`(() => {
      const rows = Array.from(document.querySelectorAll("div"));
      const peerRow = rows.find((el) => el.textContent && el.textContent.includes("peer-1481-pidash-parity") && el.className.includes("cursor-pointer"));
      if (peerRow) peerRow.click();
    })()`);

    const openPanel = async (tabLabel: DrawerTabLabel): Promise<void> => {
      await cdp!.setViewport(1280, 800);
      // Close any existing drawer so each panel mounts from clean state
      await cdp!.evalJs(`(() => {
        const closeBtn = document.querySelector('button[title="Close panel"]');
        if (closeBtn) closeBtn.click();
      })()`);
      await cdp!.clickButtonByTitle("Tasks panel");
      if (tabLabel !== "Tasks") {
        const switched = await cdp!.evalJs<boolean>(`(() => {
          const closeBtn = document.querySelector('button[title="Close panel"]');
          const tabBar = closeBtn?.parentElement;
          const tabBtn = Array.from(tabBar?.querySelectorAll("button") ?? []).find(
            (b) => (b.textContent || "").trim() === ${JSON.stringify(tabLabel)},
          );
          if (!tabBtn) return false;
          tabBtn.click();
          return true;
        })()`);
        assert.equal(switched, true, `expected drawer tab ${JSON.stringify(tabLabel)}`);
      }
    };

    return { cdp, screenshotDir, openPanel, close };
  } catch (err) {
    close();
    throw err;
  }
}

describe("PiDash TUI parity real headless Chrome E2E (#1481)", () => {
  let fixture: PidashChromeFixture | null = null;
  let skipReason: string | null = null;

  before(async () => {
    const chromeBin = findChromeBinary();
    const uiIndex = resolve("extensions/pidash/pidash-ui/dist/index.html");
    const missing: string[] = [];
    if (!chromeBin) missing.push("Chrome/Chromium binary");
    if (!existsSync(uiIndex)) missing.push("extensions/pidash/pidash-ui/dist/index.html");

    if (missing.length > 0) {
      const reason = `PiDash Chrome E2E prerequisites missing: ${missing.join(", ")}`;
      if (process.env.PIDASH_REQUIRE_E2E === "1") {
        throw new Error(`${reason} (PIDASH_REQUIRE_E2E=1 forbids skipping)`);
      }
      skipReason = reason;
      return;
    }

    fixture = await createPidashChromeFixture(chromeBin!);
  });

  after(() => {
    fixture?.close();
    fixture = null;
  });

  it("Tasks panel: [you]/[llm] badges, Mine count, expandable details, blockedBy link, and zero overflow at 1280x800 and 1440x900", async (t) => {
    if (!fixture) {
      t.skip(skipReason ?? "Chrome E2E fixture unavailable");
      return;
    }
    const { cdp, screenshotDir, openPanel } = fixture;
    await openPanel("Tasks");

    await cdp.waitForText("Approve production deploy", 8_000);
    await cdp.waitForText("[you]");
    await cdp.waitForText("[llm]");
    await cdp.waitForText("Mine [you]");

    const mineCount = await cdp.evalJs<string | null>(
      'document.querySelector(\'[data-testid="mine-open-count"]\')?.textContent?.trim() ?? null',
    );
    assert.equal(mineCount, "1", "expected Mine [you] open count badge to equal 1");

    await cdp.clickButtonContaining("Approve production deploy");
    await cdp.waitForText("Verify staging smoke checklist before production release sign-off");

    await cdp.clickButtonContaining("#2");
    await cdp.waitForText("Execute migration v12 on staging database");

    await assertZeroOverflowAndCapture(cdp, screenshotDir, "tasks");
  });

  it("Coms panel: project/all scope isolation, inbound queue, no send composer, and zero overflow at 1280x800 and 1440x900", async (t) => {
    if (!fixture) {
      t.skip(skipReason ?? "Chrome E2E fixture unavailable");
      return;
    }
    const { cdp, screenshotDir, openPanel } = fixture;
    await openPanel("Coms");

    await cdp.waitForText("peer-1479-pidash-data", 8_000);
    await cdp.waitForText("Inbound Queue (1)", 8_000);

    // Project scope must isolate out peers from other projects
    const bodyInProjectScope = await cdp.evalJs<string>("document.body.innerText");
    assert.equal(
      bodyInProjectScope.includes("other-proj-peer"),
      false,
      "other-proj-peer must not appear under 'This project' scope",
    );

    // Explicitly verify ComsPanel contains no send-message composer input/form
    const composerAudit = await cdp.evalJs<{
      panelFound: boolean;
      inputOrFormCount: number;
      sendButtonCount: number;
    }>(`(() => {
      const panel = document.querySelector('button[title="Close panel"]')?.closest('div[style*="--panel-w"]');
      if (!panel) return { panelFound: false, inputOrFormCount: -1, sendButtonCount: -1 };
      const inputOrFormCount = panel.querySelectorAll("form, textarea, input").length;
      const sendButtonCount = Array.from(panel.querySelectorAll("button")).filter((b) =>
        /^\\s*send(\\s+message)?\\s*$/i.test(b.textContent || ""),
      ).length;
      return { panelFound: true, inputOrFormCount, sendButtonCount };
    })()`);
    assert.equal(composerAudit.panelFound, true, "expected SidePanel container for ComsPanel");
    assert.equal(composerAudit.inputOrFormCount, 0, "ComsPanel must not render a send-message form/input/textarea");
    assert.equal(composerAudit.sendButtonCount, 0, "ComsPanel must not render a Send composer button");

    // Switching to All projects reveals cross-project peers
    await cdp.clickButtonContaining("All projects");
    await cdp.waitForText("other-proj-peer", 8_000);

    await assertZeroOverflowAndCapture(cdp, screenshotDir, "coms");
  });

  it("Memory panel: situation report, Dream trigger, Copy button, and zero overflow at 1280x800 and 1440x900", async (t) => {
    if (!fixture) {
      t.skip(skipReason ?? "Chrome E2E fixture unavailable");
      return;
    }
    const { cdp, screenshotDir, openPanel } = fixture;
    await openPanel("Memory");

    await cdp.waitForText("Situation report", 8_000);
    await cdp.waitForText("Keep PiDash panels untruncated with Copy buttons", 8_000);

    const hasCopyButton = await cdp.evalJs<boolean>(
      'Boolean(document.querySelector(\'button[title="Copy situation report"]\'))',
    );
    assert.equal(hasCopyButton, true, "expected visible Copy situation report button in MemoryPanel");

    await cdp.clickButtonContaining("Dream");
    await cdp.waitForText("Started background memory consolidation (job dream-e2e-1).", 8_000);

    await assertZeroOverflowAndCapture(cdp, screenshotDir, "memory");
  });

  it("MCP panel: untruncated >200-char error and >1000-char output, and zero overflow at 1280x800 and 1440x900", async (t) => {
    if (!fixture) {
      t.skip(skipReason ?? "Chrome E2E fixture unavailable");
      return;
    }
    const { cdp, screenshotDir, openPanel } = fixture;
    await openPanel("MCP");

    await cdp.waitForText("Error details", 8_000);
    await cdp.clickButtonContaining("Error details");
    await cdp.waitForText(LONG_MCP_ERR, 8_000);
    await cdp.waitForText(LONG_MCP_OUT, 8_000);

    await assertZeroOverflowAndCapture(cdp, screenshotDir, "mcp");
  });
});
