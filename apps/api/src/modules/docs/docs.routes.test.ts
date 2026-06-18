import type { Config } from "@/config";
import type { AppEnv } from "@/shared/lib/types";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { auditRoutes } from "@/modules/audit";
import { systemRoutes } from "@/modules/system";
import { mountDocs } from "./docs.routes";

const cfg = { BASE_PATH: "", APP_NAME: "app" } as unknown as Config;

function buildApp(): Hono<AppEnv> {
  const api = new Hono<AppEnv>();
  api.use("*", (c, next) => {
    c.set("config", cfg);
    return next();
  });
  // Mounted before the route modules — mirrors app.ts so the docs routes
  // stay outside each module's `use("*")` auth guards.
  mountDocs(api, cfg);
  api.route("/", systemRoutes());
  api.route("/", auditRoutes());
  return api;
}

describe("docs module", () => {
  it("serves an OpenAPI 3.1 spec at /openapi.json", async () => {
    const res = await buildApp().request("/openapi.json");
    expect(res.status).toBe(200);

    const spec = await res.json() as {
      openapi: string;
      info: { title: string };
      paths: Record<string, Record<string, { tags?: string[]; parameters?: { name: string }[] }>>;
      components?: { securitySchemes?: Record<string, unknown> };
    };

    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBe("app API");
    expect(Object.keys(spec.paths)).toContain("/health");
    expect(Object.keys(spec.paths)).toContain("/audit");
    expect(Object.keys(spec.components?.securitySchemes ?? {})).toEqual(["sessionCookie", "serviceToken"]);
  });

  it("documents validated request params in the spec", async () => {
    const spec = await (await buildApp().request("/openapi.json")).json() as {
      paths: Record<string, Record<string, { parameters?: { name: string }[] }>>;
    };
    // `GET /audit` validates its query with `validator("query", ...)`, so the
    // query fields must surface as OpenAPI parameters.
    const params = (spec.paths["/audit"]?.get?.parameters ?? []).map(p => p.name);
    expect(params).toContain("page");
    expect(params).toContain("limit");
  });

  it("documents every route it walks (no untagged operations)", async () => {
    const spec = await (await buildApp().request("/openapi.json")).json() as {
      paths: Record<string, Record<string, { tags?: string[] }>>;
    };
    const untagged: string[] = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (!op.tags || op.tags.length === 0) {
          untagged.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(untagged).toEqual([]);
  });

  it("serves the Scalar UI at /docs", async () => {
    const res = await buildApp().request("/docs");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/openapi.json");
    expect(html.toLowerCase()).toContain("scalar");
  });

  it("is not gated by module auth (public docs)", async () => {
    // `/audit` requires auth; the docs routes, mounted first, must not.
    const app = buildApp();
    expect((await app.request("/openapi.json")).status).toBe(200);
    expect((await app.request("/docs")).status).toBe(200);
  });
});
