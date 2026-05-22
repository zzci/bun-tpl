import type { AppDatabase } from "@/db";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { groupMembers, groups } from "@/modules/account/groups/schema";
import { relationTuples } from "@/modules/policy/schema";
import { loadNamespaces } from "./namespace-config";
import { check, expand, listUserResources } from "./zanzibar.engine";

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
      viewer: { union: [{ this: {} }, { computed_userset: { relation: "operator" } }] },
      operator: { union: [{ this: {} }] },
    },
  },
] as const;

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

async function ensureGroup(db: AppDatabase, id: string) {
  // `group_members.group_id` is a FK to `groups.id`; tests insert into the
  // edge table directly so backfill the parent row on demand.
  const now = new Date().toISOString();
  await db.insert(groups).values({ id, name: id, description: null, createdAt: now, updatedAt: now }).onConflictDoNothing().run();
}

async function insertTuple(
  db: AppDatabase,
  ns: string,
  objId: string,
  rel: string,
  subNs: string,
  subId: string,
  subRel?: string | null,
) {
  // Group-membership edges live in `account.group_members`, not
  // `relation_tuples`; route them so the engine can find them via the
  // dedicated source path.
  if (ns === "group" && rel === "member") {
    await ensureGroup(db, objId);
    await db.insert(groupMembers).values({
      id: nanoid(),
      groupId: objId,
      subjectNamespace: subNs,
      subjectId: subId,
      subjectRelation: subRel ?? null,
      createdBy: null,
      createdAt: new Date().toISOString(),
    }).run();
    return;
  }
  await db.insert(relationTuples).values({
    id: nanoid(),
    namespace: ns,
    objectId: objId,
    relation: rel,
    subjectNamespace: subNs,
    subjectId: subId,
    subjectRelation: subRel ?? null,
    createdBy: null,
    createdAt: new Date().toISOString(),
  }).run();
}

describe("Zanzibar Engine", () => {
  let db: AppDatabase;
  let dbPath: string;

  beforeEach(async () => {
    loadNamespaces(testNamespaces);
    const dir = resolve(tmpdir(), `test-zanzibar-${Date.now()}-${nanoid()}`);
    mkdirSync(dir, { recursive: true });
    dbPath = resolve(dir, "test.db");
    db = await createDb(dbPath);
  });

  afterEach(() => {
    db.close();
    const dir = resolve(dbPath, "..");
    if (existsSync(dir))
      rmSync(dir, { recursive: true, force: true });
    // Restore the module-global namespace registry (clear+replace
    // singleton) so test-only namespaces don't leak into other files.
    loadNamespaces();
  });

  describe("check", () => {
    it("should allow direct user-to-resource tuple", async () => {
      await insertTuple(db, "app", "customer-service", "viewer", "user", "zhangsan");

      const result = await check(db, "app", "customer-service", "viewer", "user", "zhangsan");
      expect(result.allowed).toBe(true);
      expect(result.resolvedThrough).toHaveLength(1);
    });

    it("should deny when no tuple exists", async () => {
      const result = await check(db, "app", "customer-service", "viewer", "user", "zhangsan");
      expect(result.allowed).toBe(false);
    });

    it("should allow through group membership (userset)", async () => {
      // group:dev-team#member@user:zhangsan
      await insertTuple(db, "group", "dev-team", "member", "user", "zhangsan");
      // app:customer-service#viewer@group:dev-team#member
      await insertTuple(db, "app", "customer-service", "viewer", "group", "dev-team", "member");

      const result = await check(db, "app", "customer-service", "viewer", "user", "zhangsan");
      expect(result.allowed).toBe(true);
      expect(result.resolvedThrough).toHaveLength(2);
    });

    it("should deny group member not in group", async () => {
      await insertTuple(db, "group", "dev-team", "member", "user", "zhangsan");
      await insertTuple(db, "app", "customer-service", "viewer", "group", "dev-team", "member");

      const result = await check(db, "app", "customer-service", "viewer", "user", "lisi");
      expect(result.allowed).toBe(false);
    });

    it("should allow via computed_userset (admin implies viewer)", async () => {
      // User has admin on app
      await insertTuple(db, "app", "customer-service", "admin", "user", "zhangsan");

      // Check viewer — should resolve via admin → manager → viewer
      const result = await check(db, "app", "customer-service", "viewer", "user", "zhangsan");
      expect(result.allowed).toBe(true);
    });

    it("should allow via computed_userset (manager implies viewer)", async () => {
      await insertTuple(db, "app", "customer-service", "manager", "user", "zhangsan");

      const result = await check(db, "app", "customer-service", "viewer", "user", "zhangsan");
      expect(result.allowed).toBe(true);
    });

    it("should not allow viewer to access manager", async () => {
      await insertTuple(db, "app", "customer-service", "viewer", "user", "zhangsan");

      const result = await check(db, "app", "customer-service", "manager", "user", "zhangsan");
      expect(result.allowed).toBe(false);
    });

    it("should allow host operator through group", async () => {
      await insertTuple(db, "group", "ops-team", "member", "user", "wangwu");
      await insertTuple(db, "host", "srv-01", "operator", "group", "ops-team", "member");

      const result = await check(db, "host", "srv-01", "operator", "user", "wangwu");
      expect(result.allowed).toBe(true);
    });

    it("should allow host viewer via operator (computed_userset)", async () => {
      await insertTuple(db, "host", "srv-01", "operator", "user", "wangwu");

      const result = await check(db, "host", "srv-01", "viewer", "user", "wangwu");
      expect(result.allowed).toBe(true);
    });

    it("should handle cyclic userset tuples without infinite loop", async () => {
      // Create a cycle: group-a#member@group-b#member, group-b#member@group-a#member
      await insertTuple(db, "group", "group-a", "member", "group", "group-b", "member");
      await insertTuple(db, "group", "group-b", "member", "group", "group-a", "member");
      await insertTuple(db, "app", "my-app", "viewer", "group", "group-a", "member");

      // Should not hang — returns false since user is not reachable
      const result = await check(db, "app", "my-app", "viewer", "user", "nobody");
      expect(result.allowed).toBe(false);
    });

    it("should deny when depth exceeds MAX_DEPTH", async () => {
      // Create a chain of 12 groups (exceeds MAX_DEPTH=10)
      for (let i = 0; i < 12; i++) {
        await insertTuple(db, "group", `g${i}`, "member", "group", `g${i + 1}`, "member");
      }
      await insertTuple(db, "group", "g12", "member", "user", "deep-user");
      await insertTuple(db, "app", "deep-app", "viewer", "group", "g0", "member");

      const result = await check(db, "app", "deep-app", "viewer", "user", "deep-user");
      expect(result.allowed).toBe(false);
    });
  });

  describe("expand", () => {
    it("should return direct subjects", async () => {
      await insertTuple(db, "app", "customer-service", "viewer", "user", "zhangsan");
      await insertTuple(db, "app", "customer-service", "viewer", "user", "lisi");

      const tree = await expand(db, "app", "customer-service", "viewer");
      const directUsers = tree.filter(n => n.namespace === "user" && !n.relation);
      expect(directUsers).toHaveLength(2);
    });

    it("should expand group membership", async () => {
      await insertTuple(db, "group", "dev-team", "member", "user", "zhangsan");
      await insertTuple(db, "app", "customer-service", "viewer", "group", "dev-team", "member");

      const tree = await expand(db, "app", "customer-service", "viewer");
      const groupNode = tree.find(n => n.namespace === "group" && n.id === "dev-team");
      expect(groupNode).toBeDefined();
      expect(groupNode!.children).toHaveLength(1);
      expect(groupNode!.children![0]!.id).toBe("zhangsan");
    });

    it("should handle cyclic tuples in expand without infinite loop", async () => {
      await insertTuple(db, "group", "group-x", "member", "group", "group-y", "member");
      await insertTuple(db, "group", "group-y", "member", "group", "group-x", "member");

      // Should return without hanging
      const tree = await expand(db, "group", "group-x", "member");
      expect(tree).toBeDefined();
    });

    it("should include computed_userset subjects in expansion", async () => {
      await insertTuple(db, "app", "customer-service", "admin", "user", "admin01");
      await insertTuple(db, "app", "customer-service", "viewer", "user", "zhangsan");

      // Expanding viewer should include admin01 (via manager → admin chain)
      const tree = await expand(db, "app", "customer-service", "viewer");
      const allUserIds = collectUserIds(tree);
      expect(allUserIds).toContain("zhangsan");
      expect(allUserIds).toContain("admin01");
    });
  });

  describe("listUserResources", () => {
    it("should list directly assigned resources", async () => {
      await insertTuple(db, "app", "app-a", "viewer", "user", "zhangsan");
      await insertTuple(db, "app", "app-b", "manager", "user", "zhangsan");

      const apps = await listUserResources(db, "zhangsan", "app", "viewer");
      expect(apps).toContain("app-a");
      expect(apps).toContain("app-b"); // manager implies viewer
    });

    it("should list resources through group membership", async () => {
      await insertTuple(db, "group", "dev-team", "member", "user", "zhangsan");
      await insertTuple(db, "app", "app-c", "viewer", "group", "dev-team", "member");

      const apps = await listUserResources(db, "zhangsan", "app", "viewer");
      expect(apps).toContain("app-c");
    });

    it("should include resources from higher relations via group", async () => {
      await insertTuple(db, "group", "ops-team", "member", "user", "wangwu");
      await insertTuple(db, "app", "app-d", "admin", "group", "ops-team", "member");

      const apps = await listUserResources(db, "wangwu", "app", "viewer");
      expect(apps).toContain("app-d"); // admin implies viewer
    });

    it("should return empty for user with no tuples", async () => {
      const apps = await listUserResources(db, "nobody", "app", "viewer");
      expect(apps).toHaveLength(0);
    });

    it("should not duplicate resources", async () => {
      // Direct and through group
      await insertTuple(db, "app", "app-e", "viewer", "user", "zhangsan");
      await insertTuple(db, "group", "dev-team", "member", "user", "zhangsan");
      await insertTuple(db, "app", "app-e", "viewer", "group", "dev-team", "member");

      const apps = await listUserResources(db, "zhangsan", "app", "viewer");
      const unique = new Set(apps);
      expect(unique.size).toBe(apps.length);
    });

    it("should resolve nested group memberships", async () => {
      // user → team-a → parent-group, app granted to parent-group
      await insertTuple(db, "group", "team-a", "member", "user", "zhangsan");
      await insertTuple(db, "group", "parent-group", "member", "group", "team-a", "member");
      await insertTuple(db, "app", "nested-app", "viewer", "group", "parent-group", "member");

      const apps = await listUserResources(db, "zhangsan", "app", "viewer");
      expect(apps).toContain("nested-app");
    });
  });
});

function collectUserIds(nodes: readonly { namespace: string; id: string; children?: readonly { namespace: string; id: string; children?: unknown }[] }[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    if (node.namespace === "user") {
      ids.push(node.id);
    }
    if (node.children) {
      ids.push(...collectUserIds(node.children as typeof nodes));
    }
  }
  return ids;
}
