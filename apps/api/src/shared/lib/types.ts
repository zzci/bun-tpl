import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { users } from "@/modules/account/users/schema";
import type { EncryptionState } from "@/modules/encryption/state";
import type { Logger } from "@/shared/lib/logger";

export type User = typeof users.$inferSelect;

export interface AppEnv {
  Bindings: {
    IP: { address: string; port: number; family: "IPv4" | "IPv6" } | null;
  };
  Variables: {
    requestId: string;
    db: AppDatabase;
    config: Config;
    logger: Logger;
    encryption: EncryptionState;
    user?: User;
  };
}

/**
 * Structural constraint for any Hono env carrying the standard request
 * `Variables`. Hono's `Context<E>` is invariant in `E` (its `set` accessor), so
 * a helper annotated `Context<AppEnv>` rejects a sub-app whose env narrows a
 * variable. Helpers that must run under several envs instead take `Context<E>`
 * for `E extends RequestEnv`.
 */
export interface RequestEnv {
  Variables: AppEnv["Variables"];
}
