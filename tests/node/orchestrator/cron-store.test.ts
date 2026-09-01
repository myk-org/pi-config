import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import {
  acquireLeaderLock,
  mutateDurableCronStore,
  processStartToken,
  readDurableCronStore,
  resolveProcessStartToken,
  refreshLeaderLock,
  releaseLeaderLock,
  type DurableCronTask,
} from "../../../extensions/orchestrator/cron-store.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cron-store-"));
  dirs.push(dir);
  return path.join(dir, "crons.json");
}

function task(id = "task-1", cwd = "/saved/project"): DurableCronTask {
  return { id, scope: "project", cwd, description: "check", task: "check status", intervalMs: 10_000, createdAt: 1 };
}

function runMutationWorker(store: string, worker: string, count: number): Promise<void> {
  const fixture = fileURLToPath(new URL("./fixtures/cron-store-mutate-worker.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", fixture, store, worker, String(count)], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`worker ${worker} exited ${code}: ${stderr}`)));
  });
}

function writeLockOwner(store: string, kind: "leader" | "mutation", owner: object) {
  const dir = `${store}.${kind}.lock`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify(owner));
}

describe("durable cron store", () => {
  it("writes a versioned envelope atomically and preserves the captured cwd", () => {
    const store = tempStore();
    mutateDurableCronStore(store, (tasks) => [...tasks, task()]);
    assert.deepEqual(readDurableCronStore(store).tasks, [task()]);
    assert.equal(JSON.parse(fs.readFileSync(store, "utf8")).version, 1);
  });

  it("serializes simultaneous cross-process mutations without losing tasks", async () => {
    const store = tempStore();
    const mutationsPerWorker = 12;
    await Promise.all([runMutationWorker(store, "one", mutationsPerWorker), runMutationWorker(store, "two", mutationsPerWorker)]);
    const tasks = readDurableCronStore(store).tasks;
    assert.equal(tasks.length, mutationsPerWorker * 2);
    assert.equal(new Set(tasks.map((stored) => stored.id)).size, mutationsPerWorker * 2);
  });

  it("reclaims a crashed mutation lease before a new transaction", () => {
    const store = tempStore();
    writeLockOwner(store, "mutation", { pid: 999_999_999, process_start_token: "dead", instance_id: "crashed", heartbeat_at: new Date(0).toISOString() });
    mutateDurableCronStore(store, (tasks) => [...tasks, task("recovered")]);
    assert.deepEqual(readDurableCronStore(store).tasks, [task("recovered")]);
    assert.equal(fs.existsSync(`${store}.mutation.lock`), false);
  });

  it("does not reclaim a fresh ownerless leader lock", () => {
    const store = tempStore();
    const dir = `${store}.leader.lock`;
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(acquireLeaderLock(store, "follower"), null);
    assert.equal(fs.existsSync(dir), true);
  });

  it("does not reclaim a live mutation owner", () => {
    const store = tempStore();
    writeLockOwner(store, "mutation", { pid: process.pid, process_start_token: processStartToken(), instance_id: "live", heartbeat_at: new Date().toISOString() });
    assert.throws(() => mutateDurableCronStore(store, (tasks) => [...tasks, task("must-not-write")]), /Timed out waiting for cron storage lock/);
    assert.deepEqual(readDurableCronStore(store).tasks, []);
  });

  it("keeps stores, captured cwd values, and removal targets isolated", () => {
    const firstStore = tempStore();
    const secondStore = tempStore();
    mutateDurableCronStore(firstStore, (tasks) => [
      ...tasks,
      task("remove-me", "/projects/first"),
      task("keep-me", "/projects/other"),
    ]);
    mutateDurableCronStore(secondStore, (tasks) => [...tasks, task("second", "/projects/second")]);
    mutateDurableCronStore(firstStore, (tasks) => tasks.filter((stored) => stored.id !== "remove-me"));
    assert.deepEqual(readDurableCronStore(firstStore).tasks, [task("keep-me", "/projects/other")]);
    assert.deepEqual(readDurableCronStore(secondStore).tasks, [task("second", "/projects/second")]);
  });

  it("rejects invalid durable tasks without changing the store", () => {
    const store = tempStore();
    mutateDurableCronStore(store, (tasks) => [...tasks, task()]);
    assert.throws(() => mutateDurableCronStore(store, () => [{ ...task(), scope: "global" as any }]), /Invalid durable cron task/);
    assert.throws(() => mutateDurableCronStore(store, () => [{ ...task(), cwd: "" }]), /Invalid durable cron task/);
    assert.deepEqual(readDurableCronStore(store).tasks, [task()]);
  });

  it("keeps the canonical leader lock present during cross-process contention", async () => {
    const store = tempStore();
    const fixture = fileURLToPath(new URL("./fixtures/cron-store-leader-worker.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", fixture, store, "leader"], { stdio: ["pipe", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`leader exited ${code}`)));
    });
    const dir = `${store}.leader.lock`;
    for (let attempt = 0; attempt < 50; attempt++) {
      assert.equal(acquireLeaderLock(store, `contender-${attempt}`), null);
      assert.equal(fs.existsSync(dir), true);
    }
    child.stdin.write("release\n");
    await new Promise<void>((resolve, reject) => child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`leader exited ${code}`))));
  });

  it("hands leadership to a follower after the owner releases", () => {
    const store = tempStore();
    const owner = acquireLeaderLock(store, "leader");
    assert.ok(owner);
    assert.equal(releaseLeaderLock(store, owner), true);
    const follower = acquireLeaderLock(store, "follower");
    assert.ok(follower);
    releaseLeaderLock(store, follower);
  });

  it("closes a locally owned descriptor when lock removal fails", () => {
    const store = tempStore();
    const owner = acquireLeaderLock(store, "owner");
    assert.ok(owner?.fd !== undefined);
    fs.rmSync(`${store}.leader.lock`, { recursive: true });
    assert.equal(releaseLeaderLock(store, owner!), false);
    assert.throws(() => fs.fstatSync(owner!.fd!), { code: "EBADF" });
  });

  it("allows only its owner to refresh or release a leader lock", () => {
    const store = tempStore();
    const first = acquireLeaderLock(store, "one");
    assert.ok(first);
    assert.equal(acquireLeaderLock(store, "two"), null);
    assert.equal(refreshLeaderLock(store, { ...first, instance_id: "not-owner" }), false);
    releaseLeaderLock(store, { ...first, instance_id: "not-owner" });
    assert.doesNotThrow(() => fs.fstatSync(first!.fd!), "a non-owner probe must not close the owner's descriptor");
    assert.equal(acquireLeaderLock(store, "two"), null);
    assert.equal(refreshLeaderLock(store, first!), true);
    releaseLeaderLock(store, first);
    const follower = acquireLeaderLock(store, "two");
    assert.ok(follower, "a follower takes leadership after the owner releases");
    releaseLeaderLock(store, follower);
  });

  it("reclaims dead locks but never takes over a live owner with an expired heartbeat", () => {
    const store = tempStore();
    writeLockOwner(store, "leader", { pid: 999_999_999, process_start_token: "dead", instance_id: "dead", heartbeat_at: new Date().toISOString() });
    const reclaimedDead = acquireLeaderLock(store, "reclaimer");
    assert.ok(reclaimedDead);
    releaseLeaderLock(store, reclaimedDead);

    writeLockOwner(store, "leader", { pid: process.pid, process_start_token: "wrong-token", instance_id: "reused", heartbeat_at: new Date().toISOString() });
    const reclaimedReusedPid = acquireLeaderLock(store, "reclaimer");
    assert.ok(reclaimedReusedPid);
    releaseLeaderLock(store, reclaimedReusedPid);

    const live = acquireLeaderLock(store, "live");
    assert.ok(live);
    // This is the stale-takeover/heartbeat race: a contender sees an old lease,
    // while its still-live owner renews. A lease alone must not permit replacement.
    live!.heartbeat_at = new Date(Date.now() - 31_000).toISOString();
    fs.writeFileSync(path.join(`${store}.leader.lock`, "owner.json"), JSON.stringify(live));
    assert.equal(acquireLeaderLock(store, "follower"), null);
    assert.equal(refreshLeaderLock(store, live!), true);
    assert.equal(acquireLeaderLock(store, "follower"), null);
    releaseLeaderLock(store, live);
  });

  it("fails leadership closed without a reliable process identity but still mutates the store", () => {
    const unavailable = {
      platform: "darwin" as const,
      readFileSync: () => { throw new Error("no procfs"); },
      execFileSync: () => "not trustworthy",
    };
    const store = tempStore();
    assert.equal(acquireLeaderLock(store, "leader", unavailable), null);
    mutateDurableCronStore(store, (tasks) => [...tasks, task()]);
    mutateDurableCronStore(store, (tasks) => tasks.filter((stored) => stored.id !== "task-1"));
    assert.deepEqual(readDurableCronStore(store).tasks, []);
  });

  it("uses Windows process creation time when procfs is unavailable", () => {
    assert.equal(resolveProcessStartToken(42, {
      platform: "win32",
      readFileSync: () => { throw new Error("no procfs"); },
      execFileSync: () => "133700000000000000\r\n",
    }), "win:133700000000000000");
  });

  it("migrates the early array format", () => {
    const store = tempStore();
    fs.writeFileSync(store, JSON.stringify([task("legacy")]));
    assert.deepEqual(readDurableCronStore(store), { version: 1, tasks: [task("legacy")] });
  });

  it("treats corrupt storage as empty", () => {
    const store = tempStore();
    fs.writeFileSync(store, "not json");
    assert.deepEqual(readDurableCronStore(store), { version: 1, tasks: [] });
  });

  for (const [kind, record] of [
    ["leader", undefined], ["leader", "{"], ["leader", JSON.stringify({ pid: 1 })],
    ["mutation", undefined], ["mutation", "{"], ["mutation", JSON.stringify({ pid: 1 })],
  ] as const) it(`reclaims an old ${kind} lock with ${record === undefined ? "no" : "invalid"} owner`, () => {
    const store = tempStore();
    const dir = `${store}.${kind}.lock`;
    fs.mkdirSync(dir, { recursive: true });
    if (record !== undefined) fs.writeFileSync(path.join(dir, "owner.json"), record);
    fs.utimesSync(dir, new Date(0), new Date(0));
    if (kind === "leader") {
      const owner = acquireLeaderLock(store, "reclaimer");
      assert.ok(owner); releaseLeaderLock(store, owner);
    } else {
      mutateDurableCronStore(store, (tasks) => [...tasks, task("recovered")]);
      assert.deepEqual(readDurableCronStore(store).tasks, [task("recovered")]);
    }
  });
});
