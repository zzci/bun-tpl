import type { Config } from "./config";
import type { AppDatabase } from "./db";
import type { EncryptionState } from "./modules/encryption/state";
import type { Logger } from "./shared/lib/logger";
import type { AppEnv } from "./shared/lib/types";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { loadConfig } from "./config";
import { logDefaultAdmins } from "./modules/account/auth/auth.service";
import { startAuditRetentionSweep } from "./modules/audit";
import { initCronActions, startCron } from "./modules/cron";
import { docsCspRelax, mountDocs } from "./modules/docs";
import { bootstrapEncryption } from "./modules/encryption";
import { EncryptionState as EncryptionStateCtor } from "./modules/encryption/state";
import { initFileModule, startFileGcSweep } from "./modules/file";
import { getAllRouteBindings, policyMiddleware } from "./modules/policy";
import { protectedRoutes, publicRoutes, setupRoutes } from "./routes";
import { getAuthConfig, seedSettingsFromEnv } from "./shared/lib/app-config";
import { createLogger } from "./shared/lib/logger";
import { csrfGuard } from "./shared/middleware/csrf";
import { errorHandler } from "./shared/middleware/error-handler";
import { loggingMiddleware } from "./shared/middleware/logging";
import { propagateRequestId } from "./shared/middleware/request-id";
import { hasStaticAssets, serveStaticAssets } from "./shared/middleware/static";

// ─── Types ───

interface AppDeps {
  readonly config: Config;
  readonly db: AppDatabase;
  readonly logger: Logger;
  readonly encryption: EncryptionState;
}

export interface BootstrapResult {
  /** Current app — may be locked or full. Mutable via onUnlock. */
  readonly fetch: (req: Request, env?: Record<string, unknown>) => Response | Promise<Response>;
  /** Config object */
  readonly config: Config;
  /** Logger */
  readonly logger: Logger;
  /** Close DB connection (if unlocked). Call on shutdown. */
  readonly closeDb: () => Promise<void>;
}

// ─── Bootstrap ───

/**
 * Bootstrap the application: load config, check encryption state,
 * and return a fetch handler that delegates to locked or full app.
 *
 * Used by both index.ts (production) and dev.ts (Vite dev server).
 */
export async function bootstrap(): Promise<BootstrapResult> {
  const config = await loadConfig();
  const logger = createLogger(config);
  // One controller per process owns all encryption state. Passed to the
  // bootstrap helper, threaded into `c.var.encryption` for every request,
  // and re-used across hot-swaps so DEK rotation stays consistent.
  const encryption = new EncryptionStateCtor();

  // Mutable reference for hot-swapping locked → unlocked
  let currentApp: { fetch: (req: Request, env?: Record<string, unknown>) => Response | Promise<Response> };
  let closeDb: () => Promise<void> = async () => {};

  async function onDbReady(db: AppDatabase) {
    // Close the previous database handle (no-op on first call) so DEK rotation
    // can hot-swap the live db without leaking the old encrypted handle.
    await closeDb();
    currentApp = await buildFullApp({ config, db, logger, encryption });
    logDefaultAdmins(await getAuthConfig(db, config), logger);
    closeDb = async () => {
      await db.close();
    };
    logger.info("system fully operational");
  }

  const result = await bootstrapEncryption(encryption, config, logger, onDbReady);

  if (result.mode === "disabled") {
    await onDbReady(result.db);
  }
  else {
    currentApp = buildLockedApp(config, logger, encryption);
  }

  return {
    fetch: (req, env) => currentApp.fetch(req, env),
    config,
    logger,
    closeDb: () => closeDb(),
  } as BootstrapResult;
}

// ─── Shared installers ───

// CORS_ORIGIN may be a comma-separated list. In development with no value,
// allow same-origin requests (any host) — dev usually goes through nsl which
// proxies to the SPA's vite port and the API's bun port under one host.
function resolveCorsOrigin(config: Config): string | string[] {
  if (config.CORS_ORIGIN) {
    const list = config.CORS_ORIGIN.split(",").map(s => s.trim()).filter(Boolean);
    return list.length === 1 ? list[0]! : list;
  }
  return config.NODE_ENV === "production" ? "" : "*";
}

function installCommonMiddleware(
  api: Hono<AppEnv>,
  { config, logger, db, encryption }: { config: Config; logger: Logger; db?: AppDatabase; encryption: EncryptionState },
): void {
  // Hono's `requestId()` accepts an inbound `X-Request-Id` (when present
  // and well-formed) and otherwise mints a UUID. `propagateRequestId`
  // echoes that value as an outgoing `X-Request-Id` response header so a
  // user-reported failure can be matched against the log line. Outbound
  // service callers (OIDC discovery, cron http-request) read the value
  // from `c.get("requestId")` and forward it as their own header.
  api.use("*", requestId());
  api.use("*", propagateRequestId);
  api.use("*", cors({ origin: resolveCorsOrigin(config) }));
  api.use("*", (c, next) => {
    if (db !== undefined) {
      c.set("db", db);
    }
    c.set("config", config);
    c.set("logger", logger);
    c.set("encryption", encryption);
    return next();
  });
  api.use("*", loggingMiddleware());
  api.use("*", csrfGuard);
  // Global policy enforcement: every route declared in any module's
  // `defineResource.routes` is auto-gated. Undeclared routes pass
  // through; admin actors bypass before any DB query. See
  // docs/develop/module/policy-standard.md.
  api.use("*", policyMiddleware({ basePath: `${config.BASE_PATH}/api` }));
}

// ─── Full App (unlocked) ───

export async function buildFullApp({ config, db, logger, encryption }: AppDeps) {
  const api = new Hono<AppEnv>();
  installCommonMiddleware(api, { config, logger, db, encryption });

  await seedSettingsFromEnv(db, config);
  startAuditRetentionSweep(db, config, logger);
  await initFileModule(config);
  startFileGcSweep(db, config, logger);
  // Actions catalog is always populated so admins can plan jobs even
  // with the scheduler off. `startCron` allocates Baker and starts
  // firing ticks — only run it when the operator opts in. Actions whose
  // `spec.defaultEnabled` is `false` (e.g. `shell` — sh -c, no sandbox;
  // treat the registry as a host root crontab) need an explicit opt-in
  // via `CRON_ACTIONS_ENABLED`.
  initCronActions({ enabledActions: config.CRON_ACTIONS_ENABLED });
  if (config.CRON_ENABLED) {
    await startCron({ db, logger, config });
  }

  // OpenAPI spec (/openapi.json) + Scalar UI (/docs). Mounted BEFORE the
  // route modules: Hono middleware only applies to routes registered after
  // it, so mounting here keeps docs outside every module's `use("*")` auth /
  // unlock guards (which would otherwise gate them). `openAPIRouteHandler`
  // walks `api`'s route table lazily at request time, so routes registered
  // below are still included in the spec. See modules/docs.
  mountDocs(api, config);

  api.route("/", publicRoutes());
  api.route("/", protectedRoutes());

  // Fail closed at boot: protected modules register their object-level
  // policy bindings as an import side-effect of the `protectedRoutes()`
  // mount above. An empty registry means `policyMiddleware` would fall
  // through every request unauthorized — a catastrophic silent bypass.
  // Assert here (before serving) rather than letting it degrade at runtime.
  if (getAllRouteBindings().length === 0) {
    throw new Error(
      "[policy] no route bindings registered after mounting protectedRoutes() — "
      + "policy enforcement would fail open. This is a wiring bug (a module's "
      + "defineResource() side-effect did not run).",
    );
  }

  api.onError(errorHandler);

  return buildOuterApp(api, config);
}

// ─── Locked App (setup / unlock) ───

export function buildLockedApp(config: Config, logger: Logger, encryption: EncryptionState) {
  const api = new Hono<AppEnv>();
  installCommonMiddleware(api, { config, logger, encryption });

  api.route("/", publicRoutes());
  api.route("/", setupRoutes());

  api.all("*", (c) => {
    return c.json({ success: false, error: { code: "SYSTEM_LOCKED", message: "System is locked. Provide decryption key to unlock." } }, 503);
  });

  api.onError(errorHandler);

  return buildOuterApp(api, config);
}

// ─── Outer shell (shared by full & locked) ───

function buildOuterApp(api: Hono<AppEnv>, config: Config) {
  const app = new Hono<AppEnv>();
  const base = config.BASE_PATH;

  // Scoped CSP relaxation for the Scalar docs page. Registered before
  // `secureHeaders` so its post-`next()` override wins over the strict global
  // policy (which would otherwise block Scalar's CDN bundle). See modules/docs.
  app.use(`${base}/api/docs`, docsCspRelax);

  // Security headers for every response (API JSON + static SPA HTML/JS/CSS).
  // SPA bundles are hashed under BASE_PATH; styles need 'unsafe-inline' for
  // Tailwind v4 + base-ui runtime style injection. img data:/blob: covers
  // QR codes and inline SVGs. frame-ancestors 'self' lets the SPA preview
  // PDFs via same-origin <iframe>. HSTS auto-enables when APP_URL is
  // https — a direct deployment without a reverse proxy still gets it.
  const hstsEnabled = config.APP_URL?.startsWith("https://") ?? false;
  app.use("*", secureHeaders({
    referrerPolicy: "strict-origin-when-cross-origin",
    crossOriginOpenerPolicy: "same-origin",
    crossOriginResourcePolicy: "same-origin",
    xFrameOptions: "SAMEORIGIN",
    xContentTypeOptions: "nosniff",
    xDownloadOptions: "noopen",
    permissionsPolicy: {
      camera: [],
      microphone: [],
      geolocation: [],
      payment: [],
    },
    strictTransportSecurity: hstsEnabled ? "max-age=15552000; includeSubDomains" : false,
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      frameAncestors: ["'self'"],
      frameSrc: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      objectSrc: ["'none'"],
    },
  }));

  // When BASE_PATH is set, redirect bare "/" to "${base}/" so a request to the
  // origin lands on the SPA. With no base the SPA already owns "/" — skip the
  // redirect to avoid a self-loop.
  if (base !== "") {
    app.get("/", (c) => {
      return c.html(`<meta http-equiv="refresh" content="0;url=${base}/">`);
    });
  }

  app.route(`${base}/api`, api);
  if (hasStaticAssets()) {
    app.get(`${base}/*`, serveStaticAssets(base));
  }

  return app;
}
