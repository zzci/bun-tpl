import type { Context } from "hono";

/**
 * Parse and clamp the standard `page` / `limit` query parameters used
 * across the API. `page` defaults to 1, `limit` defaults to 50 and is
 * clamped to `[1, 100]`. Use this anywhere a route would otherwise hand-
 * roll `Math.max(1, Math.floor(parseInt(...))) || 1` boilerplate.
 *
 * The returned `offset` is precomputed so callers can pass it straight
 * to drizzle's `.limit(limit).offset(offset)`.
 */
export interface PageQuery {
  readonly page: number;
  readonly limit: number;
  readonly offset: number;
}

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

export function parsePageQuery(
  c: Pick<Context, "req">,
  defaults: { page?: number; limit?: number } = {},
): PageQuery {
  const pageRaw = c.req.query("page");
  const limitRaw = c.req.query("limit");
  const page = clampInt(pageRaw, defaults.page ?? DEFAULT_PAGE, 1, Number.MAX_SAFE_INTEGER);
  const limit = clampInt(limitRaw, defaults.limit ?? DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT);
  return { page, limit, offset: (page - 1) * limit };
}

function clampInt(raw: string | undefined, fallback: number, lo: number, hi: number): number {
  if (raw === undefined || raw === "")
    return fallback;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n))
    return fallback;
  return Math.min(hi, Math.max(lo, n));
}
