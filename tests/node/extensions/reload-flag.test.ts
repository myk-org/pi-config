/**
 * reload-flag extension tests (agent-triggered extension reload).
 *
 * Verifies the routing and the nonce protocol. pi 1.3 constraint: event ctxs
 * have NO reload() — only the extension COMMAND ctx does. So the watcher
 * dispatches the registered `/reload-flag` command via sendUserMessage, and
 * the command handler consumes the flag and reloads. Crash safety: no path
 * may ever let an exception escape (an unhandled rejection kills pi).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import reloadExtension, {
  RELOAD_COMMAND,
  runReloadFlagCommand,
  parkReloadNonce,
  reloadFlagPath,
  reloadPendingPath,
  reloadDonePath,
} from "../../../extensions/reload-flag/index.js";

type Handler = (event: any, ctx: any) => Promise<void>;
type CommandHandler = (args: string, ctx: any) => Promise<void>;

interface Registered {
  handlers: Map<string, Handler>;
  commands: Map<string, CommandHandler>;
  sent: { text: string; options?: any }[];
  messages: { customType: string; content: string; details?: any; options?: any }[];
}

function register(): Registered {
  const reg: Registered = { handlers: new Map(), commands: new Map(), sent: [], messages: [] };
  const pi = {
    on: (name: string, fn: Handler) => reg.handlers.set(name, fn),
    registerCommand: (name: string, opts: { handler: CommandHandler }) => reg.commands.set(name, opts.handler),
    sendUserMessage: (text: string, options?: any) => {
      reg.sent.push({ text, options });
    },
    sendMessage: (message: any, options?: any) => {
      reg.messages.push({ ...message, options });
    },
  };
  reloadExtension(pi as any);
  return reg;
}

function makeCwd(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "reload-flag-"));
  mkdirSync(path.join(dir, ".pi", "tmp"), { recursive: true });
  return dir;
}

/** Mock ctx whose `mode` getter stays live (isLiveExtensionCtx compatible). */
function makeCtx(cwd: string, reloads: { count: number }, sessionId = "test-session") {
  return {
    cwd,
    mode: "agent",
    sessionManager: { getSessionId: () => sessionId },
    reload: async () => {
      reloads.count++;
    },
  };
}

describe("reload-flag", () => {
  test("registers the /reload-flag command and dispatches it when the flag appears", async () => {
    const reg = register();
    assert.ok(reg.commands.has("reload-flag"), "command registered");
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads);
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      assert.equal(reg.sent.length, 0, "no dispatch without a flag");
      writeFileSync(reloadFlagPath(cwd), "nonce-1");
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.deepEqual(
        reg.sent.map((s) => s.text),
        [RELOAD_COMMAND],
        "watcher dispatches the command",
      );
      assert.equal(reg.sent[0].options?.expandPromptTemplates, true);
      assert.equal(reg.sent[0].options?.deliverAs, "followUp", "disposition contract");
      // Double turn_end must not dispatch twice
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.equal(reg.sent.length, 1);
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("mid-write race: an EMPTY flag does not dispatch — wait for the nonce (Qodo PR #950 R7)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads);
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      // Requester created the flag but has not written the nonce yet
      writeFileSync(reloadFlagPath(cwd), "");
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.equal(reg.sent.length, 0, "no dispatch on an empty flag (no nonce to verify)");
      // Nonce lands — the next tick dispatches
      writeFileSync(reloadFlagPath(cwd), "nonce-race");
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.equal(reg.sent.length, 1, "dispatches once the nonce is readable");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("the command handler parks the nonce and consumes the flag", async () => {
    const cwd = makeCwd();
    try {
      writeFileSync(reloadFlagPath(cwd), "nonce-2");
      await runReloadFlagCommand(makeCtx(cwd, { count: 0 }));
      assert.ok(!existsSync(reloadFlagPath(cwd)), "flag consumed");
      const parked = JSON.parse(readFileSync(reloadPendingPath(cwd), "utf-8"));
      assert.equal(parked.nonce, "nonce-2", "nonce parked in pending");
      assert.equal(typeof parked.owner, "string", "pending carries the owner identity");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("the command handler waits for idle BEFORE reloading (pi refuses mid-stream)", async () => {
    const cwd = makeCwd();
    try {
      const order: string[] = [];
      writeFileSync(reloadFlagPath(cwd), "nonce-idle");
      const ctx = {
        ...makeCtx(cwd, { count: 0 }),
        waitForIdle: async () => {
          order.push("waited");
        },
        reload: async () => {
          order.push("reloaded");
        },
      };
      await runReloadFlagCommand(ctx);
      assert.deepEqual(order, ["waited", "reloaded"], "idle wait strictly precedes the reload call");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("the command handler reloads exactly once", async () => {
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      writeFileSync(reloadFlagPath(cwd), "nonce-2");
      const ctx = {
        ...makeCtx(cwd, reloads),
        waitForIdle: async () => {},
      };
      await runReloadFlagCommand(ctx);
      assert.equal(reloads.count, 1, "ctx.reload called exactly once");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("the command handler NEVER throws, even without a reload action (crash safety)", async () => {
    const cwd = makeCwd();
    try {
      writeFileSync(reloadFlagPath(cwd), "nonce-3");
      // ctx lacking reload() entirely — the pi-1.3 crash scenario
      await runReloadFlagCommand({ cwd });
      assert.ok(!existsSync(reloadFlagPath(cwd)), "flag still consumed");
      assert.equal(JSON.parse(readFileSync(reloadPendingPath(cwd), "utf-8")).nonce, "nonce-3");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("new runtime completes the handshake: pending nonce → done marker + continuation turn", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      writeFileSync(reloadPendingPath(cwd), "nonce-4");
      await reg.handlers.get("session_start")!({ reason: "reload" }, makeCtx(cwd, reloads));
      assert.ok(!existsSync(reloadPendingPath(cwd)), "pending consumed");
      assert.equal(readFileSync(reloadDonePath(cwd), "utf-8"), "nonce-4", "done carries the nonce");
      // Continuation message wakes the agent (seamless flow, no human)
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(reg.messages.length, 1, "continuation message sent");
      assert.equal(reg.messages[0].customType, "reload-flag-done");
      assert.equal(reg.messages[0].options?.triggerTurn, true, "continuation triggers a turn");
      assert.match(reg.messages[0].content, /nonce-4/);
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("an EMPTY pending file is garbage: session_start removes it and sends no continuation (R8 reload-loop fix)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      writeFileSync(reloadPendingPath(cwd), ""); // truncated/empty pending
      await reg.handlers.get("session_start")!({ reason: "reload" }, makeCtx(cwd, reloads));
      assert.ok(!existsSync(reloadPendingPath(cwd)), "garbage pending removed");
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(reg.messages.length, 0, "no continuation for a nonce-less pending");
      // And the watcher must not re-dispatch on the removed garbage either
      await reg.handlers.get("turn_end")!({}, makeCtx(cwd, reloads));
      assert.equal(reg.sent.length, 0, "no reload dispatch — loop closed");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("an EMPTY pending file does not dispatch from turn_end either (R8 reload-loop fix)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads);
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      writeFileSync(reloadPendingPath(cwd), "   "); // whitespace-only nonce
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.equal(reg.sent.length, 0, "garbage pending never dispatches");
      assert.ok(!existsSync(reloadPendingPath(cwd)), "garbage pending removed by the watcher");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("session_shutdown cancels a pending continuation message (R8: no turn injected into a closed session)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      writeFileSync(reloadPendingPath(cwd), "nonce-cancel");
      await reg.handlers.get("session_start")!({ reason: "reload" }, makeCtx(cwd, reloads));
      assert.equal(readFileSync(reloadDonePath(cwd), "utf-8"), "nonce-cancel", "done already published");
      // Session closes INSIDE the 250ms deferral window
      await reg.handlers.get("session_shutdown")!({}, undefined);
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(reg.messages.length, 0, "continuation cancelled — never fired into the closed session");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a pending handshake owned by ANOTHER LIVE session is never stolen (Qodo PR #950 R9)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctxB = makeCtx(cwd, reloads, "session-B");
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctxB);
      // Session A (pid 1 = always alive, different session) parked a handshake
      writeFileSync(
        reloadPendingPath(cwd),
        JSON.stringify({ nonce: "nonce-A", owner: "1:session-A" }),
      );
      // B's watcher must NOT dispatch a reload for A's handshake
      await reg.handlers.get("turn_end")!({}, ctxB);
      assert.equal(reg.sent.length, 0, "foreign live pending never dispatches");
      // B's manual reload must NOT consume it or send the continuation
      await reg.handlers.get("session_start")!({ reason: "reload" }, ctxB);
      await new Promise((r) => setTimeout(r, 350));
      assert.equal(reg.messages.length, 0, "no continuation stolen");
      assert.equal(JSON.parse(readFileSync(reloadPendingPath(cwd), "utf-8")).nonce, "nonce-A", "pending left for its owner");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a pending handshake whose owner process is DEAD is recoverable (stranded)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads, "session-B");
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      // Owner pid 999999 does not exist — the handshake is stranded
      writeFileSync(
        reloadPendingPath(cwd),
        JSON.stringify({ nonce: "nonce-dead", owner: "999999:session-A" }),
      );
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.equal(reg.sent.length, 1, "dead-owner pending re-dispatches (stranded handshake recovery)");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("our OWN pending handshake still re-dispatches (same pid + session)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads, "session-A");
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      writeFileSync(
        reloadPendingPath(cwd),
        JSON.stringify({ nonce: "nonce-self", owner: `${process.pid}:session-A` }),
      );
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.equal(reg.sent.length, 1, "own pending re-dispatches (idempotent command)");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("manual /reload (no pending) publishes NO continuation message", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      await reg.handlers.get("session_start")!({ reason: "reload" }, makeCtx(cwd, reloads));
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(reg.messages.length, 0, "manual reload stays silent");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("manual /reload satisfies a sitting flag — no second reload", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads);
      writeFileSync(reloadFlagPath(cwd), "nonce-stale");
      // User reloaded manually BEFORE the watcher consumed the flag
      await reg.handlers.get("session_start")!({ reason: "reload" }, ctx);
      assert.ok(!existsSync(reloadFlagPath(cwd)), "sitting flag removed by manual reload");
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.equal(reg.sent.length, 0, "no double reload");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("fresh session start clears stale flag/pending/done without dispatching", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      writeFileSync(reloadFlagPath(cwd), "old");
      writeFileSync(reloadPendingPath(cwd), "older");
      writeFileSync(reloadDonePath(cwd), "oldest");
      await reg.handlers.get("session_start")!({ reason: "startup" }, makeCtx(cwd, reloads));
      assert.ok(!existsSync(reloadFlagPath(cwd)));
      assert.ok(!existsSync(reloadPendingPath(cwd)));
      assert.ok(!existsSync(reloadDonePath(cwd)));
      await reg.handlers.get("turn_end")!({}, makeCtx(cwd, reloads));
      assert.equal(reg.sent.length, 0);
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("parkReloadNonce is a no-op without a flag", () => {
    const cwd = makeCwd();
    try {
      assert.equal(parkReloadNonce(cwd), null);
      assert.ok(!existsSync(reloadPendingPath(cwd)));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a stranded handshake (pending without done) re-dispatches on the next turn", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads);
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      // Simulate a refused reload from an older runtime: nonce parked, no done
      writeFileSync(reloadPendingPath(cwd), "nonce-stranded");
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.deepEqual(
        reg.sent.map((s) => s.text),
        [RELOAD_COMMAND],
        "stranded pending re-dispatches the command (self-heal)",
      );
      await reg.handlers.get("session_shutdown")!({}, undefined);
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
