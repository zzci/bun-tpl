import type { Context } from "hono";
import type { AppDatabase } from "@/db";
import type { AppEnv, User } from "@/shared/lib/types";

/**
 * AuthProvider resolves the authenticated user for a request, or returns
 * undefined if the request is anonymous / has an invalid session.
 *
 * The provider is registered by `apps/api/src/modules/account/index.ts` so
 * that the shared middleware can stay free of imports from the `account`
 * module (avoids a layering cycle).
 */
export type AuthProvider = (db: AppDatabase, c: Context<AppEnv>) => Promise<User | undefined>;

let _provider: AuthProvider | undefined;

export function registerAuthProvider(p: AuthProvider): void {
  _provider = p;
}

export function getAuthProvider(): AuthProvider {
  if (!_provider) {
    throw new Error("AuthProvider not registered — ensure account module is loaded before auth middleware runs");
  }
  return _provider;
}
