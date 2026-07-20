/**
 * Contract tests for /resume|/new CLI history re-seed (issue #661).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearCliSessionsForCwd,
  decideCliSessionStartReseed,
  loadCliSessionId,
  resolveCliHistorySeed,
  saveCliSessionId,
  type CliSessionKey,
} from "../../../extensions/cli-provider/sessions.js";
import { reapStaleCliSessions } from "../../../extensions/cli-provider/session-reaper.js";

describe("decideCliSessionStartReseed (/resume contract)", () => {
  it("keeps markers on reload", () => {
    const d = decideCliSessionStartReseed({
      reason: "reload",
      prevPiSessionId: "sid-a",
      nextPiSessionId: "sid-a",
    });
    assert.equal(d.action, "keep");
    assert.equal(d.forceHistorySeed, false);
  });

  it("reseeds on resume", () => {
    const d = decideCliSessionStartReseed({
      reason: "resume",
      prevPiSessionId: null,
      nextPiSessionId: "sid-b",
    });
    assert.equal(d.action, "reseed");
    assert.equal(d.forceHistorySeed, true);
  });

  it("reseeds on new", () => {
    const d = decideCliSessionStartReseed({
      reason: "new",
      prevPiSessionId: "sid-a",
      nextPiSessionId: "sid-b",
    });
    assert.equal(d.action, "reseed");
    assert.equal(d.forceHistorySeed, true);
  });

  it("reseeds when pi session id changes", () => {
    const d = decideCliSessionStartReseed({
      reason: "startup",
      prevPiSessionId: "sid-a",
      nextPiSessionId: "sid-b",
    });
    assert.equal(d.action, "reseed");
    assert.equal(d.forceHistorySeed, true);
  });

  it("bind-only on ordinary start with same id", () => {
    const d = decideCliSessionStartReseed({
      reason: "startup",
      prevPiSessionId: null,
      nextPiSessionId: "sid-a",
    });
    assert.equal(d.action, "bind-only");
    assert.equal(d.forceHistorySeed, false);
  });
});

describe("/resume reseed path (markers + history seed)", () => {
  it("clears cwd markers and forces history seed like session_start resume", () => {
    const prevHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "cli-resume-e2e-"));
    process.env.HOME = home;
    try {
      const cwd = "/proj-resume";
      const key: CliSessionKey = {
        cwd,
        agent: "cursor",
        model: "composer",
        piSessionId: "old-sid",
      };
      saveCliSessionId(key, "stale-cli-chat");
      assert.equal(loadCliSessionId(key), "stale-cli-chat");

      const decision = decideCliSessionStartReseed({
        reason: "resume",
        prevPiSessionId: "old-sid",
        nextPiSessionId: "new-sid",
      });
      assert.equal(decision.action, "reseed");

      const cleared = clearCliSessionsForCwd(cwd);
      assert.equal(cleared, 1);
      assert.equal(loadCliSessionId(key), null);

      const seed = resolveCliHistorySeed({
        hasCliSession: Boolean(loadCliSessionId({ ...key, piSessionId: "new-sid" })),
        forceHistorySeed: decision.forceHistorySeed,
      });
      assert.deepEqual(seed, { useCliSession: false, seedHistory: true });
    } finally {
      process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reload does not clear markers", () => {
    const prevHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "cli-reload-keep-"));
    process.env.HOME = home;
    try {
      const cwd = "/proj-reload";
      const key: CliSessionKey = {
        cwd,
        agent: "cursor",
        model: "composer",
        piSessionId: "same-sid",
      };
      saveCliSessionId(key, "live-cli-chat");

      const decision = decideCliSessionStartReseed({
        reason: "reload",
        prevPiSessionId: "same-sid",
        nextPiSessionId: "same-sid",
      });
      assert.equal(decision.action, "keep");
      // Mimic index.ts: keep path returns without clearCliSessionsForCwd
      assert.equal(loadCliSessionId(key), "live-cli-chat");
      assert.deepEqual(
        resolveCliHistorySeed({
          hasCliSession: true,
          forceHistorySeed: decision.forceHistorySeed,
        }),
        { useCliSession: true, seedHistory: false },
      );
    } finally {
      process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("reaper vs active piSessionId", () => {
  it("does not reap idle running marker for the active pi session", () => {
    const prevHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "cli-reap-active-"));
    process.env.HOME = home;
    try {
      const key: CliSessionKey = {
        cwd: "/proj",
        agent: "gemini",
        model: "flash",
        piSessionId: "active-sid",
      };
      saveCliSessionId(key, "live-id");
      const dir = join(home, ".pi", "cli-sessions");
      const files = readdirSync(dir);
      const rec = JSON.parse(readFileSync(join(dir, files[0]), "utf-8"));
      writeFileSync(
        join(dir, files[0]),
        JSON.stringify({
          ...rec,
          status: "running",
          lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      );
      const n = reapStaleCliSessions({
        inactivityThresholdMs: 1_000,
        activePiSessionId: "active-sid",
      });
      assert.equal(n, 0);
      assert.equal(loadCliSessionId(key), "live-id");
    } finally {
      process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reaps idle running marker from a different piSessionId", () => {
    const prevHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "cli-reap-other-"));
    process.env.HOME = home;
    try {
      const key: CliSessionKey = {
        cwd: "/proj",
        agent: "gemini",
        model: "flash",
        piSessionId: "old-sid",
      };
      saveCliSessionId(key, "orphan-id");
      const dir = join(home, ".pi", "cli-sessions");
      const files = readdirSync(dir);
      const rec = JSON.parse(readFileSync(join(dir, files[0]), "utf-8"));
      writeFileSync(
        join(dir, files[0]),
        JSON.stringify({
          ...rec,
          status: "running",
          lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      );
      const n = reapStaleCliSessions({
        inactivityThresholdMs: 1_000,
        activePiSessionId: "current-sid",
      });
      assert.equal(n, 1);
      assert.equal(loadCliSessionId(key), null);
    } finally {
      process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
