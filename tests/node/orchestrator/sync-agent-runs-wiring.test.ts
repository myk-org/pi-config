/**
 * Sync runs through the real async wiring (#1121).
 *
 * The registry tests cover the bookkeeping; these drive `registerAsyncAgents` itself so
 * the surfaces that render or stop sync agents — footer slot, pidash emit, the
 * `/async-status` overlay and session shutdown — are exercised, not assumed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { registerAsyncAgents } from "../../../extensions/orchestrator/async-agents.js";
import {
  abortAllSyncAgentRuns,
  abortSyncAgentRun,
  beginSyncAgentRun,
  listSyncAgentRuns,
  listSyncAgentRunsWithFinished,
  syncAgentRunCount,
} from "../../../extensions/orchestrator/sync-agent-runs.js";
import { createLogger } from "../../../extensions/shared/logger.js";
import { setGlobalSessionId } from "../../../extensions/shared/file-logger.js";
import { makeTempDir } from "../helpers/temp-dirs.js";
import { fakeAgent, fakeSpawnProcess } from "../helpers/fake-async-runtime.js";
import { fakeCustom } from "../helpers/fake-extension-ctx.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";
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
  withSubagentChildEnv(undefined, () => {
    registerAsyncAgents(pi as any, () => {}, {
      spawnProcess: fakeSpawnProcess(),
      discoverAgents: () => ({ agents: [fakeAgent("worker")] }),
    });
  });
  assert.ok(handlers.get("session_start")?.length);
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
    shutdown: () => handlers.get("session_shutdown")![0]({}, ctx),
    pidash,
    /**
     * Render the /async-status overlay. `onOpen` sees every component it opens, in order
     * (list first, then the detail when the keys navigate into a row).
     */
    async openAsyncStatus(
      keys: readonly string[] = ["close"],
      onOpen?: (component: any, opened: number) => void,
    ) {
      let frame: string[] = [];
      let opened = 0;
      const capturing = (<T,>(factory: any) =>
        fakeCustom(factory, keys, {
          onOpen: (component: any) => {
            opened += 1;
            if (opened === 1) frame = component.render(160).map((line: string) => line.trimEnd());
            onOpen?.(component, opened);
          },
        })) satisfies ExtensionUIContext["custom"];
      await commands.get("async")!.handler("", { ...ctx, ui: ui(capturing) });
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
    abortAllSyncAgentRuns();
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
    abortAllSyncAgentRuns();
  });

  it("a retained finished run is visible but counted as idle", () => {
    const h = harness();
    beginSyncAgentRun({ agent: "worker", task: "done already", cwd: h.cwd }).end(true);
    // The row outlives the child so an open detail view can show a final status; the
    // footer is a running count, so it must not.
    assert.equal(listSyncAgentRunsWithFinished().length, 1);
    assert.equal(h.footer(), "💤 agents: 0");
    const payload = h.pidash();
    assert.equal(payload.count, 0);
    assert.equal(payload.jobs.length, 0, "pidash lists running agents only");
    abortAllSyncAgentRuns();
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
    abortAllSyncAgentRuns();
  });

  it("the overlay lists a finished sync run as done, not running", async () => {
    const h = harness();
    const run = beginSyncAgentRun({ agent: "worker", task: "finished job", cwd: h.cwd });
    run.end(true);

    const frame = await h.openAsyncStatus();
    const row = frame.find((line) => line.includes("finished job"));
    assert.ok(row, `no row for the finished run in:\n${frame.join("\n")}`);
    assert.match(row!, /done/, "a finished sync row must not say running");
    assert.doesNotMatch(row!, /running/);
    abortAllSyncAgentRuns();
  });

  it("the overlay counts a finished run as inactive", async () => {
    const h = harness();
    const run = beginSyncAgentRun({ agent: "worker", task: "finished job", cwd: h.cwd });
    run.end(true);

    const frame = await h.openAsyncStatus();
    assert.ok(frame.some((line) => line.includes("0 active")), "a finished run is not active");
    abortAllSyncAgentRuns();
  });

  it("the overlay detail header shows the final status, not running", async () => {
    const h = harness();
    beginSyncAgentRun({ agent: "worker", task: "finished job", cwd: h.cwd }).end(true);

    // Enter opens the detail; it reads the row's own status.json, so it must agree.
    let header = "";
    await h.openAsyncStatus(["\r"], (component, opened) => {
      if (opened === 1) return; // the list, not the detail
      header = component.render(160)[0];
      // Empty the registry so the loop's next list pass ends instead of reopening the row.
      abortAllSyncAgentRuns();
      component.handleInput("\u001b");
    });
    assert.match(header, /complete/, "the header must carry the final status");
    assert.doesNotMatch(header, /running/);
  });

  it("the detail header reads a sync run's own status.json", async () => {
    const h = harness();
    const run = beginSyncAgentRun({ agent: "worker", task: "stop me", cwd: h.cwd });
    run.setAbort(() => {});
    // The stop origin exists only on disk, so a header that names it proves the row's
    // workerDir reached readLiveStatus.
    abortSyncAgentRun(run.id);

    let header = "";
    await h.openAsyncStatus(["\r"], (component, opened) => {
      if (opened === 1) return; // the list, not the detail
      header = component.render(160)[0];
      abortAllSyncAgentRuns();
      component.handleInput("\u001b");
    });
    assert.match(header, /killed by user/);
  });

  it("a pidash kill never reaches a sync run — the browser has no sync kill button", () => {
    const h = harness();
    const run = beginSyncAgentRun({ agent: "code-reviewer-wiring", task: "t", cwd: h.cwd });
    let aborts = 0;
    run.setAbort(() => { aborts++; });

    h.events.emit("pidash:async-kill", run.id);
    h.events.emit("pidash:async-kill", "code-reviewer-wiring");
    assert.equal(aborts, 0, "an async-name kill must not stop a sync child");
    assert.equal(syncAgentRunCount(), 1);
    abortAllSyncAgentRuns();
  });

  it("the overlay kill stops the selected sync row by id and keeps the row until exit", async () => {
    const h = harness();
    const run = beginSyncAgentRun({ agent: "worker", task: "stop me", cwd: h.cwd });
    let aborts = 0;
    run.setAbort(() => { aborts++; });

    await h.openAsyncStatus(["x", "close"]);
    assert.equal(aborts, 1, "x must reach the sync abort handle");
    assert.equal(syncAgentRunCount(), 0);
    // The child is still alive, so the row stays — and end() takes it away.
    assert.deepEqual(listSyncAgentRuns().map((r) => `${r.id}:${r.status}`), [`${run.id}:failed`]);
    run.end(false);
    assert.deepEqual(listSyncAgentRuns(), []);
    abortAllSyncAgentRuns();
  });

  it("session shutdown stops live sync runs before clearing them", () => {
    const h = harness();
    const run = beginSyncAgentRun({ agent: "worker", task: "t", cwd: h.cwd });
    let aborts = 0;
    run.setAbort(() => { aborts++; });

    h.shutdown();
    assert.equal(aborts, 1, "a sync child must not outlive the session");
    assert.deepEqual(listSyncAgentRuns(), []);
    assert.deepEqual(listSyncAgentRunsWithFinished(), []);
  });
});
