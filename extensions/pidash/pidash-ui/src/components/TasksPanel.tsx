import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { TaskItem } from "@/types";

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

/** #968 A — task list with live updates and full TUI /tasks parity operations. */
export function TasksPanel({ sendCmd, onMessage, notify }: Props) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    sendCmd("tasks-list");
    return onMessage((ev: any) => {
      if (ev.type === "tasks-list" && Array.isArray(ev.tasks)) setTasks(ev.tasks);
    });
  }, [sendCmd, onMessage]);

  const op = (opName: string, extra?: Record<string, unknown>) => sendCmd("task-op", { op: opName, ...extra });

  const create = () => {
    const s = subject.trim();
    if (!s) return;
    op("create", { subject: s, description: description.trim() });
    setSubject("");
    setDescription("");
    setShowCreate(false);
    notify("Task created");
  };

  const active = tasks.filter((t) => t.status !== "completed");
  const completedCount = tasks.length - active.length;

  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-foreground">
          Tasks {tasks.length > 0 && <span className="text-muted-foreground font-normal">({completedCount}/{tasks.length} done)</span>}
        </span>
        <div className="flex gap-1">
          <button className="px-2 py-0.5 text-[11px] rounded bg-accent/50 hover:bg-accent" onClick={() => setShowCreate((v) => !v)}>+ New</button>
          {completedCount > 0 && (
            <button className="px-2 py-0.5 text-[11px] rounded bg-muted/50 hover:bg-muted" onClick={() => op("clear-completed")}>Clear done</button>
          )}
          {tasks.length > 0 && (
            <button className="px-2 py-0.5 text-[11px] rounded bg-red-500/20 text-red-400 hover:bg-red-500/40" onClick={() => op("clear-all")}>Clear all</button>
          )}
        </div>
      </div>

      {showCreate && (
        <div className="space-y-1.5 p-2 rounded-md bg-card border border-border">
          <input
            className="w-full px-2 py-1.5 text-sm rounded bg-background border border-border outline-none focus:border-primary"
            placeholder="Task subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") create(); }}
          />
          <input
            className="w-full px-2 py-1.5 text-sm rounded bg-background border border-border outline-none focus:border-primary"
            placeholder="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") create(); }}
          />
          <div className="flex gap-1 justify-end">
            <button className="px-2 py-1 text-[11px] rounded bg-muted/50 hover:bg-muted" onClick={() => setShowCreate(false)}>Cancel</button>
            <button className="px-2 py-1 text-[11px] rounded bg-primary text-primary-foreground" onClick={create}>Create</button>
          </div>
        </div>
      )}

      {tasks.length === 0 && <div className="text-xs text-muted-foreground py-4 text-center">No tasks</div>}

      <div className="space-y-1">
        {tasks.map((t) => (
          <div key={t.id} className={cn("p-2 rounded-md bg-card border border-border text-xs", t.status === "completed" && "opacity-60")}>
            <div className="flex items-start gap-2">
              <span className={cn(
                t.status === "completed" ? "text-green-500" : t.status === "in_progress" ? "text-yellow-400" : "text-muted-foreground",
              )}>{STATUS_ICON[t.status] ?? "◻"}</span>
              <div className="flex-1 min-w-0">
                <div className={cn("font-medium text-foreground break-words", t.status === "completed" && "line-through")}>
                  #{t.id} {t.subject}
                </div>
                {t.activeForm && t.status === "in_progress" && (
                  <div className="text-[10px] text-yellow-400/80 truncate">{t.activeForm}…</div>
                )}
              </div>
            </div>
            <div className="flex gap-1 mt-1.5 justify-end">
              {t.status === "pending" && (
                <button className="px-1.5 py-0.5 text-[10px] rounded bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/40" onClick={() => op("start", { taskId: t.id })}>Start</button>
              )}
              {t.status === "in_progress" && (
                <button className="px-1.5 py-0.5 text-[10px] rounded bg-green-500/20 text-green-400 hover:bg-green-500/40" onClick={() => op("complete", { taskId: t.id })}>Complete</button>
              )}
              <button className="px-1.5 py-0.5 text-[10px] rounded bg-red-500/20 text-red-400 hover:bg-red-500/40" onClick={() => op("delete", { taskId: t.id })}>Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
