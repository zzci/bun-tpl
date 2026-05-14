// Issue attachment lifecycle (multipart upload, download, delete).
import { describe, expect, it } from "bun:test";
import { getClient } from "../../lib/oidc";

interface Issue { id: string; title: string }
interface Attachment {
  id: string;
  filename: string;
  mimetype: string;
  size: number;
}

describe("/api/issues/:id/attachments (multipart)", () => {
  it("upload → list → download → delete cycle", async () => {
    const user = await getClient("user@example.com", "admin");

    const issue = await user.json<{ data: Issue }>("/api/issues", {
      method: "POST",
      body: { title: "attachment-target" },
    });
    const issueId = issue.data.id;

    // Upload via multipart/form-data.
    const fd = new FormData();
    const payload = "hello e2e attachment";
    fd.append("file", new File([payload], "note.txt", { type: "text/plain" }));
    const upload = await user.raw(`/api/issues/${issueId}/attachments`, {
      method: "POST",
      formData: fd,
    });
    expect(upload.status).toBe(201);
    const uploadBody = await upload.json() as { data: Attachment };
    expect(uploadBody.data.filename).toBe("note.txt");
    expect(uploadBody.data.size).toBe(payload.length);
    const attId = uploadBody.data.id;

    // List.
    const list = await user.json<{ data: Attachment[] }>(`/api/issues/${issueId}/attachments`);
    expect(list.data.find(a => a.id === attId)).toBeDefined();

    // Download.
    const download = await user.raw(`/api/issues/${issueId}/attachments/${attId}`);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe(payload);

    // Delete.
    await user.raw(`/api/issues/${issueId}/attachments/${attId}`, { method: "DELETE" });
    const after = await user.json<{ data: Attachment[] }>(`/api/issues/${issueId}/attachments`);
    expect(after.data).toHaveLength(0);

    // Cleanup.
    await user.raw(`/api/issues/${issueId}`, { method: "DELETE" });
  });

  it("rejects oversized files", async () => {
    const user = await getClient("user@example.com", "admin");
    const issue = await user.json<{ data: Issue }>("/api/issues", {
      method: "POST",
      body: { title: "size-target" },
    });
    const issueId = issue.data.id;

    // Service caps individual files at 10 MB. Send +1 byte so the early
    // Content-Length / per-file size check trips. The body is large enough
    // that the orchestrator's default 5s test timeout can be tight on slow
    // environments — bump to 30s.
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    const fd = new FormData();
    fd.append("file", new File([big], "big.bin", { type: "application/octet-stream" }));

    const res = await user.raw(`/api/issues/${issueId}/attachments`, {
      method: "POST",
      formData: fd,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    await user.raw(`/api/issues/${issueId}`, { method: "DELETE" });
  }, 30_000);
});
