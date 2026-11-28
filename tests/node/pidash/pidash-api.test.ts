import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { builtinModules } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import ts from "typescript";

import { createPidashApiRouter, PIDASH_API_ROUTES, type PidashApiDeps } from "../../../scripts/pidash-api.ts";
import { createDaemonServer } from "../../../scripts/daemon-shared.ts";
import { createAsyncAgentRegistry, registerPidashSession, type PiClient } from "../../../scripts/pidash-session-state.ts";
import { ComsRegistry } from "../../../extensions/coms/coms-registry.ts";
import {
  clearSettingsCache,
  setGlobalSettingsPath,
} from "../../../extensions/orchestrator/project-settings.ts";
import { MIN_PI_VERSION } from "../../../extensions/shared/pi-version.ts";
import { getLspBrokerSocketPath } from "../../../extensions/orchestrator/lsp.ts";

// ── Test harness ────────────────────────────────────────────────────

interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  bodyText: string;
  json: () => any;
}

function invokeRouter(
  router: ReturnType<typeof createPidashApiRouter>,
  opts: {
    urlPath: string;
    method?: string;
    remoteAddress?: string | undefined;
    origin?: string;
    host?: string;
  },
): Promise<{ handled: boolean; response: MockResponse }> {
  return new Promise((resolve) => {
    const headersMap: Record<string, string> = {};
    let statusCode = 0;
    let bodyText = "";
    let ended = false;

    const reqHeaders: Record<string, string> = {
      host: opts.host ?? "127.0.0.1:19190",
    };
    if (opts.origin !== undefined) reqHeaders.origin = opts.origin;

    const req = {
      method: opts.method ?? "GET",
      url: opts.urlPath,
      headers: reqHeaders,
      socket: { remoteAddress: "remoteAddress" in opts ? opts.remoteAddress : "127.0.0.1" },
    } as unknown as IncomingMessage;

    const res = {
      get writableEnded() {
        return ended;
      },
      setHeader(name: string, value: string | number | readonly string[]) {
        headersMap[name.toLowerCase()] = String(value);
      },
      writeHead(code: number, hdrs?: Record<string, string>) {
        statusCode = code;
        if (hdrs) {
          for (const [k, v] of Object.entries(hdrs)) {
            headersMap[k.toLowerCase()] = String(v);
          }
        }
      },
      end(chunk?: string | Buffer) {
        if (chunk !== undefined) bodyText += String(chunk);
        ended = true;
        resolve({
          handled: true,
          response: {
            statusCode,
            headers: headersMap,
            bodyText,
            json: () => JSON.parse(bodyText),
          },
        });
      },
    } as unknown as ServerResponse;

    const url = new URL(opts.urlPath, "http://127.0.0.1:19190");
    const handled = router(url, req, res);
    if (!handled) {
      resolve({
        handled: false,
        response: {
          statusCode: 0,
          headers: headersMap,
          bodyText: "",
          json: () => null,
        },
      });
    }
  });
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(repoDir: string): string {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "README.md"), "hello\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
}

function makeBaseDeps(rootDir: string, overrides: Partial<PidashApiDeps> = {}): PidashApiDeps {
  const comsDir = path.join(rootDir, "coms");
  const brokerRunDir = path.join(rootDir, "lsp-brokers");
  const homeDir = path.join(rootDir, "home");
  const pkgRoot = path.join(rootDir, "pkg");
  fs.mkdirSync(comsDir, { recursive: true });
  fs.mkdirSync(brokerRunDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(pkgRoot, { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "pi-orchestrator-config", version: "9.9.9" }));

  return {
    getPort: () => 19190,
    getPiClients: () => new Map<string, PiClient>(),
    getBrowserCount: () => 2,
    getAsyncAgents: () => [],
    defaultCwd: rootDir,
    comsDir,
    brokerRunDir,
    homeDir,
    packageRoot: pkgRoot,
    sidecarPort: 19999,
    now: () => 1_750_000_000_000,
    probeLocalHttp: async () => null,
    pingLspBroker: async () => null,
    execVersionCmd: async (cmd) => (cmd === "pi" ? "1.7.0" : cmd === "myk-pi-tools" ? "6.2.0" : null),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("pidash loopback /api/* surface", () => {
  let tmpRoot: string;
  let globalSettingsFile: string;

  beforeEach(() => {
    tmpRoot = makeTempDir("pidash-api-test-");
    globalSettingsFile = path.join(tmpRoot, "global-settings.json");
    fs.writeFileSync(globalSettingsFile, "{}", "utf8");
    setGlobalSettingsPath(globalSettingsFile);
    clearSettingsCache();
  });

  afterEach(() => {
    setGlobalSettingsPath(null);
    clearSettingsCache();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ── Security & HTTP method guards ─────────────────────────────────

  it("returns 403 for non-loopback IPv4 callers", async () => {
    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { handled, response } = await invokeRouter(router, {
      urlPath: "/api/version",
      remoteAddress: "192.168.1.50",
    });
    assert.equal(handled, true);
    assert.equal(response.statusCode, 403);
    assert.match(response.json().error, /loopback/i);
  });

  it("returns 403 when remoteAddress is missing", async () => {
    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: "/api/status",
      remoteAddress: undefined,
    });
    assert.equal(response.statusCode, 403);
  });

  it("allows IPv6 loopback callers", async () => {
    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: "/api/version",
      remoteAddress: "::1",
    });
    assert.equal(response.statusCode, 200);
  });

  it("returns 405 with Allow GET header for POST requests", async () => {
    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: "/api/peers",
      method: "POST",
    });
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers["allow"], "GET");
  });

  it("returns 405 for DELETE requests", async () => {
    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: "/api/settings",
      method: "DELETE",
    });
    assert.equal(response.statusCode, 405);
  });

  it("returns 403 for non-loopback Origin header", async () => {
    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: "/api/version",
      origin: "http://192.168.1.42:8080",
    });
    assert.equal(response.statusCode, 403);
    assert.match(response.json().error, /origin/i);
  });

  it("returns 403 for DNS-rebinding non-loopback Host header", async () => {
    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: "/api/status",
      host: "rebind.attacker.example:19190",
    });
    assert.equal(response.statusCode, 403);
    assert.match(response.json().error, /host/i);
  });

  it("allows loopback Origin header with no-store cache control", async () => {
    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: "/api/version",
      origin: "http://localhost:19190",
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["access-control-allow-origin"], "http://localhost:19190");
    assert.equal(response.headers["cache-control"], "no-store");
  });

  it("returns 405 on loopback OPTIONS through createDaemonServer HTTP pipeline", async () => {
    const deps = makeBaseDeps(tmpRoot);
    const router = createPidashApiRouter(deps);
    const { server } = createDaemonServer({
      port: 0,
      uiDir: tmpRoot,
      uiName: "test-ui",
      log: () => {},
      extraApiRoutes: router,
      onPiMessage: () => {},
      onPiClose: () => {},
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const addr = server.address();
      assert.ok(addr && typeof addr === "object");
      const res = await new Promise<{ status: number; allow?: string }>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: addr.port, method: "OPTIONS", path: "/api/peers" },
          (r) => {
            r.resume();
            r.on("end", () => resolve({ status: r.statusCode ?? 0, allow: r.headers.allow }));
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(res.status, 405);
      assert.equal(res.allow, "GET");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns 403 on non-loopback OPTIONS request", async () => {
    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: "/api/peers",
      method: "OPTIONS",
      remoteAddress: "192.168.1.50",
    });
    assert.equal(response.statusCode, 403);
  });

  it("returns false for unknown paths outside the 15 routes", async () => {
    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { handled } = await invokeRouter(router, { urlPath: "/api/unknown" });
    assert.equal(handled, false);
  });

  it("registers all 15 runtime endpoints plus preserved /api/podman-build-status", () => {
    assert.equal(PIDASH_API_ROUTES.size, 16);
    assert.equal(PIDASH_API_ROUTES.has("/api/podman-build-status"), true);
  });

  it("returns Podman image build status on /api/podman-build-status", async () => {
    const router = createPidashApiRouter(
      makeBaseDeps(tmpRoot, {
        readPodmanBuildStatus: () => ({ state: "building", step: "layer-2" }),
      }),
    );
    const { response } = await invokeRouter(router, { urlPath: "/api/podman-build-status" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { state: "building", step: "layer-2" });
  });

  it("returns 403 for non-loopback callers on /api/podman-build-status", async () => {
    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: "/api/podman-build-status",
      remoteAddress: "10.0.0.8",
    });
    assert.equal(response.statusCode, 403);
  });

  // ── cwd validation ────────────────────────────────────────────────

  it("returns 400 when cwd is relative", async () => {
    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, { urlPath: "/api/worktrees?cwd=relative/path" });
    assert.equal(response.statusCode, 400);
  });

  it("returns 400 when cwd is empty", async () => {
    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, { urlPath: "/api/tasks?cwd=" });
    assert.equal(response.statusCode, 400);
  });

  it("returns 400 when cwd does not exist", async () => {
    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const missing = path.join(tmpRoot, "does-not-exist");
    const { response } = await invokeRouter(router, {
      urlPath: `/api/memory?cwd=${encodeURIComponent(missing)}`,
    });
    assert.equal(response.statusCode, 400);
  });

  it("returns 400 when cwd points to a regular file", async () => {
    const filePath = path.join(tmpRoot, "plain.txt");
    fs.writeFileSync(filePath, "hi", "utf8");
    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: `/api/crons?cwd=${encodeURIComponent(filePath)}`,
    });
    assert.equal(response.statusCode, 400);
  });

  // ── 1. GET /api/peers ─────────────────────────────────────────────

  function seedPeersFixture(now = 1_750_000_000_000): PidashApiDeps {
    const deps = makeBaseDeps(tmpRoot, { now: () => now });
    const reg = new ComsRegistry(deps.comsDir!);

    const sockA = path.join(deps.comsDir!, "sockets", "a.sock");
    const sockB = path.join(deps.comsDir!, "sockets", "b.sock");
    const sockDead = path.join(deps.comsDir!, "sockets", "dead.sock");
    fs.mkdirSync(path.dirname(sockA), { recursive: true });
    fs.writeFileSync(sockA, "");
    fs.writeFileSync(sockB, "");
    fs.writeFileSync(sockDead, "");

    reg.writeEntryAtomic(
      {
        coms_session_id: "sid-a",
        name: "alpha",
        purpose: "build API",
        model: "gemini-4-neon",
        color: "#fff",
        pid: process.pid,
        endpoint: sockA,
        cwd: tmpRoot,
        started_at: new Date(now - 60_000).toISOString(),
        heartbeat_at: new Date(now - 5_000).toISOString(),
        explicit: true,
        version: 1,
        busy: true,
        context_used_pct: 42,
        queue_depth: 1,
        workload: { agents: 1, tasks: 2, crons: 0 },
      },
      "proj-a",
    );
    reg.writeEntryAtomic(
      {
        coms_session_id: "sid-b",
        name: "beta",
        purpose: "idle worker",
        model: "claude-sonnet",
        color: "#000",
        pid: process.pid,
        endpoint: sockB,
        cwd: tmpRoot,
        started_at: new Date(now - 30_000).toISOString(),
        heartbeat_at: new Date(now - 10_000).toISOString(),
        explicit: true,
        version: 1,
        busy: false,
        context_used_pct: 12,
        queue_depth: 0,
      },
      "proj-b",
    );
    reg.writeEntryAtomic(
      {
        coms_session_id: "sid-dead",
        name: "ghost",
        purpose: "expired",
        model: "m",
        color: "#000",
        pid: process.pid,
        endpoint: sockDead,
        cwd: tmpRoot,
        started_at: new Date(now - 600_000).toISOString(),
        heartbeat_at: new Date(now - 300_000).toISOString(),
        explicit: true,
        version: 1,
        busy: false,
      },
      "proj-a",
    );

    fs.mkdirSync(reg.peersDir(), { recursive: true });
    fs.writeFileSync(
      path.join(reg.peersDir(), "alpha@proj-a.json"),
      JSON.stringify({ cname: "alpha", project: "proj-a", container: "pi-peer-proj-a-alpha" }),
    );
    return deps;
  }

  it("returns total, busy, idle peer counts on /api/peers", async () => {
    const router = createPidashApiRouter(seedPeersFixture());
    const { response } = await invokeRouter(router, { urlPath: "/api/peers?project=*" });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.total, 2);
    assert.equal(data.busy, 1);
    assert.equal(data.idle, 1);
  });

  it("excludes stale-heartbeat peers on /api/peers", async () => {
    const router = createPidashApiRouter(seedPeersFixture());
    const { response } = await invokeRouter(router, { urlPath: "/api/peers?project=*" });
    assert.equal(response.statusCode, 200);
    const names = response.json().peers.map((p: any) => p.name);
    assert.equal(names.includes("ghost"), false);
  });

  it("returns per-peer live metadata fields on /api/peers", async () => {
    const router = createPidashApiRouter(seedPeersFixture());
    const { response } = await invokeRouter(router, { urlPath: "/api/peers?project=*" });
    assert.equal(response.statusCode, 200);
    const alpha = response.json().peers.find((p: any) => p.name === "alpha");
    assert.equal(alpha.project, "proj-a");
    assert.equal(alpha.busy, true);
    assert.equal(alpha.contextUsedPct, 42);
    assert.equal(alpha.queueDepth, 1);
    assert.deepEqual(alpha.workload, { agents: 1, tasks: 2, crons: 0 });
    assert.equal(alpha.alive, true);
  });

  it("maps supervision container name onto peer entries on /api/peers", async () => {
    const router = createPidashApiRouter(seedPeersFixture());
    const { response } = await invokeRouter(router, { urlPath: "/api/peers?project=*" });
    assert.equal(response.statusCode, 200);
    const alpha = response.json().peers.find((p: any) => p.name === "alpha");
    assert.equal(alpha.container, "pi-peer-proj-a-alpha");
  });

  it("returns legacy bare array on /api/peers when format=array is requested", async () => {
    const router = createPidashApiRouter(seedPeersFixture());
    const { response } = await invokeRouter(router, { urlPath: "/api/peers?format=array" });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(Array.isArray(data), true);
    assert.equal(data.length, 2);
  });

  it("filters /api/peers by project query parameter", async () => {
    const now = 1_750_000_000_000;
    const deps = makeBaseDeps(tmpRoot, { now: () => now });
    const reg = new ComsRegistry(deps.comsDir!);
    const sock = path.join(deps.comsDir!, "sockets", "only.sock");
    fs.mkdirSync(path.dirname(sock), { recursive: true });
    fs.writeFileSync(sock, "");

    reg.writeEntryAtomic(
      {
        coms_session_id: "s1",
        name: "p1",
        purpose: "work",
        model: "m",
        color: "#fff",
        pid: process.pid,
        endpoint: sock,
        cwd: tmpRoot,
        started_at: new Date(now - 10_000).toISOString(),
        heartbeat_at: new Date(now - 1_000).toISOString(),
        explicit: true,
        version: 1,
        busy: false,
      },
      "target-proj",
    );
    reg.writeEntryAtomic(
      {
        coms_session_id: "s2",
        name: "p2",
        purpose: "other",
        model: "m",
        color: "#fff",
        pid: process.pid,
        endpoint: sock,
        cwd: tmpRoot,
        started_at: new Date(now - 10_000).toISOString(),
        heartbeat_at: new Date(now - 1_000).toISOString(),
        explicit: true,
        version: 1,
        busy: false,
      },
      "other-proj",
    );

    const router = createPidashApiRouter(deps);
    const { response } = await invokeRouter(router, { urlPath: "/api/peers?project=target-proj" });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.project, "target-proj");
    assert.equal(data.total, 1);
    assert.equal(data.peers[0].name, "p1");
  });

  // ── 2. GET /api/worktrees ─────────────────────────────────────────

  it("returns worktrees with dirty counts, active COMS peers, ghostDirCount", async () => {
    const now = 1_750_000_000_000;
    const repoDir = path.join(tmpRoot, "repo");
    fs.mkdirSync(repoDir, { recursive: true });
    initGitRepo(repoDir);

    const linkedWt = path.join(repoDir, ".worktrees", "feat-x");
    execFileSync("git", ["worktree", "add", "-q", "-b", "feat/x", linkedWt], { cwd: repoDir });
    fs.writeFileSync(path.join(linkedWt, "dirty.txt"), "untracked\n", "utf8");
    // Unregistered ghost directory inside .worktrees/
    fs.mkdirSync(path.join(repoDir, ".worktrees", "stale-ghost"), { recursive: true });

    const deps = makeBaseDeps(tmpRoot, { now: () => now });
    const reg = new ComsRegistry(deps.comsDir!);
    const sock = path.join(deps.comsDir!, "sockets", "wt.sock");
    fs.mkdirSync(path.dirname(sock), { recursive: true });
    fs.writeFileSync(sock, "");
    reg.writeEntryAtomic(
      {
        coms_session_id: "s-wt",
        name: "peer-x",
        purpose: "wt work",
        model: "m",
        color: "#fff",
        pid: process.pid,
        endpoint: sock,
        cwd: linkedWt,
        started_at: new Date(now - 10_000).toISOString(),
        heartbeat_at: new Date(now - 1_000).toISOString(),
        explicit: true,
        version: 1,
        busy: true,
      },
      "repo",
    );

    const router = createPidashApiRouter(deps);
    const { response } = await invokeRouter(router, {
      urlPath: `/api/worktrees?cwd=${encodeURIComponent(repoDir)}`,
    });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.isGitRepo, true);
    assert.equal(data.count, 2);
    assert.equal(data.ghostDirCount, 1);

    const feat = data.worktrees.find((w: any) => w.branch === "feat/x");
    assert.ok(feat);
    assert.equal(feat.dirty, true);
    assert.equal(feat.changedFiles, 1);
    assert.equal(feat.isMain, false);
    assert.deepEqual(feat.activeComsPeers, ["peer-x"]);
  });

  it("returns empty worktrees payload for a non-git directory", async () => {
    const plainDir = path.join(tmpRoot, "plain");
    fs.mkdirSync(plainDir, { recursive: true });
    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: `/api/worktrees?cwd=${encodeURIComponent(plainDir)}`,
    });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.isGitRepo, false);
    assert.equal(data.count, 0);
    assert.deepEqual(data.worktrees, []);
  });

  // ── 3. GET /api/tasks ─────────────────────────────────────────────

  it("returns open, inProgress, userPending task counts without private descriptions", async () => {
    const projDir = path.join(tmpRoot, "proj-tasks");
    const tasksDir = path.join(projDir, ".pi", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, "tasks-sess1.json"),
      JSON.stringify({
        nextId: 5,
        tasks: [
          { id: "1", subject: "Merge PR", description: "SECRET_DESC", status: "pending", assignee: "user", blockedBy: [] },
          { id: "2", subject: "Run tests", description: "PRIVATE", status: "in_progress", assignee: "llm", blockedBy: ["1"] },
          { id: "3", subject: "Done item", description: "DONE", status: "completed", assignee: "llm", blockedBy: [] },
          { id: "4", subject: "Removed", description: "DEL", status: "deleted", assignee: "user", blockedBy: [] },
        ],
      }),
    );

    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: `/api/tasks?cwd=${encodeURIComponent(projDir)}&session=sess1`,
    });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.total, 3);
    assert.equal(data.open, 2);
    assert.equal(data.pending, 1);
    assert.equal(data.inProgress, 1);
    assert.equal(data.completed, 1);
    assert.equal(data.userPending, 1);
    assert.equal("description" in data.tasks[0], false);
    assert.equal(response.bodyText.includes("SECRET_DESC"), false);
  });

  it("filters /api/tasks by assignee query parameter", async () => {
    const projDir = path.join(tmpRoot, "proj-tasks-filter");
    const tasksDir = path.join(projDir, ".pi", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, "tasks.json"),
      JSON.stringify({
        nextId: 3,
        tasks: [
          { id: "1", subject: "Owner action", status: "pending", assignee: "user", blockedBy: [] },
          { id: "2", subject: "Agent action", status: "pending", assignee: "llm", blockedBy: [] },
        ],
      }),
    );

    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: `/api/tasks?cwd=${encodeURIComponent(projDir)}&assignee=user`,
    });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.total, 1);
    assert.equal(data.tasks[0].assignee, "user");
  });

  it("returns 400 on /api/tasks for invalid assignee value", async () => {
    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: `/api/tasks?cwd=${encodeURIComponent(tmpRoot)}&assignee=admin`,
    });
    assert.equal(response.statusCode, 400);
  });

  it("reads shared tasks.json with null sessionId when PI_TASK_SCOPE is project", async () => {
    const projDir = path.join(tmpRoot, "proj-tasks-scope");
    const tasksDir = path.join(projDir, ".pi", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, "tasks.json"),
      JSON.stringify({
        nextId: 2,
        tasks: [{ id: "1", subject: "Shared project task", status: "pending", assignee: "llm", blockedBy: [] }],
      }),
    );

    const router = createPidashApiRouter(makeBaseDeps(tmpRoot, { env: { PI_TASK_SCOPE: "project" } }));
    const { response } = await invokeRouter(router, {
      urlPath: `/api/tasks?cwd=${encodeURIComponent(projDir)}&session=sess1`,
    });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.total, 1);
    assert.equal(data.tasks[0].subject, "Shared project task");
    assert.equal(data.tasks[0].sessionId, null);
  });

  it("reads custom store path when PI_TASKS is configured", async () => {
    const projDir = path.join(tmpRoot, "proj-tasks-custom");
    const customPath = path.join(tmpRoot, "custom-tasks.json");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      customPath,
      JSON.stringify({
        nextId: 2,
        tasks: [{ id: "1", subject: "Custom store task", status: "in_progress", assignee: "user", blockedBy: [] }],
      }),
    );

    const router = createPidashApiRouter(makeBaseDeps(tmpRoot, { env: { PI_TASKS: customPath } }));
    const { response } = await invokeRouter(router, {
      urlPath: `/api/tasks?cwd=${encodeURIComponent(projDir)}`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().total, 1);
    assert.equal(response.json().tasks[0].subject, "Custom store task");
  });

  it("returns empty tasks when PI_TASKS is off", async () => {
    const projDir = path.join(tmpRoot, "proj-tasks-off");
    const tasksDir = path.join(projDir, ".pi", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, "tasks.json"),
      JSON.stringify({
        nextId: 2,
        tasks: [{ id: "1", subject: "Ignored task", status: "pending", assignee: "llm", blockedBy: [] }],
      }),
    );

    const router = createPidashApiRouter(makeBaseDeps(tmpRoot, { env: { PI_TASKS: "off" } }));
    const { response } = await invokeRouter(router, {
      urlPath: `/api/tasks?cwd=${encodeURIComponent(projDir)}`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().total, 0);
  });

  // ── 4. GET /api/agents ────────────────────────────────────────────

  it("returns running sync subagents alongside async jobs on /api/agents", async () => {
    const now = 1_750_000_050_000;
    const deps = makeBaseDeps(tmpRoot, {
      now: () => now,
      getSyncAgents: () => [
        {
          id: "sync-1",
          name: "python-expert",
          agent: "python-expert",
          mode: "sync",
          task: "PRIVATE_SYNC_TASK",
          cwd: tmpRoot,
          sessionId: "sess-sync",
          taskId: null,
          startedAt: now - 4_000,
          currentTool: "read",
          text: "",
        },
      ],
    });
    const router = createPidashApiRouter(deps);
    const { response } = await invokeRouter(router, { urlPath: "/api/agents?session=sess-sync" });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.count, 1);
    assert.equal(data.agents[0].mode, "sync");
    assert.equal(data.agents[0].elapsedMs, 4_000);
    assert.equal(data.agents[0].currentTool, "read");
  });

  it("returns live running agents with elapsedMs without private output text", async () => {
    const now = 1_750_000_050_000;
    const piClients = new Map<string, PiClient>();
    registerPidashSession(piClients, {}, { sessionId: "sess-1", cwd: tmpRoot }, () => {});

    const reg = createAsyncAgentRegistry(piClients, () => {});
    const fakeWs = {};
    reg.register(fakeWs, {
      id: "job-1",
      name: "PR Reviewer",
      agent: "code-reviewer-quality",
      mode: "async",
      task: "SECRET_TASK_BODY",
      cwd: tmpRoot,
      sessionId: "sess-1",
      taskId: "42",
      startedAt: now - 15_000,
    });
    reg.event(fakeWs, {
      id: "job-1",
      event: { type: "tool_execution_start", toolName: "bash" },
    });
    reg.event(fakeWs, {
      id: "job-1",
      event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "PRIVATE_TOOL_OUTPUT" } },
    });

    const deps = makeBaseDeps(tmpRoot, {
      now: () => now,
      getPiClients: () => piClients,
      getAsyncAgents: () => reg.agents.values(),
    });

    const router = createPidashApiRouter(deps);
    const { response } = await invokeRouter(router, { urlPath: "/api/agents?session=sess-1" });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.count, 1);
    assert.deepEqual(data.agents[0], {
      id: "job-1",
      name: "PR Reviewer",
      agent: "code-reviewer-quality",
      mode: "async",
      status: "running",
      elapsedMs: 15_000,
      currentTool: "bash",
      cwd: tmpRoot,
      taskId: "42",
      sessionId: "sess-1",
    });
    assert.equal(response.bodyText.includes("PRIVATE_TOOL_OUTPUT"), false);
  });

  // ── 5. GET /api/crons ─────────────────────────────────────────────

  it("returns scheduled crons without exposing raw prompt bodies", async () => {
    const projDir = path.join(tmpRoot, "proj-crons");
    const cronDir = path.join(projDir, ".pi", "cron");
    fs.mkdirSync(cronDir, { recursive: true });
    fs.writeFileSync(
      path.join(cronDir, "crons.json"),
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: "c1",
            scope: "project",
            cwd: projDir,
            description: "Check CI",
            task: "SECRET_CRON_PROMPT",
            intervalMs: 300_000,
            createdAt: 1_750_000_000_000,
            lastRun: 1_750_000_000_000,
            paused: false,
            quiet_on_noop: true,
            lastOutcome: "noop",
            runCount: 3,
          },
          {
            id: "c2",
            scope: "project",
            cwd: projDir,
            description: "Paused job",
            task: "ANOTHER_SECRET",
            intervalMs: 600_000,
            createdAt: 1_750_000_000_000,
            paused: true,
          },
        ],
      }),
    );

    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: `/api/crons?cwd=${encodeURIComponent(projDir)}`,
    });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.total, 2);
    assert.equal(data.active, 1);
    assert.equal(data.paused, 1);
    assert.equal(data.crons[0].intervalSeconds, 300);
    assert.equal(data.crons[0].persist, true);
    assert.equal(data.crons[0].quietOnNoop, true);
    assert.equal(data.crons[0].lastOutcome, "noop");
    assert.equal(response.bodyText.includes("SECRET_CRON_PROMPT"), false);
  });

  // ── 6. GET /api/lsp ───────────────────────────────────────────────

  it("reports LSP availability with existing broker sockets without spawning servers", async () => {
    const projDir = path.join(tmpRoot, "proj-lsp");
    fs.mkdirSync(projDir, { recursive: true });
    const pinged: string[] = [];
    const deps = makeBaseDeps(tmpRoot, {
      pingLspBroker: async (sock) => {
        pinged.push(sock);
        return { ok: true, pid: 12345 };
      },
    });

    const tsSocket = getLspBrokerSocketPath(projDir, "typescript", deps.brokerRunDir!);
    fs.writeFileSync(tsSocket, "");

    const router = createPidashApiRouter(deps);
    const { response } = await invokeRouter(router, {
      urlPath: `/api/lsp?cwd=${encodeURIComponent(projDir)}`,
    });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(typeof data.enabled, "boolean");
    assert.equal(Array.isArray(data.available), true);
    assert.equal(Array.isArray(data.missing), true);
    assert.equal(data.activeBrokers.length, 1);
    assert.equal(data.activeBrokers[0].serverId, "typescript");
    assert.equal(data.activeBrokers[0].alive, true);
    assert.equal(data.activeBrokers[0].pid, 12345);
    assert.equal(pinged.length, 1);
  });

  // ── 7. GET /api/settings ──────────────────────────────────────────

  it("redacts inline credentials plus secret keys on /api/settings", async () => {
    const projDir = path.join(tmpRoot, "proj-settings");
    fs.mkdirSync(path.join(projDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, ".pi", "pi-config-settings.json"),
      JSON.stringify({
        dangerous_command_allowlist: ["curl -H 'Authorization: Bearer ghp_1234567890abcdef' https://api.example.com"],
        dream_interval_hours: 6,
      }),
    );
    fs.writeFileSync(
      globalSettingsFile,
      JSON.stringify({
        discord_bot_token: "MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkw",
      }),
    );
    clearSettingsCache();

    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: `/api/settings?cwd=${encodeURIComponent(projDir)}&only_overrides=true`,
    });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.onlyOverrides, true);
    assert.equal(response.bodyText.includes("ghp_1234567890abcdef"), false);
    assert.equal(response.bodyText.includes("MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkw"), false);

    const allowlist = data.settings.find((s: any) => s.key === "dangerous_command_allowlist");
    assert.ok(allowlist);
    assert.equal(allowlist.source, "P");
    assert.match(allowlist.effective[0], /\[REDACTED\]/);

    const dreamHours = data.settings.find((s: any) => s.key === "dream_interval_hours");
    assert.ok(dreamHours);
    assert.equal(dreamHours.effective, 6);
    assert.equal(dreamHours.scopes.project, 6);
    assert.equal(dreamHours.scopes.default, 3);
  });

  it("filters /api/settings by category query parameter", async () => {
    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: `/api/settings?cwd=${encodeURIComponent(tmpRoot)}&category=LSP`,
    });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.ok(data.count > 0);
    assert.equal(data.settings.every((s: any) => s.category === "LSP"), true);
  });

  // ── 8. GET /api/memory ────────────────────────────────────────────

  it("returns topic count, budget percentage, dream watermark, pending promotions on /api/memory", async () => {
    const projDir = path.join(tmpRoot, "proj-mem");
    const topicsDir = path.join(projDir, ".pi", "memory", "topics");
    fs.mkdirSync(topicsDir, { recursive: true });
    fs.writeFileSync(path.join(topicsDir, "lessons.md"), "- [lesson] always test loopback guards\n", "utf8");
    fs.writeFileSync(path.join(projDir, ".pi", "memory", ".dream-watermark"), "2026-11-28T04:00:00.000Z\n", "utf8");
    fs.writeFileSync(
      path.join(projDir, ".pi", "memory", "promotions.md"),
      [
        "### promo-1",
        "- destination: enforcement",
        "- status: proposed",
        "- category: lesson",
        "- text: never run git add .",
        "- reason: repeated mistake",
        "- created: 2026-11-28T01:00:00.000Z",
        "- evidence_count: 3",
        "",
      ].join("\n"),
      "utf8",
    );

    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: `/api/memory?cwd=${encodeURIComponent(projDir)}`,
    });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.topicCount, 1);
    assert.equal(data.totalEntries, 1);
    assert.equal(typeof data.tokenBudgetPct, "number");
    assert.equal(data.lastDreamAt, "2026-11-28T04:00:00.000Z");
    assert.equal(data.autoDream.enabled, true);
    assert.equal(data.pendingPromotionsCount, 1);
  });

  it("does not create .pi/memory directory on read-only /api/memory requests", async () => {
    const cleanDir = path.join(tmpRoot, "clean-mem");
    fs.mkdirSync(cleanDir, { recursive: true });
    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: `/api/memory?cwd=${encodeURIComponent(cleanDir)}`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().topicCount, 0);
    assert.equal(fs.existsSync(path.join(cleanDir, ".pi")), false);
  });

  it("leaves legacy memory scores unmigrated on /api/memory GET", async () => {
    const projDir = path.join(tmpRoot, "proj-mem-legacy");
    const topicsDir = path.join(projDir, ".pi", "memory", "topics");
    const dataDir = path.join(projDir, ".pi", "data");
    fs.mkdirSync(topicsDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(topicsDir, "lessons.md"), "- [lesson] keep GET read-only\n", "utf8");
    const legacyScoresPath = path.join(dataDir, "memory-scores.json");
    const legacyContent = JSON.stringify({ entries: { deadbeef: { topic: "lessons", stability: 1 } } });
    fs.writeFileSync(legacyScoresPath, legacyContent, "utf8");

    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: `/api/memory?cwd=${encodeURIComponent(projDir)}`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(fs.existsSync(path.join(dataDir, "state.db")), false);
    assert.equal(fs.readFileSync(legacyScoresPath, "utf8"), legacyContent);
  });

  // ── 9. GET /api/review ────────────────────────────────────────────

  it("returns normalized review loop status on /api/review", async () => {
    const projDir = path.join(tmpRoot, "proj-review");
    const dataDir = path.join(projDir, ".pi", "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "pi-config-review-state.json"),
      JSON.stringify({
        status: "has_findings",
        cycle: 2,
        subject: { kind: "local", head_sha: "abc1234" },
        findings_count: 3,
        reviewers_pending: [],
        tests_passed: false,
      }),
    );

    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: `/api/review?cwd=${encodeURIComponent(projDir)}`,
    });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.enabled, false);
    assert.equal(data.status, "findings");
    assert.equal(data.lastReviewedSha, "abc1234");
    assert.equal(data.cycle, 2);
    assert.equal(data.findingsCount, 3);
    // Strictly read-only: must not create state.db or review-tracked marker
    assert.equal(fs.existsSync(path.join(dataDir, "state.db")), false);
    assert.equal(fs.existsSync(path.join(dataDir, "review-tracked")), false);
  });

  it("does not create .pi/data directory on read-only /api/review requests", async () => {
    const cleanDir = path.join(tmpRoot, "clean-review");
    fs.mkdirSync(cleanDir, { recursive: true });
    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: `/api/review?cwd=${encodeURIComponent(cleanDir)}`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "none");
    assert.equal(fs.existsSync(path.join(cleanDir, ".pi")), false);
  });

  // ── 10. GET /api/trail ────────────────────────────────────────────

  it("returns indexed status, fileCount, sessionTokenSavings on /api/trail", async () => {
    const projDir = path.join(tmpRoot, "proj-trail");
    const graphDir = path.join(projDir, ".trail", "cache", ".graph");
    const tmpDir = path.join(projDir, ".pi", "tmp");
    fs.mkdirSync(graphDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      path.join(graphDir, "wiring.json"),
      JSON.stringify({
        nodes: [
          { id: "1", name: "a", path: "src/a.ts" },
          { id: "2", name: "b", path: "src/a.ts" },
          { id: "3", name: "c", path: "src/b.ts" },
        ],
        meta: { nodeCount: 3 },
      }),
    );
    const hash = createHash("sha256").update("sess-trail").digest("hex");
    fs.writeFileSync(path.join(tmpDir, `trail-savings-${hash}.json`), JSON.stringify({ tokenSavings: 4200 }));

    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: `/api/trail?cwd=${encodeURIComponent(projDir)}&session=sess-trail`,
    });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.status, "indexed");
    assert.equal(data.fileCount, 2);
    assert.equal(data.nodeCount, 3);
    assert.equal(data.sessionTokenSavings, 4200);
  });

  it("reports missing status on /api/trail when wiring.json is absent", async () => {
    const projDir = path.join(tmpRoot, "proj-trail-missing");
    fs.mkdirSync(projDir, { recursive: true });
    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: `/api/trail?cwd=${encodeURIComponent(projDir)}`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "missing");
    assert.equal(response.json().fileCount, 0);
  });

  it("reports stale status on /api/trail when git index is newer than wiring.json", async () => {
    const repoDir = path.join(tmpRoot, "proj-trail-stale");
    fs.mkdirSync(repoDir, { recursive: true });
    initGitRepo(repoDir);
    const graphDir = path.join(repoDir, ".trail", "cache", ".graph");
    fs.mkdirSync(graphDir, { recursive: true });
    const wiringPath = path.join(graphDir, "wiring.json");
    fs.writeFileSync(wiringPath, JSON.stringify({ nodes: [{ id: "1", name: "a", path: "README.md" }], meta: { nodeCount: 1 } }));
    const oldTime = new Date(Date.now() - 60_000);
    fs.utimesSync(wiringPath, oldTime, oldTime);

    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: `/api/trail?cwd=${encodeURIComponent(repoDir)}`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "stale");
    assert.equal(response.json().fileCount, 1);
  });

  // ── 11. GET /api/skills ───────────────────────────────────────────

  it("classifies adopted, unmarked adoptable, package skills on /api/skills", async () => {
    const projDir = path.join(tmpRoot, "proj-skills");
    const deps = makeBaseDeps(tmpRoot);

    const adoptedDir = path.join(projDir, ".pi", "skills", "my-adopted");
    const unmarkedDir = path.join(projDir, ".pi", "skills", "my-unmarked");
    const pkgSkillDir = path.join(deps.packageRoot!, "skills", "bundled-skill");
    fs.mkdirSync(adoptedDir, { recursive: true });
    fs.mkdirSync(unmarkedDir, { recursive: true });
    fs.mkdirSync(pkgSkillDir, { recursive: true });

    fs.writeFileSync(path.join(adoptedDir, "SKILL.md"), "---\nname: my-adopted\nskill-maintenance: auto\n---\nbody\n");
    fs.writeFileSync(path.join(unmarkedDir, "SKILL.md"), "---\nname: my-unmarked\n---\nbody\n");
    fs.writeFileSync(path.join(pkgSkillDir, "SKILL.md"), "---\nname: bundled-skill\n---\nbody\n");

    const router = createPidashApiRouter(deps);
    const { response } = await invokeRouter(router, {
      urlPath: `/api/skills?cwd=${encodeURIComponent(projDir)}`,
    });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.total, 3);
    assert.deepEqual(data.adopted, ["my-adopted"]);
    assert.deepEqual(data.unmarkedAdoptable, ["my-unmarked"]);
    const pkgEntry = data.loaded.find((s: any) => s.name === "bundled-skill");
    assert.equal(pkgEntry.adoptable, false);
  });

  // ── 12. GET /api/daemons ──────────────────────────────────────────

  it("reports pidash, pidiff, piSidecar health on /api/daemons", async () => {
    const projDir = path.join(tmpRoot, "proj-daemons");
    const runDir = path.join(projDir, ".pi", "run");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "pidiff.port"), "19291\n");
    fs.writeFileSync(path.join(runDir, "pidiff.pid"), "55555\n");

    const deps = makeBaseDeps(tmpRoot, {
      sidecarPort: 9100,
      probeLocalHttp: async (port, urlPath) => {
        if (port === 19291 && urlPath === "/api/health") {
          return { ok: true, status: 200, body: { status: "ok", port: 19291 } };
        }
        if (port === 9100 && urlPath === "/health") {
          return { ok: true, status: 200, body: { status: "ok", sessions: 1 } };
        }
        return null;
      },
    });

    const router = createPidashApiRouter(deps);
    const { response } = await invokeRouter(router, {
      urlPath: `/api/daemons?cwd=${encodeURIComponent(projDir)}`,
    });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.pidash.running, true);
    assert.equal(data.pidash.port, 19190);
    assert.equal(data.pidiff.running, true);
    assert.equal(data.pidiff.port, 19291);
    assert.equal(data.pidiff.pid, 55555);
    assert.equal(data.piSidecar.running, true);
    assert.equal(data.piSidecar.port, 9100);
  });

  it("reports pidash degraded on /api/daemons when startupError is present", async () => {
    const router = createPidashApiRouter(
      makeBaseDeps(tmpRoot, {
        getStartupError: () => "discord login failed",
      }),
    );
    const { response } = await invokeRouter(router, {
      urlPath: `/api/daemons?cwd=${encodeURIComponent(tmpRoot)}`,
    });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.pidash.healthy, false);
    assert.equal(data.pidash.status, "degraded");
    assert.equal(data.pidash.startupError, "discord login failed");
  });

  // ── 13. GET /api/security ─────────────────────────────────────────

  it("reads an unmigrated state.db on /api/security without creating tables or WAL files", async () => {
    const projDir = path.join(tmpRoot, "proj-sec-ro-db");
    const dataDir = path.join(projDir, ".pi", "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, "state.db");
    const initDb = new DatabaseSync(dbPath);
    initDb.exec("CREATE TABLE legacy_only (id INTEGER PRIMARY KEY)");
    initDb.close();
    const beforeBytes = fs.readFileSync(dbPath);

    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: `/api/security?cwd=${encodeURIComponent(projDir)}`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().restricted_folders.persistentApprovalCount, 0);
    assert.equal(response.json().tool_permissions.hostGrantCount, 0);
    assert.equal(fs.existsSync(`${dbPath}-wal`), false);
    assert.equal(fs.existsSync(`${dbPath}-shm`), false);
    assert.deepEqual(fs.readFileSync(dbPath), beforeBytes);
  });

  it("returns policy counts without exposing restricted folder paths or secrets on /api/security", async () => {
    const projDir = path.join(tmpRoot, "proj-sec");
    fs.mkdirSync(path.join(projDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, ".pi", "pi-config-settings.json"),
      JSON.stringify({
        secret_obfuscation: true,
        restricted_folders: ["/home/alice/super-secret-vault", "/etc/private-keys"],
        tool_permissions: {
          bash: "ask",
          fetch_content: { "example.com": "allow", "*": "ask" },
        },
        turn_snapshots: true,
        advisor_enabled: true,
        advisor_model: "google/gemini-2.5-flash",
      }),
    );
    clearSettingsCache();

    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: `/api/security?cwd=${encodeURIComponent(projDir)}`,
    });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.secret_obfuscation, true);
    assert.equal(data.restricted_folders.count, 2);
    assert.equal(data.tool_permissions.ruleCount, 3);
    assert.equal(data.tool_permissions.hostGrantCount, 0);
    assert.equal(data.turn_snapshots.enabled, true);
    assert.equal(data.turn_snapshots.depth, 20);
    assert.equal(data.advisor.enabled, true);
    assert.equal(data.advisor.model, "google/gemini-2.5-flash");
    assert.equal(response.bodyText.includes("super-secret-vault"), false);
    assert.equal(response.bodyText.includes("private-keys"), false);
  });

  // ── 14. GET /api/version ──────────────────────────────────────────

  it("returns runtime versions including MIN_PI_VERSION on /api/version", async () => {
    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, { urlPath: "/api/version" });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.minPiVersion, MIN_PI_VERSION);
    assert.equal(data.piOrchestratorConfig, "9.9.9");
    assert.equal(data.mykPiTools, "6.2.0");
    assert.equal(data.node, process.version);
    assert.ok(typeof data.pi === "string" && data.pi.length > 0);
  });

  // ── 15. GET /api/status ───────────────────────────────────────────

  it("aggregates sessions with all 14 domains in one /api/status response", async () => {
    const projDir = path.join(tmpRoot, "proj-status");
    fs.mkdirSync(projDir, { recursive: true });
    const router = createPidashApiRouter(makeBaseDeps(tmpRoot));
    const { response } = await invokeRouter(router, {
      urlPath: `/api/status?cwd=${encodeURIComponent(projDir)}&project=*`,
    });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    for (const key of [
      "timestamp",
      "cwd",
      "project",
      "sessions",
      "peers",
      "worktrees",
      "tasks",
      "agents",
      "crons",
      "lsp",
      "settings",
      "memory",
      "review",
      "trail",
      "skills",
      "daemons",
      "security",
      "version",
    ]) {
      assert.ok(key in data, `missing domain key '${key}' in /api/status`);
    }
  });

  // ── Static transitive import guard ────────────────────────────────

  it("keeps scripts/pidash-server.ts free of runtime @earendil-works/* or typebox imports", () => {
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
    const entry = path.join(repoRoot, "scripts", "pidash-server.ts");
    const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

    function resolveLocal(fromFile: string, spec: string): string | null {
      const base = path.resolve(path.dirname(fromFile), spec);
      const candidates = [
        base,
        base.replace(/\.js$/, ".ts"),
        base.replace(/\.mjs$/, ".mts"),
        `${base}.ts`,
        `${base}.js`,
        `${base}.mjs`,
        path.join(base, "index.ts"),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
      }
      return null;
    }

    function extractRuntimeImports(filePath: string): string[] {
      const source = fs.readFileSync(filePath, "utf8");
      const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
      const specs: string[] = [];

      function visit(node: ts.Node): void {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const clause = node.importClause;
          const isTypeOnly = Boolean(
            clause &&
              (clause.isTypeOnly ||
                (!clause.name &&
                  clause.namedBindings &&
                  ts.isNamedImports(clause.namedBindings) &&
                  clause.namedBindings.elements.length > 0 &&
                  clause.namedBindings.elements.every((el) => el.isTypeOnly))),
          );
          if (!isTypeOnly) specs.push(node.moduleSpecifier.text);
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const isTypeOnly = Boolean(
            node.isTypeOnly ||
              (node.exportClause &&
                ts.isNamedExports(node.exportClause) &&
                node.exportClause.elements.length > 0 &&
                node.exportClause.elements.every((el) => el.isTypeOnly)),
          );
          if (!isTypeOnly) specs.push(node.moduleSpecifier.text);
        } else if (ts.isCallExpression(node)) {
          const arg0 = node.arguments[0];
          if (arg0 && ts.isStringLiteral(arg0)) {
            if (
              node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) &&
                (node.expression.text === "require" || node.expression.text === "_require"))
            ) {
              specs.push(arg0.text);
            }
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(sf);
      return specs;
    }

    const visited = new Set<string>();
    const violations: string[] = [];

    function walk(filePath: string, chain: string[]): void {
      const abs = path.resolve(filePath);
      if (visited.has(abs)) return;
      visited.add(abs);
      for (const spec of extractRuntimeImports(abs)) {
        if (spec.startsWith("@earendil-works/") || spec === "typebox") {
          violations.push([...chain, spec].join(" -> "));
        } else if (spec.startsWith(".")) {
          const next = resolveLocal(abs, spec);
          if (next) walk(next, [...chain, path.relative(repoRoot, next)]);
        } else if (!builtins.has(spec)) {
          // Verify external runtime dependencies exist in package.json dependencies (not peer/dev only)
          const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
          const pkgName = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
          if (!pkg.dependencies?.[pkgName]) {
            violations.push([...chain, `${spec} (missing from package.json dependencies)`].join(" -> "));
          }
        }
      }
    }

    walk(entry, ["scripts/pidash-server.ts"]);
    assert.ok(visited.size > 10, "expected transitive walk to traverse pidash-server modules");
    assert.deepEqual(violations, []);
  });
});
