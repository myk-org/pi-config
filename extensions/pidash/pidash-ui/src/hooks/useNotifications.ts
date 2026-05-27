import { useCallback, useEffect, useState } from "react";
import type { NotificationPreferences } from "@/types";

const STORAGE_KEY = "pidash-notifications";

const DEFAULT_PREFS: NotificationPreferences = {
  turnComplete: true,
  agentComplete: true,
  testResults: true,
  sessionError: true,
  toolComplete: false,
  inputNeeded: true,
};

function loadPrefs(): NotificationPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_PREFS };
}

function savePrefs(prefs: NotificationPreferences) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch {}
}

export function useNotifications() {
  const supported = typeof window !== "undefined" && "Notification" in window;
  const [permission, setPermission] = useState<NotificationPermission>(
    supported ? Notification.permission : "denied"
  );
  const [preferences, setPreferences] = useState<NotificationPreferences>(loadPrefs);

  // Sync permission state (e.g. user changes in browser settings)
  useEffect(() => {
    if (!supported) return;
    setPermission(Notification.permission);
  }, [supported]);

  const requestPermission = useCallback(async () => {
    if (!supported) return;
    const result = await Notification.requestPermission();
    setPermission(result);
  }, [supported]);

  const setPreference = useCallback(<K extends keyof NotificationPreferences>(key: K, value: boolean) => {
    setPreferences((prev) => {
      const next = { ...prev, [key]: value };
      savePrefs(next);
      return next;
    });
  }, []);

  const notify = useCallback((title: string, options?: NotificationOptions) => {
    if (!supported || permission !== "granted") return;
    try {
      const n = new Notification(title, options);
      n.onclick = () => { window.focus(); n.close(); };
      setTimeout(() => n.close(), 5000);
    } catch {}
  }, [supported, permission]);

  return { permission, supported, preferences, setPreference, requestPermission, notify };
}
