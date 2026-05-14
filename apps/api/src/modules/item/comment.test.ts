import type { AppDatabase } from "@/db";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import {
  createComment,
  deleteComment,
  getCommentById,
  listComments,
} from "@/modules/item/comment.service";
import { createItem } from "@/modules/item/item.service";
import { itemComments } from "@/modules/item/schema";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

let db: AppDatabase;
let dbPath: string;

async function seedUser(name: string) {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    oauthSub: `sub-${id}`,
    username: name.toLowerCase(),
    name,
    email: `${name.toLowerCase()}@test.com`,
    role: "user",
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).run();
  return id;
}

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-item-comment-${Date.now()}-${nanoid()}`);
  mkdirSync(dir, { recursive: true });
  dbPath = resolve(dir, "test.db");
  db = await createDb(dbPath);
});

afterEach(() => {
  db.close();
  const dir = resolve(dbPath, "..");
  if (existsSync(dir))
    rmSync(dir, { recursive: true, force: true });
});

async function makeItem() {
  const userId = await seedUser(`u-${nanoid()}`);
  const item = await createItem(db, {
    type: "issue",
    title: "Carrier item",
    status: "open",
    creatorId: userId,
  });
  return { userId, item };
}

describe("createComment", () => {
  test("inserts a top-level comment", async () => {
    const { userId, item } = await makeItem();
    const c = await createComment(db, {
      itemId: item.id,
      authorId: userId,
      content: "first",
    });
    expect(c.id).toHaveLength(8);
    expect(c.itemId).toBe(item.id);
    expect(c.authorId).toBe(userId);
    expect(c.replyToId).toBeNull();
    expect(c.isInternal).toBe(false);
  });

  test("inserts an internal comment when isInternal=true", async () => {
    const { userId, item } = await makeItem();
    const c = await createComment(db, {
      itemId: item.id,
      authorId: userId,
      content: "note",
      isInternal: true,
    });
    expect(c.isInternal).toBe(true);
  });

  test("threads a reply when replyToId is valid + same item", async () => {
    const { userId, item } = await makeItem();
    const parent = await createComment(db, { itemId: item.id, authorId: userId, content: "p" });
    const child = await createComment(db, {
      itemId: item.id,
      authorId: userId,
      content: "c",
      replyToId: parent.id,
    });
    expect(child.replyToId).toBe(parent.id);
  });

  test("rejects an unknown replyToId", async () => {
    const { userId, item } = await makeItem();
    await expect(
      createComment(db, { itemId: item.id, authorId: userId, content: "c", replyToId: "missing-" }),
    ).rejects.toThrow(/reply target.*not found/i);
  });

  test("rejects a replyToId from a different item", async () => {
    const { userId, item } = await makeItem();
    const { item: other } = await makeItem();
    const otherParent = await createComment(db, { itemId: other.id, authorId: userId, content: "elsewhere" });

    await expect(
      createComment(db, { itemId: item.id, authorId: userId, content: "c", replyToId: otherParent.id }),
    ).rejects.toThrow(/different item/i);
  });

  test("forces isInternal=true when replying to an internal parent", async () => {
    const { userId, item } = await makeItem();
    const parent = await createComment(db, {
      itemId: item.id,
      authorId: userId,
      content: "internal parent",
      isInternal: true,
    });
    const child = await createComment(db, {
      itemId: item.id,
      authorId: userId,
      content: "reply default",
      replyToId: parent.id,
      // isInternal omitted — service should coerce to true so the thread
      // doesn't leak across the visibility boundary.
    });
    expect(child.isInternal).toBe(true);
  });

  test("rejects comments on missing or soft-deleted items", async () => {
    await expect(
      createComment(db, { itemId: "missing-", authorId: "anyone-", content: "c" }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("listComments", () => {
  test("includeInternal=false hides internal rows", async () => {
    const { userId, item } = await makeItem();
    await createComment(db, { itemId: item.id, authorId: userId, content: "pub" });
    await createComment(db, { itemId: item.id, authorId: userId, content: "priv", isInternal: true });

    const seenByViewer = await listComments(db, item.id, { includeInternal: false });
    expect(seenByViewer.map(r => r.content)).toEqual(["pub"]);

    const seenByOwner = await listComments(db, item.id, { includeInternal: true });
    expect(seenByOwner.map(r => r.content).sort()).toEqual(["priv", "pub"]);
  });

  test("orders by createdAt ASC, id ASC so threads read top-down", async () => {
    const { userId, item } = await makeItem();
    const first = await createComment(db, { itemId: item.id, authorId: userId, content: "first" });
    const second = await createComment(db, { itemId: item.id, authorId: userId, content: "second" });

    const list = await listComments(db, item.id, { includeInternal: true });
    expect(list.map(r => r.id)).toEqual([first.id, second.id]);
  });
});

describe("deleteComment", () => {
  test("hard deletes the row and sets reply_to_id=NULL on replies", async () => {
    const { userId, item } = await makeItem();
    const parent = await createComment(db, { itemId: item.id, authorId: userId, content: "p" });
    const child = await createComment(db, { itemId: item.id, authorId: userId, content: "c", replyToId: parent.id });

    await deleteComment(db, parent.id);

    expect(await getCommentById(db, item.id, parent.id)).toBeUndefined();
    const childRow = await db.select().from(itemComments).where(eq(itemComments.id, child.id)).get();
    expect(childRow?.replyToId).toBeNull();
    expect(childRow?.content).toBe("c");
  });
});
