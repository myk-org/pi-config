/**
 * Discord bridge pure logic — chunking, attachments, answers, state, layout,
 * event rendering. These are the parts the old bot inlined into a 592-line
 * function with no coverage; they are covered here so the correctness bugs
 * found in review cannot come back.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkDiscordText, truncateLine, DISCORD_TEXT_LIMIT, NO_MENTIONS } from "../../../extensions/pidash/discord-format.ts";
import {
  classifyAttachment,
  describeSkippedAttachment,
  MAX_IMAGE_BYTES,
  MAX_INLINE_TEXT_BYTES,
  formatKB,
} from "../../../extensions/pidash/discord-attachments.ts";
import {
  mapAnswer,
  toBridgeResponse,
  isPromptExpired,
  renderPrompt,
  PENDING_PROMPT_TTL_MS,
  type PendingPrompt,
} from "../../../extensions/pidash/discord-answers.ts";
import {
  buildSessionPage,
  pageCount,
  clampPage,
  renderSessionsPage,
  sessionLabel,
  filterSessionChoices,
  MAX_ACTION_ROWS,
  SESSIONS_PER_PAGE,
  type SessionSummary,
} from "../../../extensions/pidash/discord-sessions-view.ts";
import { renderEvent, initialRenderState, toolLine, streamingView } from "../../../extensions/pidash/discord-render.ts";
import { migrateState, pruneState, STATE_VERSION, emptyState } from "../../../extensions/pidash/discord-state.ts";

describe("discord chunking", () => {
  it("sends short text unchanged", () => {
    assert.deepEqual(chunkDiscordText("hello"), ["hello"]);
  });

  it("never exceeds the limit", () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    for (const chunk of chunkDiscordText(text, 500)) {
      assert.ok(chunk.length <= 500, `chunk of ${chunk.length} exceeds 500`);
    }
  });

  it("closes and reopens a code fence across a split", () => {
    const body = Array.from({ length: 200 }, (_, i) => `const value${i} = ${i};`).join("\n");
    const text = "before\n```ts\n" + body + "\n```\nafter";
    const chunks = chunkDiscordText(text, 600);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      const fences = (chunk.match(/```/g) || []).length;
      assert.equal(fences % 2, 0, `chunk leaves an unbalanced fence:\n${chunk.slice(0, 80)}`);
    }
    assert.ok(chunks.every((c) => c.length <= 600));
  });

  it("hard-splits a single line longer than the limit", () => {
    const chunks = chunkDiscordText("y".repeat(5000), 1000);
    assert.ok(chunks.length >= 5);
    assert.ok(chunks.every((c) => c.length <= 1000));
  });

  it("suppresses mentions in every send", () => {
    assert.deepEqual(NO_MENTIONS.allowedMentions.parse, []);
  });

  it("truncates summaries without breaking words badly", () => {
    assert.equal(truncateLine("a\nb   c", 40), "a b c");
    assert.equal(truncateLine("x".repeat(50), 10).length, 10);
  });
});

describe("discord attachments", () => {
  const base = { url: "https://cdn.example/x", filename: "x.txt", size: 10 };

  it("inlines a small text file", () => {
    assert.equal(classifyAttachment({ ...base, contentType: "text/plain" }).kind, "text");
  });

  it("treats a known extension as text even without a content type", () => {
    assert.equal(classifyAttachment({ ...base, filename: "notes.md" }).kind, "text");
  });

  it("refuses text above the inline cap", () => {
    const plan = classifyAttachment({ ...base, contentType: "text/plain", size: MAX_INLINE_TEXT_BYTES + 1 });
    assert.equal(plan.kind, "skipped-large");
    assert.match(describeSkippedAttachment(plan) || "", /exceeds/);
  });

  it("accepts an image under the cap", () => {
    assert.equal(classifyAttachment({ ...base, contentType: "image/png", size: 1024 }).kind, "image");
  });

  it("refuses an oversized image instead of calling it binary", () => {
    // The old code had no image cap at all and base64'd 25MB into memory.
    const plan = classifyAttachment({ ...base, contentType: "image/png", size: MAX_IMAGE_BYTES + 1 });
    assert.equal(plan.kind, "skipped-large");
  });

  it("marks an unknown binary as skipped, not inlined", () => {
    const plan = classifyAttachment({ ...base, filename: "blob.bin", contentType: "application/octet-stream" });
    assert.equal(plan.kind, "skipped-binary");
    assert.match(describeSkippedAttachment(plan) || "", /binary/);
  });

  it("formats sizes for humans", () => {
    assert.equal(formatKB(512), "512B");
    assert.equal(formatKB(2048), "2.0KB");
    assert.equal(formatKB(MAX_IMAGE_BYTES), "8.0MB");
  });
});

describe("discord prompt answers", () => {
  const confirm: PendingPrompt = { id: "q1", sessionId: "s", method: "confirm", options: ["Yes", "No"], createdAt: Date.now() };
  const select: PendingPrompt = { id: "q2", sessionId: "s", method: "select", options: ["Approve", "Deny", "Always"], createdAt: Date.now() };
  const input: PendingPrompt = { id: "q3", sessionId: "s", method: "input", options: [], createdAt: Date.now() };

  it("answers a confirm with the confirmed flag the bridge requires", () => {
    // ui-bridge ignores anything but `confirmed` for confirm prompts — the old
    // bot only ever sent `value`, so approvals silently hung.
    const answer = mapAnswer(confirm, "yes");
    assert.deepEqual(toBridgeResponse(confirm, answer), { type: "extension_ui_response", id: "q1", confirmed: true });
    assert.equal((toBridgeResponse(confirm, mapAnswer(confirm, "no")) as any).confirmed, false);
    assert.equal((toBridgeResponse(confirm, mapAnswer(confirm, "2")) as any).confirmed, false);
  });

  it("rejects a confirm reply that is neither yes nor no", () => {
    assert.equal(mapAnswer(confirm, "maybe").kind, "reject");
  });

  it("maps a select number to the offered option", () => {
    assert.deepEqual(toBridgeResponse(select, mapAnswer(select, "2")), { type: "extension_ui_response", id: "q2", value: "Deny" });
  });

  it("maps an exact option and a unique prefix", () => {
    assert.equal((toBridgeResponse(select, mapAnswer(select, "always")) as any).value, "Always");
    assert.equal((toBridgeResponse(select, mapAnswer(select, "app")) as any).value, "Approve");
  });

  it("refuses an out-of-range number instead of inventing an answer", () => {
    assert.equal(mapAnswer(select, "9").kind, "reject");
  });

  it("refuses an ambiguous prefix", () => {
    const ambiguous: PendingPrompt = { ...select, options: ["Deny", "Delete"] };
    assert.equal(mapAnswer(ambiguous, "de").kind, "reject");
  });

  it("lets any prompt be cancelled", () => {
    for (const prompt of [confirm, select, input]) {
      assert.deepEqual(toBridgeResponse(prompt, mapAnswer(prompt, "/cancel")), {
        type: "extension_ui_response", id: prompt.id, cancelled: true,
      });
    }
  });

  it("expires a stale prompt so it cannot eat a later message", () => {
    const old = { ...confirm, createdAt: Date.now() - PENDING_PROMPT_TTL_MS - 1 };
    assert.equal(isPromptExpired(old), true);
    assert.equal(isPromptExpired(confirm), false);
  });

  it("renders the accepted vocabulary", () => {
    assert.match(renderPrompt(confirm, "Run rm -rf?"), /Reply \*\*yes\*\* or \*\*no\*\*/);
    assert.match(renderPrompt(select, "Pick"), /Reply with a number 1-3/);
  });
});

describe("discord sessions layout", () => {
  const sessions: SessionSummary[] = Array.from({ length: 60 }, (_, i) => ({
    sessionId: `s${i}`, cwd: `/tmp/project-${i}`, model: "m", active: i % 2 === 0,
  }));

  it("never exceeds Discord's five action rows", () => {
    for (const total of [1, 5, 19, 20, 21, 25, 60, 200]) {
      const page = buildSessionPage(sessions.slice(0, total), 1);
      assert.ok(page.rows <= MAX_ACTION_ROWS, `${total} sessions produced ${page.rows} rows`);
    }
  });

  it("paginates instead of truncating silently", () => {
    assert.equal(SESSIONS_PER_PAGE, 20);
    assert.equal(pageCount(60), 3);
    assert.equal(buildSessionPage(sessions, 2).page, 2);
    assert.equal(buildSessionPage(sessions, 3).items.length, 20);
    assert.equal(buildSessionPage(sessions, 3).pages, 3);
  });

  it("clamps out-of-range pages", () => {
    assert.equal(clampPage(0, 60), 1);
    assert.equal(clampPage(99, 60), 3);
    assert.equal(clampPage(Number.NaN, 60), 1);
  });

  it("numbers sessions globally, not per page", () => {
    const page = buildSessionPage(sessions, 2);
    assert.match(renderSessionsPage(page, null), /\*\*21\.\*\*/);
  });

  it("marks the watched session", () => {
    const page = buildSessionPage([{ sessionId: "s0", cwd: "/tmp/a" }], 1);
    assert.match(renderSessionsPage(page, "s0"), /watching/);
  });

  it("labels async subagents so they are distinguishable", () => {
    assert.match(sessionLabel({ sessionId: "s", cwd: "/tmp/x", agentType: "worker" }), /\(worker\)/);
  });

  it("autocompletes /watch by label first, then path", () => {
    const pool: SessionSummary[] = [
      { sessionId: "a", cwd: "/home/me/git/other", name: "unrelated" },
      { sessionId: "b", cwd: "/home/me/git/pi-config" },
      { sessionId: "c", cwd: "/tmp/pi-thing", name: "pi-worker", agentType: "worker" },
    ];
    const choices = filterSessionChoices(pool, "pi");
    // Equal score (both labels start with "pi") → alphabetical tie-break.
    assert.deepEqual(choices.map((c) => c.value), ["b", "c"]);
    assert.equal(filterSessionChoices(pool, "").length, 3);
    assert.deepEqual(filterSessionChoices(pool, "zzz"), []);
    assert.ok(filterSessionChoices(Array.from({ length: 80 }, (_, i) => ({ sessionId: `s${i}`, cwd: `/tmp/s${i}` })), "").length === 25);
  });
});

describe("discord event rendering", () => {
  it("accumulates assistant deltas and flushes once at message end", () => {
    const state = initialRenderState();
    assert.equal(renderEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hel" } }, state).kind, "append-text");
    renderEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo" } }, state);
    const action = renderEvent({ type: "message_end", message: { role: "assistant" } }, state);
    assert.deepEqual(action, { kind: "flush-assistant", text: "Hello" });
    assert.equal(state.pendingText, "");
  });

  it("emits a tool line so tool activity is visible", () => {
    const action = renderEvent({ type: "tool_execution_start", toolName: "bash", args: { command: "cargo test" } }, initialRenderState());
    assert.equal(action.kind, "tool");
    assert.match((action as any).text, /bash/);
    assert.match((action as any).text, /cargo test/);
  });

  it("ignores tool events without a name", () => {
    assert.equal(toolLine({}), null);
  });

  it("shows user messages that came from the TUI", () => {
    const action = renderEvent({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "hi" }] } }, initialRenderState());
    assert.deepEqual(action, { kind: "user", text: "hi" });
  });

  it("keeps a streaming edit within the message limit", () => {
    const view = streamingView("a".repeat(5000), 1000);
    assert.ok(view.length <= 1000);
  });
});

describe("discord state migration", () => {
  it("drops a persisted pending prompt (the restart bug)", () => {
    const v1 = {
      "111": { watchedSessionId: "s1", responseChannelId: "c1", pendingAskUser: { id: "q", sessionId: "s1" } },
    };
    const migrated = migrateState(v1);
    assert.equal(migrated.version, STATE_VERSION);
    assert.equal(migrated.users["111"].watchedSessionId, "s1");
    assert.equal("pendingAskUser" in (migrated.users["111"] as any), false);
  });

  it("drops users with no binding and unknown fields", () => {
    const migrated = migrateState({ version: 2, users: { a: { junk: true }, b: { watchedSessionId: "s", extra: "x" } } });
    assert.deepEqual(Object.keys(migrated.users), ["b"]);
  });

  it("survives a corrupt or empty file", () => {
    assert.deepEqual(migrateState(null), emptyState());
    assert.deepEqual(migrateState("nonsense"), emptyState());
  });

  it("prunes stale users and caps the map", () => {
    const now = Date.now();
    const state = {
      version: STATE_VERSION,
      users: {
        fresh: { watchedSessionId: "s", responseChannelId: "c", updatedAt: now },
        stale: { watchedSessionId: "s", responseChannelId: "c", updatedAt: now - 400 * 24 * 3600 * 1000 },
      },
    };
    assert.deepEqual(Object.keys(pruneState(state, now).users), ["fresh"]);
    const many = {
      version: STATE_VERSION,
      users: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`u${i}`, { watchedSessionId: null, responseChannelId: "c", updatedAt: now - i }])),
    };
    assert.equal(Object.keys(pruneState(many, now).users).length, 200);
  });
});
