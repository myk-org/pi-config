import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createAsyncDebugLogWriter, createDaemonServer, resolveUiDir } from "../../../scripts/daemon-shared.ts";
import { buildUiDist } from "../../../scripts/serve-ui.ts";
import { makeTempDir } from "../helpers/temp-dirs.js";

describe("resolveUiDir", () => {
  const uiPath = ["..", "extensions", "pidash", "pidash-ui", "dist"];

  it("prefers the process program path", () => {
    assert.equal(
      resolveUiDir("/installed/scripts/pidash-server.ts", "file:///source/scripts/pidash-server.ts", ...uiPath),
      path.normalize("/installed/extensions/pidash/pidash-ui/dist"),
    );
  });

  it("falls back to the ESM module URL for programmatic imports", () => {
    assert.equal(
      resolveUiDir(undefined, "file:///source/scripts/pidash-server.ts", ...uiPath),
      path.normalize("/source/extensions/pidash/pidash-ui/dist"),
    );
  });
});

describe("daemon browser fanout helpers (#1265, #1283)", () => {
  it("sendToMatchingBrowsers filters, accepts raw strings, and removes broken sockets", () => {
    const daemon = createDaemonServer({
      port: 0,
      uiDir: "/nonexistent",
      uiName: "test",
      log: () => {},
      onPiMessage: () => {},
      onPiClose: () => {},
    });

    const receivedA: string[] = [];
    const receivedB: string[] = [];
    const wsA = { send: (data: string) => receivedA.push(data) };
    const wsB = { send: (data: string) => receivedB.push(data) };
    const wsBroken = { send: () => { throw new Error("closed"); } };

    daemon.browserClients.add(wsA);
    daemon.browserClients.add(wsB);
    daemon.browserClients.add(wsBroken);
    daemon.browserWatchMap.set(wsA, "s1");
    daemon.browserWatchMap.set(wsB, "s2");
    daemon.browserWatchMap.set(wsBroken, "s1");

    daemon.sendToMatchingBrowsers((_ws, watch) => watch === "s1", { type: "ping" });
    assert.deepEqual(receivedA, ['{"type":"ping"}']);
    assert.deepEqual(receivedB, []);
    assert.equal(daemon.browserClients.has(wsBroken), false, "broken socket removed");

    daemon.sendToMatchingBrowsers((_ws, watch) => watch === "s2", '{"raw":true}');
    assert.deepEqual(receivedB, ['{"raw":true}']);

    daemon.broadcastToBrowsers('{"broadcast":1}');
    assert.deepEqual(receivedA, ['{"type":"ping"}', '{"broadcast":1}']);
    assert.deepEqual(receivedB, ['{"raw":true}', '{"broadcast":1}']);
  });
});

describe("buildUiDist (#1289)", () => {
  it("returns false when package.json is absent", () => {
    const dir = makeTempDir("serve-ui-empty-");
    const logs: string[] = [];
    try {
      const ok = buildUiDist(dir, "test-ui", (m) => logs.push(m), (() => {
        throw new Error("should not execute");
      }) as any);
      assert.equal(ok, false);
      assert.deepEqual(logs, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs npm install && build and reports success or failure", () => {
    const dir = makeTempDir("serve-ui-pkg-");
    const logs: string[] = [];
    const cmds: string[] = [];
    try {
      writeFileSync(path.join(dir, "package.json"), "{}");
      const ok = buildUiDist(dir, "test-ui", (m) => logs.push(m), ((cmd: string) => {
        cmds.push(cmd);
        return Buffer.from("");
      }) as any);
      assert.equal(ok, true);
      assert.deepEqual(cmds, ["npm install --production=false && npm run build"]);
      assert.ok(logs.some((m) => m.includes("build complete")));

      const failLogs: string[] = [];
      const fail = buildUiDist(dir, "test-ui", (m) => failLogs.push(m), (() => {
        throw new Error("boom");
      }) as any);
      assert.equal(fail, false);
      assert.ok(failLogs.some((m) => m.includes("boom")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

class FakeWriteStream extends EventEmitter {
  writes: string[] = [];
  destroyed = false;
  writableEnded = false;
  returnOnWrite = true;
  autoFinishOnEnd = true;

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return this.returnOnWrite;
  }

  end(): this {
    this.writableEnded = true;
    if (this.autoFinishOnEnd) {
      queueMicrotask(() => this.emit("finish"));
    }
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

describe("createAsyncDebugLogWriter", () => {
  it("reopens after a stream error once backoff elapses", async () => {
    const dir = makeTempDir("dbg-log-reopen-");
    const logPath = path.join(dir, "debug.log");
    const streams: FakeWriteStream[] = [];
    const warnings: string[] = [];
    let clock = 1000;
    try {
      const writer = createAsyncDebugLogWriter(logPath, (msg) => warnings.push(msg), {
        reopenBackoffMs: 500,
        now: () => clock,
        createStream: () => {
          const s = new FakeWriteStream();
          streams.push(s);
          return s as any;
        },
      });
      assert.equal(streams.length, 1);
      writer.write("first\n");
      assert.deepEqual(streams[0].writes, ["first\n"]);

      // Trigger stream error — subsequent writes during backoff are skipped cleanly
      streams[0].emit("error", new Error("ENOSPC"));
      assert.equal(warnings.length, 1);
      writer.write("during-backoff\n");
      assert.equal(streams.length, 1);

      // After backoff elapses, a fresh stream opens and logging resumes
      clock += 600;
      writer.write("recovered\n");
      assert.equal(streams.length, 2);
      assert.deepEqual(streams[1].writes, ["recovered\n"]);
      await writer.flush();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops lines under backpressure until drain and emits a dropped-count notice", async () => {
    const dir = makeTempDir("dbg-log-bp-");
    const logPath = path.join(dir, "debug.log");
    const fake = new FakeWriteStream();
    fake.returnOnWrite = false;
    try {
      const writer = createAsyncDebugLogWriter(logPath, () => {}, {
        createStream: () => fake as any,
      });

      writer.write("line-1\n");
      writer.write("line-2\n");
      writer.write("line-3\n");
      assert.deepEqual(fake.writes, ["line-1\n"]);
      assert.equal(writer.droppedCount, 2);

      fake.returnOnWrite = true;
      fake.emit("drain");
      assert.equal(writer.droppedCount, 0);
      assert.equal(fake.writes.length, 2);
      assert.match(fake.writes[1], /dropped 2 line\(s\)/);

      writer.write("line-4\n");
      assert.equal(fake.writes[2], "line-4\n");
      await writer.flush();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flushes buffered lines to disk and respects bounded timeout when drain stalls", async () => {
    const dir = makeTempDir("dbg-log-flush-");
    const logPath = path.join(dir, "debug.log");
    try {
      const writer = createAsyncDebugLogWriter(logPath, () => {});
      writer.write("alpha\n");
      writer.write("beta\n");
      await writer.flush(2000);
      assert.equal(readFileSync(logPath, "utf-8"), "alpha\nbeta\n");

      // Stalled end() must still resolve within timeoutMs
      const stalled = new FakeWriteStream();
      stalled.autoFinishOnEnd = false;
      const stalledWriter = createAsyncDebugLogWriter(logPath, () => {}, {
        createStream: () => stalled as any,
      });
      const start = Date.now();
      await stalledWriter.flush(40);
      assert.ok(Date.now() - start < 500);
      assert.equal(stalled.writableEnded, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
