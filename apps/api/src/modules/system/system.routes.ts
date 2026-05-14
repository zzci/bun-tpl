import type { AppEnv } from "@/shared/lib/types";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { BUILD_INFO } from "@/build-info";
import { gaugeSet, renderPrometheus } from "@/shared/lib/metrics";
import { adminRequired, authRequired } from "@/shared/middleware/auth";
import { serviceTokenRequired } from "@/shared/middleware/service-token";

export function systemRoutes() {
  const router = new Hono<AppEnv>();

  // Liveness — k8s livenessProbe / Docker HEALTHCHECK.
  router.get("/health", c => c.json({ status: "ok" }));

  // Readiness — DB reachable, not setup/locked. 503 drains traffic.
  router.get("/health/ready", async (c) => {
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
  });

  router.get("/system/version", authRequired, adminRequired, c => c.json({
    success: true,
    data: BUILD_INFO,
  }));

  router.get("/metrics", serviceTokenRequired("metrics"), (c) => {
    gaugeSet(
      "encryption_locked",
      "1 when the system is currently locked, 0 when unlocked.",
      c.get("encryption").isSystemLocked() ? 1 : 0,
    );
    return c.text(renderPrometheus(), 200, { "Content-Type": "text/plain; version=0.0.4" });
  });

  router.get("/system/upload-limits", authRequired, (c) => {
    const cfg = c.get("config");
    return c.json({
      success: true,
      data: {
        maxFileSize: cfg.MAX_UPLOAD_BYTES,
        maxAttachmentsPerResource: cfg.MAX_ATTACHMENTS_PER_RESOURCE,
        totalQuota: cfg.UPLOADS_TOTAL_BYTES > 0 ? cfg.UPLOADS_TOTAL_BYTES : null,
      },
    });
  });

  return router;
}
