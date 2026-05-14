import { create } from "zustand";
import { BASE_PATH, http, SystemLockedError } from "@/shared/lib/http";

type Role = "admin" | "user";

interface UserGroup {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
}

interface User {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly email: string;
  readonly avatar?: string;
  readonly role: Role;
  readonly status: string;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
  readonly groups: readonly UserGroup[];
}

interface AuthState {
  readonly user: User | null;
  readonly loading: boolean;
  readonly fetchUser: () => Promise<void>;
  readonly logout: () => Promise<void>;
}

interface MeResponse {
  success: boolean;
  data: User;
}

export const useAuthStore = create<AuthState>(set => ({
  user: null,
  loading: true,
  fetchUser: async () => {
    try {
      set({ loading: true });
      const res = await http<MeResponse>("/account/me");
      set({ user: res.data, loading: false });
    }
    catch (err) {
      // Don't clear user on SYSTEM_LOCKED — system just isn't ready yet
      if (err instanceof SystemLockedError) {
        set({ loading: false });
        return;
      }
      set({ user: null, loading: false });
    }
  },
  logout: async () => {
    try {
      await http("/account/auth/logout", { method: "POST" });
    }
    catch {
      // ignore
    }
    set({ user: null });
    window.location.href = `${BASE_PATH}/login`;
  },
}));
