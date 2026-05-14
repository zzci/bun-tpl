import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { items } from "@/modules/item/schema";

// `document` is a Tier-C sub-type of the `item` base. The base owns the
// universal columns (title / status / creator / version / soft-delete /
// timestamps) and the comments / attachments machinery; this table holds
// only the document-specific business fields.
//
// What lives in `items` (base, queried via ItemService):
//   - id, short_id, type='document', title, status, creator_id, version,
//     deleted_at, updated_at
//
// What does NOT live here on purpose:
//   - shares → policy tuples in namespace `item` with relations
//     `viewer` / `editor` (subjects: user or group). The policy engine's
//     `parent_item` tuple_to_userset rules give the subtree inheritance
//     for free, so we no longer maintain a `document_shares` table.
//   - comments → `item_comments`.
//   - attachments → `file_references` with owner_type='item_attachment',
//     owner_id=<items.id>.
//
// `parent_id` lives here as a **business** column (it drives the
// rendered sidebar tree, no permission semantics). The matching
// **permission** edge is a `(item, X, parent_item, item, Y)` tuple that
// the service writes/rewrites in lockstep with this column at the same
// transaction boundary as moves. The two are read for two purposes;
// neither derives the other.
export const documentDetails = sqliteTable("document_details", {
  itemId: text("item_id").primaryKey().references(() => items.id, { onDelete: "cascade" }),
  content: text("content"),
  tags: text("tags").notNull().default("[]"),
  parentId: text("parent_id").references((): AnySQLiteColumn => items.id, { onDelete: "cascade" }),
  commentsLocked: integer("comments_locked", { mode: "boolean" }).notNull().default(false),
}, t => [
  index("idx_document_details_parent").on(t.parentId),
]);
