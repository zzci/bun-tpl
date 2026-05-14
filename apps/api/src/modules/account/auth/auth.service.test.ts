import type { AppDatabase } from "@/db";
import type { AuthConfig } from "@/shared/lib/app-config";
import type { Logger } from "@/shared/lib/logger";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import { upsertSingleUser, upsertUser } from "./auth.service";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

let db: AppDatabase;
let dbPath: string;

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  flush: () => {},
} as unknown as Logger;

function authConfig(defaultAdmins: readonly string[]): AuthConfig {
  return {
    sessionMaxAge: 86400,
    defaultAdmins,
  };
}

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-auth-service-${Date.now()}-${nanoid()}`);
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

describe("upsertUser DEFAULT_ADMIN bootstrap", () => {
  test("assigns admin only to the first matching user", async () => {
    const first = await upsertUser(
      db,
      { sub: "sub-admin", preferred_username: "admin", email: "admin@example.com" },
      authConfig(["admin@example.com", "second@example.com"]),
      logger,
    );

    const second = await upsertUser(
      db,
      { sub: "sub-second", preferred_username: "second", email: "second@example.com" },
      authConfig(["admin@example.com", "second@example.com"]),
      logger,
    );

    expect(first.role).toBe("admin");
    expect(second.role).toBe("user");
  });

  test("does not promote an existing user after DEFAULT_ADMIN changes", async () => {
    const created = await upsertUser(
      db,
      { sub: "sub-user", preferred_username: "alice", email: "alice@example.com" },
      authConfig([]),
      logger,
    );

    const updated = await upsertUser(
      db,
      { sub: "sub-user", preferred_username: "alice", email: "alice@example.com" },
      authConfig(["alice@example.com"]),
      logger,
    );

    const row = await db.select().from(users).where(eq(users.id, created.id)).get();

    expect(created.role).toBe("user");
    expect(updated.role).toBe("user");
    expect(row?.role).toBe("user");
  });

  test("promotes DEFAULT_ADMIN even when a non-admin user signed up first", async () => {
    // Bootstrap is gated on "no admin exists", not "no user exists", so a
    // regular employee logging in before the admin must not lock the admin
    // out of auto-promotion.
    const first = await upsertUser(
      db,
      { sub: "sub-bob", preferred_username: "bob", email: "bob@example.com" },
      authConfig(["admin@example.com"]),
      logger,
    );

    const admin = await upsertUser(
      db,
      { sub: "sub-admin", preferred_username: "admin", email: "admin@example.com" },
      authConfig(["admin@example.com"]),
      logger,
    );

    expect(first.role).toBe("user");
    expect(admin.role).toBe("admin");
  });

  test("upsertUser rebinds an existing single-user row when OAuth comes back", async () => {
    // 1. OAuth bootstrap admin
    const first = await upsertUser(
      db,
      { sub: "google-12345", preferred_username: "admin", email: "admin@example.com", name: "Admin" },
      authConfig(["admin@example.com"]),
      logger,
    );
    expect(first.role).toBe("admin");
    expect(first.oauthSub).toBe("google-12345");

    // 2. Operator flips SINGLE_USER_MODE on — single-user takes over the row.
    const single = await upsertSingleUser(db, {
      username: "admin",
      name: "Admin",
      email: "admin@example.com",
    });
    expect(single.id).toBe(first.id);
    expect(single.oauthSub).toBe("single-user");

    // 3. Operator flips SINGLE_USER_MODE off — same email lands via OAuth.
    // The row must rebind to the IdP sub instead of crashing on the email
    // unique index.
    const reclaimed = await upsertUser(
      db,
      { sub: "google-12345", preferred_username: "admin", email: "admin@example.com", name: "Admin" },
      authConfig(["admin@example.com"]),
      logger,
    );
    expect(reclaimed.id).toBe(first.id);
    expect(reclaimed.oauthSub).toBe("google-12345");
    expect(reclaimed.role).toBe("admin");

    const rows = await db.select().from(users).all();
    expect(rows.length).toBe(1);
  });

  test("upsertUser takes over a row by username/email when the IdP sub changes", async () => {
    // E.g. operator moved from one IdP to another. The original user row
    // had a Google sub; the new login carries an Okta sub.
    const original = await upsertUser(
      db,
      { sub: "google-aaa", preferred_username: "alice", email: "alice@example.com" },
      authConfig([]),
      logger,
    );

    const migrated = await upsertUser(
      db,
      { sub: "okta-bbb", preferred_username: "alice", email: "alice@example.com" },
      authConfig([]),
      logger,
    );

    expect(migrated.id).toBe(original.id);
    expect(migrated.oauthSub).toBe("okta-bbb");

    const rows = await db.select().from(users).all();
    expect(rows.length).toBe(1);
  });

  test("upsertSingleUser takes over an existing user with the same username/email", async () => {
    // Simulate an existing OAuth-bootstrapped user (e.g. operator flipped
    // SINGLE_USER_MODE on an existing deployment without wiping the DB).
    const existing = await upsertUser(
      db,
      { sub: "google-12345", preferred_username: "admin", email: "admin@example.com", name: "Existing Admin" },
      authConfig([]),
      logger,
    );

    const single = await upsertSingleUser(db, {
      username: "admin",
      name: "Admin",
      email: "admin@example.com",
    });

    expect(single.id).toBe(existing.id);
    expect(single.oauthSub).toBe("single-user");
    expect(single.role).toBe("admin");

    // Subsequent logins resolve to the same row via the sentinel oauth_sub.
    const again = await upsertSingleUser(db, {
      username: "admin",
      name: "Admin",
      email: "admin@example.com",
    });
    expect(again.id).toBe(existing.id);

    const rows = await db.select().from(users).all();
    expect(rows.length).toBe(1);
  });

  test("upsertSingleUser inserts an admin row and keeps the same id on rename", async () => {
    const first = await upsertSingleUser(db, {
      username: "owner",
      name: "Owner",
      email: "owner@local",
    });
    expect(first.role).toBe("admin");
    expect(first.oauthSub).toBe("single-user");

    const renamed = await upsertSingleUser(db, {
      username: "boss",
      name: "Boss",
      email: "boss@local",
    });
    expect(renamed.id).toBe(first.id);
    expect(renamed.username).toBe("boss");
    expect(renamed.email).toBe("boss@local");

    const rows = await db.select().from(users).all();
    expect(rows.length).toBe(1);
    expect(rows[0]?.role).toBe("admin");
  });

  test("re-promotes DEFAULT_ADMIN after the only admin is deleted", async () => {
    // Initial bootstrap.
    const initial = await upsertUser(
      db,
      { sub: "sub-initial", preferred_username: "initial", email: "initial@example.com" },
      authConfig(["initial@example.com", "backup@example.com"]),
      logger,
    );
    expect(initial.role).toBe("admin");

    // Operator removes the initial admin (e.g. employee left).
    await db.delete(users).where(eq(users.id, initial.id)).run();

    // A different DEFAULT_ADMIN logs in for the first time.
    const backup = await upsertUser(
      db,
      { sub: "sub-backup", preferred_username: "backup", email: "backup@example.com" },
      authConfig(["initial@example.com", "backup@example.com"]),
      logger,
    );
    expect(backup.role).toBe("admin");
  });
});
