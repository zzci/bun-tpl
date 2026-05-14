import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import { items } from "@/modules/item/schema";
import { loadNamespaces } from "@/modules/policy/namespace-config";
import { documentAccess } from "./document.permission";
import {
  addDocumentShare,
  createDocument,
  getDocumentById,
  getDocumentPermission,
  getDocumentTreeForUser,
  isVersionConflict,
  listDocumentSharesWithInheritance,
  listMyDocuments,
  removeDocumentShare,
  softDeleteDocument,
  updateDocument,
} from "./document.service";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

let db: AppDatabase;
let dbPath: string;

async function seedUser(name: string) {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    oauthSub: `sub-${id}`,
    username: `${name.toLowerCase()}-${id}`,
    name,
    email: `${id}@test.com`,
    role: "user",
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).run();
  return id;
}

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  flush: () => {},
} as unknown as Logger;

/** Build a policy context for service-level test calls. */
function policyCtx(actorId: string) {
  return { db, logger: noopLogger, actor: { id: actorId, type: "user" } };
}

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-document-${Date.now()}-${nanoid()}`);
  mkdirSync(dir, { recursive: true });
  dbPath = resolve(dir, "test.db");
  db = await createDb(dbPath);
  loadNamespaces();
});

afterEach(() => {
  db.close();
  const dir = resolve(dbPath, "..");
  if (existsSync(dir))
    rmSync(dir, { recursive: true, force: true });
});

describe("createDocument", () => {
  test("creates with default fields and version 1", async () => {
    const userId = await seedUser("Alice");
    const doc = await createDocument(db, { title: "Hi", creatorId: userId });
    expect(doc.id).toHaveLength(8);
    expect(doc.title).toBe("Hi");
    expect(doc.content).toBeNull();
    expect(doc.tags).toBe("[]");
    expect(doc.parentId).toBeNull();
    expect(doc.version).toBe(1);
    expect(doc.creatorId).toBe(userId);
  });

  test("nests via parentId; parent stored as short_id", async () => {
    const userId = await seedUser("Alice");
    const parent = await createDocument(db, { title: "P", creatorId: userId });
    const child = await createDocument(db, { title: "C", creatorId: userId, parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
  });
});

describe("updateDocument (version + content + parent)", () => {
  test("bumps version on every successful update", async () => {
    const userId = await seedUser("Alice");
    const doc = await createDocument(db, { title: "v1", creatorId: userId });
    const updated = await updateDocument(db, doc.id, { content: "body" });
    expect(isVersionConflict(updated)).toBe(false);
    if (!isVersionConflict(updated))
      expect(updated!.version).toBeGreaterThan(1);
  });

  test("returns VersionConflict when expectedVersion mismatches", async () => {
    const userId = await seedUser("Alice");
    const doc = await createDocument(db, { title: "v1", creatorId: userId });
    await updateDocument(db, doc.id, { content: "v2" });
    const result = await updateDocument(db, doc.id, { content: "wrong", expectedVersion: 1 });
    expect(isVersionConflict(result)).toBe(true);
    if (isVersionConflict(result))
      expect(result.current.content).toBe("v2");
  });

  test("moves to a new parent; parent_item tuple rewritten in lockstep", async () => {
    const userId = await seedUser("Alice");
    const a = await createDocument(db, { title: "A", creatorId: userId });
    const b = await createDocument(db, { title: "B", creatorId: userId });
    const child = await createDocument(db, { title: "C", creatorId: userId, parentId: a.id });
    expect(child.parentId).toBe(a.id);
    const moved = await updateDocument(db, child.id, { parentId: b.id });
    if (isVersionConflict(moved))
      expect.unreachable("no conflict expected");
    else
      expect(moved?.parentId).toBe(b.id);
  });
});

describe("field-level write policy (commentsLocked → owner)", () => {
  test("owner can write commentsLocked", async () => {
    const alice = await seedUser("Alice");
    const doc = await createDocument(db, { title: "D", creatorId: alice });
    const item = (await db.select({ id: items.id })
      .from(items)
      .where(eq(items.shortId, doc.id))
      .get())!;
    const safe = await documentAccess.filterWritable(
      policyCtx(alice),
      item.id,
      { title: "new title", commentsLocked: true },
      { onForbidden: "reject" },
    );
    expect(safe).toEqual({ title: "new title", commentsLocked: true });
  });

  test("shared editor cannot write commentsLocked — strip mode drops it", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const doc = await createDocument(db, { title: "D", creatorId: alice });
    await addDocumentShare(policyCtx(alice), {
      documentId: doc.id,
      targetType: "user",
      targetId: bob,
      permission: "editor",
    });
    const item = (await db.select({ id: items.id })
      .from(items)
      .where(eq(items.shortId, doc.id))
      .get())!;
    const safe = await documentAccess.filterWritable(
      policyCtx(bob),
      item.id,
      { title: "renamed by editor", commentsLocked: true },
      { onForbidden: "strip" },
    );
    expect(safe).toEqual({ title: "renamed by editor" });
  });

  test("shared editor cannot write commentsLocked — reject mode throws", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const doc = await createDocument(db, { title: "D", creatorId: alice });
    await addDocumentShare(policyCtx(alice), {
      documentId: doc.id,
      targetType: "user",
      targetId: bob,
      permission: "editor",
    });
    const item = (await db.select({ id: items.id })
      .from(items)
      .where(eq(items.shortId, doc.id))
      .get())!;
    expect(
      documentAccess.filterWritable(
        policyCtx(bob),
        item.id,
        { commentsLocked: true },
        { onForbidden: "reject" },
      ),
    ).rejects.toThrow(/Cannot write field/);
  });
});

describe("softDeleteDocument", () => {
  test("soft-deletes the doc and every descendant; clears tuples", async () => {
    const userId = await seedUser("Alice");
    const root = await createDocument(db, { title: "Root", creatorId: userId });
    const child = await createDocument(db, { title: "Child", creatorId: userId, parentId: root.id });
    const grand = await createDocument(db, { title: "Grand", creatorId: userId, parentId: child.id });
    await softDeleteDocument(db, root.id);
    expect(await getDocumentById(db, root.id)).toBeUndefined();
    expect(await getDocumentById(db, child.id)).toBeUndefined();
    expect(await getDocumentById(db, grand.id)).toBeUndefined();
  });
});

describe("getDocumentPermission + subtree inheritance via policy", () => {
  test("creator has editor; uninvited user has nothing", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const doc = await createDocument(db, { title: "D", creatorId: alice });
    expect(await getDocumentPermission(db, doc.id, alice)).toBe("editor");
    expect(await getDocumentPermission(db, doc.id, bob)).toBeNull();
  });

  test("explicit viewer share grants viewer", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const doc = await createDocument(db, { title: "D", creatorId: alice });
    await addDocumentShare(policyCtx(alice), {
      documentId: doc.id,
      targetType: "user",
      targetId: bob,
      permission: "viewer",
    });
    expect(await getDocumentPermission(db, doc.id, bob)).toBe("viewer");
  });

  test("ancestor share inherits to descendants (parent_item)", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const parent = await createDocument(db, { title: "P", creatorId: alice });
    const child = await createDocument(db, { title: "C", creatorId: alice, parentId: parent.id });
    const grand = await createDocument(db, { title: "G", creatorId: alice, parentId: child.id });
    await addDocumentShare(policyCtx(alice), {
      documentId: parent.id,
      targetType: "user",
      targetId: bob,
      permission: "editor",
    });
    expect(await getDocumentPermission(db, parent.id, bob)).toBe("editor");
    expect(await getDocumentPermission(db, child.id, bob)).toBe("editor");
    expect(await getDocumentPermission(db, grand.id, bob)).toBe("editor");
  });

  test("removeDocumentShare drops the tuple — inherited access disappears", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const parent = await createDocument(db, { title: "P", creatorId: alice });
    const child = await createDocument(db, { title: "C", creatorId: alice, parentId: parent.id });
    const share = await addDocumentShare(policyCtx(alice), {
      documentId: parent.id,
      targetType: "user",
      targetId: bob,
      permission: "viewer",
    });
    expect(await getDocumentPermission(db, child.id, bob)).toBe("viewer");
    await removeDocumentShare(policyCtx(alice), share.id);
    expect(await getDocumentPermission(db, child.id, bob)).toBeNull();
  });
});

describe("listDocumentSharesWithInheritance", () => {
  test("returns self-shares with inheritedFrom=null + ancestor shares with inheritedFrom set", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const carol = await seedUser("Carol");
    const parent = await createDocument(db, { title: "Parent", creatorId: alice });
    const child = await createDocument(db, { title: "Child", creatorId: alice, parentId: parent.id });
    await addDocumentShare(policyCtx(alice), { documentId: parent.id, targetType: "user", targetId: bob, permission: "viewer" });
    await addDocumentShare(policyCtx(alice), { documentId: child.id, targetType: "user", targetId: carol, permission: "editor" });

    const list = await listDocumentSharesWithInheritance(db, child.id);
    const selfRow = list.find(r => r.targetId === carol);
    const inheritedRow = list.find(r => r.targetId === bob);
    expect(selfRow?.inheritedFrom).toBeNull();
    expect(inheritedRow?.inheritedFrom).toEqual({ id: parent.id, title: "Parent" });
  });
});

describe("listMyDocuments", () => {
  test("returns docs the user created", async () => {
    const me = await seedUser("Me");
    const other = await seedUser("Other");
    const mine = await createDocument(db, { title: "Mine", creatorId: me });
    await createDocument(db, { title: "Theirs", creatorId: other });
    const list = await listMyDocuments(db, { userId: me });
    expect(list.total).toBe(1);
    expect(list.data[0]!.id).toBe(mine.id);
  });

  test("returns docs shared with the user, plus descendants of shared docs", async () => {
    const owner = await seedUser("Owner");
    const me = await seedUser("Me");
    const parent = await createDocument(db, { title: "P", creatorId: owner });
    const child = await createDocument(db, { title: "C", creatorId: owner, parentId: parent.id });
    await addDocumentShare(policyCtx(owner), {
      documentId: parent.id,
      targetType: "user",
      targetId: me,
      permission: "viewer",
    });
    const list = await listMyDocuments(db, { userId: me });
    const ids = list.data.map(d => d.id).sort();
    expect(ids).toEqual([parent.id, child.id].sort());
  });
});

describe("getDocumentTreeForUser", () => {
  test("admin sees every document; child node reports parentId as short_id", async () => {
    const alice = await seedUser("Alice");
    const a = await createDocument(db, { title: "alpha", creatorId: alice });
    const b = await createDocument(db, { title: "Beta", creatorId: alice });
    const c = await createDocument(db, { title: "alpha-child", creatorId: alice, parentId: a.id });

    const tree = await getDocumentTreeForUser(db, { id: "anyone", role: "admin" });
    const ids = tree.map(n => n.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(c.id);
    const childNode = tree.find(n => n.id === c.id);
    expect(childNode?.parentId).toBe(a.id);
  });

  test("non-admin only sees their own + their visible docs", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    await createDocument(db, { title: "alice doc", creatorId: alice });
    const bobDoc = await createDocument(db, { title: "bob doc", creatorId: bob });
    const tree = await getDocumentTreeForUser(db, { id: bob, role: "user" });
    expect(tree.map(n => n.id)).toEqual([bobDoc.id]);
  });
});
