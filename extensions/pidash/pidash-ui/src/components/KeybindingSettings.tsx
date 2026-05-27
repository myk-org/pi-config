import { useCallback, useEffect, useState } from "react";
import type { Keybinding } from "@/hooks/useKeybindings";
import { eventToKeyString } from "@/hooks/useKeybindings";

interface Props {
  bindings: Keybinding[];
  onUpdate: (id: string, newKey: string) => void;
  onReset: () => void;
  onClose: () => void;
}

export function KeybindingSettings({ bindings, onUpdate, onReset, onClose }: Props) {
  const [recording, setRecording] = useState<string | null>(null);

  const handleKeyCapture = useCallback((e: KeyboardEvent) => {
    if (!recording) return;
    // Ignore lone modifier keys
    if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    // Escape cancels recording instead of assigning
    if (e.key === "Escape") { setRecording(null); return; }
    const keyStr = eventToKeyString(e);
    onUpdate(recording, keyStr);
    setRecording(null);
  }, [recording, onUpdate]);

  useEffect(() => {
    if (!recording) return;
    document.addEventListener("keydown", handleKeyCapture, true);
    return () => {
      document.removeEventListener("keydown", handleKeyCapture, true);
    };
  }, [recording, handleKeyCapture]);

  const formatKey = (key: string) => {
    return key.split("+").map((part, i) => (
      <span key={i}>
        {i > 0 && <span className="text-muted-foreground mx-0.5">+</span>}
        <kbd className="bg-accent border border-border px-1.5 py-0.5 rounded text-xs font-mono">{part}</kbd>
      </span>
    ));
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center pt-[10vh] z-50" onClick={onClose} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts settings">
      <div className="w-[600px] max-h-[75vh] overflow-y-auto bg-card border border-border rounded-lg shadow-2xl p-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold flex items-center gap-2">⚙️ Keyboard Shortcuts</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-sm px-2 py-1 rounded hover:bg-accent">✕ Close</button>
        </div>
        <p className="text-xs text-muted-foreground mb-6">Customize keyboard shortcuts. Changes are saved automatically.</p>

        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left text-[11px] font-semibold text-muted-foreground uppercase py-2 px-3">Action</th>
              <th className="text-left text-[11px] font-semibold text-muted-foreground uppercase py-2 px-3">Shortcut</th>
              <th className="w-16"></th>
            </tr>
          </thead>
          <tbody>
            {bindings.map(b => (
              <tr key={b.id} className="border-b border-border/30 hover:bg-accent/30 transition-colors">
                <td className="py-2.5 px-3 text-sm">{b.label}</td>
                <td className="py-2.5 px-3">
                  {recording === b.id ? (
                    <div className="inline-flex items-center gap-2 px-2.5 py-1 border border-primary rounded text-xs text-primary animate-pulse">
                      ⏺ Press new shortcut...
                    </div>
                  ) : (
                    <span className="inline-flex items-center gap-0.5">{formatKey(b.key)}</span>
                  )}
                </td>
                <td className="py-2.5 px-3">
                  {recording !== b.id && (
                    <button
                      onClick={() => setRecording(b.id)}
                      className="text-[11px] text-muted-foreground border border-border px-2 py-0.5 rounded hover:bg-accent hover:text-foreground transition-colors"
                    >
                      Edit
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <button
          onClick={onReset}
          className="mt-6 text-xs text-muted-foreground border border-border px-4 py-2 rounded hover:bg-accent hover:text-foreground transition-colors"
        >
          Reset to Defaults
        </button>
        <p className="mt-3 text-[11px] text-muted-foreground flex items-center gap-1.5">
          <span className="text-green-500">✓</span> Settings saved automatically
        </p>
      </div>
    </div>
  );
}
