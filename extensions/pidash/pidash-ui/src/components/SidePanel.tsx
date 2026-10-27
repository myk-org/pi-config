import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { createLogger } from "@/lib/create-logger";
import type { SessionInfo } from "@/types";

const log = createLogger("SidePanel");
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
  sessions?: SessionInfo[];
  onWatch?: (s: SessionInfo) => void;
}

/**
 * #968 — right-side parity drawer: Tasks / Coms / Memory / MCP / Settings.
 * Every surface fetches through pidash-commands and updates from broadcast
 * events, so multiple browsers converge on the same state.
 */
export function SidePanel({ session, activeTab, onTabChange, onClose, send, onMessage, sessions, onWatch }: Props) {
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

  // Drag-to-resize (persisted): the drawer width adapts to the content the
  // user is reading — settings descriptions, task lists, peer cards.
  const MIN_W = 320;
  const MAX_W = 760;
  const [width, setWidth] = useState(() => {
    // Blocked/quota-limited storage must not crash the panel (Qodo R3)
    try {
      const saved = Number(localStorage.getItem("pidash.panelWidth"));
      return Number.isFinite(saved) && saved >= MIN_W && saved <= MAX_W ? saved : 340;
    } catch {
      return 340;
    }
  });
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const endDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    try { localStorage.setItem("pidash.panelWidth", String(widthRef.current)); } catch (e) {
      log.debug("panel width persistence failed", { error: String(e) });
    }
  };
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      // Dragging the LEFT edge right decreases the width
      const next = Math.min(MAX_W, Math.max(MIN_W, d.startW - (e.clientX - d.startX)));
      widthRef.current = next; // end-handler persists the freshest width even if the render hasn't committed yet
      setWidth(next);
    };
    // widthRef so the end-handler persists the latest width without re-binding
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", endDrag);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", endDrag);
      // Unmount mid-drag (panel closed via keyboard/tab switch): restore the
      // page and persist — otherwise the body stays cursor-locked with
      // selection disabled (Qodo R3).
      if (dragRef.current) {
        endDrag();
        log.debug("panel drag ended by unmount");
      }
    };
  }, []);
  const widthRef = useRef(width);
  useEffect(() => { widthRef.current = width; }, [width]);
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: widthRef.current };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    log.debug("panel resize started", { from: widthRef.current });
  };

  const sendCmd = useCallback((command: string, extra?: Record<string, unknown>) => {
    send({ type: "pidash-command", sessionId: session.sessionId, command, ...extra });
  }, [send, session.sessionId]);

  return (
    // Phone drawer (max-md) is FULL WIDTH and opaque: at 95% the session list
    // behind it stayed faintly legible and read as panel content.
    <div
      className="relative w-[var(--panel-w)] max-md:w-full max-md:absolute max-md:inset-0 max-md:z-30 flex-shrink-0 border-l border-border flex flex-col bg-background"
      // Width via CSS variable, not an inline width: the max-md:w-full
      // variant must be able to override it on phones — an inline style would
      // win the cascade and clamp the mobile drawer to the saved desktop
      // width (Qodo R3).
      style={{ "--panel-w": `${width}px` } as React.CSSProperties}
    >
      {/* Drag handle — resize the drawer by dragging its left edge */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/40 transition-colors z-10 max-md:hidden"
        onMouseDown={startResize}
        title="Drag to resize panel"
      />
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
        {activeTab === "coms" && <ComsPanel sendCmd={sendCmd} onMessage={onMessage} notify={notify} sessions={sessions} onWatch={onWatch} />}
        {activeTab === "memory" && <MemoryPanel sendCmd={sendCmd} onMessage={onMessage} />}
        {activeTab === "mcp" && <McpPanel sendCmd={sendCmd} onMessage={onMessage} notify={notify} />}
        {activeTab === "settings" && <SettingsPanel sendCmd={sendCmd} onMessage={onMessage} notify={notify} cwd={session.cwd} />}
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
