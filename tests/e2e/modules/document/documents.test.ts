import { describe, expect, it } from "bun:test";
import { getClient } from "../../lib/oidc";

interface Document {
  id: string;
  title: string;
  content: string | null;
  parentId: string | null;
  version: number;
}
interface Share {
  id: string;
  targetType: string;
  targetId: string;
  permission: string;
  inheritedFrom: { id: string; title: string } | null;
}

describe("/api/documents CRUD + nesting + sharing", () => {
  it("creates a parent doc, a nested child, renames, then deletes the subtree", async () => {
    const user = await getClient("user@example.com", "admin");

    const parent = await user.json<{ data: Document }>("/api/documents", {
      method: "POST",
      body: { title: "e2e-parent", content: "hello" },
    });
    expect(parent.data.title).toBe("e2e-parent");
    expect(parent.data.parentId).toBeNull();
    const parentId = parent.data.id;

    // Nest a child under the parent. The parent_item edge is rewritten by
    // the service in lockstep with `document_details.parent_id`.
    const child = await user.json<{ data: Document }>("/api/documents", {
      method: "POST",
      body: { title: "e2e-child", parentId },
    });
    expect(child.data.parentId).toBe(parentId);
    const childId = child.data.id;

    // List includes both.
    const list = await user.json<{ data: Document[] }>("/api/documents");
    expect(list.data.find(d => d.id === parentId)).toBeDefined();
    expect(list.data.find(d => d.id === childId)).toBeDefined();

    // Tree reflects the nesting.
    const tree = await user.json<{ data: Array<{ id: string; parentId: string | null }> }>("/api/documents/tree");
    const childNode = tree.data.find(n => n.id === childId);
    expect(childNode?.parentId).toBe(parentId);

    // PATCH requires `version` for optimistic concurrency.
    const patched = await user.json<{ data: Document }>(`/api/documents/${childId}`, {
      method: "PATCH",
      body: { title: "e2e-child-renamed", version: child.data.version },
    });
    expect(patched.data.title).toBe("e2e-child-renamed");

    // Delete parent — cascades to child via the subtree soft-delete.
    await user.raw(`/api/documents/${parentId}`, { method: "DELETE" });
    const gone = await user.raw(`/api/documents/${parentId}`);
    expect(gone.status).toBe(404);
    const childGone = await user.raw(`/api/documents/${childId}`);
    expect(childGone.status).toBe(404);
  });

  it("share a document with a second user grants read access (and inherits to children)", async () => {
    const owner = await getClient("user@example.com", "admin");
    const admin = await getClient("admin@example.com", "admin");
    const users = await admin.json<{ data: { id: string; email: string }[] }>("/api/account/users");
    const adminId = users.data.find(u => u.email === "admin@example.com")?.id;
    if (!adminId)
      throw new Error("admin user missing from directory");

    const parent = await owner.json<{ data: Document }>("/api/documents", {
      method: "POST",
      body: { title: "shared-parent", content: "shared body" },
    });
    const parentId = parent.data.id;

    const child = await owner.json<{ data: Document }>("/api/documents", {
      method: "POST",
      body: { title: "shared-child", parentId },
    });
    const childId = child.data.id;

    // Owner shares the parent with admin as viewer.
    const share = await owner.json<{ data: Share }>(`/api/documents/${parentId}/shares`, {
      method: "POST",
      body: { targetType: "user", targetId: adminId, permission: "viewer" },
    });
    expect(share.data.permission).toBe("viewer");

    // Admin can read the parent directly.
    const readParent = await admin.json<{ data: Document }>(`/api/documents/${parentId}`);
    expect(readParent.data.id).toBe(parentId);

    // …and the child, via the inherited `parent_item` edge.
    const readChild = await admin.json<{ data: Document }>(`/api/documents/${childId}`);
    expect(readChild.data.id).toBe(childId);

    // The child's share list reports the parent grant as `inheritedFrom`.
    const childShares = await owner.json<{ data: Share[] }>(`/api/documents/${childId}/shares`);
    const inherited = childShares.data.find(s => s.targetId === adminId);
    expect(inherited?.inheritedFrom).toMatchObject({ id: parentId });

    await owner.raw(`/api/documents/${parentId}`, { method: "DELETE" });
  });
});
