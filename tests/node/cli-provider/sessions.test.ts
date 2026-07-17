/**
 * Tests for cli-provider session directory + reaper.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearCliSessionId,
  isCliResumeFailure,
  loadCliSessionId,
  loadCliSessionRecord,
  saveCliSessionId,
  touchCliSession,
  type CliSessionKey,
} from "../../../extensions/cli-provider/sessions.js";
import { reapStaleCliSessions } from "../../../extensions/cli-provider/session-reaper.js";

describe("cli-provider sessions", () => {
  it("detects resume failure messages", () => {
    assert.equal(isCliResumeFailure("Session not found: abc"), true);
    assert.equal(isCliResumeFailure("cannot resume session"), true);
    assert.equal(isCliResumeFailure("model overloaded"), false);
  });

  it("retries without resume on empty non-zero exit", async () => {
    const { shouldRetryWithoutResume } = await import(
      "../../../extensions/cli-provider/sessions.js"
    );
    assert.equal(
      shouldRetryWithoutResume("CLI agent exited 1: no output"),
      true,
    );
    assert.equal(shouldRetryWithoutResume("CLI agent exited 1: auth failed"), false);
  });

  it("saves then loads session id", () => {
    const prevHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "cli-sess-"));
    process.env.HOME = home;
    try {
      const key: CliSessionKey = {
        cwd: "/proj",
        agent: "cursor",
        model: "composer-2",
        piSessionId: "sess-a",
      };
      saveCliSessionId(key, "cli-uuid-1");
      assert.equal(loadCliSessionId(key), "cli-uuid-1");
      const before = loadCliSessionRecord(key)!;
      assert.equal(before.status, "running");
    } finally {
      process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("touchCliSession advances lastSeenAt", () => {
    const prevHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "cli-sess-touch-"));
    process.env.HOME = home;
    try {
      const key: CliSessionKey = {
        cwd: "/proj",
        agent: "cursor",
        model: "composer-2",
        piSessionId: "sess-a",
      };
      saveCliSessionId(key, "cli-uuid-1");
      const oldSeen = loadCliSessionRecord(key)!.lastSeenAt;
      touchCliSession(key);
      assert.ok(loadCliSessionRecord(key)!.lastSeenAt >= oldSeen);
    } finally {
      process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("clearCliSessionId removes the marker", () => {
    const prevHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "cli-sess-clear-"));
    process.env.HOME = home;
    try {
      const key: CliSessionKey = {
        cwd: "/proj",
        agent: "cursor",
        model: "composer-2",
        piSessionId: "sess-a",
      };
      saveCliSessionId(key, "cli-uuid-1");
      clearCliSessionId(key);
      assert.equal(loadCliSessionId(key), null);
    } finally {
      process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("loadCliSessionId returns null on malformed JSON", () => {
    const prevHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "cli-sess-bad-"));
    process.env.HOME = home;
    try {
      const key: CliSessionKey = {
        cwd: "/proj",
        agent: "cursor",
        model: "composer-2",
        piSessionId: "bad",
      };
      saveCliSessionId(key, "ok");
      const rec = loadCliSessionRecord(key)!;
      const { writeFileSync, readdirSync } = require("node:fs") as typeof import("node:fs");
      const dir = join(home, ".pi", "cli-sessions");
      const files = readdirSync(dir);
      writeFileSync(join(dir, files[0]), "{not-json");
      assert.equal(loadCliSessionId(key), null);
      assert.equal(rec.sessionId, "ok");
    } finally {
      process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reaps idle session markers", () => {
    const prevHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "cli-reap-"));
    process.env.HOME = home;
    try {
      const key: CliSessionKey = {
        cwd: "/proj",
        agent: "gemini",
        model: "flash",
        piSessionId: "s1",
      };
      saveCliSessionId(key, "old-id");
      // Backdate lastSeen by rewriting file via save then monkey with record
      const rec = loadCliSessionRecord(key)!;
      const path = join(home, ".pi", "cli-sessions");
      // Use reap with tiny threshold after touching file mtime via write of old lastSeen
      const { writeFileSync, readdirSync } = require("node:fs") as typeof import("node:fs");
      const files = readdirSync(path);
      assert.equal(files.length, 1);
      writeFileSync(
        join(path, files[0]),
        JSON.stringify({
          ...rec,
          lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      );
      const n = reapStaleCliSessions({ inactivityThresholdMs: 1_000 });
      assert.equal(n, 1);
      assert.equal(loadCliSessionId(key), null);
    } finally {
      process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
