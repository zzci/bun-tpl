import type { AppDatabase } from "@/db";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import { loadNamespaces } from "./namespace-config";
import {
  batchCreateTuples,
  batchDeleteTuples,
  createTuple,
  deleteTuple,
  getTuplesByObject,
  getTuplesBySubject,
  listTuples,
} from "./policy.service";

const testNamespaces = [
  { name: "user" },
  {
    name: "group",
    relations: {
      member: { union: [{ this: {} }] },
    },
  },
  {
    name: "app",
    relations: {
      viewer: { union: [{ this: {} }, { computed_userset: { relation: "manager" } }] },
      manager: { union: [{ this: {} }, { computed_userset: { relation: "admin" } }] },
      admin: { union: [{ this: {} }] },
    },
  },
  {
    name: "host",
    relations: {
      viewer: { union: [{ this: {} }] },
    },
  },
] as const;

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

async function createTestUser(db: AppDatabase, id: string) {
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    oauthSub: `sub-${id}`,
    username: id,
    name: id,
    email: `${id}@test.com`,
    role: "admin",
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).run();
}

describe("Policy Service", () => {
  let db: AppDatabase;
  let dbPath: string;
  const userId = "testuser";

  beforeEach(async () => {
    loadNamespaces(testNamespaces);
    const dir = resolve(tmpdir(), `test-policy-${Date.now()}-${nanoid()}`);
    mkdirSync(dir, { recursive: true });
    dbPath = resolve(dir, "test.db");
    db = await createDb(dbPath);
    await createTestUser(db, userId);
  });

  afterEach(() => {
    db.close();
    const dir = resolve(dbPath, "..");
    if (existsSync(dir))
      rmSync(dir, { recursive: true, force: true });
  });

  describe("createTuple", () => {
    it("should create a valid tuple", async () => {
      const tuple = await createTuple(db, {
        namespace: "app",
        objectId: "my-app",
        relation: "viewer",
        subjectNamespace: "user",
        subjectId: "zhangsan",
      }, userId);

      expect(tuple.id).toHaveLength(8);
      expect(tuple.namespace).toBe("app");
      expect(tuple.relation).toBe("viewer");
    });

    it("should reject invalid namespace", async () => {
      expect(createTuple(db, {
        namespace: "invalid",
        objectId: "x",
        relation: "viewer",
        subjectNamespace: "user",
        subjectId: "y",
      }, userId)).rejects.toThrow("Invalid namespace");
    });

    it("should reject invalid relation for namespace", async () => {
      expect(createTuple(db, {
        namespace: "app",
        objectId: "x",
        relation: "invalid_rel",
        subjectNamespace: "user",
        subjectId: "y",
      }, userId)).rejects.toThrow("Invalid relation");
    });

    it("should reject duplicate direct tuple (NULL subject_relation)", async () => {
      await createTuple(db, {
        namespace: "app",
        objectId: "my-app",
        relation: "viewer",
        subjectNamespace: "user",
        subjectId: "zhangsan",
      }, userId);

      expect(createTuple(db, {
        namespace: "app",
        objectId: "my-app",
        relation: "viewer",
        subjectNamespace: "user",
        subjectId: "zhangsan",
      }, userId)).rejects.toThrow("Duplicate tuple");
    });

    it("should create tuple with subject relation", async () => {
      const tuple = await createTuple(db, {
        namespace: "app",
        objectId: "my-app",
        relation: "viewer",
        subjectNamespace: "group",
        subjectId: "dev-team",
        subjectRelation: "member",
      }, userId);

      expect(tuple.subjectRelation).toBe("member");
    });
  });

  describe("deleteTuple", () => {
    it("should delete existing tuple", async () => {
      const tuple = await createTuple(db, {
        namespace: "app",
        objectId: "my-app",
        relation: "viewer",
        subjectNamespace: "user",
        subjectId: "zhangsan",
      }, userId);

      expect(await deleteTuple(db, tuple.id)).toBe(true);
    });

    it("should return false for non-existent tuple", async () => {
      expect(await deleteTuple(db, "nonexist")).toBe(false);
    });
  });

  describe("batchCreateTuples", () => {
    it("should create multiple tuples", async () => {
      const tuples = await batchCreateTuples(db, [
        { namespace: "app", objectId: "app-a", relation: "viewer", subjectNamespace: "user", subjectId: "u1" },
        { namespace: "app", objectId: "app-b", relation: "viewer", subjectNamespace: "user", subjectId: "u2" },
      ], userId);

      expect(tuples).toHaveLength(2);
    });

    it("should reject batch with invalid tuple", async () => {
      expect(batchCreateTuples(db, [
        { namespace: "app", objectId: "app-a", relation: "viewer", subjectNamespace: "user", subjectId: "u1" },
        { namespace: "invalid", objectId: "x", relation: "y", subjectNamespace: "user", subjectId: "u2" },
      ], userId)).rejects.toThrow("Invalid namespace");
    });
  });

  describe("batchDeleteTuples", () => {
    it("should delete multiple tuples", async () => {
      const t1 = await createTuple(db, { namespace: "app", objectId: "a", relation: "viewer", subjectNamespace: "user", subjectId: "u1" }, userId);
      const t2 = await createTuple(db, { namespace: "app", objectId: "b", relation: "viewer", subjectNamespace: "user", subjectId: "u2" }, userId);

      const deleted = await batchDeleteTuples(db, [t1.id, t2.id]);
      expect(deleted).toBe(2);
    });
  });

  describe("listTuples", () => {
    it("should list all tuples with pagination", async () => {
      for (let i = 0; i < 5; i++) {
        await createTuple(db, {
          namespace: "app",
          objectId: `app-${i}`,
          relation: "viewer",
          subjectNamespace: "user",
          subjectId: "u1",
        }, userId);
      }

      const result = await listTuples(db, { page: 1, limit: 3 });
      expect(result.data).toHaveLength(3);
      expect(result.total).toBe(5);
    });

    it("should filter by namespace", async () => {
      await createTuple(db, { namespace: "app", objectId: "a", relation: "viewer", subjectNamespace: "user", subjectId: "u1" }, userId);
      await createTuple(db, { namespace: "host", objectId: "h", relation: "viewer", subjectNamespace: "user", subjectId: "u1" }, userId);

      const result = await listTuples(db, { namespace: "app" });
      expect(result.data).toHaveLength(1);
      expect(result.data[0]!.namespace).toBe("app");
    });
  });

  describe("getTuplesByObject", () => {
    it("should return tuples for a specific object", async () => {
      await createTuple(db, { namespace: "app", objectId: "my-app", relation: "viewer", subjectNamespace: "user", subjectId: "u1" }, userId);
      await createTuple(db, { namespace: "app", objectId: "my-app", relation: "admin", subjectNamespace: "user", subjectId: "u2" }, userId);
      await createTuple(db, { namespace: "app", objectId: "other", relation: "viewer", subjectNamespace: "user", subjectId: "u3" }, userId);

      const tuples = await getTuplesByObject(db, "app", "my-app");
      expect(tuples).toHaveLength(2);
    });
  });

  describe("getTuplesBySubject", () => {
    it("should return tuples for a specific subject", async () => {
      await createTuple(db, { namespace: "app", objectId: "a", relation: "viewer", subjectNamespace: "user", subjectId: "zhangsan" }, userId);
      await createTuple(db, { namespace: "host", objectId: "h", relation: "viewer", subjectNamespace: "user", subjectId: "zhangsan" }, userId);

      const tuples = await getTuplesBySubject(db, "user", "zhangsan");
      expect(tuples).toHaveLength(2);
    });
  });
});
