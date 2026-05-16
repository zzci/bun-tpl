import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import type { AppEnv } from "@/shared/lib/types";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import { __resetSingleUserLockoutForTests, authRoutes, isSingleUserLocked } from "./auth.routes";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

const stubLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  flush: () => {},
} as unknown as Logger;

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    NODE_ENV: "test",
    PORT: 3000,
    HOST: "127.0.0.1",
    DB_PATH: "data/db/app.db",
    DB_ENCRYPTION: false,
    APP_NAME: "app",
    APP_DISPLAY_NAME: "App",
    BASE_PATH: "",
    LOG_LEVEL: "info",
    LOG_FILE: "data/logs/app.log",
    LOG_TO_STDOUT: false,
    CORS_ORIGIN: undefined,
    TRUST_PROXY: false,
    TRUSTED_PROXY_IPS: "",
    ENABLE_EXPERIMENTAL_DEK_ROTATION: false,
    CRON_ENABLED: false,
    CRON_ACTIONS_ENABLED: [],
    HTTP_ACTION_ALLOW_PRIVATE: false,
    HTTP_ACTION_TIMEOUT_SECONDS: 30,
    SHELL_ACTION_TIMEOUT_SECONDS: 300,
    OAUTH_CLIENT_ID: undefined,
    OAUTH_CLIENT_SECRET: undefined,
    OAUTH_ISSUER: undefined,
    OAUTH_AUTHORIZE_URL: undefined,
    OAUTH_TOKEN_URL: undefined,
    OAUTH_USERINFO_URL: undefined,
    OAUTH_PKCE: true,
    SESSION_MAX_AGE: 86400,
    AUDIT_RETENTION_DAYS: 0,
    MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
    MAX_ATTACHMENTS_PER_RESOURCE: 20,
    UPLOADS_TOTAL_BYTES: 0,
    FILE_STORAGE_DRIVER: "local",
    FILE_STORAGE_LOCAL_ROOT: "data/uploads/files",
    FILE_GC_MODE: "async",
    FILE_GC_INTERVAL_SECONDS: 3600,
    FILE_PRESIGN_ENABLED: true,
    FILE_PRESIGN_TTL_SECONDS: 300,
    DEFAULT_ADMIN: "",
    SINGLE_USER_MODE: false,
    SINGLE_USER_USERNAME: undefined,
    SINGLE_USER_PASSWORD_HASH: undefined,
    SINGLE_USER_PASSWORD_HASH_FILE: undefined,
    SINGLE_USER_NAME: undefined,
    SINGLE_USER_EMAIL: undefined,
    APP_URL: undefined,
    OIDC_LOGOUT_URL: undefined,
    SERVICE_TOKEN_METRICS: undefined,
    SERVICE_TOKEN_BACKUP: undefined,
    BACKUP_EXPORT_MIN_INTERVAL_SECONDS: 0,
    MASTER_PASSWORD_FILE: undefined,
    ...overrides,
  };
}

function buildApp(db: AppDatabase, config: Config): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    c.set("logger", stubLogger);
    await next();
  });
  app.route("/", authRoutes());
  return app;
}

let db: AppDatabase;
let dbPath: string;

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-auth-routes-${Date.now()}-${nanoid()}`);
  mkdirSync(dir, { recursive: true });
  dbPath = resolve(dir, "test.db");
  db = await createDb(dbPath);
  await __resetSingleUserLockoutForTests(db);
});

afterEach(() => {
  db.close();
  const dir = resolve(dbPath, "..");
  if (existsSync(dir))
    rmSync(dir, { recursive: true, force: true });
});

describe("GET /account/auth/mode", () => {
  test("reports oauth mode when single-user is off", async () => {
    const app = buildApp(db, baseConfig());
    const res = await app.request("/account/auth/mode");
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { mode: string; oauthConfigured: boolean } };
    expect(body.data.mode).toBe("oauth");
    expect(body.data.oauthConfigured).toBe(false);
  });

  test("reports single-user mode when enabled", async () => {
    const hash = await Bun.password.hash("hunter22", { algorithm: "argon2id" });
    const app = buildApp(db, baseConfig({
      SINGLE_USER_MODE: true,
      SINGLE_USER_USERNAME: "owner",
      SINGLE_USER_PASSWORD_HASH: hash,
    }));
    const res = await app.request("/account/auth/mode");
    const body = await res.json() as { data: { mode: string } };
    expect(body.data.mode).toBe("single-user");
  });
});

describe("POST /account/auth/login-local", () => {
  test("404s when single-user mode is disabled", async () => {
    const app = buildApp(db, baseConfig());
    const res = await app.request("/account/auth/login-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "x", password: "y" }),
    });
    expect(res.status).toBe(404);
  });

  test("401s on wrong password", async () => {
    const hash = await Bun.password.hash("correct-horse", { algorithm: "argon2id" });
    const app = buildApp(db, baseConfig({
      SINGLE_USER_MODE: true,
      SINGLE_USER_USERNAME: "owner",
      SINGLE_USER_PASSWORD_HASH: hash,
    }));
    const res = await app.request("/account/auth/login-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "nope" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_CREDENTIALS");
  });

  test("401s on unknown username (same code as wrong password)", async () => {
    const hash = await Bun.password.hash("correct-horse", { algorithm: "argon2id" });
    const app = buildApp(db, baseConfig({
      SINGLE_USER_MODE: true,
      SINGLE_USER_USERNAME: "owner",
      SINGLE_USER_PASSWORD_HASH: hash,
    }));
    const res = await app.request("/account/auth/login-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "intruder", password: "correct-horse" }),
    });
    expect(res.status).toBe(401);
  });

  test("succeeds, creates an admin user, and sets the session cookie", async () => {
    const hash = await Bun.password.hash("correct-horse", { algorithm: "argon2id" });
    const app = buildApp(db, baseConfig({
      SINGLE_USER_MODE: true,
      SINGLE_USER_USERNAME: "owner",
      SINGLE_USER_PASSWORD_HASH: hash,
    }));
    const res = await app.request("/account/auth/login-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "OWNER", password: "correct-horse" }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("session_id=");

    const row = await db.select().from(users).where(eq(users.oauthSub, "single-user")).get();
    expect(row?.role).toBe("admin");
    expect(row?.username).toBe("owner");
  });

  test("rejects malformed json with 400", async () => {
    const hash = await Bun.password.hash("correct-horse", { algorithm: "argon2id" });
    const app = buildApp(db, baseConfig({
      SINGLE_USER_MODE: true,
      SINGLE_USER_USERNAME: "owner",
      SINGLE_USER_PASSWORD_HASH: hash,
    }));
    const res = await app.request("/account/auth/login-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  test("locks the account after 10 consecutive failures and returns 429", async () => {
    const hash = await Bun.password.hash("correct-horse", { algorithm: "argon2id" });
    const app = buildApp(db, baseConfig({
      SINGLE_USER_MODE: true,
      SINGLE_USER_USERNAME: "owner",
      SINGLE_USER_PASSWORD_HASH: hash,
    }));

    for (let i = 0; i < 10; i++) {
      const res = await app.request("/account/auth/login-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "owner", password: `wrong-${i}` }),
      });
      expect(res.status).toBe(401);
    }

    const locked = await isSingleUserLocked(db, "owner");
    expect(locked.locked).toBe(true);
    expect(locked.retryAfterSeconds).toBeGreaterThan(0);

    const res = await app.request("/account/auth/login-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "correct-horse" }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("ACCOUNT_LOCKED");
  });

  test("does not let an attacker probe past the lock by varying the submitted username", async () => {
    const hash = await Bun.password.hash("correct-horse", { algorithm: "argon2id" });
    const app = buildApp(db, baseConfig({
      SINGLE_USER_MODE: true,
      SINGLE_USER_USERNAME: "owner",
      SINGLE_USER_PASSWORD_HASH: hash,
    }));

    for (let i = 0; i < 10; i++) {
      await app.request("/account/auth/login-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: `attacker-${i}`, password: "wrong" }),
      });
    }
    expect((await isSingleUserLocked(db, "owner")).locked).toBe(true);
  });

  test("clears failure counter on successful login", async () => {
    const hash = await Bun.password.hash("correct-horse", { algorithm: "argon2id" });
    const app = buildApp(db, baseConfig({
      SINGLE_USER_MODE: true,
      SINGLE_USER_USERNAME: "owner",
      SINGLE_USER_PASSWORD_HASH: hash,
    }));

    for (let i = 0; i < 5; i++) {
      await app.request("/account/auth/login-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "owner", password: "wrong" }),
      });
    }
    const ok = await app.request("/account/auth/login-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "correct-horse" }),
    });
    expect(ok.status).toBe(200);
    expect((await isSingleUserLocked(db, "owner")).locked).toBe(false);
  });
});

describe("GET /account/auth/login", () => {
  test("redirects with single_user_mode_active when single-user mode is on", async () => {
    const hash = await Bun.password.hash("hunter22", { algorithm: "argon2id" });
    const app = buildApp(db, baseConfig({
      SINGLE_USER_MODE: true,
      SINGLE_USER_USERNAME: "owner",
      SINGLE_USER_PASSWORD_HASH: hash,
    }));
    const res = await app.request("/account/auth/login");
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/error");
    expect(location).toContain("code=single_user_mode_active");
  });
});
