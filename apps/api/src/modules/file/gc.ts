import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import { deleteUnreferencedFile, listUnreferencedFiles } from "./file.service";
import { runOrphanSweepOnce } from "./orphan-sweep";

const SWEEP_BATCH = 500;
const FIRST_RUN_DELAY_MS = 30 * 1000;

let timer: ReturnType<typeof setInterval> | undefined;
let firstRunTimer: ReturnType<typeof setTimeout> | undefined;
// Mutable: DEK rotation rebuilds the app with a new db handle. The
// long-lived timer reads this ref so it doesn't outlive the previous
// connection.
let currentDb: AppDatabase | undefined;

/**
 * One pass of the unreferenced-files sweeper. Walks up to `limit` blobs
 * with `ref_count = 0`, deletes their backend object, then drops the row.
 * Returns the count of successfully-collected entries.
 *
 * Designed to be safe to invoke directly from tests and from the
 * scheduled interval.
 */
export async function runFileGcOnce(db: AppDatabase, limit = SWEEP_BATCH): Promise<number> {
  const candidates = await listUnreferencedFiles(db, limit);
  let collected = 0;
  for (const c of candidates) {
    const ok = await deleteUnreferencedFile(db, c);
    if (ok)
      collected++;
  }
  return collected;
}

/**
 * Start the periodic sweep. Idempotent — calling twice updates the live
 * `db` reference (so a DEK rotation can swap the handle) and otherwise
 * no-ops. Pass `intervalSeconds = 0` (or `FILE_GC_MODE=sync`) to disable.
 */
export function startFileGcSweep(db: AppDatabase, config: Config, logger: Logger): void {
  currentDb = db;
  if (timer || firstRunTimer)
    return;
  if (config.FILE_GC_INTERVAL_SECONDS <= 0 || config.FILE_GC_MODE === "sync")
    return;

  const intervalMs = config.FILE_GC_INTERVAL_SECONDS * 1000;

  const run = async () => {
    const live = currentDb;
    if (!live)
      return;
    try {
      // First, release file_references rows whose owner row has gone
      // away (e.g. comments deleted without a cascading attachment
      // release). This decrements `files.ref_count`, feeding the
      // unreferenced-files pass below.
      const orphans = await runOrphanSweepOnce(live, config, SWEEP_BATCH, logger);
      if (orphans > 0)
        logger.info({ orphans }, "orphan reference sweep");
      const collected = await runFileGcOnce(live, SWEEP_BATCH);
      if (collected > 0)
        logger.info({ collected }, "file GC sweep");
    }
    catch (err) {
      logger.error({ err }, "file GC sweep failed");
    }
  };

  // Defer the first sweep so it doesn't fight startup work.
  firstRunTimer = setTimeout(() => {
    firstRunTimer = undefined;
    void run();
    timer = setInterval(() => void run(), intervalMs);
  }, FIRST_RUN_DELAY_MS);
}

/** Stop the periodic sweep — used by shutdown and tests. */
export function stopFileGcSweep(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  if (firstRunTimer) {
    clearTimeout(firstRunTimer);
    firstRunTimer = undefined;
  }
}
