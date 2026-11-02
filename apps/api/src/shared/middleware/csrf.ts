import type { AppEnv } from "@/shared/lib/types";
import { createMiddleware } from "hono/factory";
import { RE_ANY_SESSION_COOKIE } from "@/modules/account/auth/session-cookie";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const RE_ORIGIN_FROM_REFERER = /^https?:\/\/[^/]+/;
// Accepts either the dev (`session_id=`) or prod (`__Secure-session_id=`)
// cookie name; sourced from the auth module so both stay in lockstep.
const RE_SESSION_COOKIE = RE_ANY_SESSION_COOKIE;

/**
 * CSRF defense for mutating requests. Two checks:
 *
 *   1. `X-Requested-With: XMLHttpRequest` must be present. Forms cannot set
 *      custom headers, and a cross-origin fetch attempting to set one triggers
 *      a CORS preflight that the browser only forwards for an allow-listed
 *      origin. Combined with `SameSite=Lax` cookies (set by `auth.routes.ts`),
 *      this stops the standard CSRF vectors.
 *
 *   2. When an allow-list can be built (from `CORS_ORIGIN`, falling back to
 *      `APP_URL`), the request must carry a matching `Origin` header (or a
 *      `Referer` whose origin matches). Missing both is treated as a
 *      rejection — closes the gap where a `Referrer-Policy: no-referrer`
 *      request would otherwise skip the origin check entirely. When no
 *      allow-list can be built, production fails closed (rejects mutating
 *      requests); dev stays permissive but logs a warning.
 *
 * Bearer-token requests are exempt (no cookie → no CSRF surface).
 */
export const csrfGuard = createMiddleware<AppEnv>(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) {
    return next();
  }

  // Only exempt pure Bearer-token requests. If a session cookie is also
  // present, the cookie auth provider sees it first — a CSRF attacker could
  // send `Authorization: Bearer x` with the victim's cookie and bypass this
  // gate. Requiring the cookie to be absent closes that footgun.
  const auth = c.req.header("authorization");
  const cookies = c.req.header("cookie") ?? "";
  const hasSessionCookie = RE_SESSION_COOKIE.test(cookies);
  if (auth?.startsWith("Bearer ") && !hasSessionCookie) {
    return next();
  }

  const xrw = c.req.header("x-requested-with");
  if (xrw !== "XMLHttpRequest") {
    return c.json(
      {
        success: false,
        error: { code: "CSRF_REJECTED", message: "Missing CSRF header" },
      },
      403,
    );
  }

  // Build the allow-list from CORS_ORIGIN, falling back to APP_URL's
  // origin when CORS_ORIGIN is unset. Without this fallback the guard would
  // reduce to "X-Requested-With present" alone in single-origin deploys
  // (one host serves the SPA + API, CORS_ORIGIN intentionally unset).
  const config = c.get("config");
  const allowed = buildAllowedOrigins(config.CORS_ORIGIN, config.APP_URL);

  // No allow-list could be built (neither CORS_ORIGIN nor APP_URL set). Fail
  // closed in production — silently skipping the origin check there would
  // degrade CSRF defense to the `X-Requested-With` header alone. In dev we
  // stay permissive (no config is required to run locally) but log a warning.
  if (allowed.length === 0) {
    if (config.NODE_ENV === "production") {
      return c.json(
        {
          success: false,
          error: { code: "CSRF_REJECTED", message: "Origin verification unavailable" },
        },
        403,
      );
    }
    c.get("logger")?.warn(
      { path: c.req.path, method: c.req.method },
      "CSRF origin check skipped: set CORS_ORIGIN or APP_URL (permissive in dev only)",
    );
    return next();
  }

  const origin = c.req.header("origin")
    ?? c.req.header("referer")?.match(RE_ORIGIN_FROM_REFERER)?.[0];
  if (!origin || !allowed.includes(origin)) {
    return c.json(
      {
        success: false,
        error: { code: "CSRF_REJECTED", message: "Origin mismatch" },
      },
      403,
    );
  }

  return next();
});

function originOf(url: string | undefined): string | undefined {
  if (!url)
    return undefined;
  try {
    return new URL(url).origin;
  }
  catch {
    return undefined;
  }
}

function buildAllowedOrigins(corsOrigin: string | undefined, appUrl: string | undefined): readonly string[] {
  if (corsOrigin) {
    return corsOrigin.split(",").map(s => s.trim()).filter(Boolean);
  }
  const fromAppUrl = originOf(appUrl);
  return fromAppUrl
    ? [fromAppUrl]
    : [];
}
