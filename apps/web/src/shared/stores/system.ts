import { create } from "zustand";
import { http } from "@/shared/lib/http";

export type SystemStatus = "loading" | "uninitialized" | "locked" | "unlocked" | "db-error" | "error";

const POLL_INTERVAL = 30_000;

interface SystemState {
  readonly status: SystemStatus;
  readonly dbError: string | null;
  readonly fetchStatus: () => Promise<void>;
  readonly startPolling: () => void;
  readonly stopPolling: () => void;
}

interface StatusResponse {
  success: boolean;
  data: { initialized: boolean; locked: boolean; status: string; dbError?: string | null };
}

// Reference-counted polling. React 19 StrictMode mounts → unmounts → mounts
// the root once in dev, and the previous module-global `pollTimer` got
// stopped by the cleanup function while a second mount was already running
// — leaving the app un-polled in production after route churn. Refcount
// the subscribers so the timer is alive iff at least one consumer still
// wants updates, and idempotent across nested mounts.
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollRefCount = 0;

export const useSystemStore = create<SystemState>((set, get) => ({
  status: "loading",
  dbError: null,
  fetchStatus: async () => {
    try {
      const json = await http<StatusResponse>("/encryption/status");
      if (!json.success || !json.data) {
        set({ status: "error", dbError: null });
        return;
      }

      if (json.data.dbError) {
        set({ status: "db-error", dbError: json.data.dbError });
        return;
      }

      if (json.data.status === "disabled") {
        set({ status: "unlocked", dbError: null });
      }
      else if (!json.data.initialized) {
        set({ status: "uninitialized", dbError: null });
      }
      else if (json.data.locked) {
        set({ status: "locked", dbError: null });
      }
      else {
        set({ status: "unlocked", dbError: null });
      }
    }
    catch {
      set({ status: "error", dbError: null });
    }
  },
  startPolling: () => {
    pollRefCount += 1;
    if (pollTimer)
      return;
    pollTimer = setInterval(() => void get().fetchStatus(), POLL_INTERVAL);
  },
  stopPolling: () => {
    if (pollRefCount > 0)
      pollRefCount -= 1;
    if (pollRefCount === 0 && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  },
}));
