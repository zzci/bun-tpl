import type { Context, MiddlewareHandler } from "hono";
import type { RateLimitCheck } from "./rate-limit";
import type { Config } from "@/config";
import type { AppEnv } from "@/shared/lib/types";
import { createMiddleware } from "hono/factory";
import { getClientIp } from "@/shared/lib/client-ip";
import { getAuthProvider } from "@/shared/middleware/auth-registry";
import { consumeRateLimit, rateLimited } from "./rate-limit";
import { BULK_PREFIXES, BULK_SUFFIXES, CREATE_SUFFIXES } from "./write-rate-limit.paths";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** A bucket plus its budget; the key is supplied per request by `charge`. */
type Budget = Omit<RateLimitCheck, "key">;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Strip the `${BASE_PATH}/api` mount prefix. */
function apiPath(c: Context<AppEnv>, basePath: string): string {
  const base = `${basePath}/api`;
  return c.req.path.startsWith(`${base}/`)
    ? c.req.path.slice(base.length)
    : c.req.path;
}

function isBulkWrite(path: string): boolean {
  return BULK_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`))
    || path.includes("/attachments")
    || BULK_SUFFIXES.some(suffix => path.endsWith(suffix));
}

function isRecordCreate(path: string): boolean {
  return CREATE_SUFFIXES.some(suffix => path.endsWith(suffix));
}

/**
 * Budget key: the actor, falling back to the client IP for a request that
 * reached a protected route without a resolvable session. Keying by user means
 * colleagues behind one NAT egress do not share a budget, and rotating IPs does
 * not buy a script a fresh one.
 */
function actorKey(c: Context<AppEnv>): string {
  const user = c.get("user");
  return user
    ? `user:${user.id}`
    : `ip:${getClientIp(c, c.var.config)}`;
}

/**
 * Idempotent actor load, mirroring `policyMiddleware`. Not an
 * extra query: it performs the lookup the module's own `authRequired` would
 * have done, and caches it on the context so that guard skips its own.
 */
async function ensureActor(c: Context<AppEnv>): Promise<void> {
  if (c.get("user"))
    return;
  const user = await getAuthProvider()(c.get("db"), c);
  if (user)
    c.set("user", user);
}

/**
 * Charge one hit against each budget in turn, stopping at the first that is
 * spent. A budget of `0` is disabled and skipped, and a bucket is only charged
 * once an earlier one has let the request through — so a create rejected for
 * being too fast does not also spend the hourly allowance.
 */
async function charge(key: string, budgets: readonly Budget[]): Promise<number> {
  for (const budget of budgets) {
    if (budget.max <= 0)
      continue;
    const retryAfter = await consumeRateLimit({ ...budget, key });
    if (retryAfter > 0)
      return retryAfter;
  }
  return 0;
}

/** The buckets a mutating request is charged against, in order. */
function budgetsFor(method: string, path: string, config: Config): readonly Budget[] {
  if (isBulkWrite(path)) {
    return [
      { bucket: "write-bulk", windowMs: MINUTE_MS, max: config.BULK_WRITE_RATE_LIMIT_PER_MINUTE },
    ];
  }
  if (method === "POST" && isRecordCreate(path)) {
    return [
      { bucket: "create", windowMs: MINUTE_MS, max: config.CREATE_RATE_LIMIT_PER_MINUTE_MEMORY },
      { bucket: "create-hour", windowMs: HOUR_MS, max: config.CREATE_RATE_LIMIT_PER_HOUR_MEMORY },
    ];
  }
  return [
    { bucket: "write", windowMs: MINUTE_MS, max: config.WRITE_RATE_LIMIT_PER_MINUTE },
  ];
}

/**
 * Per-actor frequency cap on every mutating protected route.
 *
 * Reads pass through untouched — they create no records. Writes are sorted into
 * three budgets, all of them per actor and all of them tunable (any knob at `0`
 * disables its bucket):
 *
 *   - `create` — `CREATE_RATE_LIMIT_PER_MINUTE_MEMORY` **and**
 *     `CREATE_RATE_LIMIT_PER_HOUR_MEMORY`. The per-hour ceiling answers "how many",
 *     not just "how fast": it stops a loop that stays politely under the
 *     per-minute budget from producing tens of thousands of rows a day.
 *   - `write-bulk` — `BULK_WRITE_RATE_LIMIT_PER_MINUTE`, see `BULK_PREFIXES`.
 *   - `write` — `WRITE_RATE_LIMIT_PER_MINUTE` for everything else. It has to
 *     clear routine editing: the issue panel patches one field per request, so
 *     triaging a handful of work orders is dozens of writes a minute.
 *
 * The per-minute create budget is charged before the per-hour one, so a request
 * rejected for being too fast does not also spend the hourly allowance.
 *
 * State is in-memory (hence the `_MEMORY` suffix on the create knobs): replicas
 * each carry their own budget and a restart clears the counters. The durable,
 * per-resource creation quota is a separate gate; see `creation-rate-limit.ts`.
 */
export function writeRateLimit(): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (SAFE_METHODS.has(c.req.method))
      return next();

    const config = c.get("config");
    await ensureActor(c);
    const retryAfter = await charge(actorKey(c), budgetsFor(c.req.method, apiPath(c, config.BASE_PATH), config));
    if (retryAfter > 0)
      return rateLimited(c, retryAfter);
    return next();
  });
}
