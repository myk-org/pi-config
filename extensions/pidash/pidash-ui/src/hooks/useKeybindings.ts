import { useCallback, useEffect, useMemo, useState } from "react";

export interface Keybinding {
  id: string;
  label: string;
  defaultKey: string;
  key: string;
}

const STORAGE_KEY = "pidash-keybindings";

export const DEFAULT_KEYBINDINGS: Keybinding[] = [
  { id: "session-switcher", label: "Open session switcher", defaultKey: "Ctrl+K", key: "Ctrl+K" },
  { id: "prev-session", label: "Previous session", defaultKey: "Ctrl+ArrowUp", key: "Ctrl+ArrowUp" },
  { id: "next-session", label: "Next session", defaultKey: "Ctrl+ArrowDown", key: "Ctrl+ArrowDown" },
  { id: "session-1", label: "Jump to session 1", defaultKey: "Ctrl+1", key: "Ctrl+1" },
  { id: "session-2", label: "Jump to session 2", defaultKey: "Ctrl+2", key: "Ctrl+2" },
  { id: "session-3", label: "Jump to session 3", defaultKey: "Ctrl+3", key: "Ctrl+3" },
  { id: "session-4", label: "Jump to session 4", defaultKey: "Ctrl+4", key: "Ctrl+4" },
  { id: "session-5", label: "Jump to session 5", defaultKey: "Ctrl+5", key: "Ctrl+5" },
  { id: "session-6", label: "Jump to session 6", defaultKey: "Ctrl+6", key: "Ctrl+6" },
  { id: "session-7", label: "Jump to session 7", defaultKey: "Ctrl+7", key: "Ctrl+7" },
  { id: "session-8", label: "Jump to session 8", defaultKey: "Ctrl+8", key: "Ctrl+8" },
  { id: "session-9", label: "Jump to session 9", defaultKey: "Ctrl+9", key: "Ctrl+9" },
  // Abort is intentionally UNBOUND in the browser UI: the Stop button in the
  // composer is the only way to kill a run. Escape is pressed constantly for
  // menu dismissal and out of habit, and a stray keypress silently destroying
  // an in-flight turn is not an acceptable default. Users who want a key can
  // assign one in Keyboard shortcuts.
  { id: "abort", label: "Abort / Stop", defaultKey: "", key: "" },
];

function loadKeybindings(): Keybinding[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_KEYBINDINGS.map(k => ({ ...k }));
    const saved: Record<string, string> = JSON.parse(raw);
    return DEFAULT_KEYBINDINGS.map(k => ({
      ...k,
      // Drop a persisted Escape->abort from older versions: it was the default
      // that silently killed runs, so it must not survive an upgrade.
      key: k.id === "abort" && saved[k.id] === "Escape" ? k.defaultKey : saved[k.id] || k.defaultKey,
    }));
  } catch {
    return DEFAULT_KEYBINDINGS.map(k => ({ ...k }));
  }
}

function saveKeybindings(bindings: Keybinding[]) {
  try {
    const map: Record<string, string> = {};
    for (const b of bindings) map[b.id] = b.key;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {}
}

export function eventToKeyString(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  const key = e.key;
  if (!["Control", "Alt", "Shift", "Meta"].includes(key)) {
    parts.push(key.length === 1 ? key.toUpperCase() : key);
  }
  return parts.join("+");
}

export function matchesKeybinding(e: KeyboardEvent, keyStr: string): boolean {
  const parts = keyStr.split("+");
  const needCtrl = parts.includes("Ctrl");
  const needAlt = parts.includes("Alt");
  const needShift = parts.includes("Shift");
  const keyPart = parts.filter(p => !["Ctrl", "Alt", "Shift"].includes(p))[0] || "";

  if (needCtrl !== (e.ctrlKey || e.metaKey)) return false;
  if (needAlt !== e.altKey) return false;
  if (needShift !== e.shiftKey) return false;

  const eventKey = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return eventKey === keyPart;
}

/**
 * True only when a real key is configured AND it matches the event.
 *
 * Abort ships unbound (`""`) because Escape is pressed constantly for menu
 * dismissal; `matchesKeybinding(e, "")` would otherwise match every keypress
 * and silently destroy an in-flight turn. The Stop button is the abort path.
 */
export function isAbortKey(e: KeyboardEvent, keyStr: string): boolean {
  return Boolean(keyStr) && matchesKeybinding(e, keyStr);
}

export function useKeybindings() {
  const [bindings, setBindings] = useState<Keybinding[]>(loadKeybindings);

  const updateBinding = useCallback((id: string, newKey: string) => {
    setBindings(prev => {
      // Clear duplicate: if another binding uses this key, reset it to its default
      const updated = prev.map(b => {
        if (b.id === id) return { ...b, key: newKey };
        if (b.key === newKey) return { ...b, key: b.defaultKey };
        return b;
      });
      saveKeybindings(updated);
      return updated;
    });
  }, []);

  const resetToDefaults = useCallback(() => {
    const defaults = DEFAULT_KEYBINDINGS.map(k => ({ ...k }));
    saveKeybindings(defaults);
    setBindings(defaults);
  }, []);

  const getKey = useCallback((id: string): string => {
    return bindings.find(b => b.id === id)?.key || "";
  }, [bindings]);

  const api = useMemo(() => ({ bindings, updateBinding, resetToDefaults, getKey }), [bindings, updateBinding, resetToDefaults, getKey]);
  return api;
}
