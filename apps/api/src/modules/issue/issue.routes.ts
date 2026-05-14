import type { Context } from "hono";
import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "@/modules/audit/audit.service";
import {
  buildDownloadResponse,
  getFileById,
  getReferenceById,
  listAttachmentsByOwner,
  makeAttachmentView,
  releaseReference,
  uploadAndReference,
} from "@/modules/file";
import { mountItemCommentRoutes } from "@/modules/item/comment.routes";
import { getClientIp } from "@/shared/lib/client-ip";
import { AppError, ForbiddenError, NotFoundError } from "@/shared/lib/errors";
import { authRequired } from "@/shared/middleware/auth";
import {
  createIssue,
  getIssueByShortId,
  getUserById,
  listIssues,
  listMyIssues,
  resolveAccess,
  resolveIssueItem,
  softDeleteIssue,
  updateIssue,
} from "./issue.service";

const createSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(2000).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  assigneeId: z.string().min(1).optional(),
  dueDate: z.string().max(30).optional(),
});

const updateSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(2000).nullable().optional(),
  status: z.enum(["open", "in_progress", "done", "cancelled"]).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  assigneeId: z.string().min(1).nullable().optional(),
  dueDate: z.string().max(30).nullable().optional(),
}).refine(d => Object.values(d).some(v => v !== undefined), {
  message: "At least one field must be provided",
});

function auditMeta(c: Context) {
  return {
    ip: getClientIp(c),
    userAgent: c.req.header("user-agent") ?? "unknown",
  };
}

export function issueRoutes() {
  const router = new Hono<AppEnv>();
  router.use("*", authRequired);

  // ─── List ──────────────────────────────────────────────────────────
  router.get("/issues", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const q = c.req.query("q");
    const status = c.req.query("status");
    const priority = c.req.query("priority");
    const assigneeId = c.req.query("assignee_id");
    const creatorId = c.req.query("creator_id");
    const page = Math.max(1, Math.floor(Number.parseInt(c.req.query("page") ?? "", 10)) || 1);
    const limit = Math.min(100, Math.max(1, Math.floor(Number.parseInt(c.req.query("limit") ?? "", 10)) || 20));

    const isAdmin = user.role === "admin";
    const result = isAdmin
      ? await listIssues(db, { q, status, priority, assigneeId, creatorId, page, limit })
      : await listMyIssues(db, { userId: user.id, q, status, priority, page, limit });

    return c.json({
      success: true,
      data: result.data,
      meta: { total: result.total, page, limit },
    });
  });

  // ─── Create ────────────────────────────────────────────────────────
  router.post("/issues", async (c) => {
    const db = c.get("db");
    const body = createSchema.parse(await c.req.json());
    const actor = c.get("user")!;

    if (body.assigneeId) {
      const assignee = await getUserById(db, body.assigneeId);
      if (!assignee)
        throw new NotFoundError("User", body.assigneeId);
    }

    const issue = await createIssue(db, { ...body, creatorId: actor.id });

    await audit(db, c.get("logger"), {
      actorId: actor.id,
      actorName: actor.name,
      action: "issue.created",
      resourceType: "issue",
      resourceId: issue.id,
      resourceName: issue.title,
      ...(body.assigneeId ? { detail: { assigneeId: body.assigneeId } } : {}),
      ...auditMeta(c),
      result: "success",
    });

    if (body.assigneeId) {
      await audit(db, c.get("logger"), {
        actorId: actor.id,
        actorName: actor.name,
        action: "issue.assigned",
        resourceType: "issue",
        resourceId: issue.id,
        resourceName: issue.title,
        detail: { from: null, to: body.assigneeId },
        ...auditMeta(c),
        result: "success",
      });
    }

    return c.json({ success: true, data: issue }, 201);
  });

  // ─── Detail ────────────────────────────────────────────────────────
  router.get("/issues/:id", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const issue = await getIssueByShortId(db, id);
    if (!issue)
      throw new NotFoundError("Issue", id);
    if (user.role !== "admin" && issue.creatorId !== user.id && issue.assigneeId !== user.id) {
      throw new ForbiddenError();
    }
    return c.json({ success: true, data: issue });
  });

  // ─── Update ────────────────────────────────────────────────────────
  router.patch("/issues/:id", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const existing = await getIssueByShortId(db, id);
    if (!existing)
      throw new NotFoundError("Issue", id);

    const isAdmin = user.role === "admin";
    const isCreator = existing.creatorId === user.id;
    const isAssignee = existing.assigneeId === user.id;
    if (!isAdmin && !isCreator && !isAssignee) {
      throw new ForbiddenError();
    }

    const body = updateSchema.parse(await c.req.json());

    if (!isAdmin && !isCreator) {
      const nonStatusKeys = Object.keys(body).filter(k => k !== "status");
      if (nonStatusKeys.length > 0) {
        throw new AppError("Assignees can only update status", 403, "FORBIDDEN");
      }
    }

    if (body.assigneeId) {
      const assignee = await getUserById(db, body.assigneeId);
      if (!assignee)
        throw new NotFoundError("User", body.assigneeId);
    }

    const updated = await updateIssue(db, id, body);

    const detail: Record<string, unknown> = {};
    if (body.status && body.status !== existing.status) {
      detail.previousStatus = existing.status;
      detail.newStatus = body.status;
    }

    await audit(db, c.get("logger"), {
      actorId: user.id,
      actorName: user.name,
      action: "issue.updated",
      resourceType: "issue",
      resourceId: id,
      resourceName: existing.title,
      ...(Object.keys(detail).length > 0 ? { detail } : {}),
      ...auditMeta(c),
      result: "success",
    });

    if (body.status && body.status !== existing.status) {
      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "issue.status_changed",
        resourceType: "issue",
        resourceId: id,
        resourceName: existing.title,
        detail: { previous: existing.status, new: body.status },
        ...auditMeta(c),
        result: "success",
      });
    }

    if (body.assigneeId !== undefined && body.assigneeId !== existing.assigneeId) {
      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "issue.assigned",
        resourceType: "issue",
        resourceId: id,
        resourceName: existing.title,
        detail: { from: existing.assigneeId, to: body.assigneeId },
        ...auditMeta(c),
        result: "success",
      });
    }

    return c.json({ success: true, data: updated });
  });

  // ─── Delete (soft) ─────────────────────────────────────────────────
  router.delete("/issues/:id", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const existing = await getIssueByShortId(db, id);
    if (!existing)
      throw new NotFoundError("Issue", id);
    if (user.role !== "admin" && existing.creatorId !== user.id) {
      throw new ForbiddenError();
    }
    await softDeleteIssue(db, id);
    await audit(db, c.get("logger"), {
      actorId: user.id,
      actorName: user.name,
      action: "issue.deleted",
      resourceType: "issue",
      resourceId: id,
      resourceName: existing.title,
      ...auditMeta(c),
      result: "success",
    });
    return c.json({ success: true, data: null });
  });

  // ─── Attachments (delegating to mod-file) ─────────────────────────
  router.post("/issues/:id/attachments", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const issue = await getIssueByShortId(db, id);
    if (!issue)
      throw new NotFoundError("Issue", id);
    if (user.role !== "admin" && issue.creatorId !== user.id && issue.assigneeId !== user.id) {
      throw new ForbiddenError();
    }
    const item = await resolveIssueItem(db, id);
    if (!item)
      throw new NotFoundError("Issue", id);

    const config = c.get("config");
    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (contentLength > config.MAX_UPLOAD_BYTES) {
      throw new AppError("Upload too large", 413, "UPLOAD_TOO_LARGE");
    }

    const formData = await c.req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      throw new AppError("No file provided", 400, "VALIDATION_ERROR");
    }

    const { reference, file: uploaded } = await uploadAndReference(db, config, {
      file,
      ownerType: "item_attachment",
      ownerId: item.id,
      uploadedBy: user.id,
    });
    const view = makeAttachmentView(reference, uploaded);

    await audit(db, c.get("logger"), {
      actorId: user.id,
      actorName: user.name,
      action: "issue.attachment_uploaded",
      resourceType: "issue",
      resourceId: id,
      resourceName: issue.title,
      detail: { attachmentId: reference.id, filename: file.name, size: file.size },
      ...auditMeta(c),
      result: "success",
    });

    return c.json({ success: true, data: view }, 201);
  });

  router.get("/issues/:id/attachments", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const issue = await getIssueByShortId(db, id);
    if (!issue)
      throw new NotFoundError("Issue", id);
    if (user.role !== "admin" && issue.creatorId !== user.id && issue.assigneeId !== user.id) {
      throw new ForbiddenError();
    }
    const item = await resolveIssueItem(db, id);
    if (!item)
      throw new NotFoundError("Issue", id);
    const data = await listAttachmentsByOwner(db, "item_attachment", item.id);
    return c.json({ success: true, data });
  });

  router.get("/issues/:id/attachments/:aid", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const aid = c.req.param("aid");
    const issue = await getIssueByShortId(db, id);
    if (!issue)
      throw new NotFoundError("Issue", id);
    if (user.role !== "admin" && issue.creatorId !== user.id && issue.assigneeId !== user.id) {
      throw new ForbiddenError();
    }
    const item = await resolveIssueItem(db, id);
    if (!item)
      throw new NotFoundError("Issue", id);
    const ref = await getReferenceById(db, aid);
    if (!ref || ref.ownerType !== "item_attachment" || ref.ownerId !== item.id)
      throw new NotFoundError("Attachment", aid);
    const file = await getFileById(db, ref.fileId);
    if (!file)
      throw new NotFoundError("File", aid);
    const wantInline = c.req.query("inline") === "true";
    return await buildDownloadResponse(c.get("config"), file, ref, { inline: wantInline });
  });

  router.delete("/issues/:id/attachments/:aid", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const aid = c.req.param("aid");
    const issue = await getIssueByShortId(db, id);
    if (!issue)
      throw new NotFoundError("Issue", id);
    if (user.role !== "admin" && issue.creatorId !== user.id && issue.assigneeId !== user.id) {
      throw new ForbiddenError();
    }
    const item = await resolveIssueItem(db, id);
    if (!item)
      throw new NotFoundError("Issue", id);
    const ref = await getReferenceById(db, aid);
    if (!ref || ref.ownerType !== "item_attachment" || ref.ownerId !== item.id)
      throw new NotFoundError("Attachment", aid);
    if (user.role !== "admin" && issue.creatorId !== user.id && ref.createdBy !== user.id) {
      throw new ForbiddenError();
    }
    await releaseReference(db, c.get("config"), { referenceId: aid });
    await audit(db, c.get("logger"), {
      actorId: user.id,
      actorName: user.name,
      action: "issue.attachment_deleted",
      resourceType: "issue",
      resourceId: id,
      resourceName: issue.title,
      detail: { attachmentId: aid, filename: ref.filename },
      ...auditMeta(c),
      result: "success",
    });
    return c.json({ success: true, data: null });
  });
  // ─── Comments + attachments (delegated to mod-item) ───────────────
  mountItemCommentRoutes(router, {
    routePrefix: "/issues",
    resourceType: "issue",
    async resolve(db, idParam) {
      const issue = await getIssueByShortId(db, idParam);
      if (!issue)
        return null;
      const item = await resolveIssueItem(db, idParam);
      if (!item)
        return null;
      return { item, resource: issue, externalId: idParam, resourceName: issue.title };
    },
    async permissions(db, user, subject) {
      const access = await resolveAccess(db, subject.item, user.id);
      const isAdmin = user.role === "admin";
      const canAct = isAdmin || access.isCreator || access.isAssignee;
      return {
        canRead: canAct,
        canPost: canAct,
        includeInternal: isAdmin || access.isCreator || access.isAssignee,
        canDelete: authorId => isAdmin || authorId === user.id,
      };
    },
  });

  return router;
}
