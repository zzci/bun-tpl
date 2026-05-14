import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { BackupData } from "./export.service";
import type { AppDatabase } from "@/db";
import { getTableColumns, getTableName, sql } from "drizzle-orm";
import { AppError } from "@/shared/lib/errors";
import { getDataModules, resolveModulesWithDeps } from "./registry";

const MAX_FILE_SIZE = 50 * 1024 * 1024;

const INSERT_BATCH_SIZE = 500;

/**
 * Hard caps to bound an admin-supplied backup. A 50 MB JSON can otherwise
 * contain millions of rows of one table; a single SQLite transaction holding
 * that long would lock writes process-wide. The numbers are conservative —
 * legitimate exports for the use cases this template targets stay well below.
 */
const MAX_TOTAL_ROWS = 1_000_000;
const MAX_ROWS_PER_TABLE = 500_000;
const MAX_STRING_LENGTH = 1_000_000;
const MAX_OBJECT_DEPTH = 16;

/**
 * Highest backup version this binary knows how to import. Older versions
 * must be upgraded by the migrator chain in `MIGRATIONS`.
 */
const CURRENT_BACKUP_VERSION = 1;

type BackupMigrator = (data: BackupData) => BackupData;

/**
 * Forward-version migrators: index N transforms version N into N+1. Empty
 * today — when version 2 ships, append a function that reshapes a v1 dump
 * into the v2 layout. Never break old backups outright.
 */
const MIGRATIONS: ReadonlyArray<BackupMigrator> = [];

/**
 * Walk a parsed JSON tree and reject pathological shapes (unbounded
 * recursion / megabyte strings) before we hand the rows to drizzle.
 */
function assertSane(value: unknown, depth = 0): void {
  if (depth > MAX_OBJECT_DEPTH) {
    throw new AppError("Backup nesting too deep", 400, "INVALID_BACKUP_ROW");
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH)
      throw new AppError("Backup contains an oversized string field", 400, "INVALID_BACKUP_ROW");
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) assertSane(v, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) assertSane(v, depth + 1);
  }
}

// Identifier alphabet covers nanoid (8 chars) and session ids (64-char hex).
// Both are URL-safe / base62-style. Reject anything carrying control chars,
// path separators, or quotes.
const RE_SAFE_ID = /^[\w-]{1,128}$/;

/**
 * Validate id-like fields (where present) match the URL-safe id alphabet
 * so a malicious backup cannot smuggle SQL-meta or path-traversal payloads
 * through `id` / FK columns that we later interpolate into filesystem
 * paths or audit messages.
 */
function assertIdShape(row: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined || typeof v !== "string")
      continue;
    if (k === "id" || k.endsWith("Id") || k.endsWith("_id")) {
      if (!RE_SAFE_ID.test(v))
        throw new AppError(`Invalid id format on field ${k}`, 400, "INVALID_BACKUP_ROW");
    }
  }
}

export function validateBackupData(data: unknown): BackupData {
  if (!data || typeof data !== "object") {
    throw new AppError("Invalid backup file format", 400, "INVALID_FORMAT");
  }

  const obj = data as Record<string, unknown>;
  const version = typeof obj.version === "number" ? obj.version : 0;

  if (version <= 0 || !Number.isFinite(version)) {
    throw new AppError("Invalid backup version", 400, "UNSUPPORTED_VERSION");
  }
  if (version > CURRENT_BACKUP_VERSION) {
    throw new AppError(
      `Backup version ${version} is newer than this build supports (max ${CURRENT_BACKUP_VERSION}). Upgrade the server before restoring.`,
      400,
      "UNSUPPORTED_VERSION",
    );
  }

  if (!Array.isArray(obj.modules) || obj.modules.length === 0) {
    throw new AppError("Backup file contains no modules", 400, "NO_MODULES");
  }

  if (!obj.tables || typeof obj.tables !== "object") {
    throw new AppError("Backup file contains no table data", 400, "NO_TABLES");
  }

  // Run forward migrations one at a time so old backups do not break when
  // the schema evolves. The list is empty in v1 — chain entries land here
  // on version-2 ship.
  //
  // `unknown` first, then `BackupData`: the four checks above prove
  // `obj.version` is a finite positive integer, `obj.modules` is a
  // non-empty array, and `obj.tables` is an object. Per-row inspection
  // happens after the migration chain via `assertSane(current.tables)`
  // and the row-count caps that follow. TypeScript can't narrow the
  // generic Record without that runtime work, so the assertion is the
  // bridge between validated shape and typed code.
  let current: BackupData = obj as unknown as BackupData;
  for (let v = version; v < CURRENT_BACKUP_VERSION; v++) {
    const m = MIGRATIONS[v - 1];
    if (!m)
      throw new AppError(`Missing migrator for backup v${v} → v${v + 1}`, 500, "MIGRATOR_MISSING");
    current = m(current);
  }

  // Pathological-shape rejection AFTER migration so the migrator can rely
  // on bounded input.
  assertSane(current.tables);

  // Row-count caps.
  let total = 0;
  for (const [table, rows] of Object.entries(current.tables)) {
    if (!Array.isArray(rows))
      throw new AppError(`Invalid table payload for ${table}`, 400, "INVALID_BACKUP_ROW");
    if (rows.length > MAX_ROWS_PER_TABLE)
      throw new AppError(`Table ${table} exceeds ${MAX_ROWS_PER_TABLE}-row cap`, 400, "INVALID_BACKUP_ROW");
    total += rows.length;
  }
  if (total > MAX_TOTAL_ROWS)
    throw new AppError(`Backup exceeds ${MAX_TOTAL_ROWS}-row cap`, 400, "INVALID_BACKUP_ROW");

  return current;
}

export function validateFileSize(size: number): void {
  if (size > MAX_FILE_SIZE) {
    throw new AppError(`File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`, 400, "FILE_TOO_LARGE");
  }
}

function getDeleteOrder(modules: string[]): SQLiteTable[] {
  const tables: SQLiteTable[] = [];
  const resolved = resolveModulesWithDeps(modules);
  const registry = getDataModules();

  for (const modName of [...resolved].reverse()) {
    const mod = registry[modName];
    if (!mod)
      continue;
    for (const table of [...mod.tables].reverse()) {
      tables.push(table);
    }
  }

  return tables;
}

function getInsertOrder(modules: string[]): SQLiteTable[] {
  const tables: SQLiteTable[] = [];
  const resolved = resolveModulesWithDeps(modules);
  const registry = getDataModules();

  for (const modName of resolved) {
    const mod = registry[modName];
    if (!mod)
      continue;
    for (const table of mod.tables) {
      tables.push(table);
    }
  }

  return tables;
}

/**
 * Validate that every key in `row` is a known column on `table`. Drops the
 * row entirely if a foreign key is present that the schema does not expect.
 */
function validateRowShape(table: SQLiteTable, tableName: string, row: Record<string, unknown>): void {
  const allowed = new Set(Object.keys(getTableColumns(table)));
  for (const key of Object.keys(row)) {
    if (!allowed.has(key)) {
      throw new AppError(`Invalid row in ${tableName}`, 400, "INVALID_BACKUP_ROW");
    }
  }
}

export async function importJsonBackup(db: AppDatabase, data: BackupData): Promise<{ tablesImported: number; rowsImported: number }> {
  const modules = data.modules;
  const deleteOrder = getDeleteOrder(modules);
  const insertOrder = getInsertOrder(modules);

  let tablesImported = 0;
  let rowsImported = 0;

  await db.transaction(async (tx) => {
    // defer_foreign_keys is checked at COMMIT time only and applies for the
    // life of the current transaction. Unlike `PRAGMA foreign_keys = OFF`
    // which is a process-level flag, this never leaks to other connections.
    await tx.run(sql`PRAGMA defer_foreign_keys = 1`);

    for (const table of deleteOrder) {
      await tx.delete(table).run();
    }

    for (const table of insertOrder) {
      const tableName = getTableName(table);
      const rows = data.tables[tableName];
      if (!rows || rows.length === 0)
        continue;

      tablesImported++;

      const sanitized: Record<string, unknown>[] = rows.map((raw) => {
        const row = { ...raw };
        validateRowShape(table, tableName, row);
        assertIdShape(row);
        return row;
      });

      for (let i = 0; i < sanitized.length; i += INSERT_BATCH_SIZE) {
        const batch = sanitized.slice(i, i + INSERT_BATCH_SIZE);
        try {
          // Drizzle accepts an array of values for a single multi-row INSERT.
          await tx.insert(table).values(batch).run();
        }
        catch (err) {
          // Identify the offending row by re-inserting the batch one row at a
          // time. Slow path, but it only runs on the failure case and gives
          // operators a clear pointer to the bad row instead of a generic
          // "FOREIGN KEY constraint failed" against the whole table.
          for (let j = 0; j < batch.length; j++) {
            const row = batch[j]!;
            try {
              await tx.insert(table).values(row).run();
            }
            catch (rowErr) {
              const rowId = typeof row.id === "string" ? row.id : `index ${i + j}`;
              throw new AppError(
                `Failed to insert into ${tableName} (row ${rowId}): ${rowErr instanceof Error ? rowErr.message : String(rowErr)}`,
                400,
                "INVALID_BACKUP_ROW",
              );
            }
          }
          // Single-row replay succeeded somehow; report the aggregate error.
          throw new AppError(
            `Failed to insert into ${tableName}: ${err instanceof Error ? err.message : String(err)}`,
            400,
            "INVALID_BACKUP_ROW",
          );
        }
        rowsImported += batch.length;
      }
    }
  });

  return { tablesImported, rowsImported };
}
