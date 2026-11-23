#!/usr/bin/env node
/**
 * Deterministic $0 PR retrospective telemetry collector (issue #1343).
 *
 * Collects PR metadata, commits, review findings, CI check outcomes, recent Pi
 * session JSONL stats, steering-file sizes, and CI/lint config presence into a
 * compact (~3-5 KB) JSON digest with zero LLM calls.
 *
 * Usage:
 *   node scripts/pr-retro-collect.mjs [--pr <number>] [--cwd <dir>] [--repo <owner/repo>]
 *                                     [--sessions-dir <dir>] [--force] [--no-record]
 *                                     [--mark-done] [--max-bytes <n>]
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../extensions/shared/install-logger.mjs";

const log = createLogger("pr-retro-collect");

export const STATE_FILE_NAME = "pr-retro-state.json";
export const MAX_STATE_ENTRIES = 500;
export const DEFAULT_MAX_DIGEST_BYTES = 5120;
export const LARGE_OUTPUT_THRESHOLD_BYTES = 4096;
export const TRIVIAL_MAX_CHANGED_LINES = 20;
const MAX_MATCHED_SESSIONS = 20;
const MAX_INSPECTED_SESSIONS = 200;
const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const SESSION_WINDOW_PAD_MS = 60 * 60 * 1000;
const STATE_LOCK_STALE_MS = 30_000;
const STATE_LOCK_RETRIES = 40;
const STATE_LOCK_WAIT_MS = 25;

const VERSION_BUMP_TITLE_RE =
  /^(?:chore(?:\([^)]*\))?:\s*bump\s+version\b|release\s+v?\d|chore\(release\):)/i;
const VERSION_BUMP_BRANCH_RE = /^(?:chore\/bump-version|release\/)/i;
const TASK_TOOLS = new Set([
  "TaskList",
  "TaskCreate",
  "TaskBulkCreate",
  "TaskUpdate",
  "TaskBulkUpdate",
  "TaskBulkDelete",
  "TaskGet",
]);

function syncSleepMs(ms) {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

function defaultExec(cmd, args, cwd, timeout = 15_000) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function parseCliArgs(argv) {
  const opts = {
    pr: null,
    cwd: process.cwd(),
    repo: null,
    sessionsDir: null,
    force: false,
    record: true,
    markDone: false,
    maxBytes: DEFAULT_MAX_DIGEST_BYTES,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--pr" && argv[i + 1]) {
      opts.pr = argv[++i].replace(/^#/, "");
    } else if (arg === "--cwd" && argv[i + 1]) {
      opts.cwd = resolve(argv[++i]);
    } else if (arg === "--repo" && argv[i + 1]) {
      opts.repo = argv[++i].trim();
    } else if (arg === "--sessions-dir" && argv[i + 1]) {
      opts.sessionsDir = resolve(argv[++i]);
    } else if (arg === "--force") {
      opts.force = true;
    } else if (arg === "--no-record") {
      opts.record = false;
    } else if (arg === "--mark-done") {
      opts.markDone = true;
    } else if (arg === "--max-bytes" && argv[i + 1]) {
      const n = Number.parseInt(argv[++i], 10);
      if (Number.isInteger(n) && n >= 1024 && n <= 32768) opts.maxBytes = n;
    }
  }
  return opts;
}

export function resolveMainRepoRoot(cwd, execFn = defaultExec) {
  const abs = resolve(cwd);
  try {
    const out = execFn("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], abs, 3000).trim();
    if (out && !out.startsWith("fatal")) return dirname(out);
  } catch {
    try {
      const out = execFn("git", ["rev-parse", "--git-common-dir"], abs, 3000).trim();
      if (out && !out.startsWith("fatal")) return dirname(resolve(abs, out));
    } catch {
      log.debug("resolve_main_repo_root_fallback", { cwd: abs });
    }
  }
  return abs;
}

export function parseOwnerRepoFromUrl(url) {
  if (typeof url !== "string" || !url.trim()) return null;
  const trimmed = url.trim();
  const ghUrl = trimmed.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git|\/pull\/\d+|\/|$)/i);
  if (!ghUrl) return null;
  return `${ghUrl[1]}/${ghUrl[2].replace(/\.git$/i, "")}`;
}

export function resolveRepoSlug(cwd, explicitRepo, execFn = defaultExec) {
  if (typeof explicitRepo === "string" && /^[\w.-]+\/[\w.-]+$/.test(explicitRepo.trim())) {
    return explicitRepo.trim();
  }
  try {
    const remote = execFn("git", ["remote", "get-url", "origin"], cwd, 3000).trim();
    const parsed = parseOwnerRepoFromUrl(remote);
    if (parsed) return parsed;
  } catch {
    log.debug("resolve_repo_slug_git_failed", { cwd });
  }
  return null;
}

export function makeRetroKey(repoSlug, prNumber) {
  return `${repoSlug || "local"}#${prNumber}`;
}

export function flattenSlurpedPages(parsed) {
  if (!Array.isArray(parsed)) return [];
  if (parsed.length > 0 && parsed.every((item) => Array.isArray(item))) {
    return parsed.flat();
  }
  return parsed;
}

export function loadRetroState(dataDir) {
  const filePath = join(dataDir, STATE_FILE_NAME);
  if (!existsSync(filePath)) return { version: 1, retroed: {} };
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    if (raw && typeof raw === "object" && raw.retroed && typeof raw.retroed === "object") {
      return { version: 1, retroed: { ...raw.retroed } };
    }
  } catch (err) {
    log.warn("load_retro_state_failed", { filePath, error: String(err?.message ?? err).slice(0, 160) });
  }
  return { version: 1, retroed: {} };
}

export function hasRetroReport(dataDir, prNumber) {
  if (!dataDir || prNumber === null || prNumber === undefined) return false;
  const num = String(prNumber).trim();
  if (!/^\d+$/.test(num)) return false;
  const reportPath = join(dataDir, "retros", `pr-${num}.md`);
  try {
    return existsSync(reportPath) && statSync(reportPath).size > 0;
  } catch {
    return false;
  }
}

export function isAlreadyRetroed(state, key, dataDir = null, prNumber = null) {
  if (state?.retroed && Object.prototype.hasOwnProperty.call(state.retroed, key)) {
    const entry = state.retroed[key];
    const status = typeof entry?.status === "string" ? entry.status : "completed";
    if (status === "completed" || status.startsWith("skipped_")) return true;
  }
  if (dataDir && prNumber !== null && hasRetroReport(dataDir, prNumber)) {
    return true;
  }
  return false;
}

function withStateLock(dataDir, fn) {
  mkdirSync(dataDir, { recursive: true });
  const lockDir = join(dataDir, `.${STATE_FILE_NAME}.lock`);
  let acquired = false;
  for (let attempt = 0; attempt < STATE_LOCK_RETRIES; attempt += 1) {
    try {
      mkdirSync(lockDir);
      acquired = true;
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        const st = statSync(lockDir);
        if (Date.now() - st.mtimeMs > STATE_LOCK_STALE_MS) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      syncSleepMs(STATE_LOCK_WAIT_MS);
    }
  }
  if (!acquired) {
    throw new Error(`Timed out acquiring state lock: ${lockDir}`);
  }
  try {
    return fn();
  } finally {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {
      /* best-effort lock cleanup */
    }
  }
}

export function markRetroed(dataDir, key, meta = {}) {
  return withStateLock(dataDir, () => {
    const filePath = join(dataDir, STATE_FILE_NAME);
    const state = loadRetroState(dataDir);
    state.retroed[key] = {
      at: new Date().toISOString(),
      status: "completed",
      ...meta,
    };
    const keys = Object.keys(state.retroed);
    if (keys.length > MAX_STATE_ENTRIES) {
      const sorted = keys.sort((a, b) =>
        String(state.retroed[a]?.at ?? "").localeCompare(String(state.retroed[b]?.at ?? "")),
      );
      for (const oldKey of sorted.slice(0, keys.length - MAX_STATE_ENTRIES)) {
        delete state.retroed[oldKey];
      }
    }
    const tmpPath = join(
      dataDir,
      `.${STATE_FILE_NAME}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
    );
    try {
      writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf-8");
      renameSync(tmpPath, filePath);
    } catch (err) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best-effort cleanup */
      }
      log.warn("mark_retroed_failed", { filePath, error: String(err?.message ?? err).slice(0, 160) });
      throw err;
    }
    return state;
  });
}

function tryMarkRetroed(dataDir, key, meta = {}) {
  try {
    markRetroed(dataDir, key, meta);
    return true;
  } catch (err) {
    log.warn("try_mark_retroed_failed", {
      dataDir,
      key,
      error: String(err?.message ?? err).slice(0, 160),
    });
    return false;
  }
}

export function countCiFailures(statusCheckRollup) {
  if (!Array.isArray(statusCheckRollup)) return { failed: 0, total: 0, failedNames: [] };
  const failedNames = [];
  for (const check of statusCheckRollup) {
    if (!check || typeof check !== "object") continue;
    const conclusion = String(check.conclusion || check.state || "").toUpperCase();
    const name = String(check.name || check.context || "unnamed").slice(0, 60);
    if (
      ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR", "CANCELLED"].includes(
        conclusion,
      )
    ) {
      failedNames.push(name);
    }
  }
  return {
    failed: failedNames.length,
    total: statusCheckRollup.length,
    failedNames: [...new Set(failedNames)].slice(0, 8),
  };
}

export function countReviewFindings(pr, inlineComments = []) {
  let count = 0;
  if (Array.isArray(inlineComments)) {
    count += inlineComments.filter((c) => c && typeof c === "object" && !c.in_reply_to_id).length;
  }
  if (Array.isArray(pr?.reviews)) {
    for (const r of pr.reviews) {
      if (!r || typeof r !== "object") continue;
      const state = String(r.state || "").toUpperCase();
      if (state === "CHANGES_REQUESTED") count += 1;
      else if (state === "COMMENTED" && typeof r.body === "string" && r.body.trim().length > 20) {
        count += 1;
      }
    }
  }
  return count;
}

export function classifyTrivialPr(pr, inlineComments = []) {
  const title = String(pr?.title || "").trim();
  const branch = String(pr?.headRefName || "").trim();
  const additions = Number(pr?.additions || 0);
  const deletions = Number(pr?.deletions || 0);
  const changedLines = additions + deletions;
  const ci = countCiFailures(pr?.statusCheckRollup);
  const reviewFindings = countReviewFindings(pr, inlineComments);

  if (VERSION_BUMP_TITLE_RE.test(title) || VERSION_BUMP_BRANCH_RE.test(branch)) {
    return { skip: true, reason: "version_bump", changedLines, reviewFindings, ciFailures: ci.failed };
  }
  if (changedLines < TRIVIAL_MAX_CHANGED_LINES && reviewFindings === 0 && ci.failed === 0) {
    return { skip: true, reason: "trivial_pr", changedLines, reviewFindings, ciFailures: ci.failed };
  }
  return { skip: false, reason: null, changedLines, reviewFindings, ciFailures: ci.failed };
}

export function encodeSessionDirPrefix(repoRoot) {
  const normalized = resolve(repoRoot).replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-");
  return `--${normalized}`;
}

function isPathUnderRoot(candidate, root) {
  if (!candidate || typeof candidate !== "string") return false;
  const resolvedCandidate = resolve(candidate);
  const resolvedRoot = resolve(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + sep);
}

function extractTextFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && typeof block === "object" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function normalizeBashCommand(cmd) {
  if (typeof cmd !== "string") return "";
  return cmd.replace(/\s+/g, " ").trim().slice(0, 120);
}

/**
 * @param {{
 *   sessionsDir?: string,
 *   repoRoot: string,
 *   prNumber?: number | string | null,
 *   headRefName?: string | null,
 *   createdAt?: string | null,
 *   mergedAt?: string | null,
 *   commitShas?: string[],
 * }} opts
 */
export function scanSessionLogs({
  sessionsDir = join(homedir(), ".pi", "agent", "sessions"),
  repoRoot,
  prNumber = null,
  headRefName = null,
  createdAt = null,
  mergedAt = null,
  commitShas = [],
}) {
  const empty = {
    sessionsScanned: 0,
    sessionFilesMatched: 0,
    turns: 0,
    totalToolCalls: 0,
    toolCounts: {},
    errorCount: 0,
    errorSamples: [],
    repeatedCommands: [],
    largeOutputCount: 0,
    largeOutputs: [],
    taskListChurn: { total: 0, byTool: {} },
  };
  if (!sessionsDir || !existsSync(sessionsDir)) return empty;

  const prefix = encodeSessionDirPrefix(repoRoot);
  let candidateDirs = [];
  try {
    candidateDirs = readdirSync(sessionsDir, { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() &&
          (d.name === `${prefix}--` || (d.name.startsWith(`${prefix}-`) && d.name.endsWith("--"))),
      )
      .map((d) => join(sessionsDir, d.name));
  } catch (err) {
    log.debug("scan_session_dirs_failed", { sessionsDir, error: String(err?.message ?? err).slice(0, 120) });
    return empty;
  }

  const startMs = createdAt ? Date.parse(createdAt) - SESSION_WINDOW_PAD_MS : 0;
  const endMs = mergedAt ? Date.parse(mergedAt) + SESSION_WINDOW_PAD_MS : Number.POSITIVE_INFINITY;

  const candidates = [];
  for (const dir of candidateDirs) {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = join(dir, entry.name);
      try {
        const st = statSync(filePath);
        if (st.size === 0 || st.size > MAX_SESSION_BYTES) continue;
        if (Number.isFinite(startMs) && startMs > 0 && st.mtimeMs < startMs) continue;
        if (Number.isFinite(endMs) && st.mtimeMs > endMs && st.birthtimeMs > endMs) continue;
        candidates.push({ filePath, mtimeMs: st.mtimeMs });
      } catch {
        continue;
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const inspected = candidates.slice(0, MAX_INSPECTED_SESSIONS);

  const toolCounts = new Map();
  const cmdCounts = new Map();
  const errorSamples = [];
  const largeOutputs = [];
  const taskByTool = new Map();
  let sessionsScanned = 0;
  let sessionFilesMatched = 0;
  let turns = 0;
  let totalToolCalls = 0;
  let errorCount = 0;
  let largeOutputCount = 0;
  let taskTotal = 0;

  const matchTokens = [
    ...(headRefName ? [headRefName] : []),
    ...(prNumber ? [`#${prNumber}`, `/pull/${prNumber}`] : []),
    ...commitShas.slice(0, 6).map((s) => String(s).slice(0, 7)),
  ].filter(Boolean);

  for (const { filePath } of inspected) {
    if (sessionFilesMatched >= MAX_MATCHED_SESSIONS) break;

    let raw;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const lines = raw.split("\n");
    // Verify session cwd belongs to repoRoot (rejects sibling repos with shared prefix)
    let sessionCwd = null;
    for (let i = 0; i < Math.min(lines.length, 5); i += 1) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "session" && typeof parsed.cwd === "string") {
          sessionCwd = parsed.cwd;
          break;
        }
      } catch {
        /* ignore malformed header */
      }
    }
    if (sessionCwd && !isPathUnderRoot(sessionCwd, repoRoot)) continue;

    sessionsScanned += 1;
    const mentionsPr =
      matchTokens.length === 0 || matchTokens.some((tok) => raw.includes(tok));
    if (!mentionsPr) continue;

    sessionFilesMatched += 1;

    for (const line of lines) {
      if (!line || line[0] !== "{") continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.type !== "message" || !rec.message) continue;
      const msg = rec.message;
      if (msg.role === "assistant") {
        turns += 1;
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (!part || part.type !== "toolCall") continue;
            const name = String(part.name || "unknown");
            totalToolCalls += 1;
            toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
            if (TASK_TOOLS.has(name)) {
              taskTotal += 1;
              taskByTool.set(name, (taskByTool.get(name) || 0) + 1);
            }
            if (name === "bash" && typeof part.arguments?.command === "string") {
              const norm = normalizeBashCommand(part.arguments.command);
              if (norm) cmdCounts.set(norm, (cmdCounts.get(norm) || 0) + 1);
            }
          }
        }
      } else if (msg.role === "toolResult") {
        const text = extractTextFromContent(msg.content);
        const bytes = Buffer.byteLength(text, "utf-8");
        const toolName = String(msg.toolName || "unknown");
        if (msg.isError === true || /\[BLOCKED\]|BLOCKED:/i.test(text.slice(0, 200))) {
          errorCount += 1;
          if (errorSamples.length < 8) {
            errorSamples.push({
              tool: toolName,
              snippet: text.replace(/\s+/g, " ").trim().slice(0, 140),
            });
          }
        }
        if (bytes > LARGE_OUTPUT_THRESHOLD_BYTES) {
          largeOutputCount += 1;
          if (largeOutputs.length < 6) {
            largeOutputs.push({
              tool: toolName,
              bytes,
              preview: text.replace(/\s+/g, " ").trim().slice(0, 100),
            });
          }
        }
      }
    }
  }

  const topTools = Object.fromEntries(
    [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
  );
  const repeatedCommands = [...cmdCounts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([cmd, count]) => ({ cmd, count }));

  return {
    sessionsScanned,
    sessionFilesMatched,
    turns,
    totalToolCalls,
    toolCounts: topTools,
    errorCount,
    errorSamples,
    repeatedCommands,
    largeOutputCount,
    largeOutputs,
    taskListChurn: {
      total: taskTotal,
      byTool: Object.fromEntries([...taskByTool.entries()].sort((a, b) => b[1] - a[1])),
    },
  };
}

function measureFile(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, "utf-8");
    return {
      bytes: Buffer.byteLength(content, "utf-8"),
      lines: content.length === 0 ? 0 : content.split("\n").length,
    };
  } catch {
    return null;
  }
}

function measureMarkdownDir(dirPath) {
  if (!existsSync(dirPath)) return null;
  try {
    const files = readdirSync(dirPath).filter((f) => f.endsWith(".md"));
    let bytes = 0;
    let lines = 0;
    for (const f of files) {
      const m = measureFile(join(dirPath, f));
      if (m) {
        bytes += m.bytes;
        lines += m.lines;
      }
    }
    return { files: files.length, bytes, lines };
  } catch {
    return null;
  }
}

export function scanRepoSignals(repoRoot) {
  /** @type {Record<string, { bytes: number, lines: number, files?: number }>} */
  const steeringFiles = {};
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const m = measureFile(join(repoRoot, name));
    if (m) steeringFiles[name] = m;
  }
  const rulesDir = measureMarkdownDir(join(repoRoot, "rules"));
  if (rulesDir) steeringFiles["rules/"] = rulesDir;
  const piRulesDir = measureMarkdownDir(join(repoRoot, ".pi", "rules"));
  if (piRulesDir) steeringFiles[".pi/rules/"] = piRulesDir;

  let packageJsonScripts = [];
  const pkgPath = join(repoRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg?.scripts && typeof pkg.scripts === "object") {
        packageJsonScripts = Object.keys(pkg.scripts).slice(0, 15);
      }
    } catch {
      /* ignore malformed package.json */
    }
  }

  let preCommitHooks = [];
  const preCommitPath = join(repoRoot, ".pre-commit-config.yaml");
  const hasPreCommit = existsSync(preCommitPath);
  if (hasPreCommit) {
    try {
      const raw = readFileSync(preCommitPath, "utf-8");
      const matches = [...raw.matchAll(/^\s*-\s*id:\s*([A-Za-z0-9._-]+)/gm)].map((m) => m[1]);
      preCommitHooks = [...new Set(matches)].slice(0, 20);
    } catch {
      /* ignore unreadable config */
    }
  }

  let workflows = [];
  const wfDir = join(repoRoot, ".github", "workflows");
  if (existsSync(wfDir)) {
    try {
      workflows = readdirSync(wfDir)
        .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
        .sort()
        .slice(0, 15);
    } catch {
      /* ignore */
    }
  }

  return {
    steeringFiles,
    checks: {
      hasPackageJson: existsSync(pkgPath),
      packageJsonScripts,
      hasToxToml: existsSync(join(repoRoot, "tox.toml")),
      hasToxIni: existsSync(join(repoRoot, "tox.ini")),
      hasPyprojectToml: existsSync(join(repoRoot, "pyproject.toml")),
      hasPreCommit,
      preCommitHooks,
      workflows,
    },
  };
}

export function fitDigestBudget(digest, maxBytes = DEFAULT_MAX_DIGEST_BYTES) {
  const clone = JSON.parse(JSON.stringify(digest));
  const sizeOf = (obj) => Buffer.byteLength(JSON.stringify(obj), "utf-8");
  if (sizeOf(clone) <= maxBytes) return clone;

  // Step 1: shorten text previews/snippets
  if (clone.sessions) {
    for (const s of clone.sessions.errorSamples || []) s.snippet = String(s.snippet || "").slice(0, 80);
    for (const l of clone.sessions.largeOutputs || []) l.preview = String(l.preview || "").slice(0, 50);
    for (const r of clone.sessions.repeatedCommands || []) r.cmd = String(r.cmd || "").slice(0, 70);
  }
  if (clone.pr?.reviewSample) {
    for (const r of clone.pr.reviewSample) r.summary = String(r.summary || "").slice(0, 80);
  }
  if (sizeOf(clone) <= maxBytes) return clone;

  // Step 2: trim sample array lengths progressively
  const trimSteps = [
    () => { if (clone.pr?.reviewSample) clone.pr.reviewSample = clone.pr.reviewSample.slice(0, 4); },
    () => { if (clone.sessions?.largeOutputs) clone.sessions.largeOutputs = clone.sessions.largeOutputs.slice(0, 3); },
    () => { if (clone.sessions?.errorSamples) clone.sessions.errorSamples = clone.sessions.errorSamples.slice(0, 4); },
    () => { if (clone.sessions?.repeatedCommands) clone.sessions.repeatedCommands = clone.sessions.repeatedCommands.slice(0, 4); },
    () => { if (clone.pr?.commits) clone.pr.commits = clone.pr.commits.slice(0, 6); },
    () => { if (clone.sessions?.largeOutputs) clone.sessions.largeOutputs = []; },
    () => { if (clone.sessions?.errorSamples) clone.sessions.errorSamples = clone.sessions.errorSamples.slice(0, 2); },
    () => { if (clone.pr?.reviewSample) clone.pr.reviewSample = []; },
    () => { if (clone.repo?.checks?.preCommitHooks) clone.repo.checks.preCommitHooks = clone.repo.checks.preCommitHooks.slice(0, 8); },
  ];
  for (const step of trimSteps) {
    step();
    if (sizeOf(clone) <= maxBytes) {
      clone.truncated = true;
      return clone;
    }
  }
  clone.truncated = true;
  return clone;
}

export function fetchPrData({ prNumber, repoSlug, cwd, execFn = defaultExec }) {
  const fields = [
    "number",
    "title",
    "url",
    "state",
    "mergedAt",
    "createdAt",
    "baseRefName",
    "headRefName",
    "additions",
    "deletions",
    "changedFiles",
    "commits",
    "reviews",
    "statusCheckRollup",
    "labels",
    "author",
  ].join(",");

  let resolvedNumber = prNumber;
  if (!resolvedNumber) {
    try {
      const currentRaw = execFn("gh", ["pr", "view", "--json", "number"], cwd, 15_000);
      const parsed = JSON.parse(currentRaw);
      if (parsed?.number) resolvedNumber = String(parsed.number);
    } catch {
      const args = ["pr", "list", "--state", "merged", "--limit", "1", "--json", "number"];
      if (repoSlug) args.push("--repo", repoSlug);
      const listRaw = execFn("gh", args, cwd, 15_000);
      const list = JSON.parse(listRaw);
      if (Array.isArray(list) && list[0]?.number) resolvedNumber = String(list[0].number);
    }
  }
  if (!resolvedNumber || !/^\d+$/.test(String(resolvedNumber))) {
    throw new Error("Could not resolve a valid PR number (pass --pr <number>)");
  }

  const viewArgs = ["pr", "view", String(resolvedNumber), "--json", fields];
  if (repoSlug) viewArgs.push("--repo", repoSlug);
  const pr = JSON.parse(execFn("gh", viewArgs, cwd, 15_000));

  const effectiveRepo = repoSlug || parseOwnerRepoFromUrl(pr.url);
  let inlineComments = [];
  if (effectiveRepo) {
    try {
      // --slurp wraps paginated page arrays in a single valid JSON array so multi-page PRs (>30 comments) parse cleanly
      const apiRaw = execFn(
        "gh",
        ["api", `repos/${effectiveRepo}/pulls/${pr.number}/comments`, "--paginate", "--slurp"],
        cwd,
        15_000,
      );
      inlineComments = flattenSlurpedPages(JSON.parse(apiRaw));
    } catch (err) {
      log.warn("inline_comments_fetch_failed", {
        repo: effectiveRepo,
        pr: pr.number,
        error: String(err?.message ?? err).slice(0, 160),
      });
    }
  }
  return { pr, inlineComments, repoSlug: effectiveRepo };
}

/**
 * @param {{
 *   pr?: string | number | null,
 *   cwd?: string,
 *   repo?: string | null,
 *   sessionsDir?: string,
 *   force?: boolean,
 *   record?: boolean,
 *   markDone?: boolean,
 *   maxBytes?: number,
 *   execFn?: (cmd: string, args: string[], cwd: string, timeout?: number) => string,
 *   prDataOverride?: { pr: Record<string, any>, inlineComments?: any[], repoSlug?: string | null } | null,
 * }} [opts]
 */
export function collectPrRetro({
  pr = null,
  cwd = process.cwd(),
  repo = null,
  sessionsDir = join(homedir(), ".pi", "agent", "sessions"),
  force = false,
  record = true,
  markDone = false,
  maxBytes = DEFAULT_MAX_DIGEST_BYTES,
  execFn = defaultExec,
  prDataOverride = null,
} = {}) {
  const repoRoot = resolveMainRepoRoot(cwd, execFn);
  const dataDir = join(repoRoot, ".pi", "data");
  const initialRepoSlug = resolveRepoSlug(cwd, repo, execFn);

  // Explicit post-report completion mark (called only after .pi/data/retros/pr-<N>.md is written)
  if (markDone) {
    if (!pr || !/^\d+$/.test(String(pr))) {
      throw new Error("--mark-done requires a numeric --pr <number>");
    }
    const key = makeRetroKey(initialRepoSlug, pr);
    const saved = tryMarkRetroed(dataDir, key, { status: "completed" });
    return {
      status: "marked",
      key,
      prNumber: Number(pr),
      ...(saved ? {} : { stateWriteWarning: true }),
    };
  }

  // Fast-path dedupe before hitting GitHub API when PR number & repo are known
  if (!force && pr && /^\d+$/.test(String(pr)) && initialRepoSlug) {
    const fastKey = makeRetroKey(initialRepoSlug, pr);
    const state = loadRetroState(dataDir);
    if (isAlreadyRetroed(state, fastKey, dataDir, pr)) {
      log.info("pr_retro_skipped_dedupe", { key: fastKey });
      return {
        status: "skipped",
        reason: "already_retroed",
        key: fastKey,
        prNumber: Number(pr),
      };
    }
  }

  const fetched = prDataOverride
    ? {
        pr: prDataOverride.pr,
        inlineComments: prDataOverride.inlineComments || [],
        repoSlug: prDataOverride.repoSlug || initialRepoSlug || parseOwnerRepoFromUrl(prDataOverride.pr?.url),
      }
    : fetchPrData({ prNumber: pr, repoSlug: initialRepoSlug, cwd, execFn });

  const prObj = fetched.pr;
  const repoSlug = fetched.repoSlug || initialRepoSlug || "local";
  const key = makeRetroKey(repoSlug, prObj.number);

  if (!force) {
    const state = loadRetroState(dataDir);
    if (isAlreadyRetroed(state, key, dataDir, prObj.number)) {
      log.info("pr_retro_skipped_dedupe", { key });
      return {
        status: "skipped",
        reason: "already_retroed",
        key,
        prNumber: prObj.number,
      };
    }
    // Never retro or permanently mark a still-open PR (e.g., gh pr merge --auto queued)
    if (String(prObj.state || "").toUpperCase() !== "MERGED") {
      log.info("pr_retro_skipped_not_merged", { key, state: prObj.state || null });
      return {
        status: "skipped",
        reason: "not_merged",
        key,
        prNumber: prObj.number,
        state: prObj.state || null,
      };
    }
  }

  const trivial = classifyTrivialPr(prObj, fetched.inlineComments);
  if (trivial.skip && !force) {
    const stateSaved = record ? tryMarkRetroed(dataDir, key, { status: `skipped_${trivial.reason}` }) : true;
    log.info("pr_retro_skipped_trivial", { key, reason: trivial.reason, changedLines: trivial.changedLines });
    return {
      status: "skipped",
      reason: trivial.reason,
      key,
      prNumber: prObj.number,
      title: prObj.title,
      changedLines: trivial.changedLines,
      reviewFindings: trivial.reviewFindings,
      ciFailures: trivial.ciFailures,
      ...(stateSaved ? {} : { stateWriteWarning: true }),
    };
  }

  const ci = countCiFailures(prObj.statusCheckRollup);
  const commits = Array.isArray(prObj.commits) ? prObj.commits : [];
  const commitShas = commits.map((c) => String(c.oid || c.sha || "")).filter(Boolean);
  const reviewSample = fetched.inlineComments
    .filter((c) => c && !c.in_reply_to_id)
    .slice(0, 8)
    .map((c) => ({
      path: c.path ? basename(c.path) : "",
      line: c.line ?? c.original_line ?? null,
      author: c.user?.login || "",
      summary: String(c.body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120),
    }));

  const sessions = scanSessionLogs({
    sessionsDir,
    repoRoot,
    prNumber: prObj.number,
    headRefName: prObj.headRefName,
    createdAt: prObj.createdAt,
    mergedAt: prObj.mergedAt,
    commitShas,
  });
  const repoSignals = scanRepoSignals(repoRoot);

  const rawDigest = {
    status: "collected",
    key,
    outputPath: `.pi/data/retros/pr-${prObj.number}.md`,
    trivialHint: trivial.skip ? trivial.reason : null,
    pr: {
      number: prObj.number,
      title: String(prObj.title || "").slice(0, 140),
      url: prObj.url || null,
      state: prObj.state || null,
      author: prObj.author?.login || null,
      base: prObj.baseRefName || null,
      head: prObj.headRefName || null,
      createdAt: prObj.createdAt || null,
      mergedAt: prObj.mergedAt || null,
      additions: Number(prObj.additions || 0),
      deletions: Number(prObj.deletions || 0),
      changedFiles: Number(prObj.changedFiles || 0),
      commitCount: commits.length,
      commits: commits.slice(0, 12).map((c) => ({
        sha: String(c.oid || c.sha || "").slice(0, 7),
        msg: String(c.messageHeadline || c.message || "").split("\n")[0].slice(0, 80),
      })),
      reviewFindingsCount: trivial.reviewFindings,
      reviewSample,
      ci,
    },
    sessions,
    repo: repoSignals,
  };

  const digest = fitDigestBudget(rawDigest, maxBytes);
  // Note: do NOT mark "completed" here — state is marked only via --mark-done
  // after .pi/data/retros/pr-<N>.md is written so failed analyzer runs can retry.
  log.info("pr_retro_collected", {
    key,
    bytes: Buffer.byteLength(JSON.stringify(digest), "utf-8"),
    sessionsScanned: sessions.sessionsScanned,
    sessionFilesMatched: sessions.sessionFilesMatched,
    findings: trivial.reviewFindings,
    ciFailures: ci.failed,
  });
  return digest;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isDirectExecution()) {
  try {
    const opts = parseCliArgs(process.argv.slice(2));
    const result = collectPrRetro(opts);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (err) {
    const msg = String(err?.message ?? err);
    log.error("pr_retro_collect_failed", { error: msg.slice(0, 300) });
    process.stdout.write(JSON.stringify({ status: "error", error: msg }, null, 2) + "\n");
    process.exitCode = 1;
  }
}
