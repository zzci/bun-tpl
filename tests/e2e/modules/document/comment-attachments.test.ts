// Document comment-attachment lifecycle. Route surface comes from
// mountItemCommentRoutes; this file only covers the happy-path cycle
// against `/api/documents/...` to keep Phase B's encrypted-WAL volume
// under the libsql SQLITE_CORRUPT threshold (see the issue counterpart
// + comment.service.ts).
import { describe, expect, it } from "bun:test";
import { getClient } from "../../lib/oidc";

interface Document { id: string; title: string }
interface Comment { id: string; content: string }
interface Attachment { id: string; filename: string; mimetype: string; size: number }

describe("/api/documents/:id/comments/:cid/attachments", () => {
  it("upload → list → download → delete cycle", async () => {
    const author = await getClient("user@example.com");
    const doc = await author.json<{ data: Document }>("/api/documents", {
      method: "POST",
      body: { title: `doc-comment-attach ${Date.now()}`, content: "body" },
    });
    const docId = doc.data.id;
    const comment = await author.json<{ data: Comment }>(`/api/documents/${docId}/comments`, {
      method: "POST",
      body: { content: "see file" },
    });
    const cid = comment.data.id;

    const fd = new FormData();
    const payload = "doc-comment payload";
    fd.append("file", new File([payload], "ref.txt", { type: "text/plain" }));
    const upload = await author.raw(`/api/documents/${docId}/comments/${cid}/attachments`, {
      method: "POST",
      formData: fd,
    });
    expect(upload.status).toBe(201);
    const attId = (await upload.json() as { data: Attachment }).data.id;

    const list = await author.json<{ data: Attachment[] }>(`/api/documents/${docId}/comments/${cid}/attachments`);
    expect(list.data.find(a => a.id === attId)).toBeDefined();

    const dl = await author.raw(`/api/documents/${docId}/comments/${cid}/attachments/${attId}`);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe(payload);

    await author.raw(`/api/documents/${docId}/comments/${cid}/attachments/${attId}`, { method: "DELETE" });
    const after = await author.json<{ data: Attachment[] }>(`/api/documents/${docId}/comments/${cid}/attachments`);
    expect(after.data).toHaveLength(0);

    await author.raw(`/api/documents/${docId}`, { method: "DELETE" });
  });
});
