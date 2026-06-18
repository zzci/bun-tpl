import type { AppEnv } from "@/shared/lib/types";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { BUILD_INFO } from "@/build-info";
import { gaugeSet, renderPrometheus } from "@/shared/lib/metrics";
import { describeRoute, errors, jsonOk, raw, resolver, SECURITY, TAGS } from "@/shared/lib/openapi";
import { adminRequired, authRequired } from "@/shared/middleware/auth";
import { serviceTokenRequired } from "@/shared/middleware/service-token";

export function systemRoutes() {
  const router = new Hono<AppEnv>();

  // Liveness — k8s livenessProbe / Docker HEALTHCHECK.
  router.get(
    "/health",
    describeRoute({
      tags: [TAGS.System],
      summary: "Liveness probe",
      description: "Returns 200 while the process is up. Used by orchestrator liveness probes.",
      responses: {
        200: { description: "Alive", content: { "application/json": { schema: resolver(z.object({ status: z.literal("ok") })) } } },
      },
    }),
    c => c.json({ status: "ok" }),
  );

  // Readiness — DB reachable, not setup/locked. 503 drains traffic.
  router.get(
    "/health/ready",
    describeRoute({
      tags: [TAGS.System],
      summary: "Readiness probe",
      description: "200 when the DB is reachable and the system is unlocked; 503 (with a `status` reason) otherwise, to drain traffic.",
      responses: {
        200: { description: "Ready", content: { "application/json": { schema: resolver(z.object({ status: z.literal("ready") })) } } },
        503: { description: "Not ready", content: { "application/json": { schema: resolver(z.object({ status: z.enum(["locked", "no_db", "db_unavailable"]) })) } } },
      },
    }),
    async (c) => {
      if (c.get("encryption").isSystemLocked()) {
        c.status(503);
        return c.json({ status: "locked" });
      }
      const db = c.get("db");
      if (!db) {
        c.status(503);
        return c.json({ status: "no_db" });
      }
      try {
        await db.run(sql`SELECT 1`);
      }
      catch (err) {
        c.get("logger").error({ err }, "readiness probe: db ping failed");
        c.status(503);
        return c.json({ status: "db_unavailable" });
      }
      return c.json({ status: "ready" });
    },
  );

  router.get(
    "/system/version",
    describeRoute({
      tags: [TAGS.System],
      summary: "Build version",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.object({ commit: z.string(), buildTime: z.string(), version: z.string() }), "Build identifiers"),
        ...errors(401, 403),
      },
    }),
    authRequired,
    adminRequired,
    c => c.json({
      success: true,
      data: BUILD_INFO,
    }),
  );

  router.get(
    "/metrics",
    describeRoute({
      tags: [TAGS.System],
      summary: "Prometheus metrics",
      description: "Prometheus text exposition. Requires the `metrics` service token.",
      security: SECURITY.serviceToken,
      responses: {
        ...raw(200, "text/plain", "Prometheus exposition format"),
        ...errors(401, 403),
      },
    }),
    serviceTokenRequired("metrics"),
    (c) => {
      gaugeSet(
        "encryption_locked",
        "1 when the system is currently locked, 0 when unlocked.",
        c.get("encryption").isSystemLocked() ? 1 : 0,
      );
      return c.text(renderPrometheus(), 200, { "Content-Type": "text/plain; version=0.0.4" });
    },
  );

  router.get(
    "/system/upload-limits",
    describeRoute({
      tags: [TAGS.System],
      summary: "Upload limits",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.object({
          maxFileSize: z.number(),
          maxAttachmentsPerResource: z.number(),
          totalQuota: z.number().nullable(),
        }), "Effective upload limits"),
        ...errors(401),
      },
    }),
    authRequired,
    (c) => {
      const cfg = c.get("config");
      return c.json({
        success: true,
        data: {
          maxFileSize: cfg.MAX_UPLOAD_BYTES,
          maxAttachmentsPerResource: cfg.MAX_ATTACHMENTS_PER_RESOURCE,
          totalQuota: cfg.UPLOADS_TOTAL_BYTES > 0 ? cfg.UPLOADS_TOTAL_BYTES : null,
        },
      });
    },
  );

  return router;
}
