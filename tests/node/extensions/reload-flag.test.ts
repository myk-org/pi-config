/**
 * reload-flag extension tests (agent-triggered extension reload).
 *
 * Verifies the nonce protocol: `reload.flag` (nonce) → old runtime consumes
 * it, writes `reload.pending`, calls ctx.reload() → new runtime's
 * session_start(reason "reload") writes `reload.done` with the same nonce.
 * Stale state is cleared at fresh session starts, never re-triggered.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import reloadExtension, {
  consumeReloadFlag,
  reloadFlagPath,
  reloadPendingPath,
  reloadDonePath,
} from "../../../extensions/reload-flag/index.js";

type Handler = (event: any, ctx: any) => Promise<void>;

function register(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const pi = { on: (name: string, fn: Handler) => handlers.set(name, fn) };
  reloadExtension(pi as any);
  return handlers;
}

function makeCwd(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "reload-flag-"));
  mkdirSync(path.join(dir, ".pi", "tmp"), { recursive: true });
  return dir;
}

/** Mock ctx whose `mode` getter stays live (isLiveExtensionCtx compatible). */
function makeCtx(cwd: string, reloads: { count: number }) {
  return {
    cwd,
    mode: "agent",
    reload: async () => {
      reloads.count++;
    },
  };
}

describe("reload-flag", () => {
  test("consumeReloadFlag moves the nonce to pending and reloads", async () => {
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      writeFileSync(reloadFlagPath(cwd), "nonce-123");
      const nonce = await consumeReloadFlag(makeCtx(cwd, reloads));
      assert.equal(nonce, "nonce-123");
      assert.equal(reloads.count, 1, "ctx.reload called exactly once");
      assert.ok(!existsSync(reloadFlagPath(cwd)), "flag consumed");
      assert.equal(readFileSync(reloadPendingPath(cwd), "utf-8"), "nonce-123", "nonce parked in pending");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("consumeReloadFlag without a flag is a no-op", async () => {
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const nonce = await consumeReloadFlag(makeCtx(cwd, reloads));
      assert.equal(nonce, null);
      assert.equal(reloads.count, 0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("new runtime completes the handshake: pending nonce → done marker", async () => {
    const handlers = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      writeFileSync(reloadPendingPath(cwd), "nonce-456");
      await handlers.get("session_start")!({ reason: "reload" }, makeCtx(cwd, reloads));
      assert.ok(!existsSync(reloadPendingPath(cwd)), "pending consumed");
      assert.equal(readFileSync(reloadDonePath(cwd), "utf-8"), "nonce-456", "done carries the nonce");
      await handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("fresh session start clears stale flag/pending/done without reloading", async () => {
    const handlers = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      writeFileSync(reloadFlagPath(cwd), "old");
      writeFileSync(reloadPendingPath(cwd), "older");
      writeFileSync(reloadDonePath(cwd), "oldest");
      await handlers.get("session_start")!({ reason: "startup" }, makeCtx(cwd, reloads));
      assert.ok(!existsSync(reloadFlagPath(cwd)));
      assert.ok(!existsSync(reloadPendingPath(cwd)));
      assert.ok(!existsSync(reloadDonePath(cwd)));
      // And a later turn_end finds no flag → no reload
      await handlers.get("turn_end")!({}, makeCtx(cwd, reloads));
      assert.equal(reloads.count, 0);
      await handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("turn_end consumes a pending flag via the live ctx", async () => {
    const handlers = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads);
      await handlers.get("session_start")!({ reason: "startup" }, ctx);
      writeFileSync(reloadFlagPath(cwd), "nonce-789");
      await handlers.get("turn_end")!({}, ctx);
      assert.equal(reloads.count, 1, "reload fired at turn end");
      assert.ok(!existsSync(reloadFlagPath(cwd)), "flag consumed");
      assert.equal(readFileSync(reloadPendingPath(cwd), "utf-8"), "nonce-789");
      // A second turn_end without re-touching must not reload again
      await handlers.get("turn_end")!({}, ctx);
      assert.equal(reloads.count, 1);
      await handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("manual /reload satisfies a sitting flag — no second reload", async () => {
    const handlers = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads);
      writeFileSync(reloadFlagPath(cwd), "nonce-stale");
      // User reloaded manually BEFORE the watcher consumed the flag
      await handlers.get("session_start")!({ reason: "reload" }, ctx);
      assert.ok(!existsSync(reloadFlagPath(cwd)), "sitting flag removed by manual reload");
      await handlers.get("turn_end")!({}, ctx);
      assert.equal(reloads.count, 0, "no double reload");
      await handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("flag paths are scoped to the session cwd tmp dir", () => {
    assert.equal(reloadFlagPath("/proj"), path.join("/proj", ".pi", "tmp", "reload.flag"));
    assert.equal(reloadPendingPath("/proj"), path.join("/proj", ".pi", "tmp", "reload.pending"));
    assert.equal(reloadDonePath("/proj"), path.join("/proj", ".pi", "tmp", "reload.done"));
  });
});
