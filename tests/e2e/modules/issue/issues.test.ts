import { describe, expect, it } from "bun:test";
import { getClient } from "../../lib/oidc";

interface Issue {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  creatorId: string;
  assigneeId: string | null;
}
interface Comment { id: string; content: string }

describe("/api/issues CRUD + comments", () => {
  it("user creates / lists / updates / completes / deletes a issue", async () => {
    const user = await getClient("user@example.com", "admin");

    // Create.
    const created = await user.json<{ data: Issue }>("/api/issues", {
      method: "POST",
      body: { title: "e2e-issue", description: "fixture" },
    });
    expect(created.data.title).toBe("e2e-issue");
    expect(created.data.status).toBe("open");
    const id = created.data.id;

    // List.
    const list = await user.json<{ data: Issue[] }>("/api/issues");
    expect(list.data.find(t => t.id === id)).toBeDefined();

    // Read by id.
    const got = await user.json<{ data: Issue }>(`/api/issues/${id}`);
    expect(got.data.id).toBe(id);

    // Patch: change priority + status.
    const patched = await user.json<{ data: Issue }>(`/api/issues/${id}`, {
      method: "PATCH",
      body: { priority: "high", status: "in_progress" },
    });
    expect(patched.data.priority).toBe("high");
    expect(patched.data.status).toBe("in_progress");

    // Delete.
    await user.raw(`/api/issues/${id}`, { method: "DELETE" });
    const gone = await user.raw(`/api/issues/${id}`);
    expect(gone.status).toBe(404);
  });

  it("comment lifecycle on a issue", async () => {
    const user = await getClient("user@example.com", "admin");
    const created = await user.json<{ data: Issue }>("/api/issues", {
      method: "POST",
      body: { title: "comment-target" },
    });
    const issueId = created.data.id;

    // Add a comment.
    const added = await user.json<{ data: Comment }>(`/api/issues/${issueId}/comments`, {
      method: "POST",
      body: { content: "first comment" },
    });
    expect(added.data.content).toBe("first comment");

    // List comments.
    const list = await user.json<{ data: Comment[] }>(`/api/issues/${issueId}/comments`);
    expect(list.data.find(c => c.id === added.data.id)).toBeDefined();

    // Delete comment.
    await user.raw(`/api/issues/${issueId}/comments/${added.data.id}`, { method: "DELETE" });
    const after = await user.json<{ data: Comment[] }>(`/api/issues/${issueId}/comments`);
    expect(after.data).toHaveLength(0);

    // Cleanup.
    await user.raw(`/api/issues/${issueId}`, { method: "DELETE" });
  });
});
