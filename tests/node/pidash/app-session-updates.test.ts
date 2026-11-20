import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { createRoot, type Root } from "../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js";
import { useSessions } from "../../../extensions/pidash/pidash-ui/src/hooks/useSessions.ts";
import type { SessionInfo } from "../../../extensions/shared/types.ts";
import { installReactDomShim } from "./react-dom-shim.mjs";

const mounted: Root[] = [];
afterEach(async () => {
  while (mounted.length) await act(async () => mounted.pop()!.unmount());
});

function makeSession(sessionId: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId, pid: 1, cwd: "/tmp/project", branch: "main", model: "old",
    startedAt: "now", lastActivity: 0, active: true, ...overrides,
  };
}

describe("selected pidash session updates", () => {
  it("merges capability updates while preserving session selection", async () => {
    const { container } = installReactDomShim();
    let handler: (event: any) => void = () => {};
    let sessions: SessionInfo[] = [];
    let selectedId = "selected";
    let selected: SessionInfo | undefined;
    globalThis.fetch = async () => ({ json: async () => [makeSession("selected"), makeSession("other")] }) as Response;

    function Probe() {
      sessions = useSessions(true, (next) => { handler = next; return () => {}; });
      selected = sessions.find((candidate) => candidate.sessionId === selectedId);
      return null;
    }

    const root = createRoot(container);
    mounted.push(root);
    await act(async () => root.render(createElement(Probe)));
    await act(async () => handler({
      type: "session_updated",
      session: { sessionId: "selected", reasoning: true, thinkingLevel: "high", trailTokenSavings: 321 },
    }));
    assert.deepEqual(
      { reasoning: selected?.reasoning, thinkingLevel: selected?.thinkingLevel, trailTokenSavings: selected?.trailTokenSavings },
      { reasoning: true, thinkingLevel: "high", trailTokenSavings: 321 },
    );

    selectedId = "other";
    await act(async () => root.render(createElement(Probe)));
    await act(async () => handler({ type: "session_updated", session: { sessionId: "selected", thinkingLevel: "max" } }));
    assert.equal(selected?.sessionId, "other");
    assert.equal(selected?.thinkingLevel, undefined);
  });

  it("skips 10s interval when wsConnected is true and skips setSessions when payload is unchanged", async () => {
    const { container } = installReactDomShim();
    let fetchCount = 0;
    const snapshots: SessionInfo[][] = [];
    const payload = [makeSession("s1")];
    globalThis.fetch = async () => {
      fetchCount++;
      return { json: async () => payload.map((s) => ({ ...s })) } as Response;
    };

    const origSetInterval = globalThis.setInterval;
    const intervals: Array<() => void> = [];
    globalThis.setInterval = ((fn: () => void) => {
      intervals.push(fn);
      return 123 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    const origClearInterval = globalThis.clearInterval;
    globalThis.clearInterval = (() => {}) as typeof clearInterval;

    try {
      function Probe({ connected }: { connected: boolean }) {
        const s = useSessions(connected, () => () => {});
        snapshots.push(s);
        return null;
      }

      const root = createRoot(container);
      mounted.push(root);
      await act(async () => root.render(createElement(Probe, { connected: true })));
      assert.equal(fetchCount, 1);
      assert.equal(intervals.length, 0, "no 10s interval scheduled while WS is connected");

      await act(async () => root.render(createElement(Probe, { connected: false })));
      assert.equal(intervals.length, 1, "fallback 10s interval scheduled while disconnected");
      const beforeRef = snapshots.at(-1);
      await act(async () => { await intervals[0](); });
      assert.equal(fetchCount, 2);
      assert.equal(snapshots.at(-1), beforeRef, "identical JSON payload keeps existing sessions reference");
    } finally {
      globalThis.setInterval = origSetInterval;
      globalThis.clearInterval = origClearInterval;
    }
  });

  it("schedules a bounded retry when /api/sessions fails while connected and cancels on unmount", async () => {
    const { container } = installReactDomShim();
    let fetchCount = 0;
    let latest: SessionInfo[] = [];
    globalThis.fetch = async () => {
      fetchCount++;
      if (fetchCount === 1) throw new Error("transient network error");
      return { ok: true, json: async () => [makeSession("recovered")] } as unknown as Response;
    };

    const origSetTimeout = globalThis.setTimeout;
    const origClearTimeout = globalThis.clearTimeout;
    const scheduled: Array<{ fn: () => void; cleared: boolean }> = [];
    globalThis.setTimeout = ((fn: () => void) => {
      const entry = { fn, cleared: false };
      scheduled.push(entry);
      return entry as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: any) => {
      if (id && typeof id === "object" && "cleared" in id) id.cleared = true;
    }) as typeof clearTimeout;

    try {
      function Probe({ connected }: { connected: boolean }) {
        latest = useSessions(connected, () => () => {});
        return null;
      }

      const root = createRoot(container);
      mounted.push(root);
      await act(async () => root.render(createElement(Probe, { connected: true })));
      assert.equal(fetchCount, 1);
      assert.equal(latest.length, 0);
      assert.equal(scheduled.length, 1, "scheduled bounded retry after failed connected load");

      await act(async () => { scheduled[0].fn(); });
      assert.equal(fetchCount, 2);
      assert.deepEqual(latest.map(s => s.sessionId), ["recovered"]);

      // Fail again and unmount before retry fires — retry timer must be cleared.
      globalThis.fetch = async () => { throw new Error("down"); };
      await act(async () => root.render(createElement(Probe, { connected: false })));
      await act(async () => root.render(createElement(Probe, { connected: true })));
      assert.equal(scheduled.length, 2);
      await act(async () => root.unmount());
      mounted.pop();
      assert.equal(scheduled[1].cleared, true, "unmount clears pending retry timer");
    } finally {
      globalThis.setTimeout = origSetTimeout;
      globalThis.clearTimeout = origClearTimeout;
    }
  });
});
