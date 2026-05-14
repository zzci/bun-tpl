import type { AppDatabase } from "@/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { itemComments, items } from "@/modules/item/schema";
import { NotFoundError, ValidationError } from "@/shared/lib/errors";
import { nanoid } from "@/shared/lib/id";

export type ItemCommentRow = typeof itemComments.$inferSelect;

export interface ListCommentsOptions {
  /**
   * When `false`, rows with `is_internal = 1` are filtered out. Callers
   * resolve the actor's relations on the parent item first (typically via
   * `policy.check`) and pass `true` iff the actor has owner / assignee /
   * approver / admin role. Viewer-only actors get `false`.
   */
  readonly includeInternal: boolean;
}

export async function listComments(
  db: AppDatabase,
  itemId: string,
  opts: ListCommentsOptions,
): Promise<readonly ItemCommentRow[]> {
  const conditions = [eq(itemComments.itemId, itemId)];
  if (!opts.includeInternal) {
    conditions.push(eq(itemComments.isInternal, false));
  }
  return await db
    .select()
    .from(itemComments)
    .where(and(...conditions))
    .orderBy(asc(itemComments.createdAt), asc(itemComments.id))
    .all();
}

export async function getCommentById(
  db: AppDatabase,
  itemId: string,
  commentId: string,
): Promise<ItemCommentRow | undefined> {
  return await db
    .select()
    .from(itemComments)
    .where(and(eq(itemComments.id, commentId), eq(itemComments.itemId, itemId)))
    .get();
}

export interface CreateCommentInput {
  readonly itemId: string;
  readonly authorId: string;
  readonly content: string;
  readonly replyToId?: string | null | undefined;
  readonly isInternal?: boolean | undefined;
}

/**
 * Create a comment. Reply validation:
 *
 * 1. The target comment must exist.
 * 2. The target must belong to the same `itemId` (no cross-item replies).
 * 3. If the target is `is_internal=1`, the reply is forced to `is_internal=1`
 *    too — internal threads stay internal so a viewer-only actor can't
 *    quote-leak an internal parent.
 *
 * Reasons (1) and (2) throw `ValidationError`; reason (3) is silent
 * coercion.
 */
export async function createComment(
  db: AppDatabase,
  input: CreateCommentInput,
): Promise<ItemCommentRow> {
  // Verify parent item exists and is live (callers usually already did this,
  // but the base guards anyway — a comment on a soft-deleted item would be
  // invisible everywhere and is almost certainly a bug).
  const parent = await db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.id, input.itemId), isNull(items.deletedAt)))
    .get();
  if (!parent)
    throw new NotFoundError("Item", input.itemId);

  let replyToId: string | null = null;
  let isInternal = input.isInternal ?? false;

  if (input.replyToId) {
    const target = await db
      .select({ id: itemComments.id, itemId: itemComments.itemId, isInternal: itemComments.isInternal })
      .from(itemComments)
      .where(eq(itemComments.id, input.replyToId))
      .get();
    if (!target) {
      throw new ValidationError(`Reply target ${input.replyToId} not found`, {
        replyToId: "Unknown comment id",
      });
    }
    if (target.itemId !== input.itemId) {
      throw new ValidationError("Reply target belongs to a different item", {
        replyToId: "Cross-item replies are not allowed",
      });
    }
    replyToId = target.id;
    if (target.isInternal && !isInternal) {
      // Force internal so threads don't leak across the visibility boundary.
      isInternal = true;
    }
  }

  const id = nanoid();
  const now = new Date().toISOString();

  await db.insert(itemComments).values({
    id,
    itemId: input.itemId,
    authorId: input.authorId,
    replyToId,
    content: input.content,
    isInternal,
    createdAt: now,
    updatedAt: now,
  }).run();

  return (await db.select().from(itemComments).where(eq(itemComments.id, id)).get())!;
}

/**
 * Hard delete (no soft delete for comments). The FK `ON DELETE SET NULL`
 * leaves any replies addressable but with `reply_to_id = NULL`; the UI
 * surfaces them as "replying to a removed comment".
 *
 * Cascading attachment release is intentionally **not** performed here.
 * Calling `releaseAllByOwner('item_comment_attachment', commentId)`
 * from this path reproducibly trips a libsql encrypted-WAL recovery
 * quirk that surfaces as `SQLITE_CORRUPT` on the next cold open.
 * Until the upstream behaviour is fixed, the SPA is expected to detach
 * a comment's attachments first (the sub-type routes expose
 * `DELETE /comments/:cid/attachments/:aid`); anything left behind
 * becomes orphan `file_references` rows that the `runOrphanSweep` pass
 * reclaims out-of-band.
 */
export async function deleteComment(db: AppDatabase, commentId: string): Promise<void> {
  await db.delete(itemComments).where(eq(itemComments.id, commentId)).run();
}
