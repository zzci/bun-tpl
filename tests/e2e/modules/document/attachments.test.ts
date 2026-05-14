// Document attachment lifecycle (multipart upload, list, delete).
import { describe, expect, it } from "bun:test";
import { getClient } from "../../lib/oidc";

interface Document { id: string; title: string }
interface Attachment {
  id: string;
  filename: string;
  mimetype: string;
  size: number;
}

describe("/api/documents/:id/attachments", () => {
  it("upload + list + download + delete", async () => {
    const user = await getClient("user@example.com", "admin");

    const doc = await user.json<{ data: Document }>("/api/documents", {
      method: "POST",
      body: { title: "attach-target", content: "see attached" },
    });
    const docId = doc.data.id;

    const fd = new FormData();
    const payload = "doc attachment payload";
    fd.append("file", new File([payload], "spec.txt", { type: "text/plain" }));

    const upload = await user.raw(`/api/documents/${docId}/attachments`, {
      method: "POST",
      formData: fd,
    });
    expect(upload.status).toBe(201);
    const uploadBody = await upload.json() as { data: Attachment };
    const attId = uploadBody.data.id;

    const list = await user.json<{ data: Attachment[] }>(`/api/documents/${docId}/attachments`);
    expect(list.data.find(a => a.id === attId)).toBeDefined();

    const download = await user.raw(`/api/documents/${docId}/attachments/${attId}`);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe(payload);

    await user.raw(`/api/documents/${docId}/attachments/${attId}`, { method: "DELETE" });
    const after = await user.json<{ data: Attachment[] }>(`/api/documents/${docId}/attachments`);
    expect(after.data).toHaveLength(0);

    await user.raw(`/api/documents/${docId}`, { method: "DELETE" });
  });
});
