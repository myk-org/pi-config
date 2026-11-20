/**
 * reload-flag extension tests (agent-triggered extension reload).
 *
 * Verifies the routing and the nonce protocol. pi 1.3 constraint: event ctxs
 * have NO reload() — only the extension COMMAND ctx does. So the watcher
 * dispatches the registered `/reload-flag` command via sendUserMessage, and
 * the command handler consumes the flag and reloads. Crash safety: no path
 * may ever let an exception escape (an unhandled rejection kills pi).
 */

import { test, describe, afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync } from "node:fs";

import path from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as reloadFlagModule from "../../../extensions/reload-flag/index.js";
import reloadExtension, {
  shouldSkipReloadFlag,
  isHandshakeParticipant,
  RELOAD_COMMAND,
  runReloadFlagCommand,
  parkReloadNonce,
  pendingOwnerIsClaimable,
  reconcileStartupHandshake,
  reloadFlagPath,
  reloadPendingPath,
  reloadDonePath,
} from "../../../extensions/reload-flag/index.js";
import { clearLogLevelCache } from "../../../extensions/shared/file-logger.js";
import { makeTempDir } from "../helpers/temp-dirs.js";


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
  const dir = makeTempDir("reload-flag-");
  mkdirSync(path.join(dir, ".pi", "run"), { recursive: true });
  // Legacy location — kept only for the pre-#1020 read-fallback tests.
  mkdirSync(path.join(dir, ".pi", "tmp"), { recursive: true });
  return dir;
}

/** Pre-#1020 control-file path (`.pi/tmp`). */
function legacyPath(cwd: string, name: string): string {
  return path.join(cwd, ".pi", "tmp", name);
}

/** Mock ctx whose `mode` getter stays live (isLiveExtensionCtx compatible). */
function makeCtx(cwd: string, reloads: { count: number }, sessionId = "test-session", mode = "agent") {
  return {
    cwd,
    mode,
    sessionManager: { getSessionId: () => sessionId },
    reload: async () => {
      reloads.count++;
    },
  };
}

const TEN_MINUTES_MS = 10 * 60_000;

/** Age a control file well past five minutes to verify age never deletes state. */
function backdate(file: string, ageMs = TEN_MINUTES_MS): void {
  const when = new Date(Date.now() - ageMs);
  utimesSync(file, when, when);
}

/** Capture file-logger writes without touching ~/.pi/logs or calling loggers in tests. */
function captureLogs(t: any): string[] {
  const records: string[] = [];
  const prevSid = (globalThis as any).__piConfigSessionId;
  (globalThis as any).__piConfigSessionId = prevSid || "reload-flag-test";
  const mkdir = fs.mkdirSync;
  t.mock.method(fs, "mkdirSync", (target: fs.PathLike, ...args: any[]) => {
    if (String(target).includes(`${path.sep}.pi${path.sep}logs${path.sep}`)) return undefined;
    return (mkdir as any)(target, ...args);
  });
  t.mock.method(fs, "appendFileSync", (_target: fs.PathOrFileDescriptor, data: any) => {
    const line = String(data);
    if (line.includes("[reload-flag]")) records.push(line);
  });
  syncBuiltinESMExports();
  t.after(() => {
    if (prevSid === undefined) delete (globalThis as any).__piConfigSessionId;
    else (globalThis as any).__piConfigSessionId = prevSid;
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return records;
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
      writeFileSync(reloadPendingPath(cwd), JSON.stringify({ nonce: "nonce-4", owner: `${process.pid}:test-session` }));
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

  test("reload session_start removes an empty pending file without false confirmation", async (t) => {
    const records = captureLogs(t);
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const pendingFile = reloadPendingPath(cwd);
      writeFileSync(pendingFile, ""); // truncated/empty pending
      await reg.handlers.get("session_start")!({ reason: "reload" }, makeCtx(cwd, reloads));
      assert.ok(!existsSync(pendingFile), "corrupt empty pending removed");
      assert.ok(records.some((line) => line.includes("reload_pending_corrupt") && line.includes(pendingFile)));
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(reg.messages.length, 0, "no continuation for a nonce-less pending");
      await reg.handlers.get("turn_end")!({}, makeCtx(cwd, reloads));
      assert.equal(reg.sent.length, 0, "no reload dispatch — loop closed");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("turn_end removes whitespace-only pending without dispatching", async (t) => {
    const records = captureLogs(t);
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads);
      const pendingFile = reloadPendingPath(cwd);
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      writeFileSync(pendingFile, "   "); // whitespace-only nonce
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.equal(reg.sent.length, 0, "garbage pending never dispatches");
      assert.ok(!existsSync(pendingFile), "watcher removes corrupt pending");
      assert.ok(records.some((line) => line.includes("reload_pending_corrupt") && line.includes(pendingFile)));
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("empty pending file is removed as corrupt so a deploy flag dispatches", async (t) => {
    const records = captureLogs(t);
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads);
      const pendingFile = reloadPendingPath(cwd);
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      writeFileSync(pendingFile, "");
      writeFileSync(reloadFlagPath(cwd), "nonce-unwedged");
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.ok(records.some((line) => line.includes("reload_pending_corrupt") && line.includes(pendingFile)));
      assert.equal(reg.sent.length, 1, "deploy flag dispatches instead of wedging");
      await reg.commands.get("reload-flag")!("", ctx);
      assert.equal(reloads.count, 1);
      assert.equal(JSON.parse(readFileSync(pendingFile, "utf-8")).nonce, "nonce-unwedged");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("syntactically invalid pending owner is removed as corrupt before flag dispatch", async (t) => {
    const records = captureLogs(t);
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads);
      const pendingFile = reloadPendingPath(cwd);
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      for (const bad of ["{truncated", "plain-nonce", JSON.stringify({ nonce: "n", owner: "" }), JSON.stringify({ nonce: "n", owner: "bad-owner" })]) {
        writeFileSync(pendingFile, bad);
        await reg.handlers.get("turn_end")!({}, ctx);
        assert.ok(!existsSync(pendingFile), `corrupt pending removed: ${bad}`);
        assert.equal(reg.sent.length, 0, "corrupt pending alone never dispatches");
      }
      writeFileSync(pendingFile, JSON.stringify({ nonce: "n", owner: "not-a-pid:sess" }));
      writeFileSync(reloadFlagPath(cwd), "nonce-valid-after-corrupt");
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.equal(reg.sent.length, 1);
      await reg.commands.get("reload-flag")!("", ctx);
      assert.equal(reloads.count, 1);
      assert.equal(JSON.parse(readFileSync(pendingFile, "utf-8")).nonce, "nonce-valid-after-corrupt");
      assert.ok(records.some((line) => line.includes("reload_pending_corrupt") && line.includes(pendingFile)));
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("corrupt pending cleanup preserves a valid pending published concurrently", async (t) => {
    const cwd = makeCwd();
    const reg = register();
    const pendingFile = reloadPendingPath(cwd);
    const valid = JSON.stringify({ nonce: "concurrent-valid", owner: "1:foreign" });
    try {
      const ctx = makeCtx(cwd, { count: 0 });
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      writeFileSync(pendingFile, "");
      const rename = fs.renameSync;
      let injected = false;
      t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
        if (String(from) === pendingFile && !injected) {
          injected = true;
          writeFileSync(pendingFile, valid);
        }
        return rename(from, to);
      });
      syncBuiltinESMExports();
      await reg.handlers.get("turn_end")!({}, ctx);
      t.mock.restoreAll();
      syncBuiltinESMExports();
      assert.equal(injected, true);
      assert.equal(readFileSync(pendingFile, "utf-8"), valid);
      assert.equal(reg.sent.length, 0);
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("session_shutdown cancels a pending continuation message (R8: no turn injected into a closed session)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      writeFileSync(reloadPendingPath(cwd), JSON.stringify({ nonce: "nonce-cancel", owner: `${process.pid}:test-session` }));
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

  test("manual /reload leaves an unproven sitting flag for an extra reload", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads);
      writeFileSync(reloadFlagPath(cwd), "nonce-stale");
      // User reloaded manually BEFORE the watcher consumed the flag
      await reg.handlers.get("session_start")!({ reason: "reload" }, ctx);
      assert.equal(readFileSync(reloadFlagPath(cwd), "utf-8"), "nonce-stale");
      assert.equal(existsSync(reloadDonePath(cwd)), false, "no preload proof, no confirmation");
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.equal(reg.sent.length, 1, "conservative extra reload");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("fresh session preserves stale requests for a proven reload", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      writeFileSync(reloadFlagPath(cwd), "old");
      writeFileSync(reloadPendingPath(cwd), JSON.stringify({ nonce: "older", owner: "999999:dead" }));
      writeFileSync(reloadDonePath(cwd), "oldest");
      for (const file of [reloadFlagPath(cwd), reloadPendingPath(cwd), reloadDonePath(cwd)]) backdate(file);
      await reg.handlers.get("session_start")!({ reason: "startup" }, makeCtx(cwd, reloads));
      assert.ok(existsSync(reloadFlagPath(cwd)));
      assert.ok(existsSync(reloadPendingPath(cwd)));
      assert.equal(readFileSync(reloadDonePath(cwd), "utf-8"), "oldest");
      await reg.handlers.get("turn_end")!({}, makeCtx(cwd, reloads));
      assert.equal(reg.sent.length, 1);
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("fresh session start preserves recent handshake files", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads, "session-B");
      writeFileSync(reloadFlagPath(cwd), "deploy-in-flight");
      writeFileSync(reloadPendingPath(cwd), JSON.stringify({ nonce: "p", owner: "999999:dead" }));
      writeFileSync(reloadDonePath(cwd), "recent-done");
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      assert.equal(readFileSync(reloadFlagPath(cwd), "utf-8"), "deploy-in-flight", "a just-written flag survives");
      assert.ok(existsSync(reloadPendingPath(cwd)), "a just-parked pending survives");
      assert.equal(readFileSync(reloadDonePath(cwd), "utf-8"), "recent-done", "done completion proof survives");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("fresh session preserves old reload.done completion proof beyond five minutes", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads, "session-B");
      writeFileSync(reloadDonePath(cwd), "long-turn-proof");
      writeFileSync(legacyPath(cwd, "reload.done"), "long-turn-proof");
      backdate(reloadDonePath(cwd));
      backdate(legacyPath(cwd, "reload.done"));
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      assert.equal(readFileSync(reloadDonePath(cwd), "utf-8"), "long-turn-proof");
      assert.equal(readFileSync(legacyPath(cwd, "reload.done"), "utf-8"), "long-turn-proof");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a fresh session never deletes another session's pending, not even when old (#1091)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      writeFileSync(
        reloadPendingPath(cwd),
        JSON.stringify({ nonce: "nonce-A", owner: "1:session-A" }), // pid 1 = alive
      );
      backdate(reloadPendingPath(cwd));
      const ctxB = makeCtx(cwd, reloads, "session-B");
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctxB);
      assert.equal(JSON.parse(readFileSync(reloadPendingPath(cwd), "utf-8")).nonce, "nonce-A", "foreign pending kept");
      await reg.handlers.get("turn_end")!({}, ctxB);
      assert.equal(reg.sent.length, 0, "and B never dispatches for it");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a print/json child session never deletes the handshake (#1091)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      writeFileSync(reloadFlagPath(cwd), "deploy-B");
      writeFileSync(reloadPendingPath(cwd), JSON.stringify({ nonce: "nonce-1", owner: "1:session-A" }));
      writeFileSync(reloadDonePath(cwd), "deploy-A");
      for (const mode of ["json", "print", "rpc"]) {
        const ctx = makeCtx(cwd, { count: 0 }, "child", mode);
        await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
        await reg.handlers.get("turn_end")!({}, ctx);
      }
      assert.equal(readFileSync(reloadFlagPath(cwd), "utf-8"), "deploy-B", "flag untouched");
      assert.ok(existsSync(reloadPendingPath(cwd)), "pending untouched");
      assert.equal(readFileSync(reloadDonePath(cwd), "utf-8"), "deploy-A", "done untouched");
      assert.equal(reg.sent.length, 0, "a child never dispatches the reload command");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a flag written during an in-flight reload still reloads — done ends with the NEWER nonce (#1091)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads, "session-A");
      const command = reg.commands.get("reload-flag")!;
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      // Deploy A: watcher dispatches, the command parks A's nonce and reloads.
      writeFileSync(reloadFlagPath(cwd), "deploy-A");
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.deepEqual(reg.sent.map((s) => s.text), [RELOAD_COMMAND]);
      await command("", ctx);
      assert.equal(reloads.count, 1, "first reload fired");
      assert.equal(JSON.parse(readFileSync(reloadPendingPath(cwd), "utf-8")).nonce, "deploy-A");
      // Deploy B lands while A's reload is in flight...
      writeFileSync(reloadFlagPath(cwd), "deploy-B");
      // ...and a oneshot child starts in the same checkout in between.
      const child = register();
      await child.handlers.get("session_start")!(
        { reason: "startup" },
        makeCtx(cwd, { count: 0 }, "child", "json"),
      );
      assert.equal(readFileSync(reloadFlagPath(cwd), "utf-8"), "deploy-B", "the child deleted nothing");
      // A's new runtime publishes the nonce it actually loaded, leaves B's flag.
      await reg.handlers.get("session_start")!({ reason: "reload" }, ctx);
      assert.equal(readFileSync(reloadDonePath(cwd), "utf-8"), "deploy-A", "done = the nonce just loaded");
      assert.equal(readFileSync(reloadFlagPath(cwd), "utf-8"), "deploy-B", "newer request left for the watcher");
      // The watcher dispatches it → second reload → done converges on B.
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.equal(reg.sent.length, 2, "second dispatch, not a swallowed request");
      await command("", ctx);
      assert.equal(reloads.count, 2, "second reload fired");
      await reg.handlers.get("session_start")!({ reason: "reload" }, ctx);
      assert.equal(readFileSync(reloadDonePath(cwd), "utf-8"), "deploy-B", "done ends with the NEWER nonce");
      assert.ok(!existsSync(reloadFlagPath(cwd)), "no request left behind");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("legacy done mirror write errors warn without leaving pending behind", async (t) => {
    const records = captureLogs(t);
    const cwd = makeCwd();
    const reg = register();
    try {
      const ctx = makeCtx(cwd, { count: 0 });
      for (const code of ["EACCES", "EROFS"]) {
        writeFileSync(reloadPendingPath(cwd), JSON.stringify({ nonce: `nonce-${code}`, owner: `${process.pid}:test-session` }));
        const origWrite = fs.writeFileSync;
        t.mock.method(fs, "writeFileSync", (target: fs.PathOrFileDescriptor, data: any, ...args: any[]) => {
          if (String(target).startsWith(path.join(cwd, ".pi", "tmp"))) {
            throw Object.assign(new Error(`legacy ${code}`), { code });
          }
          return (origWrite as any)(target, data, ...args);
        });
        syncBuiltinESMExports();
        await reg.handlers.get("session_start")!({ reason: "reload" }, ctx);
        assert.equal(readFileSync(reloadDonePath(cwd), "utf-8"), `nonce-${code}`);
        assert.equal(existsSync(reloadPendingPath(cwd)), false);
        assert.equal(fs.readdirSync(path.dirname(reloadPendingPath(cwd))).some((n) => n.endsWith(".claim")), false);
        assert.ok(records.some((line) => line.includes("[warn]") && line.includes("reload_legacy_mirror_failed") && line.includes(`"code":"${code}"`)));
        await reg.handlers.get("turn_end")!({}, ctx);
        assert.equal(reg.sent.length, 0, `no endless reload loop for ${code}`);
      }
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a command waiting for idle cannot reload a replaced session", async () => {
    const cwd = makeCwd();
    let active = true;
    const reloads = { count: 0 };
    const ctx = {
      ...makeCtx(cwd, reloads),
      get mode() { if (!active) throw new Error("stale"); return "tui"; },
      waitForIdle: async () => { active = false; },
    };
    writeFileSync(reloadFlagPath(cwd), "departing");
    await runReloadFlagCommand(ctx);
    assert.equal(reloads.count, 0);
  });

  for (const reason of ["reload", "new", "resume", "fork", "quit"]) {
    test(`${reason} shutdown preserves a foreign pending owner`, async () => {
      const cwd = makeCwd();
      const reg = register();
      const ctx = makeCtx(cwd, { count: 0 });
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      const foreign = JSON.stringify({ nonce: "foreign", owner: "1:busy" });
      writeFileSync(reloadPendingPath(cwd), foreign);
      await reg.handlers.get("session_shutdown")!({ reason }, ctx);
      assert.equal(readFileSync(reloadPendingPath(cwd), "utf8"), foreign);
    });
  }

  test("stale current flag cleanup preserves a fresh legacy request", async (t) => {
    const cwd = makeCwd();
    const reg = register();
    t.after(() => reg.handlers.get("session_shutdown")!({}, undefined));
    writeFileSync(reloadFlagPath(cwd), "old");
    backdate(reloadFlagPath(cwd));
    writeFileSync(legacyPath(cwd, "reload.flag"), "fresh");
    await reg.handlers.get("session_start")!({ reason: "startup" }, makeCtx(cwd, { count: 0 }));
    assert.equal(readFileSync(legacyPath(cwd, "reload.flag"), "utf8"), "fresh");
  });

  test("inaccessible legacy directory does not break completion cleanup", async (t) => {
    const records = captureLogs(t);
    const cwd = makeCwd();
    const reg = register();
    const legacyDir = path.join(cwd, ".pi", "tmp");
    try {
      const ctx = makeCtx(cwd, { count: 0 });
      writeFileSync(reloadPendingPath(cwd), JSON.stringify({ nonce: "chmod-zero", owner: `${process.pid}:test-session` }));
      fs.chmodSync(legacyDir, 0o000);
      await reg.handlers.get("session_start")!({ reason: "reload" }, ctx);
      fs.chmodSync(legacyDir, 0o700);
      assert.equal(readFileSync(reloadDonePath(cwd), "utf-8"), "chmod-zero");
      assert.equal(existsSync(reloadPendingPath(cwd)), false);
      assert.ok(records.some((line) => line.includes("reload_legacy_mirror_failed")));
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.equal(reg.sent.length, 0);
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      try { fs.chmodSync(legacyDir, 0o700); } catch {}
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("old flags waiting for a live foreign owner survive cleanup", async (t) => {
    const cwd = makeCwd();
    const reg = register();
    t.after(() => reg.handlers.get("session_shutdown")!({}, undefined));
    writeFileSync(reloadPendingPath(cwd), JSON.stringify({ nonce: "owner", owner: "1:busy" }));
    writeFileSync(reloadFlagPath(cwd), "queued");
    backdate(reloadFlagPath(cwd));
    await reg.handlers.get("session_start")!({ reason: "startup" }, makeCtx(cwd, { count: 0 }));
    assert.equal(readFileSync(reloadFlagPath(cwd), "utf8"), "queued");
  });

  test("owner retries a failed reload after the backoff window", async (t) => {
    const cwd = makeCwd();
    const reg = register();
    let now = 50_000;
    t.mock.method(Date, "now", () => now);
    t.after(async () => {
      t.mock.restoreAll();
      await reg.handlers.get("session_shutdown")!({}, undefined);
      rmSync(cwd, { recursive: true, force: true });
    });
    const ctx = { ...makeCtx(cwd, { count: 0 }), reload: async () => { throw new Error("refused"); } };
    await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
    writeFileSync(reloadFlagPath(cwd), "retry");
    await reg.handlers.get("turn_end")!({}, ctx);
    assert.equal(reg.sent.length, 1);
    await reg.commands.get("reload-flag")!("", ctx);
    now += 500;
    await reg.handlers.get("turn_end")!({}, ctx);
    assert.equal(reg.sent.length, 1, "skipped while inside backoff window");
    now += 500;
    await reg.handlers.get("turn_end")!({}, ctx);
    assert.equal(reg.sent.length, 2, "retried once backoff elapsed");
    assert.equal(JSON.parse(readFileSync(reloadPendingPath(cwd), "utf8")).nonce, "retry");
  });

  test("persistent reload failures double backoff up to thirty seconds without spin logging", async (t) => {
    const records = captureLogs(t);
    const cwd = makeCwd();
    const reg = register();
    let now = 100_000;
    t.mock.method(Date, "now", () => now);
    try {
      const ctx = { ...makeCtx(cwd, { count: 0 }), reload: async () => { throw new Error("persistent-fail"); } };
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      writeFileSync(reloadFlagPath(cwd), "backoff-seq");
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.equal(reg.sent.length, 1);
      await reg.commands.get("reload-flag")!("", ctx);

      const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
      let expectedSent = 1;
      for (const delay of expectedDelays) {
        const logCountBeforeSkip = records.length;
        for (let step = 500; step < delay; step += 500) {
          now += 500;
          await reg.handlers.get("turn_end")!({}, ctx);
          assert.equal(reg.sent.length, expectedSent, `no dispatch at +${step}ms of ${delay}ms backoff`);
        }
        assert.equal(records.length, logCountBeforeSkip, `no spin logging during ${delay}ms backoff`);
        now += 500;
        await reg.handlers.get("turn_end")!({}, ctx);
        expectedSent++;
        assert.equal(reg.sent.length, expectedSent, `dispatches once ${delay}ms backoff expires`);
        await reg.commands.get("reload-flag")!("", ctx);
      }
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("new flag nonce resets retry backoff immediately", async (t) => {
    const cwd = makeCwd();
    const reg = register();
    let now = 200_000;
    t.mock.method(Date, "now", () => now);
    t.after(async () => {
      t.mock.restoreAll();
      await reg.handlers.get("session_shutdown")!({}, undefined);
      rmSync(cwd, { recursive: true, force: true });
    });
    const ctx = { ...makeCtx(cwd, { count: 0 }), reload: async () => { throw new Error("refused"); } };
    await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
    writeFileSync(reloadFlagPath(cwd), "nonce-first");
    await reg.handlers.get("turn_end")!({}, ctx);
    await reg.commands.get("reload-flag")!("", ctx);
    now += 1_000;
    await reg.handlers.get("turn_end")!({}, ctx);
    await reg.commands.get("reload-flag")!("", ctx);
    // Now backoff is 2_000ms; at +100ms a new flag nonce arrives.
    now += 100;
    await reg.handlers.get("turn_end")!({}, ctx);
    assert.equal(reg.sent.length, 2, "still backed off before new flag");
    writeFileSync(reloadFlagPath(cwd), "nonce-second");
    await reg.handlers.get("turn_end")!({}, ctx);
    assert.equal(reg.sent.length, 3, "new flag nonce dispatches immediately");
    await reg.commands.get("reload-flag")!("", ctx);
    // And backoff delay was reset back to 1_000ms (not 4_000ms).
    now += 500;
    await reg.handlers.get("turn_end")!({}, ctx);
    assert.equal(reg.sent.length, 3);
    now += 500;
    await reg.handlers.get("turn_end")!({}, ctx);
    assert.equal(reg.sent.length, 4, "reset backoff retries after initial 1_000ms");
  });

  test("unreadable retained claim backs off instead of retrying every tick", async (t) => {
    const cwd = makeCwd();
    const reg = register();
    let now = 300_000;
    t.mock.method(Date, "now", () => now);
    const claimFile = path.join(cwd, ".pi", "run", "reload.flag.stuck.claim");
    writeFileSync(claimFile, "stuck-nonce");
    const origRead = fs.readFileSync;
    t.mock.method(fs, "readFileSync", (target: any, ...args: any[]) => {
      if (String(target) === claimFile) {
        throw Object.assign(new Error("claim denied"), { code: "EACCES" });
      }
      return (origRead as any)(target, ...args);
    });
    syncBuiltinESMExports();
    t.after(async () => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await reg.handlers.get("session_shutdown")!({}, undefined);
      rmSync(cwd, { recursive: true, force: true });
    });
    const ctx = makeCtx(cwd, { count: 0 });
    await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
    await reg.handlers.get("turn_end")!({}, ctx);
    assert.equal(reg.sent.length, 1);
    await reg.commands.get("reload-flag")!("", ctx);
    now += 500;
    await reg.handlers.get("turn_end")!({}, ctx);
    assert.equal(reg.sent.length, 1, "unreadable claim skips retry inside backoff window");
    now += 500;
    await reg.handlers.get("turn_end")!({}, ctx);
    assert.equal(reg.sent.length, 2, "unreadable claim retries once backoff expires");
  });

  test("session replacement releases only its owner's pending record", async (t) => {
    const cwd = makeCwd();
    const reg = register();
    t.after(() => reg.handlers.get("session_shutdown")!({}, undefined));
    const ctx = makeCtx(cwd, { count: 0 });
    await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
    writeFileSync(reloadFlagPath(cwd), "departing");
    parkReloadNonce(cwd, `${process.pid}:test-session`);
    await reg.handlers.get("session_shutdown")!({ reason: "new" }, ctx);
    assert.equal(existsSync(reloadPendingPath(cwd)), false);
    assert.equal(fs.readdirSync(path.dirname(reloadPendingPath(cwd))).some(name => name.includes(".release-")), true);
    const next = makeCtx(cwd, { count: 0 }, "replacement");
    await reg.handlers.get("session_start")!({ reason: "reload" }, next);
    assert.equal(existsSync(reloadDonePath(cwd)), false);
    await runReloadFlagCommand(next);
    await reg.handlers.get("session_start")!({ reason: "reload" }, next);
    assert.equal(readFileSync(reloadDonePath(cwd), "utf8"), "departing");
  });

  test("consuming a request preserves a replacement published after its claim", (t) => {
    const cwd = makeCwd();
    writeFileSync(reloadFlagPath(cwd), "first");
    writeFileSync(legacyPath(cwd, "reload.flag"), "legacy");
    const rename = fs.renameSync;
    t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      rename(from, to);
      if (String(from) === reloadFlagPath(cwd)) writeFileSync(reloadFlagPath(cwd), "newer");
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    assert.equal(parkReloadNonce(cwd, `${process.pid}:test-session`), "first");
    assert.equal(readFileSync(reloadFlagPath(cwd), "utf8"), "newer");
    assert.equal(readFileSync(legacyPath(cwd, "reload.flag"), "utf8"), "legacy");
  });

  test("unreadable claim retries before a newer publication", async (t) => {
    const cwd = makeCwd();
    const owner = `${process.pid}:test-session`;
    writeFileSync(reloadFlagPath(cwd), "retained");
    const read = fs.readFileSync;
    let failed = false;
    t.mock.method(fs, "readFileSync", (file: any, ...args: any[]) => {
      if (String(file).endsWith(".claim") && !failed) {
        failed = true;
        throw Object.assign(new Error("injected read failure"), { code: "EACCES" });
      }
      return (read as any)(file, ...args);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    assert.equal(parkReloadNonce(cwd, owner), null);
    writeFileSync(reloadFlagPath(cwd), "newer");
    assert.equal(parkReloadNonce(cwd, owner), "retained");
    assert.equal(JSON.parse(readFileSync(reloadPendingPath(cwd), "utf8")).nonce, "retained");
    rmSync(reloadPendingPath(cwd));
    assert.equal(parkReloadNonce(cwd, owner), "newer");
  });

  test("completion preserves pending published after its claim", async (t) => {
    const cwd = makeCwd();
    const reg = register();
    const ctx = makeCtx(cwd, { count: 0 });
    const file = reloadPendingPath(cwd);
    writeFileSync(file, JSON.stringify({ nonce: "loaded", owner: `${process.pid}:test-session` }));
    const rename = fs.renameSync;
    let injected = false;
    t.mock.method(fs, "renameSync", (from: any, to: any) => {
      rename(from, to);
      if (String(from) === file && !injected) {
        injected = true;
        writeFileSync(file, JSON.stringify({ nonce: "newer", owner: "1:foreign" }));
      }
    });
    syncBuiltinESMExports();
    t.after(async () => {
      t.mock.restoreAll(); syncBuiltinESMExports();
      await reg.handlers.get("session_shutdown")!({}, undefined);
    });
    await reg.handlers.get("session_start")!({ reason: "reload" }, ctx);
    assert.equal(readFileSync(reloadDonePath(cwd), "utf8"), "loaded");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).nonce, "newer");
  });

  test("completion write failure retries through the watcher", async (t) => {
    const cwd = makeCwd();
    const reg = register();
    const ctx = makeCtx(cwd, { count: 0 });
    writeFileSync(reloadPendingPath(cwd), JSON.stringify({ nonce: "retry-done", owner: `${process.pid}:test-session` }));
    const rename = fs.renameSync;
    let failed = false;
    t.mock.method(fs, "renameSync", (from: any, to: any) => {
      if (String(to) === reloadDonePath(cwd) && !failed) {
        failed = true; throw new Error("injected done failure");
      }
      rename(from, to);
    });
    syncBuiltinESMExports();
    t.after(async () => {
      t.mock.restoreAll(); syncBuiltinESMExports();
      await reg.handlers.get("session_shutdown")!({}, undefined);
    });
    await reg.handlers.get("session_start")!({ reason: "reload" }, ctx);
    assert.equal(existsSync(reloadDonePath(cwd)), false);
    await reg.handlers.get("turn_end")!({}, ctx);
    assert.equal(reg.sent.length, 1);
    await reg.commands.get("reload-flag")!("", ctx);
    await reg.handlers.get("session_start")!({ reason: "reload" }, ctx);
    assert.equal(readFileSync(reloadDonePath(cwd), "utf8"), "retry-done");
  });

  test("current pending cannot hide a live legacy owner from the command", async () => {
    const cwd = makeCwd();
    writeFileSync(reloadPendingPath(cwd), JSON.stringify({ nonce: "ours", owner: `${process.pid}:test-session` }));
    writeFileSync(legacyPath(cwd, "reload.pending"), JSON.stringify({ nonce: "foreign", owner: "1:foreign" }));
    const reloads = { count: 0 };
    assert.equal(await runReloadFlagCommand(makeCtx(cwd, reloads)), false);
    assert.equal(reloads.count, 0);
  });

  test("foreign pending claims block newer flags until their owner releases", async (t) => {
    const cwd = makeCwd();
    const reg = register();
    const ctx = makeCtx(cwd, { count: 0 });
    t.after(() => reg.handlers.get("session_shutdown")!({}, undefined));
    const claimed = path.join(cwd, ".pi", "run", "reload.pending.collision.claim");
    writeFileSync(claimed, JSON.stringify({ nonce: "foreign", owner: "1:foreign" }));
    writeFileSync(reloadFlagPath(cwd), "newer");
    await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
    await reg.handlers.get("turn_end")!({}, ctx);
    assert.equal(reg.sent.length, 0);
    assert.equal(parkReloadNonce(cwd, `${process.pid}:test-session`), null);
    assert.equal(readFileSync(reloadFlagPath(cwd), "utf8"), "newer");
    fs.renameSync(claimed, `${claimed}.release-${encodeURIComponent("1:foreign")}.claim`);
    await reg.handlers.get("turn_end")!({}, ctx);
    assert.equal(reg.sent.length, 1);
    await reg.commands.get("reload-flag")!("", ctx);
    assert.equal(JSON.parse(readFileSync(reloadPendingPath(cwd), "utf8")).nonce, "foreign");
  });

  test("pending publication failure retains the claimed request for retry", (t) => {
    const cwd = makeCwd();
    writeFileSync(reloadFlagPath(cwd), "retry-publication");
    const link = fs.linkSync;
    let failed = false;
    t.mock.method(fs, "linkSync", (from: any, to: any) => {
      if (!failed) { failed = true; throw new Error("injected pending publication failure"); }
      return link(from, to);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    assert.throws(() => parkReloadNonce(cwd, "owner"), /injected/);
    assert.equal(parkReloadNonce(cwd, "owner"), "retry-publication");
  });

  test("restore-colliding legacy claims require a proven reload", async (t) => {
    const cwd = makeCwd();
    const reg = register();
    const ctx = makeCtx(cwd, { count: 0 });
    t.after(() => reg.handlers.get("session_shutdown")!({}, undefined));
    writeFileSync(path.join(cwd, ".pi", "run", "reload.pending.old.claim"), JSON.stringify({ nonce: "recovered", owner: "999999:old" }));
    writeFileSync(reloadFlagPath(cwd), "current");
    await reg.handlers.get("session_start")!({ reason: "reload" }, ctx);
    assert.equal(existsSync(reloadDonePath(cwd)), false);
    await reg.handlers.get("turn_end")!({}, ctx);
    assert.equal(reg.sent.length, 1);
    await reg.commands.get("reload-flag")!("", ctx);
    await reg.handlers.get("session_start")!({ reason: "reload" }, ctx);
    assert.equal(readFileSync(reloadDonePath(cwd), "utf8"), "recovered");
    await reg.commands.get("reload-flag")!("", ctx);
    await reg.handlers.get("session_start")!({ reason: "reload" }, ctx);
    assert.equal(readFileSync(reloadDonePath(cwd), "utf8"), "current");
  });

  test("parkReloadNonce is a no-op without a flag", () => {
    const cwd = makeCwd();
    try {
      assert.equal(parkReloadNonce(cwd, `${process.pid}:test-session`), null);
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
      writeFileSync(reloadPendingPath(cwd), JSON.stringify({ nonce: "nonce-stranded", owner: "999999:old-runtime" }));
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

  test("flag paths live in the session cwd's .pi/run (not throwaway .pi/tmp)", () => {
    const legacyDir = path.join("/proj", ".pi", "tmp");
    const cases: [string, string][] = [
      [reloadFlagPath("/proj"), "reload.flag"],
      [reloadPendingPath("/proj"), "reload.pending"],
      [reloadDonePath("/proj"), "reload.done"],
    ];
    for (const [resolved, name] of cases) {
      assert.equal(resolved, path.join("/proj", ".pi", "run", name));
      // Explicit: the home is `.pi/run`, OUTSIDE the dir the sweep deletes (#1020).
      assert.equal(
        resolved.startsWith(legacyDir + path.sep),
        false,
        `${name} must not resolve into the swept .pi/tmp dir`,
      );
    }
  });

  test("legacy .pi/tmp flag is consumed (#1020)", () => {
    const cwd = makeCwd();
    try {
      const legacyFlag = legacyPath(cwd, "reload.flag");
      writeFileSync(legacyFlag, "nonce-legacy");
      const nonce = parkReloadNonce(cwd, `${process.pid}:session-A`);
      assert.equal(nonce, "nonce-legacy", "a pre-upgrade deploy script's flag is still consumed");
      assert.ok(!existsSync(legacyFlag), "legacy flag removed");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a consumed legacy flag parks pending in .pi/run (#1020)", () => {
    const cwd = makeCwd();
    try {
      writeFileSync(legacyPath(cwd, "reload.flag"), "nonce-legacy");
      parkReloadNonce(cwd, `${process.pid}:session-A`);
      assert.ok(existsSync(reloadPendingPath(cwd)), "pending parked in the new dir");
      assert.ok(!existsSync(legacyPath(cwd, "reload.pending")), "never written to the legacy dir");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("the done marker is mirrored to .pi/tmp for a pre-#1020 requester (#1020)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      writeFileSync(legacyPath(cwd, "reload.flag"), "nonce-legacy");
      parkReloadNonce(cwd, `${process.pid}:session-A`);
      await reg.handlers.get("session_start")!(
        { reason: "reload" },
        makeCtx(cwd, { count: 0 }, `session-A`),
      );
      assert.equal(readFileSync(reloadDonePath(cwd), "utf-8"), "nonce-legacy");
      assert.equal(
        readFileSync(legacyPath(cwd, "reload.done"), "utf-8"),
        "nonce-legacy",
        "a requester polling the old location still sees its nonce",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("legacy .pi/tmp pending is still seen by the watcher (#1020)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads);
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      // A pre-upgrade runtime parked this one in the old location.
      writeFileSync(legacyPath(cwd, "reload.pending"), JSON.stringify({ nonce: "n-legacy", owner: "999999:gone" }));
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.deepEqual(reg.sent.map((s) => s.text), [RELOAD_COMMAND]);
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("reused PID with mismatched startToken in reload.pending is claimable and removed (646422b5)", async (t) => {
    const records = captureLogs(t);
    const cwd = makeCwd();
    const reg = register();
    const origRead = fs.readFileSync;
    const fakeStat = `${process.pid} (node) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 999999 0 0\n`;
    t.mock.method(fs, "readFileSync", (target: any, ...args: any[]) => {
      if (String(target) === `/proc/${process.pid}/stat`) return fakeStat;
      return (origRead as any)(target, ...args);
    });
    syncBuiltinESMExports();
    try {
      const selfOwner = `${process.pid}:test-session`;
      const foreignOwner = `${process.pid}:stale-session`;
      assert.equal(
        pendingOwnerIsClaimable({ nonce: "live", owner: foreignOwner, startToken: "proc:999999" }, selfOwner),
        false,
        "matching startToken on live foreign PID stays protected",
      );
      assert.equal(
        pendingOwnerIsClaimable({ nonce: "reused", owner: foreignOwner, startToken: "proc:111111" }, selfOwner),
        true,
        "mismatched startToken proves PID reuse and makes pending claimable",
      );

      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads);
      writeFileSync(
        reloadPendingPath(cwd),
        JSON.stringify({ nonce: "nonce-reused-pid", owner: foreignOwner, startToken: "proc:111111" }),
      );
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.equal(reg.sent.length, 1, "reused-PID pending dispatches recovery reload");
      await reg.commands.get("reload-flag")!("", ctx);
      assert.equal(reloads.count, 1);
      assert.equal(JSON.parse(readFileSync(reloadPendingPath(cwd), "utf-8")).startToken, "proc:999999");
      await reg.handlers.get("session_start")!({ reason: "reload" }, ctx);
      assert.equal(existsSync(reloadPendingPath(cwd)), false, "stale reload.pending removed upon completion");
      assert.equal(readFileSync(reloadDonePath(cwd), "utf-8"), "nonce-reused-pid");
      assert.ok(records.some((line) => line.includes("reload_pending_pid_reused")));
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("missing .pi/tmp (ENOENT) on writeLegacyControlFile logs at debug, not warn (255a3001)", async (t) => {
    const prevLevel = process.env.PI_LOG_RELOAD_FLAG;
    process.env.PI_LOG_RELOAD_FLAG = "debug";
    clearLogLevelCache();
    t.after(() => {
      if (prevLevel === undefined) delete process.env.PI_LOG_RELOAD_FLAG;
      else process.env.PI_LOG_RELOAD_FLAG = prevLevel;
      clearLogLevelCache();
    });
    const records = captureLogs(t);
    const cwd = makeCwd();
    rmSync(path.join(cwd, ".pi", "tmp"), { recursive: true, force: true });
    const reg = register();
    try {
      const ctx = makeCtx(cwd, { count: 0 });
      writeFileSync(
        reloadPendingPath(cwd),
        JSON.stringify({ nonce: "nonce-missing-tmp", owner: `${process.pid}:test-session` }),
      );
      await reg.handlers.get("session_start")!({ reason: "reload" }, ctx);
      assert.equal(readFileSync(reloadDonePath(cwd), "utf-8"), "nonce-missing-tmp");
      assert.equal(existsSync(reloadPendingPath(cwd)), false);
      assert.ok(
        records.some(
          (line) =>
            line.includes("[debug]") &&
            line.includes("reload_legacy_mirror_failed") &&
            line.includes('"code":"ENOENT"'),
        ),
        "ENOENT logged at debug",
      );
      assert.equal(
        records.some((line) => line.includes("[warn]") && line.includes("reload_legacy_mirror_failed")),
        false,
        "ENOENT never logs at warn",
      );
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("idle 500ms watcher tick performs zero readdirSync calls on .pi/tmp and keeps claims in .pi/run (856c87ef)", async (t) => {
    const cwd = makeCwd();
    writeFileSync(legacyPath(cwd, "scratch.tmp"), "throwaway");
    const reg = register();
    const readdirCalls: string[] = [];
    const existsCalls: string[] = [];
    const origReaddir = fs.readdirSync;
    const origExists = fs.existsSync;
    t.mock.method(fs, "readdirSync", (target: any, ...args: any[]) => {
      readdirCalls.push(String(target));
      return (origReaddir as any)(target, ...args);
    });
    t.mock.method(fs, "existsSync", (target: any) => {
      existsCalls.push(String(target));
      return origExists(target);
    });
    syncBuiltinESMExports();
    try {
      const ctx = makeCtx(cwd, { count: 0 });
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      readdirCalls.length = 0;
      existsCalls.length = 0;
      await new Promise((r) => setTimeout(r, 650));
      await reg.handlers.get("session_shutdown")!({}, undefined);

      const legacyDir = path.join(cwd, ".pi", "tmp");
      assert.ok(readdirCalls.includes(path.join(cwd, ".pi", "run")), "500ms watcher tick ran");
      assert.deepEqual(
        readdirCalls.filter((dir) => dir === legacyDir || dir.startsWith(legacyDir + path.sep)),
        [],
        "zero readdirSync calls on .pi/tmp during idle watcher ticks",
      );
      assert.ok(existsCalls.includes(legacyPath(cwd, "reload.flag")), "checks legacy reload.flag via existsSync");
      assert.ok(existsCalls.includes(legacyPath(cwd, "reload.pending")), "checks legacy reload.pending via existsSync");

      // Also verify consuming a legacy .pi/tmp flag stages its .claim in .pi/run, never .pi/tmp.
      const claimedLocations: string[] = [];
      const origRename = fs.renameSync;
      t.mock.method(fs, "renameSync", (from: any, to: any) => {
        if (String(to).endsWith(".claim")) claimedLocations.push(String(to));
        return origRename(from, to);
      });
      syncBuiltinESMExports();
      writeFileSync(legacyPath(cwd, "reload.flag"), "legacy-claim-loc");
      assert.equal(parkReloadNonce(cwd, `${process.pid}:test-session`), "legacy-claim-loc");
      assert.equal(claimedLocations.length, 1);
      assert.equal(path.dirname(claimedLocations[0]!), path.join(cwd, ".pi", "run"));
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("idle turn_end tick performs at most 3 fs syscalls (1 readdirSync + 2 existsSync) (#1182)", async (t) => {
    const cwd = makeCwd();
    const reg = register();
    const readdirCalls: string[] = [];
    const existsCalls: string[] = [];
    const origReaddir = fs.readdirSync;
    const origExists = fs.existsSync;
    t.mock.method(fs, "readdirSync", (target: any, ...args: any[]) => {
      readdirCalls.push(String(target));
      return (origReaddir as any)(target, ...args);
    });
    t.mock.method(fs, "existsSync", (target: any) => {
      existsCalls.push(String(target));
      return origExists(target);
    });
    syncBuiltinESMExports();
    try {
      const ctx = makeCtx(cwd, { count: 0 });
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      readdirCalls.length = 0;
      existsCalls.length = 0;

      await reg.handlers.get("turn_end")!({}, ctx);
      assert.equal(readdirCalls.length, 1, "exactly 1 readdirSync per idle tick");
      assert.equal(readdirCalls[0], path.join(cwd, ".pi", "run"));
      assert.equal(existsCalls.length, 2, "at most 2 existsSync checks per idle tick");
      assert.ok(readdirCalls.length + existsCalls.length <= 3, "total <= 3 fs checks per idle tick");

      // When .pi/run/reload.flag exists, legacy reload.flag check is skipped (only 1 existsSync)
      writeFileSync(reloadFlagPath(cwd), "nonce-run-fast");
      readdirCalls.length = 0;
      existsCalls.length = 0;
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.equal(readdirCalls.length, 1);
      assert.equal(existsCalls.length, 1);
      assert.equal(reg.sent.length, 1);

      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("reconcileStartupHandshake replaces pruneStaleHandshake without age-pruning branches (f2742a50)", () => {
    assert.equal(typeof reconcileStartupHandshake, "function");
    assert.equal("pruneStaleHandshake" in reloadFlagModule, false);
    const cwd = makeCwd();
    try {
      writeFileSync(reloadPendingPath(cwd), "{corrupt-json");
      writeFileSync(reloadFlagPath(cwd), "aged-flag");
      writeFileSync(legacyPath(cwd, "reload.pending"), JSON.stringify({ nonce: "aged-pending", owner: "999999:dead" }));
      writeFileSync(reloadDonePath(cwd), "aged-done");
      for (const file of [reloadFlagPath(cwd), legacyPath(cwd, "reload.pending"), reloadDonePath(cwd)]) {
        backdate(file);
      }
      reconcileStartupHandshake(cwd, `${process.pid}:test-session`, "startup");
      assert.equal(existsSync(reloadPendingPath(cwd)), false, "corrupt pending removed");
      assert.equal(readFileSync(reloadFlagPath(cwd), "utf-8"), "aged-flag");
      assert.equal(JSON.parse(readFileSync(legacyPath(cwd, "reload.pending"), "utf-8")).nonce, "aged-pending");
      assert.equal(readFileSync(reloadDonePath(cwd), "utf-8"), "aged-done");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("isHandshakeParticipant", () => {
  it("only an interactive session may touch the handshake (#1091)", () => {
    assert.equal(isHandshakeParticipant("tui", ["node", "pi"]), true);
    assert.equal(isHandshakeParticipant("agent", ["node", "pi"]), true);
    assert.equal(isHandshakeParticipant("print", ["node", "pi"]), false);
    assert.equal(isHandshakeParticipant("json", ["node", "pi"]), false);
    assert.equal(isHandshakeParticipant("rpc", ["node", "pi"]), false);
    assert.equal(isHandshakeParticipant("tui", ["node", "pi", "-p", "hi"]), false);
    assert.equal(isHandshakeParticipant("tui", ["node", "pi", "--mode", "json"]), false);
  });
});

describe("shouldSkipReloadFlag", () => {
  it("skips a headless rpc session", () => {
    // The bug: a spawned peer in the same checkout consumed the deploy nonce, so the operator's
    // TUI session never reloaded and no banner appeared.
    assert.equal(shouldSkipReloadFlag(["node", "pi", "--mode", "rpc", "--coms"]), true);
    assert.equal(shouldSkipReloadFlag(["node", "pi", "--mode=rpc"]), true);
  });

  it("does not skip a TUI or oneshot session", () => {
    assert.equal(shouldSkipReloadFlag(["node", "pi"]), false);
    assert.equal(shouldSkipReloadFlag(["node", "pi", "--mode", "json"]), false);
    assert.equal(shouldSkipReloadFlag(["node", "pi", "-p", "hi"]), false);
  });
});
