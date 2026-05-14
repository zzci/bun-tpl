import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import { sql } from "drizzle-orm";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const FIRST_SWEEP_DELAY_MS = 30 * 1000; // 30 seconds — let boot settle
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DELETE_BATCH = 5000;
const INTER_BATCH_PAUSE_MS = 50;

let timer: ReturnType<typeof setInterval> | undefined;
let firstRunTimer: ReturnType<typeof setTimeout> | undefined;
let inFlight: Promise<void> | undefined;
// Mutable reference: DEK rotation closes the previous AppDatabase and rebuilds
// the app context with a new handle. The sweep is idempotent / re-entrant via
// the early-return in `startAuditRetentionSweep`, so updating this ref is the
// only way to keep the long-lived interval pointed at the live db.
let currentDb: AppDatabase | undefined;

/**
 * Drop audit events older than `retentionDays`. Returns the number of rows
 * deleted. No-op when retention is 0 (keep forever). Deletes in chunks of
 * `DELETE_BATCH` rows so a long-stale table does not produce a single
 * unbounded statement that holds locks for minutes.
 */
export async function pruneAuditEvents(db: AppDatabase, retentionDays: number): Promise<number> {
  if (retentionDays <= 0)
    return 0;
  const cutoff = new Date(Date.now() - retentionDays * MS_PER_DAY).toISOString();
  let totalDeleted = 0;
  while (true) {
    const res = await db.run(
      sql`DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE created_at < ${cutoff} LIMIT ${DELETE_BATCH})`,
    );
    const affected = res.rowsAffected ?? 0;
    totalDeleted += affected;
    if (affected < DELETE_BATCH)
      break;
    await new Promise(r => setTimeout(r, INTER_BATCH_PAUSE_MS));
  }
  return totalDeleted;
}

/**
 * Start the hourly retention sweep. Idempotent — calling twice updates the
 * live db reference and otherwise no-ops. Pass the new AppDatabase after a
 * DEK rotation so the long-lived timer reads the current handle.
 */
export function startAuditRetentionSweep(db: AppDatabase, config: Config, logger: Logger): void {
  currentDb = db;
  if (timer || firstRunTimer || config.AUDIT_RETENTION_DAYS <= 0)
    return;
  const run = async () => {
    const work = (async () => {
      const liveDb = currentDb;
      if (!liveDb)
        return;
      try {
        const deleted = await pruneAuditEvents(liveDb, config.AUDIT_RETENTION_DAYS);
        if (deleted > 0)
          logger.info({ deleted, retentionDays: config.AUDIT_RETENTION_DAYS }, "audit retention sweep");
      }
      catch (err) {
        logger.error({ err }, "audit retention sweep failed");
      }
    })();
    inFlight = work;
    try {
      await work;
    }
    finally {
      if (inFlight === work)
        inFlight = undefined;
    }
  };
  // Defer the first sweep so it does not fight startup work (migrations,
  // index builds, warm caches). Subsequent sweeps run on the hour.
  firstRunTimer = setTimeout(() => {
    firstRunTimer = undefined;
    void run();
    timer = setInterval(run, SWEEP_INTERVAL_MS);
    timer.unref?.();
  }, FIRST_SWEEP_DELAY_MS);
  firstRunTimer.unref?.();
}

/**
 * Stop the sweep. Clears both the recurring interval and any pending
 * first-run timer. Awaits any in-flight delete on a best-effort basis so
 * graceful shutdown does not leave a half-finished transaction.
 */
export async function stopAuditRetentionSweep(): Promise<void> {
  if (firstRunTimer) {
    clearTimeout(firstRunTimer);
    firstRunTimer = undefined;
  }
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  if (inFlight) {
    try {
      await inFlight;
    }
    catch {
      // best-effort — errors are already logged inside `run`
    }
  }
  currentDb = undefined;
}
