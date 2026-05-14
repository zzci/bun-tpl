// NOTE: SQLite treats each NULL as distinct in UNIQUE constraints, so the
// idx_tuples_unique index does NOT prevent duplicate rows where subjectRelation
// is NULL. The app-level check (checkDuplicateTuple) guards against this.
import { index, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { users } from "@/modules/account/users/schema";

export const relationTuples = sqliteTable("relation_tuples", {
  id: text("id").primaryKey(),
  namespace: text("namespace").notNull(),
  objectId: text("object_id").notNull(),
  relation: text("relation").notNull(),
  subjectNamespace: text("subject_namespace").notNull(),
  subjectId: text("subject_id").notNull(),
  subjectRelation: text("subject_relation"),
  createdBy: text("created_by").references(() => users.id),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, t => [
  unique("idx_tuples_unique").on(t.namespace, t.objectId, t.relation, t.subjectNamespace, t.subjectId, t.subjectRelation),
  index("idx_tuples_object").on(t.namespace, t.objectId, t.relation),
  index("idx_tuples_subject").on(t.subjectNamespace, t.subjectId, t.subjectRelation),
]);
