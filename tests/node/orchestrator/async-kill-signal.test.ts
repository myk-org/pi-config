/**
 * Kill-signalling decisions, tested without real processes.
 *
 * A kill that reports success while the worker is still alive is the dangerous direction
 * to be wrong in: the job is marked failed, the user is told it is gone, and a live agent
 * keeps burning tokens. Both failures below were real — a failed signal treated as a kill,
 * and one target's failure charged to the next.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isProcessAlive, signalAndReportSurvivors } from "../../../extensions/orchestrator/async-kill-signal.js";

/** A probe that fails the way the real one fails, so the distinction is exercised. */
function probeReturning(code: string | null) {
  return () => {
    const e: any = new Error(code ?? "alive");
    e.code = code;
    throw e;
  };
}

describe("isProcessAlive", () => {
  it("reports the current process as alive", () => {
    // Must assert the VALUE, not just the type: `typeof x === "boolean"` passes even if the
    // helper reports every process as gone, which would silently disarm the kill path.
    assert.equal(isProcessAlive(process.pid), true,
      "the process running this test is definitionally alive");
  });

  it("treats only an explicit ESRCH as proof the process is gone", () => {
    // Permission denial is NOT absence: reporting a denied process as gone is how a live
    // worker gets announced as killed.
    const denied = new Error("EPERM") as any;
    denied.code = "EPERM";
    const original = process.kill;
    (process as any).kill = () => { throw denied; };
    try {
      assert.equal(isProcessAlive(4242), true, "a denied probe must count as still alive");
    } finally {
      (process as any).kill = original;
    }
  });

  it("reports a vanished process as gone", () => {
    const gone = new Error("ESRCH") as any;
    gone.code = "ESRCH";
    const original = process.kill;
    (process as any).kill = () => { throw gone; };
    try {
      assert.equal(isProcessAlive(4242), false, "ESRCH is the only proof of absence");
    } finally {
      (process as any).kill = original;
    }
  });
});

describe("signalAndReportSurvivors", () => {
  it("reports a signal that was denied and whose process survives", () => {
    const survivors = signalAndReportSurvivors(
      [111],
      () => { throw new Error("EPERM"); },
      () => true,
    );
    assert.deepEqual(survivors, [111], "a failed signal with a live process is a survivor");
  });

  it("does not report a survivor when the process actually exited", () => {
    const survivors = signalAndReportSurvivors(
      [111],
      () => { throw new Error("EPERM"); },
      () => false,
    );
    assert.deepEqual(survivors, [], "the process is gone, so nothing survives");
  });

  it("only probes pids whose signal failed", () => {
    // A pid signalled successfully is gone; re-probing it costs a syscall and, more
    // importantly, lets one target's leftovers leak into the next target's verdict.
    const probed: number[] = [];
    signalAndReportSurvivors([1, 2, 3], () => {}, (pid) => { probed.push(pid); return true; });
    assert.deepEqual(probed, [], "no pid needs a liveness probe after a successful signal");
  });

  it("keeps one target's survivors out of the next target's verdict", () => {
    // The multi-target bug: the failed-pid set was declared outside the loop, so a pid
    // that survived target A was re-checked for target B — and target B, having been
    // signalled fine, was charged with A's failure and skipped its state/result updates.
    const signal = (failing: Set<number>) => (pid: number) => {
      if (failing.has(pid)) throw new Error("EPERM");
    };
    const alive = (set: Set<number>) => (pid: number) => set.has(pid);

    // Target A: pid 1 cannot be signalled and is alive.
    const survivorsA = signalAndReportSurvivors([1], signal(new Set([1])), alive(new Set([1])));
    assert.deepEqual(survivorsA, [1]);

    // Target B: pid 2 signals cleanly. It must be reported as killed.
    const survivorsB = signalAndReportSurvivors([2], signal(new Set()), alive(new Set()));
    assert.deepEqual(survivorsB, [],
      "a later target must not inherit an earlier target's failed signal");
  });

  it("reports several survivors from one target", () => {
    const survivors = signalAndReportSurvivors(
      [1, 2, 3],
      (pid) => { if (pid !== 2) throw new Error("EPERM"); },
      () => true,
    );
    assert.deepEqual(survivors, [1, 3]);
  });

  it("handles a target with no pids", () => {
    assert.deepEqual(signalAndReportSurvivors([], () => {}, () => true), []);
  });
});
