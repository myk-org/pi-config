import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { createLogger } from "@/lib/create-logger";
import { CopyButton } from "@/components/CopyButton";
import type { TaskItem } from "@/types";

const log = createLogger("TasksPanel");

type TaskFilter = "all" | "mine" | "agent" | "open";

const COMPLETION_NOTE_MAX = 200;
let taskOpSeq = 0;

interface Props {
  sendCmd: (command: string, extra?: Record<string, unknown>) => void;
  onMessage: (handler: (data: any) => void) => () => void;
  notify: (msg: string, level?: string) => void;
}

const STATUS_ICON: Record<string, string> = {
  pending: "◻",
  in_progress: "◼",
  completed: "✔",
};

function isUserTask(t: TaskItem): boolean {
  return t.assignee === "user";
}

function sortTasksForDisplay(tasks: readonly TaskItem[]): TaskItem[] {
  const statusRank = (status: string): number =>
    status === "pending" ? 0 : status === "in_progress" ? 1 : 2;
  const assigneeRank = (t: TaskItem): number => (isUserTask(t) ? 0 : 1);
  return [...tasks].sort(
    (a, b) =>
      statusRank(a.status) - statusRank(b.status) ||
      assigneeRank(a) - assigneeRank(b) ||
      Number(a.id) - Number(b.id),
  );
}

function formatTaskCopyText(t: TaskItem): string {
  const tag = isUserTask(t) ? "[you]" : "[llm]";
  const lines = [`#${t.id} [${t.status}] ${tag} ${t.subject}`];
  if (t.description) lines.push(`Description:\n${t.description}`);
  if (t.blockedBy && t.blockedBy.length > 0) {
    lines.push(`Blocked by: ${t.blockedBy.map((id) => `#${id}`).join(", ")}`);
  }
  if (t.completedBy) lines.push(`Completed by: ${t.completedBy}`);
  if (t.completionNote) lines.push(`Completion note: ${t.completionNote}`);
  return lines.join("\n");
}

/** #968 A / #1481 — task list with live updates and full TUI /tasks parity. */
export function TasksPanel({ sendCmd, onMessage, notify }: Props) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [showCreate, setShowCreate] = useState(false);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [assignee, setAssignee] = useState<"llm" | "user">("llm");
  const [completingTaskId, setCompletingTaskId] = useState<string | null>(null);
  const [completionNote, setCompletionNote] = useState("");
  const [submittingCompleteIds, setSubmittingCompleteIds] = useState<Set<string>>(() => new Set());
  const pendingCompletesRef = useRef<Map<string, string>>(new Map());
  const completingTaskIdRef = useRef<string | null>(completingTaskId);
  completingTaskIdRef.current = completingTaskId;

  useEffect(() => {
    sendCmd("tasks-list");
    return onMessage((ev: any) => {
      if (ev.type === "tasks-list" && Array.isArray(ev.tasks)) setTasks(ev.tasks);
      if (ev.type === "task-op-result" && ev.op === "complete") {
        const pending = pendingCompletesRef.current;
        if (pending.size === 0) return;
        let matchedReqId: string | null = null;
        let matchedTaskId: string | null = null;
        if (typeof ev.requestId === "string" && pending.has(ev.requestId)) {
          matchedReqId = ev.requestId;
          matchedTaskId = pending.get(ev.requestId) ?? null;
        } else if (!ev.requestId && typeof ev.taskId === "string") {
          for (const [reqId, tid] of pending.entries()) {
            if (tid === ev.taskId) {
              matchedReqId = reqId;
              matchedTaskId = tid;
              break;
            }
          }
        }
        if (!matchedReqId || !matchedTaskId) return;
        pending.delete(matchedReqId);
        const stillSubmitting = [...pending.values()].includes(matchedTaskId);
        if (!stillSubmitting) {
          setSubmittingCompleteIds((prev) => {
            if (!prev.has(matchedTaskId!)) return prev;
            const next = new Set(prev);
            next.delete(matchedTaskId!);
            return next;
          });
        }
        if (ev.ok) {
          if (completingTaskIdRef.current === matchedTaskId) {
            setCompletingTaskId(null);
            setCompletionNote("");
          }
          notify("Task completed");
        } else {
          notify(ev.error || "Task could not be completed", "error");
        }
      }
    });
  }, [sendCmd, onMessage, notify]);

  const op = (opName: string, extra?: Record<string, unknown>) => sendCmd("task-op", { op: opName, ...extra });

  const create = () => {
    const s = subject.trim();
    if (!s) return;
    op("create", { subject: s, description: description.trim(), assignee });
    log.debug("task_create_dispatched", { assignee });
    setSubject("");
    setDescription("");
    setAssignee("llm");
    setShowCreate(false);
    notify("Task created");
  };

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openBlockedByTask = (targetId: string) => {
    if (!visibleTasks.some((t) => t.id === targetId) && tasks.some((t) => t.id === targetId)) {
      setFilter("all");
    }
    setExpandedIds((prev) => {
      const next = new Set(prev);
      next.add(targetId);
      return next;
    });
    log.debug("blocked_by_task_opened", { targetId });
    const scrollToTarget = () => {
      try {
        if (typeof document === "undefined" || typeof document.querySelector !== "function") return;
        const el = document.querySelector(`[data-task-id="${CSS?.escape ? CSS.escape(targetId) : targetId.replace(/"/g, '\\"')}"]`);
        (el as HTMLElement | null)?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
      } catch { /* ignore scroll errors */ }
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(scrollToTarget);
    else scrollToTarget();
  };

  const submitUserComplete = (taskId: string) => {
    if (submittingCompleteIds.has(taskId) || [...pendingCompletesRef.current.values()].includes(taskId)) return;
    const trimmed = completionNote.trim().slice(0, COMPLETION_NOTE_MAX);
    const requestId = `task-complete-${Date.now()}-${++taskOpSeq}`;
    pendingCompletesRef.current.set(requestId, taskId);
    setSubmittingCompleteIds((prev) => {
      const next = new Set(prev);
      next.add(taskId);
      return next;
    });
    op("complete", {
      taskId,
      requestId,
      ...(trimmed ? { completionNote: trimmed } : {}),
    });
    log.debug("user_task_complete_dispatched", { taskId, requestId, hasNote: trimmed.length > 0 });
  };

  const sortedTasks = useMemo(() => sortTasksForDisplay(tasks), [tasks]);
  const completedCount = useMemo(() => tasks.filter((t) => t.status === "completed").length, [tasks]);
  const openMineCount = useMemo(
    () => tasks.filter((t) => isUserTask(t) && t.status !== "completed").length,
    [tasks],
  );
  const visibleTasks = useMemo(() => {
    switch (filter) {
      case "mine":
        return sortedTasks.filter((t) => isUserTask(t));
      case "agent":
        return sortedTasks.filter((t) => !isUserTask(t));
      case "open":
        return sortedTasks.filter((t) => t.status !== "completed");
      default:
        return sortedTasks;
    }
  }, [sortedTasks, filter]);

  const filterButtons: Array<{ id: TaskFilter; label: string; badge?: number }> = [
    { id: "all", label: "All" },
    { id: "mine", label: "Mine [you]", badge: openMineCount },
    { id: "agent", label: "Agent [llm]" },
    { id: "open", label: "Open" },
  ];

  return (
    <div className="p-3 space-y-2 min-w-0">
      <div className="flex items-center justify-between gap-1 flex-wrap">
        <span className="text-xs font-semibold text-foreground">
          Tasks{" "}
          {tasks.length > 0 && (
            <span className="text-muted-foreground font-normal">
              ({completedCount}/{tasks.length} done)
            </span>
          )}
        </span>
        <div className="flex gap-1 flex-wrap">
          <button
            type="button"
            className="px-2 py-0.5 text-[11px] rounded bg-accent/50 hover:bg-accent"
            onClick={() => setShowCreate((v) => !v)}
          >
            + New
          </button>
          {completedCount > 0 && (
            <button
              type="button"
              className="px-2 py-0.5 text-[11px] rounded bg-muted/50 hover:bg-muted"
              onClick={() => op("clear-completed")}
            >
              Clear done
            </button>
          )}
          {tasks.length > 0 && (
            <button
              type="button"
              className="px-2 py-0.5 text-[11px] rounded bg-red-500/20 text-red-400 hover:bg-red-500/40"
              onClick={() => op("clear-all")}
            >
              Clear all
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-1" role="group" aria-label="Filter tasks">
        {filterButtons.map((btn) => (
          <button
            key={btn.id}
            type="button"
            aria-pressed={filter === btn.id}
            onClick={() => setFilter(btn.id)}
            className={cn(
              "inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-full border transition-colors",
              filter === btn.id
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-card text-muted-foreground border-border hover:text-foreground hover:bg-accent/40",
            )}
          >
            <span>{btn.label}</span>
            {btn.badge !== undefined && (
              <span
                data-testid="mine-open-count"
                className={cn(
                  "px-1 rounded-full text-[9px] font-semibold",
                  filter === btn.id
                    ? "bg-primary-foreground/20 text-primary-foreground"
                    : btn.badge > 0
                      ? "bg-cyan-500/20 text-cyan-700 dark:text-cyan-300"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {btn.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {showCreate && (
        <div className="space-y-1.5 p-2 rounded-md bg-card border border-border min-w-0">
          <input
            className="w-full px-2 py-1.5 text-sm rounded bg-background border border-border outline-none focus:border-primary"
            placeholder="Task subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
            }}
          />
          <textarea
            rows={2}
            className="w-full px-2 py-1.5 text-xs rounded bg-background border border-border outline-none focus:border-primary resize-y"
            placeholder="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1 text-[10px]" role="group" aria-label="Task assignee">
              <span className="text-muted-foreground">Assignee:</span>
              <button
                type="button"
                aria-pressed={assignee === "llm"}
                onClick={() => setAssignee("llm")}
                className={cn(
                  "px-1.5 py-0.5 rounded border transition-colors",
                  assignee === "llm"
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background text-muted-foreground border-border hover:text-foreground",
                )}
              >
                Agent [llm]
              </button>
              <button
                type="button"
                aria-pressed={assignee === "user"}
                onClick={() => setAssignee("user")}
                className={cn(
                  "px-1.5 py-0.5 rounded border transition-colors",
                  assignee === "user"
                    ? "bg-cyan-600 text-white border-cyan-600"
                    : "bg-background text-muted-foreground border-border hover:text-foreground",
                )}
              >
                Me [you]
              </button>
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                className="px-2 py-1 text-[11px] rounded bg-muted/50 hover:bg-muted"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="px-2 py-1 text-[11px] rounded bg-primary text-primary-foreground"
                onClick={create}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {visibleTasks.length === 0 && (
        <div className="text-xs text-muted-foreground py-4 text-center">
          {tasks.length === 0 ? "No tasks" : "No matching tasks"}
        </div>
      )}

      <div className="space-y-1.5">
        {visibleTasks.map((t) => {
          const userAssigned = isUserTask(t);
          const isExpanded = expandedIds.has(t.id);
          const isCompleting = completingTaskId === t.id;
          const isSubmittingThis = submittingCompleteIds.has(t.id);
          const blockedBy = Array.isArray(t.blockedBy) ? t.blockedBy : [];
          return (
            <div
              key={t.id}
              data-task-id={t.id}
              className={cn(
                "p-2 rounded-md bg-card border text-xs min-w-0",
                userAssigned ? "border-cyan-500/40" : "border-border",
                t.status === "completed" && "opacity-65",
              )}
            >
              <button
                type="button"
                aria-expanded={isExpanded}
                onClick={() => toggleExpanded(t.id)}
                className="w-full text-left flex items-start gap-1.5 min-w-0"
              >
                <span className="mt-0.5 text-muted-foreground shrink-0">
                  {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                </span>
                <span
                  className={cn(
                    "shrink-0",
                    t.status === "completed"
                      ? "text-green-500"
                      : t.status === "in_progress"
                        ? "text-yellow-400"
                        : "text-muted-foreground",
                  )}
                >
                  {STATUS_ICON[t.status] ?? "◻"}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                    <span
                      className={cn(
                        "px-1 py-0 text-[9px] rounded border shrink-0 font-semibold",
                        userAssigned
                          ? "bg-cyan-500/20 text-cyan-700 dark:text-cyan-300 border-cyan-500/40"
                          : "bg-muted text-muted-foreground border-border",
                      )}
                    >
                      {userAssigned ? "[you]" : "[llm]"}
                    </span>
                    <span
                      className={cn(
                        "font-medium text-foreground break-words min-w-0",
                        t.status === "completed" && "line-through",
                      )}
                    >
                      #{t.id} {t.subject}
                    </span>
                    {blockedBy.length > 0 && t.status !== "completed" && (
                      <span
                        className="text-[10px] text-amber-600 dark:text-amber-400 shrink-0"
                        title={`Blocked by ${blockedBy.map((id) => `#${id}`).join(", ")}`}
                      >
                        ⛔
                      </span>
                    )}
                  </div>
                  {t.activeForm && t.status === "in_progress" && (
                    <div className="text-[10px] text-yellow-500 dark:text-yellow-400/80 break-words mt-0.5">
                      {t.activeForm}…
                    </div>
                  )}
                </div>
              </button>

              {isExpanded && (
                <div className="mt-2 pt-2 border-t border-border/60 space-y-1.5 text-[11px] min-w-0">
                  <div>
                    <div className="text-[10px] font-medium text-muted-foreground">Description</div>
                    <div className="text-foreground whitespace-pre-wrap break-words">
                      {t.description || "—"}
                    </div>
                  </div>
                  {blockedBy.length > 0 && (
                    <div className="flex items-center gap-1 flex-wrap">
                      <span className="text-[10px] font-medium text-muted-foreground">Blocked by:</span>
                      {blockedBy.map((bid) => (
                        <button
                          key={bid}
                          type="button"
                          onClick={() => openBlockedByTask(bid)}
                          title={`Open blocking task #${bid}`}
                          className="px-1.5 py-0.5 text-[10px] rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30 hover:bg-amber-500/30 underline-offset-2 hover:underline cursor-pointer"
                        >
                          #{bid}
                        </button>
                      ))}
                    </div>
                  )}
                  {t.completedBy && (
                    <div className="text-[10px] text-muted-foreground">
                      Completed by: <span className="text-foreground font-medium">{t.completedBy}</span>
                    </div>
                  )}
                  {t.completionNote && (
                    <div>
                      <div className="text-[10px] font-medium text-muted-foreground">Completion note</div>
                      <div className="text-foreground whitespace-pre-wrap break-words">
                        {t.completionNote}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {isCompleting && userAssigned && t.status !== "completed" && (
                <div className="mt-2 p-2 rounded bg-background border border-cyan-500/40 space-y-1.5">
                  <input
                    className="w-full px-2 py-1 text-xs rounded bg-card border border-border outline-none focus:border-primary"
                    placeholder="Optional completion note… (Enter to complete)"
                    maxLength={COMPLETION_NOTE_MAX}
                    value={completionNote}
                    onChange={(e) => setCompletionNote(e.target.value)}
                    disabled={isSubmittingThis}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitUserComplete(t.id);
                      if (e.key === "Escape" && !isSubmittingThis) {
                        setCompletingTaskId(null);
                        setCompletionNote("");
                      }
                    }}
                  />
                  <div className="flex gap-1 justify-end">
                    <button
                      type="button"
                      disabled={isSubmittingThis}
                      className="px-1.5 py-0.5 text-[10px] rounded bg-muted/60 hover:bg-muted disabled:opacity-50"
                      onClick={() => {
                        setCompletingTaskId(null);
                        setCompletionNote("");
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={isSubmittingThis}
                      className="px-2 py-0.5 text-[10px] rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                      onClick={() => submitUserComplete(t.id)}
                    >
                      {isSubmittingThis ? "Completing…" : "Confirm Done"}
                    </button>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-1 mt-1.5 justify-end flex-wrap">
                <CopyButton
                  text={formatTaskCopyText(t)}
                  title={`Copy task #${t.id}`}
                  onCopied={() => notify(`Copied task #${t.id}`)}
                />
                {userAssigned ? (
                  t.status !== "completed" && !isCompleting && (
                    <button
                      type="button"
                      className="px-1.5 py-0.5 text-[10px] rounded bg-green-500/20 text-green-600 dark:text-green-400 hover:bg-green-500/40 font-medium"
                      onClick={() => {
                        setCompletingTaskId(t.id);
                        setCompletionNote("");
                      }}
                    >
                      Done
                    </button>
                  )
                ) : (
                  <>
                    {t.status === "pending" && (
                      <button
                        type="button"
                        className="px-1.5 py-0.5 text-[10px] rounded bg-yellow-500/20 text-yellow-600 dark:text-yellow-400 hover:bg-yellow-500/40"
                        onClick={() => op("start", { taskId: t.id })}
                      >
                        Start
                      </button>
                    )}
                    {t.status === "in_progress" && (
                      <button
                        type="button"
                        className="px-1.5 py-0.5 text-[10px] rounded bg-green-500/20 text-green-600 dark:text-green-400 hover:bg-green-500/40"
                        onClick={() => op("complete", { taskId: t.id })}
                      >
                        Complete
                      </button>
                    )}
                  </>
                )}
                <button
                  type="button"
                  className="px-1.5 py-0.5 text-[10px] rounded bg-red-500/20 text-red-400 hover:bg-red-500/40"
                  onClick={() => op("delete", { taskId: t.id })}
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
