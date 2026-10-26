import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionInfo } from "@/types";
import { TasksPanel } from "./TasksPanel";
import { ComsPanel } from "./ComsPanel";
import { MemoryPanel } from "./MemoryPanel";
import { McpPanel } from "./McpPanel";
import { SettingsPanel } from "./SettingsPanel";

export type PanelTab = "tasks" | "coms" | "memory" | "mcp" | "settings";

const TABS: Array<{ id: PanelTab; label: string }> = [
  { id: "tasks", label: "Tasks" },
  { id: "coms", label: "Coms" },
  { id: "memory", label: "Memory" },
  { id: "mcp", label: "MCP" },
  { id: "settings", label: "Settings" },
];

interface Props {
  session: SessionInfo;
  activeTab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  onClose: () => void;
  send: (data: object) => void;
  onMessage: (handler: (data: any) => void) => () => void;
}

/**
 * #968 — right-side parity drawer: Tasks / Coms / Memory / MCP / Settings.
 * Every surface fetches through pidash-commands and updates from broadcast
 * events, so multiple browsers converge on the same state.
 */
export function SidePanel({ session, activeTab, onTabChange, onClose, send, onMessage }: Props) {
  // Route extension notifications into a transient toast line.
  // Stable identity: panels use notify in effect deps — a new function per
  // render would restart their fetch effects on every session_updated re-render.
  const [toast, setToast] = useState<{ msg: string; level: string } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  const notify = useCallback((msg: string, level?: string) => setToast({ msg: String(msg), level: level || "info" }), []);

  const sendCmd = useCallback((command: string, extra?: Record<string, unknown>) => {
    send({ type: "pidash-command", sessionId: session.sessionId, command, ...extra });
  }, [send, session.sessionId]);

  return (
    <div className="w-[340px] max-md:w-full max-md:absolute max-md:inset-0 max-md:z-30 flex-shrink-0 border-l border-border flex flex-col bg-background max-md:bg-background/95">
      <div className="flex items-center border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={cn(
              "flex-1 px-2 py-2 text-xs font-medium transition-colors",
              activeTab === t.id ? "text-foreground border-b-2 border-primary bg-accent/30" : "text-muted-foreground hover:text-foreground hover:bg-accent/20",
            )}
            onClick={() => onTabChange(t.id)}
          >
            {t.label}
          </button>
        ))}
        <button className="px-2 py-2 text-muted-foreground hover:text-foreground" onClick={onClose} title="Close panel">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {activeTab === "tasks" && <TasksPanel sendCmd={sendCmd} onMessage={onMessage} notify={notify} />}
        {activeTab === "coms" && <ComsPanel sendCmd={sendCmd} onMessage={onMessage} notify={notify} />}
        {activeTab === "memory" && <MemoryPanel sendCmd={sendCmd} onMessage={onMessage} />}
        {activeTab === "mcp" && <McpPanel sendCmd={sendCmd} onMessage={onMessage} notify={notify} />}
        {activeTab === "settings" && <SettingsPanel sendCmd={sendCmd} onMessage={onMessage} notify={notify} />}
      </div>
      {toast && (
        <div className={cn(
          "px-3 py-1.5 text-xs border-t",
          toast.level === "error" ? "text-red-400 border-red-500/30 bg-red-500/10" : "text-muted-foreground border-border",
        )}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
