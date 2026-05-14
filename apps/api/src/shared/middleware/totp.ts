import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "@/shared/lib/types";
import { validateStepUpToken } from "@/modules/account/users/totp.service";

export const requireTotp: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ success: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } }, 401);
  }

  const header = c.req.header("x-totp-token");
  if (!header || !validateStepUpToken(header, user.id)) {
    return c.json({ success: false, error: { code: "STEP_UP_REQUIRED", message: "TOTP step-up verification required" } }, 401);
  }

  return next();
};

export const requireTotpStepUp = requireTotp;
