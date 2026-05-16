/** Stable surface for the rest of the API: `loadConfig` returns a fully-resolved `Config`. */
import type { Config } from "./config/schema";
import { resolve } from "node:path";
import process from "node:process";
import { ConfigError } from "./config/errors";
import { resolveOidcDiscovery } from "./config/oidc-discovery";
import { configSchema } from "./config/schema";
import { assertProductionNetworkGuards, assertProductionSentinels } from "./config/sentinels";
import { oauthInPlay, resolveSingleUserConfig } from "./config/single-user";

import { ROOT_DIR } from "./root";

export { ConfigError } from "./config/errors";
/**
 * Public config entrypoint. The heavy lifting lives in
 * `apps/api/src/config/`:
 *
 *   - `schema.ts`         — zod schema + `Config` type.
 *   - `single-user.ts`    — single-user mode hash resolution / validation.
 *   - `sentinels.ts`      — production sentinel + network-boundary guards.
 *   - `oidc-discovery.ts` — IdP discovery fetch + same-origin cache.
 *   - `errors.ts`         — `ConfigError` raised by the guards.
 *
 * `loadConfig` is the boot-time entrypoint used by `app.ts` —
 * it prints + `process.exit(1)`s on `ConfigError`. Unit tests reach
 * for `loadConfigStrict` instead so failures surface as throws.
 */
export type { Config } from "./config/schema";

const RE_SLASH_TRIM = /^\/+|\/+$/g;
const RE_DB_SUFFIX = /\.db$/;

function resolvePath(p: string): string {
  return p.startsWith("/") ? p : resolve(ROOT_DIR, p);
}

/**
 * Run the entire pipeline, throwing `ConfigError` on the first guard
 * failure. Use this from tests so failures bubble up as exceptions.
 *
 * @param warn  Receives non-fatal warnings (stale OIDC cache,
 *              production-but-no-APP_URL in single-user mode, …).
 *              Defaults to `console.warn` so production output stays
 *              identical to the pre-split version.
 */
export async function loadConfigStrict(
  warn: (msg: string) => void = msg => console.warn(msg),
): Promise<Config> {
  const result = configSchema.safeParse(Bun.env);
  if (!result.success) {
    const formatted = result.error.flatten().fieldErrors;
    throw new ConfigError(`Invalid configuration: ${JSON.stringify(formatted)}`);
  }
  const data = result.data;

  // Boot guards in dependency order:
  //   1. Network-boundary requirements (CORS_ORIGIN / APP_URL).
  //   2. Single-user mode (resolves hash file → validates format).
  //   3. Production sentinels (refuse example values).
  for (const w of assertProductionNetworkGuards(data, oauthInPlay(data)))
    warn(w);
  resolveSingleUserConfig(data, resolvePath);
  assertProductionSentinels(data);

  // Resolve OIDC endpoints from env vars if available (for initial seeding).
  // Discovery is best-effort: try the network first, fall back to the on-disk
  // cache so a deploy that boots while the IdP is degraded still serves
  // traffic with the last-known-good endpoints. A successful refresh
  // updates the cache for next boot.
  if ((!data.OAUTH_AUTHORIZE_URL || !data.OAUTH_TOKEN_URL || !data.OAUTH_USERINFO_URL) && data.OAUTH_ISSUER) {
    const cachePath = resolvePath(`${data.DB_PATH.replace(RE_DB_SUFFIX, "")}-oidc.json`);
    const { discovery, warnings } = await resolveOidcDiscovery({ issuer: data.OAUTH_ISSUER, cachePath });
    for (const w of warnings)
      warn(w);
    if (discovery) {
      data.OAUTH_AUTHORIZE_URL ??= discovery.authorization_endpoint;
      data.OAUTH_TOKEN_URL ??= discovery.token_endpoint;
      data.OAUTH_USERINFO_URL ??= discovery.userinfo_endpoint;
      data.OIDC_LOGOUT_URL ??= discovery.end_session_endpoint;
    }
  }

  const trimmedBase = data.BASE_PATH.replace(RE_SLASH_TRIM, "");
  const basePath = trimmedBase ? `/${trimmedBase}` : "";

  return {
    ...data,
    BASE_PATH: basePath,
    DB_PATH: resolvePath(data.DB_PATH),
    LOG_FILE: resolvePath(data.LOG_FILE),
  };
}

/**
 * Boot entrypoint — wraps `loadConfigStrict` with the production
 * "print + exit" failure surface. Preserves the pre-split observable
 * behaviour: a `ConfigError` produces the same `console.error` lines
 * as the inline guards used to, then `process.exit(1)`.
 */
export async function loadConfig(): Promise<Config> {
  try {
    return await loadConfigStrict();
  }
  catch (err) {
    if (err instanceof ConfigError) {
      const where = err.field ? `[config:${err.field}] ` : "[config] ";
      console.error(`${where}${err.message}`);
      if (err.hint)
        console.error(err.hint);
      console.error("Fix: edit your .env (or set the variable in your environment), then re-run.");
      process.exit(1);
    }
    throw err;
  }
}

export function parseDefaultAdmins(raw: string): readonly string[] {
  if (!raw.trim())
    return [];
  return raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}
