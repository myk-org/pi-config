import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

interface Props {
  send: (data: object) => void;
  onMessage: (handler: (data: any) => void) => () => void;
  sessionId: string;
  onClose: () => void;
}

/** #968 D — new session creation: name + initial model. */
export function NewSessionDialog({ send, onMessage, sessionId, onClose }: Props) {
  const [name, setName] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelId, setModelId] = useState("");
  const [filter, setFilter] = useState("");

  useEffect(() => {
    send({ type: "pidash-command", command: "list-models", sessionId });
    return onMessage((ev: any) => {
      if (ev.type === "models-list" && ev.models) setModels(ev.models);
    });
  }, [send, onMessage, sessionId]);

  const create = () => {
    send({
      type: "pidash-command",
      sessionId,
      command: "new-session",
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(modelId ? { modelId } : {}),
    });
    onClose();
  };

  const filtered = models.filter((m) => {
    if (!filter) return true;
    const f = filter.toLowerCase();
    return m.name?.toLowerCase().includes(f) || m.id?.toLowerCase().includes(f) || m.provider?.toLowerCase().includes(f);
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-[380px] max-w-[90vw] rounded-lg bg-card border border-border shadow-xl p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <span className="text-sm font-bold text-foreground">New session</span>
          <button className="text-muted-foreground hover:text-foreground" onClick={onClose}><X className="h-4 w-4" /></button>
        </div>

        <div>
          <label className="text-xs text-muted-foreground">Session name (optional)</label>
          <input
            className="w-full mt-1 px-2 py-1.5 text-sm rounded bg-background border border-border outline-none focus:border-primary"
            placeholder="e.g. issue-973-fix"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") create(); }}
          />
        </div>

        <div>
          <label className="text-xs text-muted-foreground">Initial model (optional)</label>
          <input
            className="w-full mt-1 px-2 py-1.5 text-xs rounded bg-background border border-border outline-none focus:border-primary"
            placeholder="Search models…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="mt-1 max-h-48 overflow-y-auto rounded border border-border">
            {models.length === 0 && <div className="px-2 py-2 text-xs text-muted-foreground">Loading models…</div>}
            {filtered.map((m) => (
              <button
                key={m.id}
                className={cn(
                  "w-full text-left px-2 py-1.5 text-xs hover:bg-accent transition-colors flex justify-between",
                  modelId === m.id && "bg-accent/50",
                )}
                onClick={() => setModelId(m.id)}
              >
                <span className="truncate">{m.name || m.id}</span>
                <span className="text-[10px] text-muted-foreground ml-2 shrink-0">{m.provider}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button className="px-3 py-1.5 text-xs rounded bg-muted/50 hover:bg-muted" onClick={onClose}>Cancel</button>
          <button className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground" onClick={create}>Create</button>
        </div>
      </div>
    </div>
  );
}
