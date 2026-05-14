import type { AppDatabase } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { groups } from "@/modules/account/groups/schema";
import { users } from "@/modules/account/users/schema";
import {
  addGroupMembership,
  deleteTuplesForEntity,
  getGroupMemberCounts,
  listGroupMembersWithJoinedAt,
  removeGroupMembership,
} from "@/modules/policy/policy.service";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

export async function listGroups(db: AppDatabase) {
  const allGroups = await db.select().from(groups).limit(500).all();
  const countMap = await getGroupMemberCounts(db);
  return allGroups.map(g => ({
    ...g,
    memberCount: countMap.get(g.id) ?? 0,
  }));
}

export async function getGroupById(db: AppDatabase, id: string) {
  return await db.select().from(groups).where(eq(groups.id, id)).get();
}

export async function getGroupByName(db: AppDatabase, name: string) {
  return await db.select().from(groups).where(eq(groups.name, name)).get();
}

export async function createGroup(db: AppDatabase, data: { name: string; description?: string | undefined }) {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(groups).values({
    id,
    name: data.name,
    description: data.description ?? null,
    createdAt: now,
    updatedAt: now,
  }).run();
  return (await db.select().from(groups).where(eq(groups.id, id)).get())!;
}

export async function updateGroup(db: AppDatabase, id: string, data: { name?: string | undefined; description?: string | undefined }) {
  const now = new Date().toISOString();
  const setData: Record<string, unknown> = { updatedAt: now };
  if (data.name !== undefined)
    setData.name = data.name;
  if (data.description !== undefined)
    setData.description = data.description;
  await db.update(groups)
    .set(setData)
    .where(eq(groups.id, id))
    .run();
  return await db.select().from(groups).where(eq(groups.id, id)).get();
}

export async function deleteGroup(db: AppDatabase, id: string) {
  await deleteTuplesForEntity(db, "group", id);
  await db.delete(groups).where(eq(groups.id, id)).run();
}

export async function getGroupMembers(db: AppDatabase, groupId: string) {
  const memberships = await listGroupMembersWithJoinedAt(db, groupId);
  if (memberships.length === 0)
    return [];

  const userIds = memberships.map(m => m.subjectId);
  const joinedAtMap = new Map(memberships.map(m => [m.subjectId, m.joinedAt]));

  const memberUsers = await db
    .select({
      id: users.id,
      username: users.username,
      name: users.name,
      email: users.email,
      avatar: users.avatar,
      role: users.role,
      status: users.status,
    })
    .from(users)
    .where(inArray(users.id, userIds))
    .all();

  return memberUsers.map(u => ({
    ...u,
    joinedAt: joinedAtMap.get(u.id) ?? "",
  }));
}

export async function addGroupMember(db: AppDatabase, groupId: string, userId: string) {
  return await addGroupMembership(db, groupId, userId, userId);
}

export async function removeGroupMember(db: AppDatabase, groupId: string, userId: string) {
  return await removeGroupMembership(db, groupId, userId);
}
