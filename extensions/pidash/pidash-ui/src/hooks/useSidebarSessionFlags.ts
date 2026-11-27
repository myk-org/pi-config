import { useCallback, useEffect, useRef, useState } from "react";
import { createLogger } from "../lib/create-logger.ts";
import {
  ARCHIVED_SESSIONS_STORAGE_KEY,
  PINNED_SESSIONS_STORAGE_KEY,
  loadPersistedSidebarFlagsDetailed,
  reconcileAndToggleArchive,
  reconcileAndTogglePin,
  reconcileAndUnarchive,
  type SidebarFlags,
} from "../lib/pidash-ux-helpers.ts";

const log = createLogger("SidebarFlags");

/**
 * Manages persisted pinned/archived session sets with cross-tab `storage`
 * synchronization and read-before-write reconciliation outside React state
 * updaters so StrictMode/concurrent replays never undo a click and storage
 * failures fall back cleanly to in-memory state.
 */
export function useSidebarSessionFlags() {
  const initialRef = useRef<{ flags: SidebarFlags; ok: boolean } | null>(null);
  if (initialRef.current === null) {
    initialRef.current = loadPersistedSidebarFlagsDetailed();
  }

  const [flags, setFlags] = useState<SidebarFlags>(() => initialRef.current!.flags);
  const flagsRef = useRef<SidebarFlags>(flags);
  const storageBrokenRef = useRef<boolean>(!initialRef.current.ok);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    const onStorage = (ev: StorageEvent) => {
      if (
        ev.key !== null
        && ev.key !== PINNED_SESSIONS_STORAGE_KEY
        && ev.key !== ARCHIVED_SESSIONS_STORAGE_KEY
      ) {
        return;
      }
      const loaded = loadPersistedSidebarFlagsDetailed();
      if (!loaded.ok) return;
      storageBrokenRef.current = false;
      flagsRef.current = loaded.flags;
      log.debug("synced sidebar session flags from storage event", { key: ev.key });
      setFlags(loaded.flags);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const togglePin = useCallback((sessionId: string) => {
    const next = reconcileAndTogglePin(flagsRef.current, sessionId, !storageBrokenRef.current);
    if (!next.persisted) storageBrokenRef.current = true;
    const nextFlags = { pinned: next.pinned, archived: next.archived };
    flagsRef.current = nextFlags;
    log.debug("session pin toggled", { sessionId, pinned: next.isPinned, persisted: next.persisted });
    setFlags(nextFlags);
  }, []);

  const toggleArchive = useCallback((sessionId: string) => {
    const next = reconcileAndToggleArchive(flagsRef.current, sessionId, !storageBrokenRef.current);
    if (!next.persisted) storageBrokenRef.current = true;
    const nextFlags = { pinned: next.pinned, archived: next.archived };
    flagsRef.current = nextFlags;
    log.debug("session archive toggled", { sessionId, archived: next.isArchived, persisted: next.persisted });
    setFlags(nextFlags);
  }, []);

  const unarchive = useCallback((sessionId: string) => {
    const next = reconcileAndUnarchive(flagsRef.current, sessionId, !storageBrokenRef.current);
    if (!next.persisted) storageBrokenRef.current = true;
    if (!next.changed) return;
    const nextFlags = { pinned: next.pinned, archived: next.archived };
    flagsRef.current = nextFlags;
    log.info("auto-unarchived session on send", { sessionId });
    setFlags(nextFlags);
  }, []);

  return {
    pinned: flags.pinned,
    archived: flags.archived,
    togglePin,
    toggleArchive,
    unarchive,
  };
}
