import type { AppDatabase } from "@/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { relationTuples } from "@/modules/policy/schema";
import { ValidationError } from "@/shared/lib/errors";
import { getNamespace, getValidRelations } from "./namespace-config";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

// The drizzle transaction callback receives a tx handle that is API-compatible
// with the db for queries but not structurally `AppDatabase` (no .transaction
// /.close). Helpers that must run either standalone or inside a tx accept this.
type TxOrDb = AppDatabase | Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

export interface CreateTupleInput {
  readonly namespace: string;
  readonly objectId: string;
  readonly relation: string;
  readonly subjectNamespace: string;
  readonly subjectId: string;
  readonly subjectRelation?: string | null | undefined;
}

export interface TupleFilter {
  readonly namespace?: string | undefined;
  readonly objectId?: string | undefined;
  readonly relation?: string | undefined;
  readonly subjectNamespace?: string | undefined;
  readonly subjectId?: string | undefined;
  readonly page?: number | undefined;
  readonly limit?: number | undefined;
}

export type RelationTuple = typeof relationTuples.$inferSelect;

function validateTupleInput(input: CreateTupleInput): void {
  const ns = getNamespace(input.namespace);
  if (!ns) {
    throw new ValidationError("Invalid namespace", { namespace: `Unknown namespace: ${input.namespace}` });
  }

  if (input.namespace !== "user") {
    const validRelations = getValidRelations(input.namespace);
    if (validRelations.length > 0 && !validRelations.includes(input.relation)) {
      throw new ValidationError("Invalid relation", {
        relation: `Invalid relation '${input.relation}' for namespace '${input.namespace}'. Valid: ${validRelations.join(", ")}`,
      });
    }
  }

  const subjectNs = getNamespace(input.subjectNamespace);
  if (!subjectNs) {
    throw new ValidationError("Invalid subject namespace", { subjectNamespace: `Unknown namespace: ${input.subjectNamespace}` });
  }

  if (input.subjectRelation) {
    const subjectRelations = getValidRelations(input.subjectNamespace);
    if (subjectRelations.length > 0 && !subjectRelations.includes(input.subjectRelation)) {
      throw new ValidationError("Invalid subject relation", {
        subjectRelation: `Invalid relation '${input.subjectRelation}' for namespace '${input.subjectNamespace}'`,
      });
    }
  }
}

export async function getTupleById(db: AppDatabase, id: string): Promise<RelationTuple | undefined> {
  return await db.select().from(relationTuples).where(eq(relationTuples.id, id)).get();
}

async function checkDuplicateTuple(db: TxOrDb, input: CreateTupleInput): Promise<void> {
  const subjectRelation = input.subjectRelation ?? null;

  const subjectRelationCondition = subjectRelation === null
    ? isNull(relationTuples.subjectRelation)
    : eq(relationTuples.subjectRelation, subjectRelation);

  const existing = await db
    .select({ id: relationTuples.id })
    .from(relationTuples)
    .where(
      and(
        eq(relationTuples.namespace, input.namespace),
        eq(relationTuples.objectId, input.objectId),
        eq(relationTuples.relation, input.relation),
        eq(relationTuples.subjectNamespace, input.subjectNamespace),
        eq(relationTuples.subjectId, input.subjectId),
        subjectRelationCondition,
      ),
    )
    .get();

  if (existing) {
    throw new ValidationError("Duplicate tuple", {
      tuple: "A relation tuple with the same key already exists",
    });
  }
}

export async function createTuple(db: AppDatabase, input: CreateTupleInput, createdBy: string): Promise<RelationTuple> {
  validateTupleInput(input);

  const id = nanoid();
  const now = new Date().toISOString();
  const values = {
    id,
    namespace: input.namespace,
    objectId: input.objectId,
    relation: input.relation,
    subjectNamespace: input.subjectNamespace,
    subjectId: input.subjectId,
    subjectRelation: input.subjectRelation ?? null,
    createdBy,
    createdAt: now,
  };

  // BEGIN IMMEDIATE (libsql sqlite3 client default) takes the write lock at
  // transaction start, so the duplicate check + insert serialize against
  // concurrent writers — the only protection for NULL subjectRelation rows,
  // which idx_tuples_unique cannot enforce (SQLite treats NULLs as distinct).
  await db.transaction(async (tx) => {
    await checkDuplicateTuple(tx, input);
    await tx.insert(relationTuples).values(values).run();
  });

  return values;
}

export async function deleteTuple(db: AppDatabase, id: string): Promise<boolean> {
  const existing = await db.select({ id: relationTuples.id }).from(relationTuples).where(eq(relationTuples.id, id)).get();
  if (!existing)
    return false;
  await db.delete(relationTuples).where(eq(relationTuples.id, id)).run();
  return true;
}

/**
 * Delete a single tuple identified by its composite key
 * (namespace, objectId, relation, subjectNamespace, subjectId, subjectRelation).
 * Returns true if a row was removed, false if no matching tuple existed.
 * Used by the action-based permission wrapper to revoke a specific grant
 * without the caller having to remember the tuple id.
 */
export async function deleteTupleByKey(
  db: AppDatabase,
  key: {
    readonly namespace: string;
    readonly objectId: string;
    readonly relation: string;
    readonly subjectNamespace: string;
    readonly subjectId: string;
    readonly subjectRelation?: string | null | undefined;
  },
): Promise<boolean> {
  const subjectRelation = key.subjectRelation ?? null;
  const subjectRelationCondition = subjectRelation === null
    ? isNull(relationTuples.subjectRelation)
    : eq(relationTuples.subjectRelation, subjectRelation);

  const existing = await db
    .select({ id: relationTuples.id })
    .from(relationTuples)
    .where(
      and(
        eq(relationTuples.namespace, key.namespace),
        eq(relationTuples.objectId, key.objectId),
        eq(relationTuples.relation, key.relation),
        eq(relationTuples.subjectNamespace, key.subjectNamespace),
        eq(relationTuples.subjectId, key.subjectId),
        subjectRelationCondition,
      ),
    )
    .get();

  if (!existing)
    return false;
  await db.delete(relationTuples).where(eq(relationTuples.id, existing.id)).run();
  return true;
}

export async function batchCreateTuples(db: AppDatabase, inputs: readonly CreateTupleInput[], createdBy: string): Promise<readonly RelationTuple[]> {
  for (const input of inputs) {
    validateTupleInput(input);
  }

  const now = new Date().toISOString();
  const tuples: RelationTuple[] = [];

  await db.transaction(async (tx) => {
    // Dedup check inside the (BEGIN IMMEDIATE) tx so it serializes with the
    // inserts against concurrent writers.
    for (const input of inputs) {
      await checkDuplicateTuple(tx, input);
    }
    for (const input of inputs) {
      const id = nanoid();
      const values = {
        id,
        namespace: input.namespace,
        objectId: input.objectId,
        relation: input.relation,
        subjectNamespace: input.subjectNamespace,
        subjectId: input.subjectId,
        subjectRelation: input.subjectRelation ?? null,
        createdBy,
        createdAt: now,
      };
      await tx.insert(relationTuples).values(values).run();
      tuples.push(values);
    }
  });

  return tuples;
}

export async function batchDeleteTuples(db: AppDatabase, ids: readonly string[]): Promise<number> {
  if (ids.length === 0)
    return 0;
  // Single transactional DELETE … RETURNING avoids N round-trips and the
  // per-row existence pre-check the previous loop performed.
  const removed = await db.transaction(async (tx) => {
    return await tx
      .delete(relationTuples)
      .where(inArray(relationTuples.id, [...ids]))
      .returning({ id: relationTuples.id });
  });
  return removed.length;
}

export async function listTuples(db: AppDatabase, filter: TupleFilter): Promise<{ data: readonly RelationTuple[]; total: number }> {
  const conditions = [];

  if (filter.namespace)
    conditions.push(eq(relationTuples.namespace, filter.namespace));
  if (filter.objectId)
    conditions.push(eq(relationTuples.objectId, filter.objectId));
  if (filter.relation)
    conditions.push(eq(relationTuples.relation, filter.relation));
  if (filter.subjectNamespace)
    conditions.push(eq(relationTuples.subjectNamespace, filter.subjectNamespace));
  if (filter.subjectId)
    conditions.push(eq(relationTuples.subjectId, filter.subjectId));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(relationTuples)
    .where(where)
    .get();

  const total = countResult?.count ?? 0;
  const page = filter.page ?? 1;
  const limit = Math.min(filter.limit ?? 50, 100);
  const offset = (page - 1) * limit;

  const data = await db
    .select()
    .from(relationTuples)
    .where(where)
    .limit(limit)
    .offset(offset)
    .all();

  return { data, total };
}

export async function getTuplesByObject(db: AppDatabase, namespace: string, objectId: string): Promise<readonly RelationTuple[]> {
  return await db
    .select()
    .from(relationTuples)
    .where(
      and(
        eq(relationTuples.namespace, namespace),
        eq(relationTuples.objectId, objectId),
      ),
    )
    .all();
}

export async function getTuplesBySubject(db: AppDatabase, subjectNamespace: string, subjectId: string): Promise<readonly RelationTuple[]> {
  return await db
    .select()
    .from(relationTuples)
    .where(
      and(
        eq(relationTuples.subjectNamespace, subjectNamespace),
        eq(relationTuples.subjectId, subjectId),
      ),
    )
    .all();
}

/**
 * Cross-module helper: delete every tuple that references the given namespace
 * + id, either as object or subject. Used to cascade tuple cleanup when an
 * external module (document, item, …) deletes its underlying entity.
 *
 * Note: `group:<id>#member@…` rows live in `account.group_members`, not here —
 * `groups.service.deleteGroup` cleans those separately before calling this.
 */
export async function deleteTuplesForEntity(
  db: AppDatabase,
  namespace: string,
  id: string,
): Promise<void> {
  await db.delete(relationTuples)
    .where(
      or(
        and(eq(relationTuples.namespace, namespace), eq(relationTuples.objectId, id)),
        and(eq(relationTuples.subjectNamespace, namespace), eq(relationTuples.subjectId, id)),
      ),
    )
    .run();
}
