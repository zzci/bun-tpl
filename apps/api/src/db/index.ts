import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { ROOT_DIR } from "../root";
import * as schema from "./schema";

const RE_HEX_64 = /^[0-9a-f]{64}$/;

/** Validate that an encryption key is a valid 64-char hex string. */
export function validateEncryptionKey(dekHex: string): void {
  if (!RE_HEX_64.test(dekHex)) {
    throw new Error("Invalid encryption key: expected 64-char lowercase hex string");
  }
}

export async function createDb(path: string, encryptionKey?: string) {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (encryptionKey) {
    validateEncryptionKey(encryptionKey);
  }

  const client = createClient(
    encryptionKey
      ? { url: `file:${path}`, encryptionKey }
      : { url: `file:${path}` },
  );

  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA busy_timeout = 5000");

  // Performance / footprint tuning. Some PRAGMAs are no-ops on libsql with
  // encryption enabled — swallow the error and continue rather than aborting
  // the whole bootstrap.
  for (const pragma of [
    "PRAGMA synchronous = NORMAL",
    "PRAGMA cache_size = -65536",
    "PRAGMA mmap_size = 268435456",
    "PRAGMA temp_store = MEMORY",
  ]) {
    try {
      await client.execute(pragma);
    }
    catch (err) {
      // eslint-disable-next-line no-console
      console.debug(`[db] ${pragma} skipped:`, err);
    }
  }

  const db = drizzle(client, { schema });

  await runMigrations(db);

  return Object.assign(db, {
    close: () => client.close(),
    // Used by encryption.service.rotateDek to flush WAL before the libsql
    // copy-client opens the same file.
    checkpoint: () => client.execute("PRAGMA wal_checkpoint(TRUNCATE)"),
  });
}

async function runMigrations(db: ReturnType<typeof drizzle>) {
  const fsMigrationsFolder = resolveMigrationsFolder();
  const journalPath = resolve(fsMigrationsFolder, "meta/_journal.json");

  if (!existsSync(journalPath)) {
    throw new Error(
      `No migrations available: expected ${journalPath}. `
      + "Packaged releases must ship drizzle/ alongside index.js. "
      + "Run `bun run package` to rebuild the lode artifact.",
    );
  }

  await migrate(db, { migrationsFolder: fsMigrationsFolder });
}

/**
 * Locate the Drizzle migrations folder for both layouts: a packaged lode
 * artifact ships `drizzle/` at ROOT_DIR (next to index.js); the dev/source
 * tree keeps it under `apps/api/drizzle`.
 */
function resolveMigrationsFolder(): string {
  const packaged = resolve(ROOT_DIR, "drizzle");
  if (existsSync(resolve(packaged, "meta/_journal.json")))
    return packaged;
  return resolve(ROOT_DIR, "apps/api/drizzle");
}

export type AppDatabase = Awaited<ReturnType<typeof createDb>>;
