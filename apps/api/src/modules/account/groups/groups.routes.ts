import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { getUserById } from "@/modules/account/users/users.service";
import { audit } from "@/modules/audit/audit.service";
import { getClientIp } from "@/shared/lib/client-ip";
import { AppError, NotFoundError } from "@/shared/lib/errors";
import { adminRequired, authRequired } from "@/shared/middleware/auth";
import {
  addGroupMember,
  createGroup,
  deleteGroup,
  getGroupById,
  getGroupByName,
  getGroupMembers,
  listGroups,
  removeGroupMember,
  updateGroup,
} from "./groups.service";

const createGroupSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

const updateGroupSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
}).refine(d => d.name !== undefined || d.description !== undefined, {
  message: "At least one of name or description must be provided",
});

const addMemberSchema = z.object({
  userId: z.string().min(1),
});

export function groupRoutes() {
  const router = new Hono<AppEnv>();

  router.use("*", authRequired);

  // GET /groups — list all groups
  router.get("/account/groups", adminRequired, async (c) => {
    const db = c.get("db");
    const data = await listGroups(db);
    return c.json({ success: true, data });
  });

  // POST /groups — create group
  router.post("/account/groups", adminRequired, async (c) => {
    const db = c.get("db");
    const body = createGroupSchema.parse(await c.req.json());

    const existing = await getGroupByName(db, body.name);
    if (existing) {
      throw new AppError(`Group name "${body.name}" already exists`, 409, "CONFLICT");
    }

    const group = await createGroup(db, {
      name: body.name,
      ...body.description ? { description: body.description } : {},
    });
    const actor = c.get("user")!;
    await audit(db, c.get("logger"), {
      actorId: actor.id,
      actorName: actor.name,
      action: "group.created",
      resourceType: "group",
      resourceId: group.id,
      resourceName: group.name,
      ip: getClientIp(c),
      userAgent: c.req.header("user-agent") ?? "unknown",
      result: "success",
    });
    return c.json({ success: true, data: group }, 201);
  });

  // GET /groups/:id — group detail
  router.get("/account/groups/:id", adminRequired, async (c) => {
    const db = c.get("db");
    const group = await getGroupById(db, c.req.param("id"));
    if (!group) {
      throw new NotFoundError("Group", c.req.param("id"));
    }
    return c.json({ success: true, data: group });
  });

  // PATCH /groups/:id — update group
  router.patch("/account/groups/:id", adminRequired, async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    const existing = await getGroupById(db, id);
    if (!existing) {
      throw new NotFoundError("Group", id);
    }

    const body = updateGroupSchema.parse(await c.req.json());

    if (body.name && body.name !== existing.name) {
      const nameConflict = await getGroupByName(db, body.name);
      if (nameConflict) {
        throw new AppError(`Group name "${body.name}" already exists`, 409, "CONFLICT");
      }
    }

    const updated = await updateGroup(db, id, {
      ...body.name ? { name: body.name } : {},
      ...body.description !== undefined ? { description: body.description } : {},
    });
    const actor = c.get("user")!;
    await audit(db, c.get("logger"), {
      actorId: actor.id,
      actorName: actor.name,
      action: "group.updated",
      resourceType: "group",
      resourceId: id,
      resourceName: existing.name,
      ip: getClientIp(c),
      userAgent: c.req.header("user-agent") ?? "unknown",
      result: "success",
    });
    return c.json({ success: true, data: updated });
  });

  // DELETE /groups/:id — delete group
  router.delete("/account/groups/:id", adminRequired, async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    const existing = await getGroupById(db, id);
    if (!existing) {
      throw new NotFoundError("Group", id);
    }

    await deleteGroup(db, id);
    const actor = c.get("user")!;
    await audit(db, c.get("logger"), {
      actorId: actor.id,
      actorName: actor.name,
      action: "group.deleted",
      resourceType: "group",
      resourceId: id,
      resourceName: existing.name,
      ip: getClientIp(c),
      userAgent: c.req.header("user-agent") ?? "unknown",
      result: "success",
    });
    return c.json({ success: true, data: null });
  });

  // GET /groups/:id/members — member list
  router.get("/account/groups/:id/members", adminRequired, async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    const group = await getGroupById(db, id);
    if (!group) {
      throw new NotFoundError("Group", id);
    }

    const members = await getGroupMembers(db, id);
    return c.json({ success: true, data: members });
  });

  // POST /groups/:id/members — add member
  router.post("/account/groups/:id/members", adminRequired, async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    const group = await getGroupById(db, id);
    if (!group) {
      throw new NotFoundError("Group", id);
    }

    const body = addMemberSchema.parse(await c.req.json());
    const user = await getUserById(db, body.userId);
    if (!user) {
      throw new NotFoundError("User", body.userId);
    }

    const added = await addGroupMember(db, id, body.userId);
    if (!added) {
      throw new AppError("User is already a member of this group", 409, "CONFLICT");
    }

    const actor = c.get("user")!;
    await audit(db, c.get("logger"), {
      actorId: actor.id,
      actorName: actor.name,
      action: "group.member_added",
      resourceType: "group",
      resourceId: id,
      resourceName: group.name,
      detail: { userId: body.userId, userName: user.name },
      ip: getClientIp(c),
      userAgent: c.req.header("user-agent") ?? "unknown",
      result: "success",
    });
    return c.json({ success: true, data: null }, 201);
  });

  // DELETE /groups/:id/members/:userId — remove member
  router.delete("/account/groups/:id/members/:userId", adminRequired, async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const userId = c.req.param("userId");

    const group = await getGroupById(db, id);
    if (!group) {
      throw new NotFoundError("Group", id);
    }

    const removed = await removeGroupMember(db, id, userId);
    if (!removed) {
      throw new NotFoundError("Member", userId);
    }

    const actor = c.get("user")!;
    await audit(db, c.get("logger"), {
      actorId: actor.id,
      actorName: actor.name,
      action: "group.member_removed",
      resourceType: "group",
      resourceId: id,
      resourceName: group.name,
      detail: { userId },
      ip: getClientIp(c),
      userAgent: c.req.header("user-agent") ?? "unknown",
      result: "success",
    });
    return c.json({ success: true, data: null });
  });

  return router;
}
