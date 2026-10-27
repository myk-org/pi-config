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
  fetchAttachment,
  MAX_IMAGE_BYTES,
  MAX_INLINE_TEXT_BYTES,
  formatKB,
} from "../../../extensions/pidash/discord-attachments.ts";
import {
  mapAnswer,
  toBridgeResponse,
  isPromptExpired,
  renderPrompt,
  DEFAULT_PENDING_PROMPT_TTL_MS,
  resolvePromptTtlMs,
  isAnswerLike,
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
import { renderEvent, initialRenderState, toolLine, streamingView, shouldSuppressEcho } from "../../../extensions/pidash/discord-render.ts";
import { resolveDiscordConfig, parseEnvFile } from "../../../extensions/pidash/discord-config.ts";
import { boundListText } from "../../../extensions/pidash/discord-sessions-view.ts";
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

  it("accepts free text for a select, like the TUI does", () => {
    // ask_user's select allows a custom answer; the old bot allowed it too.
    const custom = mapAnswer(select, "use the staging cluster");
    assert.deepEqual(custom, { kind: "value", value: "use the staging cluster" });
  });

  it("knows whether a reply is an answer at all", () => {
    assert.equal(isAnswerLike(confirm, "yes"), true);
    assert.equal(isAnswerLike(confirm, "deploy it now"), false);
    assert.equal(isAnswerLike(select, "anything"), true);
  });

  it("reads the prompt TTL from the environment within sane bounds", () => {
    assert.equal(resolvePromptTtlMs({}), DEFAULT_PENDING_PROMPT_TTL_MS);
    assert.equal(resolvePromptTtlMs({ DISCORD_PROMPT_TTL_MS: "60000" }), 60000);
    assert.equal(resolvePromptTtlMs({ DISCORD_PROMPT_TTL_MS: "1" }), 30000, "clamped up");
    assert.equal(resolvePromptTtlMs({ DISCORD_PROMPT_TTL_MS: "999999999" }), 24 * 3600 * 1000, "clamped down");
    assert.equal(resolvePromptTtlMs({ DISCORD_PROMPT_TTL_MS: "nope" }), DEFAULT_PENDING_PROMPT_TTL_MS);
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
    const old = { ...confirm, createdAt: Date.now() - DEFAULT_PENDING_PROMPT_TTL_MS - 1 };
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

describe("discord echo correlation (Qodo 8faf3fdd / 9306351e)", () => {
  it("suppresses only the exact prompt we forwarded", () => {
    assert.equal(shouldSuppressEcho("deploy it", "deploy it"), true);
    assert.equal(shouldSuppressEcho("deploy it", "  deploy it  "), true);
    assert.equal(shouldSuppressEcho("deploy it", "deploy it now"), false);
    assert.equal(shouldSuppressEcho(undefined, "anything"), false, "no marker means no suppression");
  });

  it("is a pure decision, so two watchers cannot consume it in turn", () => {
    // The old code deleted the marker inside the watcher loop; the same input
    // must now give the same answer for every watcher.
    const expected = "run the tests";
    const actual = "run the tests";
    assert.equal(shouldSuppressEcho(expected, actual), true);
    assert.equal(shouldSuppressEcho(expected, actual), true);
  });
});

describe("session list bounding (Qodo 56dd47a3)", () => {
  it("keeps a long list inside the message limit and says what it dropped", () => {
    const text = Array.from({ length: 60 }, (_, i) => `[active] **${i}.** very-long-session-name-${i} — model-name (branch-name)`).join("\n");
    const bounded = boundListText(text, 500);
    assert.ok(bounded.length <= 540, `bounded to ${bounded.length}`);
    assert.match(bounded, /and \d+ more/);
  });

  it("leaves a short list untouched", () => {
    assert.equal(boundListText("two\nlines", 500), "two\nlines");
  });
});

describe("discord startup configuration (Qodo 5e9bc957)", () => {
  it("refuses to start without a token", () => {
    const result = resolveDiscordConfig({ HOME: "/home/x" });
    assert.equal(result.ok, false);
    assert.match((result as any).reason, /DISCORD_BOT_TOKEN/);
  });

  it("fails closed when no allowlist and no explicit opt-in", () => {
    const result = resolveDiscordConfig({ HOME: "/home/x", DISCORD_BOT_TOKEN: "t" });
    assert.equal(result.ok, false, "a token alone must not mean open access");
    assert.match((result as any).reason, /DISCORD_ALLOWED_USERS/);
  });

  it("accepts an explicit open-access opt-in", () => {
    const result = resolveDiscordConfig({ HOME: "/home/x", DISCORD_BOT_TOKEN: "t", DISCORD_ALLOW_ALL: "true" });
    assert.equal(result.ok, true);
    assert.equal((result as any).config.allowAll, true);
  });

  it("parses a comma-separated allowlist and ignores blanks", () => {
    const result = resolveDiscordConfig({ HOME: "/home/x", DISCORD_BOT_TOKEN: "t", DISCORD_ALLOWED_USERS: " 1, 2 ,,3 " });
    assert.deepEqual([...(result as any).config.allowedUsers], ["1", "2", "3"]);
  });

  it("resolves the state/env paths from HOME", () => {
    const result = resolveDiscordConfig({ HOME: "/home/x", DISCORD_BOT_TOKEN: "t", DISCORD_ALLOWED_USERS: "1" });
    assert.equal((result as any).config.stateFile, "/home/x/.pi/discord-state.json");
    assert.equal((result as any).config.envFile, "/home/x/.pi/discord.env");
  });

  it("parses the credentials file", () => {
    const env = parseEnvFile("# comment\nDISCORD_BOT_TOKEN=abc\n\nDISCORD_ALLOWED_USERS=1,2");
    assert.deepEqual(env, { DISCORD_BOT_TOKEN: "abc", DISCORD_ALLOWED_USERS: "1,2" });
  });
});

describe("discord session identity (user report)", () => {
  const messy: SessionSummary = {
    sessionId: "s1",
    cwd: "/home/me/git/pi-config",
    name: "check pi changelog [1.2.0] - whats new",
    model: "DeepSeek V4.1 Flash",
    branch: "main",
  };

  it("labels a session by its checkout, not by its first message", () => {
    // The first message ("local run is running…") identifies nothing; the
    // checkout is what a human recognises.
    assert.match(sessionLabel(messy), /^pi-config/);
    assert.match(sessionLabel({ sessionId: "s", cwd: "/tmp/scratch", name: "fix the bug" }), /scratch/);
  });

  it("lists the checkout first, then the name and model", () => {
    const page = buildSessionPage([messy], 1);
    const line = renderSessionsPage(page, null);
    assert.match(line, /📁 \*\*pi-config\*\*/);
    assert.ok(line.indexOf("pi-config") < line.indexOf("check pi changelog"), "checkout before name");
  });

  it("autocompletes on the checkout name", () => {
    const choices = filterSessionChoices([messy], "pi-config");
    assert.equal(choices.length, 1);
    assert.match(choices[0].name, /^pi-config/);
  });
});

describe("chunk size invariant (Qodo 983b4f6f)", () => {
  const fenced = (limit: number, text: string) => chunkDiscordText(text, limit);

  it("never exceeds the limit for a fenced block of long lines", () => {
    const text = "```ts\n" + Array.from({ length: 40 }, (_, i) => `const v${i} = ${"x".repeat(120)};`).join("\n") + "\n```";
    assert.ok(fenced(300, text).every((chunk) => chunk.length <= 300));
  });

  it("never exceeds the limit for a fenced block holding one giant line", () => {
    // This is the case that produced 402-char chunks at a 400 limit.
    const text = "```\n" + "y".repeat(5000) + "\n```";
    const chunks = fenced(400, text);
    assert.ok(chunks.every((chunk) => chunk.length <= 400), `max ${Math.max(...chunks.map((c) => c.length))}`);
  });

  it("keeps the invariant across mixed content and limits", () => {
    const text = "a\n```js\nx\n```\nb\n```py\ny\n```\nc\n" + "z".repeat(900) + "\n" + "w ".repeat(500);
    for (const limit of [120, 200, 250, 500, 1000]) {
      const chunks = fenced(limit, text);
      assert.ok(chunks.every((chunk) => chunk.length <= limit), `limit ${limit} exceeded`);
    }
  });
});

describe("discord attachment download (Qodo bdb68b09)", () => {
  it("returns the body when it fits the cap", async () => {
    const response = new Response("hello", { headers: { "content-type": "text/plain", "content-length": "5" } });
    const result = await fetchAttachment("https://cdn.example/x", 100, async () => response);
    assert.equal(result?.buffer.toString(), "hello");
    assert.equal(result?.contentType, "text/plain");
  });

  it("refuses a declared body larger than the cap without reading it", async () => {
    const response = new Response("x".repeat(500), { headers: { "content-length": "500" } });
    assert.equal(await fetchAttachment("https://cdn.example/x", 10, async () => response), null);
  });

  it("refuses a body that only turns out to be oversized after download", async () => {
    // No content-length: the cap has to be enforced on the bytes themselves.
    const response = new Response("y".repeat(500), { headers: {} });
    assert.equal(await fetchAttachment("https://cdn.example/x", 10, async () => response), null);
  });

  it("returns null on an HTTP error instead of throwing", async () => {
    const response = new Response("nope", { status: 403 });
    assert.equal(await fetchAttachment("https://cdn.example/x", 100, async () => response), null);
  });

  it("returns null when the fetch itself fails", async () => {
    assert.equal(await fetchAttachment("https://cdn.example/x", 100, async () => { throw new Error("boom"); }), null);
  });
});
