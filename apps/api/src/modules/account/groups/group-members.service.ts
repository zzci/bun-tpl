import type { AppDatabase } from "@/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { groupMembers } from "@/modules/account/groups/schema";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

// The drizzle transaction callback receives a tx handle that is API-compatible
// with `db` for queries but not structurally `AppDatabase`. Helpers that must
// run either standalone or inside a tx accept either.
type TxOrDb = AppDatabase | Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

export type GroupMember = typeof groupMembers.$inferSelect;

/** Idempotently add a `group:<groupId>#member@user:<userId>` row; false if it already existed. */
export async function addUserMember(
  db: AppDatabase,
  groupId: string,
  userId: string,
  createdBy: string,
): Promise<boolean> {
  const existing = await db
    .select({ id: groupMembers.id })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.subjectNamespace, "user"),
        eq(groupMembers.subjectId, userId),
        isNull(groupMembers.subjectRelation),
      ),
    )
    .get();
  if (existing)
    return false;
  await db.insert(groupMembers).values({
    id: nanoid(),
    groupId,
    subjectNamespace: "user",
    subjectId: userId,
    subjectRelation: null,
    createdBy,
    createdAt: new Date().toISOString(),
  }).run();
  return true;
}

/** Remove a `group:<groupId>#member@user:<userId>` row; false if it did not exist. */
export async function removeUserMember(
  db: AppDatabase,
  groupId: string,
  userId: string,
): Promise<boolean> {
  const existing = await db
    .select({ id: groupMembers.id })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.subjectNamespace, "user"),
        eq(groupMembers.subjectId, userId),
        isNull(groupMembers.subjectRelation),
      ),
    )
    .get();
  if (!existing)
    return false;
  await db.delete(groupMembers).where(eq(groupMembers.id, existing.id)).run();
  return true;
}

/** Direct user members of a group, with join time. Used by `groups.service.getGroupMembers`. */
export async function listUserMembersWithJoinedAt(
  db: AppDatabase,
  groupId: string,
): Promise<readonly { subjectId: string; joinedAt: string }[]> {
  return await db
    .select({ subjectId: groupMembers.subjectId, joinedAt: groupMembers.createdAt })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.subjectNamespace, "user"),
        isNull(groupMembers.subjectRelation),
      ),
    )
    .all();
}

/**
 * Aggregate direct user-member counts for every group, keyed by groupId.
 * Empty groups are absent from the map (callers default to 0).
 */
export async function getUserMemberCounts(db: AppDatabase): Promise<Map<string, number>> {
  const rows = await db
    .select({ groupId: groupMembers.groupId, count: sql<number>`count(*)` })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.subjectNamespace, "user"),
        isNull(groupMembers.subjectRelation),
      ),
    )
    .groupBy(groupMembers.groupId)
    .all();
  return new Map(rows.map(r => [r.groupId, r.count]));
}

/**
 * Group ids the given user is a direct member of.
 */
export async function listGroupIdsForUser(db: AppDatabase, userId: string): Promise<readonly string[]> {
  const rows = await db
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.subjectNamespace, "user"),
        eq(groupMembers.subjectId, userId),
        isNull(groupMembers.subjectRelation),
      ),
    )
    .all();
  return rows.map(r => r.groupId);
}

/**
 * User ids that are direct members of a given group (no nested-group recursion).
 */
export async function listUserIdsInGroup(db: AppDatabase, groupId: string): Promise<readonly string[]> {
  const rows = await db
    .select({ subjectId: groupMembers.subjectId })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.subjectNamespace, "user"),
        isNull(groupMembers.subjectRelation),
      ),
    )
    .all();
  return rows.map(r => r.subjectId);
}

/** Group memberships for a single user, with join time. Used by `users.service.getUserGroups`. */
export async function listGroupMembershipsForUser(
  db: AppDatabase,
  userId: string,
): Promise<readonly { groupId: string; joinedAt: string }[]> {
  return await db
    .select({ groupId: groupMembers.groupId, joinedAt: groupMembers.createdAt })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.subjectNamespace, "user"),
        eq(groupMembers.subjectId, userId),
        isNull(groupMembers.subjectRelation),
      ),
    )
    .all();
}

/**
 * `(userId, groupId)` membership pairs for the given user ids, or for every
 * user when `userIds` is omitted or empty.
 */
export async function listGroupMembershipsForUsers(
  db: AppDatabase,
  userIds?: readonly string[],
): Promise<readonly { userId: string; groupId: string }[]> {
  const filter = and(
    eq(groupMembers.subjectNamespace, "user"),
    isNull(groupMembers.subjectRelation),
    userIds && userIds.length > 0 ? inArray(groupMembers.subjectId, [...userIds]) : undefined,
  );
  const rows = await db
    .select({ userId: groupMembers.subjectId, groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(filter)
    .all();
  return rows;
}

// --- Engine-facing helpers ---------------------------------------------------

/**
 * Look up a direct `group:<groupId>#member@<subjectNs>:<subjectId>` row
 * matching `subjectRelation` exactly (NULL vs. value). Used by the policy
 * engine's `check()` direct-match branch.
 */
export async function findDirectMember(
  db: TxOrDb,
  groupId: string,
  subjectNs: string,
  subjectId: string,
  subjectRelation: string | null,
): Promise<GroupMember | undefined> {
  const subjectRelationCondition = subjectRelation === null
    ? isNull(groupMembers.subjectRelation)
    : eq(groupMembers.subjectRelation, subjectRelation);
  return await db
    .select()
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.subjectNamespace, subjectNs),
        eq(groupMembers.subjectId, subjectId),
        subjectRelationCondition,
      ),
    )
    .get();
}

/**
 * All membership rows whose subject is itself a userset (subjectRelation IS
 * NOT NULL). Used by the engine's userset-traversal branch in `check()`.
 */
export async function listUsersetMembers(db: TxOrDb, groupId: string): Promise<readonly GroupMember[]> {
  return await db
    .select()
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.groupId, groupId),
        sql`${groupMembers.subjectRelation} IS NOT NULL`,
      ),
    )
    .all();
}

/**
 * Every direct member row for a group. Used by the engine's `expand()`.
 */
export async function listAllMembers(db: TxOrDb, groupId: string): Promise<readonly GroupMember[]> {
  return await db
    .select()
    .from(groupMembers)
    .where(eq(groupMembers.groupId, groupId))
    .all();
}

/**
 * Group ids that have this group as a nested member
 * (rows where `subject_namespace='group' AND subject_id=<groupId> AND subject_relation='member'`).
 * Used by the engine's `resolveUserGroups()` BFS over nested groups.
 */
export async function listParentGroupsForGroup(
  db: TxOrDb,
  groupId: string,
): Promise<readonly string[]> {
  const rows = await db
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.subjectNamespace, "group"),
        eq(groupMembers.subjectId, groupId),
        eq(groupMembers.subjectRelation, "member"),
      ),
    )
    .all();
  return rows.map(r => r.groupId);
}

/**
 * Remove every row that references the given group either as the parent or
 * as a nested subject. Used by `groups.service.deleteGroup` to mop up before
 * the `groups` row is removed (the parent side also cascades via FK, but the
 * subject-side rows do not).
 */
export async function deleteAllForGroup(db: AppDatabase, groupId: string): Promise<void> {
  await db.delete(groupMembers)
    .where(
      or(
        eq(groupMembers.groupId, groupId),
        and(eq(groupMembers.subjectNamespace, "group"), eq(groupMembers.subjectId, groupId)),
      ),
    )
    .run();
}
