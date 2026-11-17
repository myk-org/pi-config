/**
 * Sync runs through the real async wiring (#1121).
 *
 * The registry tests cover the bookkeeping; these drive `registerAsyncAgents` itself so
 * the three surfaces that were blind to sync agents — footer slot, pidash emit, and the
 * `/async-status` overlay with its kill routing — are exercised, not assumed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { registerAsyncAgents } from "../../../extensions/orchestrator/async-agents.js";
import { beginSyncAgentRun, clearSyncAgentRuns, syncAgentRunCount } from "../../../extensions/orchestrator/sync-agent-runs.js";
import { createLogger } from "../../../extensions/shared/logger.js";
import { setGlobalSessionId } from "../../../extensions/shared/file-logger.js";
import { makeTempDir } from "../helpers/temp-dirs.js";
import { fakeAgent, fakeSpawnProcess } from "../helpers/fake-async-runtime.js";
import { fakeCustom } from "../helpers/fake-extension-ctx.js";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const log = createLogger("sync-agent-runs-wiring-test");
setGlobalSessionId("sync-agent-runs-wiring-test");

function harness() {
  const cwd = makeTempDir("sync-runs-wiring-");
  const handlers = new Map<string, Array<(event: unknown, ctx: any) => void>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const events = new EventEmitter();
  const statuses = new Map<string, string | undefined>();

  const ui = (custom: ExtensionUIContext["custom"]) => ({
    theme: { fg: (_: string, value: string) => value },
    setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
    custom,
    notify() {},
  });
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    ui: ui((<T,>(factory: any) => fakeCustom(factory, ["close"])) satisfies ExtensionUIContext["custom"]),
    sessionManager: { getCwd: () => cwd, getSessionId: () => "test" },
  };

  const pi = {
    on(event: string, handler: (event: unknown, ctx: any) => void) {
      (handlers.get(event) ?? handlers.set(event, []).get(event)!).push(handler);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, command); },
    sendMessage() {},
    events,
  };
  registerAsyncAgents(pi as any, () => {}, {
    spawnProcess: fakeSpawnProcess(),
    discoverAgents: () => ({ agents: [fakeAgent("worker")] }),
  });
  handlers.get("session_start")![0]({}, ctx);

  const pidash = () => {
    const seen: any[] = [];
    const listener = (data: unknown) => { seen.push(data); };
    events.on("pidash:async-status", listener);
    // Every registry change repaints; a throwaway run is the cheapest trigger that does
    // not need a real child process. It emits twice (begin, end), so take the last one.
    const probe = beginSyncAgentRun({ agent: "worker", task: "probe", cwd });
    probe.end(true);
    events.off("pidash:async-status", listener);
    return seen[seen.length - 1];
  };

  return {
    cwd,
    events,
    /** The footer slot as last written. */
    footer: () => statuses.get("2-async"),
    pidash,
    /** Rendered lines of the /async-status overlay. */
    async openAsyncStatus() {
      let frame: string[] = [];
      const capturing = (<T,>(factory: any) =>
        fakeCustom(factory, ["close"], {
          onOpen: (component: any) => { frame = component.render(160).map((line: string) => line.trimEnd()); },
        })) satisfies ExtensionUIContext["custom"];
      await commands.get("async-status")!.handler("", { ...ctx, ui: ui(capturing) });
      return frame;
    },
  };
}

describe("sync runs in the async surfaces", () => {
  it("footer counts a running sync agent and returns to idle when it ends", () => {
    const h = harness();
    const run = beginSyncAgentRun({ agent: "worker", task: "t", cwd: h.cwd });
    log.debug("case", { footer: h.footer() });
    assert.equal(h.footer(), "⏳ agents: 1 (1 sync)");
    run.end(true);
    assert.equal(h.footer(), "💤 agents: 0");
  });

  it("pidash emit carries the sync run as a sync-mode row and counts it", async () => {
    const h = harness();
    const run = beginSyncAgentRun({ agent: "worker", task: "measure the footer", cwd: h.cwd });
    const payload = h.pidash();
    run.end(true);
    assert.equal(payload.count, 1);
    assert.equal(payload.agents, "worker");
    assert.equal(payload.jobs.length, 1);
    assert.deepEqual(
      { id: payload.jobs[0].id, mode: payload.jobs[0].mode, name: payload.jobs[0].name, status: payload.jobs[0].status },
      { id: run.id, mode: "sync", name: "worker", status: "running" },
    );
  });

  it("the overlay renders a sync row with the marker and the current tool", async () => {
    const h = harness();
    const run = beginSyncAgentRun({ agent: "worker", task: "review the diff", cwd: h.cwd });
    run.setTool("bash");
    const frame = await h.openAsyncStatus();
    run.end(true);
    const row = frame.find((line) => line.includes("worker"));
    assert.ok(row, `no worker row in:\n${frame.join("\n")}`);
    assert.match(row!, /sync/, "a sync row must say it is not an async job");
    assert.match(row!, /bash/, "current tool must be visible");
    assert.ok(frame.some((line) => line.includes("1 active")), "the sync run counts as active");
  });

  it("a pidash kill of a sync id aborts the child", () => {
    const h = harness();
    const run = beginSyncAgentRun({ agent: "worker", task: "t", cwd: h.cwd });
    let aborts = 0;
    run.setAbort(() => { aborts++; });

    h.events.emit("pidash:async-kill", run.id);
    assert.equal(aborts, 1, "the sync spawn must be aborted, not reported as an unknown async job");
    assert.equal(syncAgentRunCount(), 0);
    clearSyncAgentRuns();
  });

  it("a pidash kill by agent name reaches the sync run too", () => {
    const h = harness();
    const run = beginSyncAgentRun({ agent: "code-reviewer-wiring", task: "t", cwd: h.cwd });
    let aborts = 0;
    run.setAbort(() => { aborts++; });

    h.events.emit("pidash:async-kill", "code-reviewer-wiring");
    assert.equal(aborts, 1);
    assert.equal(syncAgentRunCount(), 0);
    clearSyncAgentRuns();
  });
});
