import type { AppDatabase } from "@/db";
import { and, eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { relationTuples } from "@/modules/policy/schema";
import { NotFoundError, ValidationError } from "@/shared/lib/errors";
import { getAllNamespaces } from "./namespace-config";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

export interface ResourceGroup {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly createdAt: string;
}

export interface ResourceGroupMember {
  readonly tupleId: string;
  readonly namespace: string;
  readonly objectId: string;
}

/**
 * Resource groups are virtual entities tracked via relation tuples.
 *
 * - Group identity:  resource_group:<id>#__meta__@resource_group:<name>  (stores description in subjectRelation)
 * - Group members:   <resource-ns>:<resource-id>#parent@resource_group:<groupId>
 *
 * Member namespaces must be registered via `loadNamespaces`. In this template the
 * default registry only ships the `user`, `group`, and `resource_group`
 * namespaces — register your own resource namespaces to make them groupable.
 */

export async function createResourceGroup(
  db: AppDatabase,
  input: { readonly name: string; readonly description?: string | null },
  createdBy: string,
): Promise<ResourceGroup> {
  if (!input.name.trim()) {
    throw new ValidationError("Name is required", { name: "Name cannot be empty" });
  }

  // Check duplicate name
  const existing = await db
    .select()
    .from(relationTuples)
    .where(
      and(
        eq(relationTuples.namespace, "resource_group"),
        eq(relationTuples.relation, "__meta__"),
        eq(relationTuples.subjectNamespace, "resource_group"),
        eq(relationTuples.subjectId, input.name.trim()),
      ),
    )
    .get();

  if (existing) {
    throw new ValidationError("Duplicate resource group", { name: "A resource group with this name already exists" });
  }

  const id = nanoid();
  const now = new Date().toISOString();

  // Store metadata as a special tuple
  await db.insert(relationTuples).values({
    id,
    namespace: "resource_group",
    objectId: id,
    relation: "__meta__",
    subjectNamespace: "resource_group",
    subjectId: input.name.trim(),
    subjectRelation: input.description?.trim() || null,
    createdBy,
    createdAt: now,
  }).run();

  return { id, name: input.name.trim(), description: input.description?.trim() ?? null, createdAt: now };
}

export async function deleteResourceGroup(db: AppDatabase, id: string): Promise<boolean> {
  const meta = await db
    .select()
    .from(relationTuples)
    .where(
      and(
        eq(relationTuples.namespace, "resource_group"),
        eq(relationTuples.objectId, id),
        eq(relationTuples.relation, "__meta__"),
      ),
    )
    .get();

  if (!meta)
    return false;

  await db.transaction(async (tx) => {
    // Delete meta tuple
    await tx.delete(relationTuples).where(eq(relationTuples.id, meta.id)).run();

    // Delete all member tuples (<resource>:<id>#parent@resource_group:<id>)
    await tx.delete(relationTuples).where(
      and(
        eq(relationTuples.relation, "parent"),
        eq(relationTuples.subjectNamespace, "resource_group"),
        eq(relationTuples.subjectId, id),
      ),
    ).run();

    // Delete all access tuples on this resource group
    await tx.delete(relationTuples).where(
      and(
        eq(relationTuples.namespace, "resource_group"),
        eq(relationTuples.objectId, id),
      ),
    ).run();
  });

  return true;
}

export async function listResourceGroups(db: AppDatabase): Promise<readonly ResourceGroup[]> {
  const metas = await db
    .select()
    .from(relationTuples)
    .where(
      and(
        eq(relationTuples.namespace, "resource_group"),
        eq(relationTuples.relation, "__meta__"),
      ),
    )
    .all();

  return metas.map(m => ({
    id: m.objectId,
    name: m.subjectId,
    description: m.subjectRelation,
    createdAt: m.createdAt,
  }));
}

export async function getResourceGroupMembers(db: AppDatabase, groupId: string): Promise<readonly ResourceGroupMember[]> {
  const tuples = await db
    .select()
    .from(relationTuples)
    .where(
      and(
        eq(relationTuples.relation, "parent"),
        eq(relationTuples.subjectNamespace, "resource_group"),
        eq(relationTuples.subjectId, groupId),
      ),
    )
    .all();

  return tuples.map(t => ({
    tupleId: t.id,
    namespace: t.namespace,
    objectId: t.objectId,
  }));
}

export async function addResourceGroupMember(
  db: AppDatabase,
  groupId: string,
  memberNamespace: string,
  memberId: string,
  createdBy: string,
): Promise<ResourceGroupMember> {
  const reserved = new Set(["user", "group", "resource_group"]);
  const validNamespaces = [...getAllNamespaces().keys()].filter(n => !reserved.has(n));
  if (!validNamespaces.includes(memberNamespace)) {
    throw new ValidationError("Invalid member namespace", {
      namespace: validNamespaces.length
        ? `Must be one of: ${validNamespaces.join(", ")}`
        : "No resource namespaces registered. Call loadNamespaces() with your resource namespaces.",
    });
  }

  // Verify group exists
  const meta = await db
    .select()
    .from(relationTuples)
    .where(
      and(
        eq(relationTuples.namespace, "resource_group"),
        eq(relationTuples.objectId, groupId),
        eq(relationTuples.relation, "__meta__"),
      ),
    )
    .get();

  if (!meta) {
    throw new NotFoundError("ResourceGroup", groupId);
  }

  // Check duplicate
  const existing = await db
    .select()
    .from(relationTuples)
    .where(
      and(
        eq(relationTuples.namespace, memberNamespace),
        eq(relationTuples.objectId, memberId),
        eq(relationTuples.relation, "parent"),
        eq(relationTuples.subjectNamespace, "resource_group"),
        eq(relationTuples.subjectId, groupId),
      ),
    )
    .get();

  if (existing) {
    throw new ValidationError("Duplicate member", { member: "This resource is already a member of this group" });
  }

  const tupleId = nanoid();
  const now = new Date().toISOString();

  await db.insert(relationTuples).values({
    id: tupleId,
    namespace: memberNamespace,
    objectId: memberId,
    relation: "parent",
    subjectNamespace: "resource_group",
    subjectId: groupId,
    subjectRelation: null,
    createdBy,
    createdAt: now,
  }).run();

  return { tupleId, namespace: memberNamespace, objectId: memberId };
}

export async function removeResourceGroupMember(db: AppDatabase, tupleId: string): Promise<boolean> {
  const existing = await db
    .select()
    .from(relationTuples)
    .where(
      and(
        eq(relationTuples.id, tupleId),
        eq(relationTuples.relation, "parent"),
      ),
    )
    .get();

  if (!existing)
    return false;

  await db.delete(relationTuples).where(eq(relationTuples.id, tupleId)).run();
  return true;
}
