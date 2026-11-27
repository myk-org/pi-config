import { useCallback, useEffect, useState } from "react";
import { createLogger } from "../lib/create-logger.ts";
import {
  ARCHIVED_SESSIONS_STORAGE_KEY,
  PINNED_SESSIONS_STORAGE_KEY,
  loadPersistedSidebarFlags,
  reconcileAndToggleArchive,
  reconcileAndTogglePin,
  reconcileAndUnarchive,
  type SidebarFlags,
} from "../lib/pidash-ux-helpers.ts";

const log = createLogger("SidebarFlags");

/**
 * Manages persisted pinned/archived session sets with cross-tab `storage`
 * synchronization and read-before-write reconciliation so concurrent tabs
 * never overwrite each other's updates.
 */
export function useSidebarSessionFlags() {
  const [flags, setFlags] = useState<SidebarFlags>(() => loadPersistedSidebarFlags());

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
      log.debug("synced sidebar session flags from storage event", { key: ev.key });
      setFlags(loadPersistedSidebarFlags());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const togglePin = useCallback((sessionId: string) => {
    setFlags((prev) => {
      const next = reconcileAndTogglePin(prev, sessionId);
      log.debug("session pin toggled", { sessionId, pinned: next.isPinned });
      return { pinned: next.pinned, archived: next.archived };
    });
  }, []);

  const toggleArchive = useCallback((sessionId: string) => {
    setFlags((prev) => {
      const next = reconcileAndToggleArchive(prev, sessionId);
      log.debug("session archive toggled", { sessionId, archived: next.isArchived });
      return { pinned: next.pinned, archived: next.archived };
    });
  }, []);

  const unarchive = useCallback((sessionId: string) => {
    setFlags((prev) => {
      const next = reconcileAndUnarchive(prev, sessionId);
      if (!next.changed) return prev;
      log.info("auto-unarchived session on send", { sessionId });
      return { pinned: next.pinned, archived: next.archived };
    });
  }, []);

  return {
    pinned: flags.pinned,
    archived: flags.archived,
    togglePin,
    toggleArchive,
    unarchive,
  };
}
