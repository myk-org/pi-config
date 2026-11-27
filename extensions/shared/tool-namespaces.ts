import type { ToolAnnotations, ToolNamespace } from "@earendil-works/pi-coding-agent";

/**
 * Shared Pi 1.6 tool namespaces for extension tools exposed via `codemode` / `deferred`.
 *
 * Grouping related tools under compact namespaces lets Pi's `codemode` tool render
 * them under shared headings within its inline token budget and expose longer guidance
 * on demand via `describeNamespace(name)`.
 */
export const TOOL_NAMESPACES = {
  memory: {
    name: "memory",
    description: "Project memory search, storage, reinforcement, editing, and consolidation.",
    instructions:
      'Call via codemode (`await tools.memory_search(...)`). Use `memory_search` / `memory_reflect` before answering questions about past decisions; `memory_add` for standing one-line rules; `memory_edit` / `memory_remove` to fix stale entries. Rare admin tools (`memory_consolidate`, `memory_dream`) are deferred — discover via `searchTools` or `describeNamespace("memory")`.',
  },
  coms: {
    name: "coms",
    description: "Peer-to-peer inter-agent communication, peer supervision, queue recovery, and remote tasks.",
    instructions:
      "Call via codemode (`await tools.coms_peers(...)`, `await tools.coms_send(...)`). Call `coms_start` before using gated P2P tools (`coms_send`, `coms_list`, `coms_tasks_create`, etc.). Never call `coms_send` to reply to an inbound `[from <peer>]` message — your final assistant text auto-replies.",
  },
  tasks: {
    name: "tasks",
    description: "Structured task board for tracking multi-step work and dependencies.",
    instructions:
      'Call via codemode (`await tools.TaskBulkCreate(...)`, `await tools.TaskUpdate(...)`). Plan 2+ steps in one `TaskBulkCreate`, mark `in_progress` before starting and `completed` when done. `TaskUpdate` / `TaskBulkUpdate` return remaining open tasks; call `TaskList` only for full board state. Never start or complete `assignee: "user"` tasks.',
  },
  trail: {
    name: "trail",
    description: "Local Trail code-graph search, API skeletons, call tracing, repo map, and blast radius.",
    instructions:
      "Call via codemode (`await tools.trail_find_code({ query })`). Describe concepts rather than raw identifiers; call `trail_find_code` before reading/grepping indexed code files to satisfy the Trail navigation gate.",
  },
  runtime: {
    name: "runtime",
    description:
      "Session diagnostics, async subagent status, git worktrees, daemons, scheduled crons, model discovery, and past session search.",
    instructions:
      'Call via codemode (`await tools.session_status({})`, `await tools.async_status({})`, `await tools.list_models({})`). Rare admin tools (`skill_adopt`, `review_status`) are deferred — discover via `searchTools` or `describeNamespace("runtime")`.',
  },
} as const satisfies Record<string, ToolNamespace>;

/** Standard MCP-style annotations for strictly local read-only, idempotent queries. */
export const READ_ONLY_LOCAL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
