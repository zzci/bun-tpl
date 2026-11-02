import type { AppEnv } from "@/shared/lib/types";
import { createHash, timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";

export type ServiceTokenScope = "metrics" | "backup";

const SCOPED_FIELD: Record<ServiceTokenScope, "SERVICE_TOKEN_METRICS" | "SERVICE_TOKEN_BACKUP"> = {
  metrics: "SERVICE_TOKEN_METRICS",
  backup: "SERVICE_TOKEN_BACKUP",
};

export function serviceTokenRequired(scope: ServiceTokenScope) {
  const field = SCOPED_FIELD[scope];
  return createMiddleware<AppEnv>(async (c, next) => {
    const expected = c.get("config")[field];
    if (!expected) {
      return c.json(
        {
          success: false,
          error: { code: "SERVICE_TOKEN_DISABLED", message: "Service-token authentication is not configured" },
        },
        503,
      );
    }

    const auth = c.req.header("authorization");
    const supplied = auth?.startsWith("Bearer ")
      ? auth.slice("Bearer ".length).trim()
      : undefined;
    if (!supplied) {
      return c.json(
        {
          success: false,
          error: { code: "UNAUTHORIZED", message: "Service token required" },
        },
        401,
      );
    }

    // Hash both sides to a fixed 32-byte digest before the constant-time
    // compare. A raw `a.length !== b.length` short-circuit would leak the
    // configured token's length; hashing normalises the width so the check
    // is length-independent. Mirrors the PAT comparison path.
    const a = createHash("sha256").update(supplied).digest();
    const b = createHash("sha256").update(expected).digest();
    if (!timingSafeEqual(a, b)) {
      return c.json(
        {
          success: false,
          error: { code: "UNAUTHORIZED", message: "Invalid service token" },
        },
        401,
      );
    }

    return next();
  });
}
