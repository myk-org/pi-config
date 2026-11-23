/**
 * Opt-in post-merge PR retrospective trigger (issue #1343).
 *
 * Strictly gated on `pr_retro_on_merge` (default `false` — zero runtime overhead
 * when disabled). Skips subagent children and oneshot invocations (`pi -p` /
 * `--mode json`). Watches successful `gh pr merge` tool results from both main
 * `bash` calls and `github-expert` subagent calls, deduplicates against
 * `.pi/data/pr-retro-state.json`, and emits a non-blocking follow-up note to run
 * the `$0` collector and read-only background retro (`.pi/data/retros/pr-<N>.md`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";
import { isPiOneshotInvocation } from "../shared/oneshot.js";
import { sendSystemNote } from "../shared/system-note.js";
import { getOriginUrl, parseRemoteRepo } from "./git-helpers.js";
import { getSetting } from "./project-settings.js";
import { getProjectDataDir } from "./utils.js";

const log = createLogger("pr-retro");

export const RETRO_STATE_FILE = "pr-retro-state.json";
export const COLLECTOR_SCRIPT_PATH = fileURLToPath(
  new URL("../../scripts/pr-retro-collect.mjs", import.meta.url),
);

const PR_URL_RE = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i;
const REPO_FLAG_RE = /(?:^|\s)(?:-R|--repo)(?:=|\s+)([\w.-]+\/[\w.-]+)/;
const MERGE_CONFIRM_RE =
  /(?:\bmerged\s+(?:pull\s+request|pr)\s*#?(\d+)|✓\s*merged\b|successfully\s+merged\b|\bstate["':\s]+MERGED\b|\bpr\s*#?(\d+)\s+(?:was\s+|has\s+been\s+)?merged\b)/i;
const MERGE_FAILURE_RE =
  /\b(?:merge\s+failed|failed\s+to\s+merge|could\s+not\s+merge|not\s+merged|cannot\s+merge|dry[- ]run)\b/i;

export interface DetectedMerge {
  prNumber: number | null;
  repo: string | null;
}

function extractResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
      parts.push((item as { text: string }).text);
    }
  }
  return parts.join("\n");
}

function stripLeadingEnvAssignments(segment: string): string {
  let rest = segment.trim();
  while (/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+/.test(rest)) {
    rest = rest.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+/, "");
  }
  return rest;
}

function extractPrFromMergeArgs(segment: string): DetectedMerge {
  let repo: string | null = null;
  let prNumber: number | null = null;

  const urlMatch = segment.match(PR_URL_RE);
  if (urlMatch) {
    repo = urlMatch[1];
    prNumber = Number.parseInt(urlMatch[2], 10);
    return { prNumber, repo };
  }

  const repoMatch = segment.match(REPO_FLAG_RE);
  if (repoMatch) repo = repoMatch[1];

  const afterMerge = segment.replace(/^gh(?:\s+(?:-R|--repo)(?:=|\s+)\S+)?\s+pr\s+merge\b/, "").trim();
  const tokens = afterMerge.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const valueFlags = new Set([
    "-R",
    "--repo",
    "-b",
    "--body",
    "-F",
    "--body-file",
    "-t",
    "--subject",
    "--match-head-commit",
    "--author-email",
  ]);
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (valueFlags.has(tok)) {
      i += 1;
      continue;
    }
    if (tok.startsWith("-")) continue;
    const cleaned = tok.replace(/^['"]|['"]$/g, "").replace(/^#/, "");
    if (/^\d+$/.test(cleaned)) {
      prNumber = Number.parseInt(cleaned, 10);
      break;
    }
  }
  return { prNumber, repo };
}

function extractPrFromText(text: string): DetectedMerge {
  const urlMatch = text.match(PR_URL_RE);
  if (urlMatch) {
    return { repo: urlMatch[1], prNumber: Number.parseInt(urlMatch[2], 10) };
  }
  const numMatch =
    text.match(/(?:merged\s+(?:pull\s+request|pr)|pull\s+request|pr)\s*#?(\d+)/i) ??
    text.match(/#(\d+)\b/);
  return {
    prNumber: numMatch ? Number.parseInt(numMatch[1], 10) : null,
    repo: null,
  };
}

/**
 * Detect a completed `gh pr merge` command from a successful `bash` tool result.
 */
export function detectMergedPrFromBash(command: unknown, resultText: string): DetectedMerge | null {
  if (typeof command !== "string" || !command.trim()) return null;
  if (MERGE_FAILURE_RE.test(resultText)) return null;

  const segments = command.split(/(?:&&|\|\||;|\||\n)/);
  let mergeSegment: string | null = null;
  for (const rawSeg of segments) {
    const seg = stripLeadingEnvAssignments(rawSeg);
    if (!/^gh(?:\s+(?:-R|--repo)(?:=|\s+)\S+)?\s+pr\s+merge(?:\s|$)/.test(seg)) continue;
    if (/(?:^|\s)(?:-h|--help|--dry-run)(?:\s|$)/.test(seg)) continue;
    mergeSegment = seg;
    break;
  }
  if (!mergeSegment) return null;

  const fromArgs = extractPrFromMergeArgs(mergeSegment);
  const fromOut = extractPrFromText(resultText);
  return {
    prNumber: fromArgs.prNumber ?? fromOut.prNumber,
    repo: fromArgs.repo ?? fromOut.repo,
  };
}

function collectGithubExpertTasks(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  if (obj.async === true) return [];

  const tasks: string[] = [];
  if (obj.agent === "github-expert" && typeof obj.task === "string") {
    tasks.push(obj.task);
  }
  for (const key of ["tasks", "chain"]) {
    const list = obj[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (
        item &&
        typeof item === "object" &&
        (item as Record<string, unknown>).agent === "github-expert" &&
        typeof (item as Record<string, unknown>).task === "string"
      ) {
        tasks.push((item as Record<string, unknown>).task as string);
      }
    }
  }
  return tasks;
}

/**
 * Detect a completed PR merge from a synchronous `github-expert` subagent tool result.
 */
export function detectMergedPrFromSubagent(input: unknown, resultText: string): DetectedMerge | null {
  const expertTasks = collectGithubExpertTasks(input);
  if (expertTasks.length === 0) return null;
  if (!resultText.trim() || MERGE_FAILURE_RE.test(resultText)) return null;

  const taskText = expertTasks.join("\n");
  const taskMentionsMerge = /\b(?:gh\s+pr\s+merge|merge\s+(?:the\s+)?pr|merge\s+pull\s+request|merge\s+#\d+)\b/i.test(
    taskText,
  );
  if (!taskMentionsMerge && !/\bgh\s+pr\s+merge\b/i.test(resultText)) return null;
  if (!MERGE_CONFIRM_RE.test(resultText)) return null;

  const fromOut = extractPrFromText(resultText);
  const fromTask = extractPrFromText(taskText);
  return {
    prNumber: fromOut.prNumber ?? fromTask.prNumber,
    repo: fromOut.repo ?? fromTask.repo,
  };
}

export function isAlreadyRetroedOnDisk(cwd: string, key: string): boolean {
  try {
    const statePath = path.join(getProjectDataDir(cwd), RETRO_STATE_FILE);
    if (!fs.existsSync(statePath)) return false;
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    return Boolean(parsed?.retroed && Object.prototype.hasOwnProperty.call(parsed.retroed, key));
  } catch (err: unknown) {
    log.debug("retro_state_read_failed", {
      cwd,
      error: String((err as Error)?.message ?? err).slice(0, 120),
    });
    return false;
  }
}

export function buildRetroFollowUpPrompt(params: {
  prNumber: number | null;
  repo: string | null;
  cwd: string;
  collectorPath?: string;
}): string {
  const script = params.collectorPath ?? COLLECTOR_SCRIPT_PATH;
  const args = [`node "${script}"`, `--cwd "${params.cwd}"`];
  if (params.prNumber !== null) args.push(`--pr ${params.prNumber}`);
  if (params.repo) args.push(`--repo "${params.repo}"`);
  const prLabel = params.prNumber !== null ? `PR #${params.prNumber}` : "the merged PR";
  const outputPath =
    params.prNumber !== null ? `.pi/data/retros/pr-${params.prNumber}.md` : ".pi/data/retros/pr-<N>.md";

  return [
    `Post-merge PR retrospective enabled (\`pr_retro_on_merge: true\`) for ${prLabel}.`,
    `1. Run the zero-token collector: \`${args.join(" ")}\`.`,
    `2. If it outputs \`"status": "skipped"\` (trivial/version-bump/already retroed), stop with a one-line note.`,
    `3. Otherwise, dispatch a read-only \`async: true\` subagent with ONLY the JSON digest + the 7 \`/retro\` categories (Navigation, Automated checks, Coding standards mechanical-vs-judgement, Global AGENTS.md, Tool economy, No-ops, Information access) to write a ranked report to \`${outputPath}\` and return a concise summary.`,
    `4. Never auto-edit \`AGENTS.md\`, \`rules/\`, or tracked repo files, and never auto-file GitHub issues.`,
  ].join("\n");
}

function resolveRepoSlug(cwd: string, detectedRepo: string | null): string | null {
  if (detectedRepo) return detectedRepo;
  const origin = getOriginUrl(cwd);
  if (!origin) return null;
  const parsed = parseRemoteRepo(origin);
  return parsed ? `${parsed.owner}/${parsed.repo}` : null;
}

export interface RegisterPrRetroOptions {
  argv?: string[];
  collectorPath?: string;
  sendNote?: (pi: ExtensionAPI, text: string) => Promise<void>;
}

export function registerPrRetro(pi: ExtensionAPI, opts: RegisterPrRetroOptions = {}): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") {
    log.debug("skip_register_subagent_child");
    return;
  }
  if (isPiOneshotInvocation(opts.argv)) {
    log.info("skip_register_oneshot");
    return;
  }

  const triggered = new Set<string>();
  const dispatchNote =
    opts.sendNote ??
    (async (api: ExtensionAPI, text: string) => {
      await sendSystemNote(api, text, {
        customType: "pr-retro-trigger",
        triggerTurn: true,
        deliverAs: "followUp",
        display: true,
      });
    });

  pi.on("session_start", () => {
    triggered.clear();
  });

  pi.on("tool_result", (event: any, ctx: any) => {
    try {
      if (event?.isError) return;
      const cwd = ctx?.cwd;
      if (typeof cwd !== "string" || !cwd) return;
      if (!getSetting(cwd, "pr_retro_on_merge")) return;

      const toolName = String(event?.toolName ?? "").toLowerCase();
      if (toolName !== "bash" && toolName !== "subagent") return;

      const resultText = extractResultText(event?.content);
      const detected =
        toolName === "bash"
          ? detectMergedPrFromBash(event?.input?.command, resultText)
          : detectMergedPrFromSubagent(event?.input, resultText);
      if (!detected) return;

      const repoSlug = resolveRepoSlug(cwd, detected.repo);
      const key = `${repoSlug ?? "local"}#${detected.prNumber ?? "latest"}`;
      if (triggered.has(key)) {
        log.debug("pr_retro_already_triggered_in_session", { key });
        return;
      }
      if (detected.prNumber !== null && isAlreadyRetroedOnDisk(cwd, key)) {
        log.info("pr_retro_already_recorded", { key });
        return;
      }

      triggered.add(key);
      log.info("pr_retro_triggered", { tool: toolName, key, prNumber: detected.prNumber });

      const prompt = buildRetroFollowUpPrompt({
        prNumber: detected.prNumber,
        repo: repoSlug,
        cwd,
        collectorPath: opts.collectorPath,
      });
      void dispatchNote(pi, prompt).catch((err: unknown) => {
        log.warn("pr_retro_followup_failed", {
          key,
          error: String((err as Error)?.message ?? err).slice(0, 200),
        });
      });
    } catch (err: unknown) {
      log.warn("pr_retro_tool_result_failed", {
        error: String((err as Error)?.message ?? err).slice(0, 200),
      });
    }
  });
}
