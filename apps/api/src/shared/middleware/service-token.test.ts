import type { Config } from "@/config";
import type { AppEnv } from "@/shared/lib/types";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { serviceTokenRequired } from "./service-token";

function appWith(config: Partial<Config>) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("config", config as Config);
    await next();
  });
  app.get("/metrics", serviceTokenRequired("metrics"), c => c.text("metrics-body"));
  app.get("/backup", serviceTokenRequired("backup"), c => c.text("backup-body"));
  return app;
}

describe("serviceTokenRequired", () => {
  test("503 when the scoped token is not configured", async () => {
    const res = await appWith({}).request("/metrics");
    expect(res.status).toBe(503);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("SERVICE_TOKEN_DISABLED");
  });

  test("401 when no Authorization header is sent", async () => {
    const res = await appWith({ SERVICE_TOKEN_METRICS: "secret-token" }).request("/metrics");
    expect(res.status).toBe(401);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("UNAUTHORIZED");
  });

  test("401 when the scheme is not Bearer", async () => {
    const res = await appWith({ SERVICE_TOKEN_METRICS: "secret-token" }).request("/metrics", {
      headers: { authorization: "Basic secret-token" },
    });
    expect(res.status).toBe(401);
  });

  test("401 on a wrong token of the same length", async () => {
    const res = await appWith({ SERVICE_TOKEN_METRICS: "0123456789ab" }).request("/metrics", {
      headers: { authorization: "Bearer ffffffffffff" },
    });
    expect(res.status).toBe(401);
  });

  test("401 on a wrong token of a different length (no timingSafeEqual throw)", async () => {
    const res = await appWith({ SERVICE_TOKEN_METRICS: "0123456789ab" }).request("/metrics", {
      headers: { authorization: "Bearer short" },
    });
    expect(res.status).toBe(401);
  });

  test("200 with the correct token", async () => {
    const res = await appWith({ SERVICE_TOKEN_METRICS: "secret-token" }).request("/metrics", {
      headers: { authorization: "Bearer secret-token" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("metrics-body");
  });

  test("scopes are independent — a metrics token does not unlock backup", async () => {
    const app = appWith({ SERVICE_TOKEN_METRICS: "m-tok", SERVICE_TOKEN_BACKUP: "b-tok" });
    const res = await app.request("/backup", {
      headers: { authorization: "Bearer m-tok" },
    });
    expect(res.status).toBe(401);
    const ok = await app.request("/backup", {
      headers: { authorization: "Bearer b-tok" },
    });
    expect(ok.status).toBe(200);
  });
});
