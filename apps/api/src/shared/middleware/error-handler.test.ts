import type { Logger } from "@/shared/lib/logger";
import type { AppEnv } from "@/shared/lib/types";
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { AppError, NotFoundError } from "@/shared/lib/errors";
import { errorHandler } from "./error-handler";

const captured: { msg: string; ctx: unknown }[] = [];
const stubLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: (ctx: unknown, msg: string) => captured.push({ ctx, msg }),
  fatal: () => {},
  flush: () => {},
} as unknown as Logger;

afterEach(() => {
  captured.length = 0;
});

function buildApp(thrown: Error) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("logger", stubLogger);
    return next();
  });
  app.get("/p", () => {
    throw thrown;
  });
  app.onError(errorHandler);
  return app;
}

describe("errorHandler", () => {
  test("returns AppError.toJSON with its statusCode", async () => {
    const app = buildApp(new AppError("nope", 418, "TEAPOT"));
    const res = await app.request("/p");
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ success: false, error: { code: "TEAPOT", message: "nope" } });
  });

  test("specialized AppError subclasses pass through", async () => {
    const app = buildApp(new NotFoundError("user", "u_1"));
    const res = await app.request("/p");
    expect(res.status).toBe(404);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  test("non-AppError errors return 500 INTERNAL_ERROR and log via logger.error", async () => {
    const app = buildApp(new Error("kaboom"));
    const res = await app.request("/p");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
    expect(captured.length).toBe(1);
    expect(captured[0]!.msg).toBe("unhandled error");
  });
});
