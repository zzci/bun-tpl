# Document Module

Document workspace with nested documents (Outline-style self-nesting),
attachments, comments, and policy-based sharing with parent-chain
inheritance. **Built on top of the [`item`](./item.md) base**: common
metadata (title / soft-delete / version / comments / attachments) lives
in the base; this module owns one detail table and the routes that
surface "documents" as a domain concept. Sharing and the parent edge are
expressed as policy tuples in the `item` namespace.

## File layout

```text
apps/api/src/modules/document/
  schema.ts            # document_details ONLY (no documents / shares / attachments / comments)
  document.service.ts  # composition over items + document_details + policy
  document.routes.ts   # /api/documents/...
  document.backup.ts   # backup contribution (document_details only)
  index.ts             # backup registration
  document.test.ts
```

## Database

| Table              | Purpose                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `document_details` | Per-document business fields keyed off `item_id` (1:1 with `items` rows where `type='document'`). Columns: `content`, `tags` (JSON array string), `parent_id` (self-FK through `items.id`), `comments_locked`. |

The **business hierarchy** lives in `document_details.parent_id` — what
the sidebar tree renders against. The **permission hierarchy** lives in
`relation_tuples` as `(item, X, parent_item, item, parent)` tuples — what
the policy engine walks for `viewer` / `editor` checks. Document service
writes both in the same transaction every time a document is created or
moved; neither derives the other.

What does **not** live in this module:

| Concern                                          | Where it lives                                                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `short_id`, `title`, `status`, `creator_id`, `version`, `deleted_at`, `updated_at` | `items` (the base). `items.id` is a ULID (timestamp prefix); `items.short_id` is the 8-char nanoid in URLs / payloads. |
| Sharing (`viewer` / `editor`, user or group)     | `relation_tuples` namespace `item`. The policy engine's `tuple_to_userset(parent_item, viewer/editor)` rule gives subtree inheritance for free. |
| Comments                                         | `item_comments` (flat reply model, `is_internal` flag — currently unused by document routes).                                                    |
| Attachments                                      | `file_references` rows with `owner_type='item_attachment'`, `owner_id=<items.id>`; bytes in `files` (via `mod-file`).                            |

## Routes

Mounted under `protectedRoutes`. All require `authRequired`.

| Method | Path                                          | Description                                                                                                                                            |
| ------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/documents`                              | Lists documents the caller can read (admin: all; user: creator + direct shares + inherited via `parent_item`). Filters: `q`, `tag`, `creator_id`.       |
| POST   | `/api/documents`                              | Create. Body accepts nullable `parentId` (the parent document's short_id; `null` for a root document).                                                  |
| GET    | `/api/documents/tree`                         | Returns every document the caller can read as `{ id, title, parentId, updatedAt, childCount }[]`. Siblings sorted case-insensitively by title.          |
| GET    | `/api/documents/tags`                         | All tags currently in use.                                                                                                                              |
| GET    | `/api/documents/users`                        | Active users (for the share UI).                                                                                                                        |
| GET    | `/api/documents/groups`                       | All groups (for the share UI).                                                                                                                          |
| GET    | `/api/documents/:id`                          | Detail (`:id` is the 8-char short id). Includes `version`.                                                                                              |
| PATCH  | `/api/documents/:id`                          | Update. Body **must** include `version`. Mismatch returns 409 with the current row. `parentId` change re-parents and rewrites the `parent_item` tuple.   |
| PATCH  | `/api/documents/:id/move`                     | Re-parent. Body: `{ parentId: short_id \| null }`. Validates target exists, caller can edit it, and the move would not introduce a cycle.               |
| DELETE | `/api/documents/:id`                          | **Soft delete** of the document and every descendant. Each `item_attachment` reference in the subtree is released so the async GC reclaims blobs.        |
| GET    | `/api/documents/:id/attachments`              | List attachments — `file_references` keyed on `(item_attachment, items.id)`.                                                                              |
| POST   | `/api/documents/:id/attachments`              | Upload — `FileService.uploadAndReference`. Editor permission required.                                                                                    |
| GET    | `/api/documents/:id/attachments/:aid`         | Download. `:aid` is `file_references.id`. `inline=true` opts into inline rendering for safe MIME types.                                                  |
| DELETE | `/api/documents/:id/attachments/:aid`         | Release the reference — async GC reclaims the blob when refcount drains.                                                                                  |
| GET    | `/api/documents/:id/comments`, `POST`, `DELETE /:cid`, and `/:cid/attachments[/:aid]` (CRUD) | Mounted by [`mountItemCommentRoutes`](./item.md#shared-comment--attachment-routes). Read requires viewer; post requires viewer **and** `!commentsLocked`. Comment-attachment upload is author-only. Max comment body 10000 chars. |
| GET    | `/api/documents/:id/shares`                   | List shares + inherited grants. Each row carries `inheritedFrom` (`null` for self, `{ id, title }` for inherited).                                       |
| POST   | `/api/documents/:id/shares`                   | Add share. Writes a `(item, X, viewer\|editor, user\|group, target)` policy tuple. Re-sharing the same target updates the role.                            |
| DELETE | `/api/documents/:id/shares/:shareId`          | Delete the share — `shareId` is the policy tuple id.                                                                                                     |

## Permissions

Effective permission resolution honours **parent-chain inheritance**:

1. **Self-creator** — `items.creator_id === user.id` ⇒ `editor`.
2. **Self-share** — `(item, X, viewer|editor, user|group, U)` tuple.
3. **Inherited share** — for each ancestor `D₁, D₂, …, root`, any share on that ancestor flows down via the `parent_item` tuple chain.
4. **Strongest wins** — `editor > viewer`. A child-level grant escalates an inherited permission; explicit deny is not supported.
5. **Admin** — `user.role === 'admin'` bypasses every check.

The walker is the `policy` module's `check()`. We do not maintain a
custom recursive CTE in document code — the `item` namespace's
`tuple_to_userset(parent_item, viewer/editor)` rules express the
inheritance, and the engine resolves it.

`listMyDocuments` / `getDocumentTreeForUser` need a *list* of visible
ids (not single checks), so they call `policy.listUserResources` for
direct grants and then walk `document_details.parent_id` to expand
descendants of each visible ancestor. The result mirrors what `check()`
would say row-by-row.

## Soft delete

`DELETE /documents/:id` stamps `items.deleted_at` on the document and
every descendant (walking the business `parent_id` chain), then drops
every `relation_tuples` row keyed off any of those items. Before that
it calls `FileService.releaseAllByOwner('item_attachment', ...)` for
each item so the async GC reclaims the blobs.

Hard delete is not exposed; a future retention janitor would prune items
past a configured age.

## Audit

`document.created`, `document.updated`, `document.deleted`,
`document.attachment_uploaded`, `document.attachment_deleted`,
`document.comment_added`, `document.comment_deleted`,
`document.comment_attachment_uploaded`, `document.comment_attachment_deleted`,
`document.share_added`, `document.share_removed`.

## Backup

`document_details` only. `items` / `item_comments` rows and the
`relation_tuples` carrying owner / share / `parent_item` come from the
`items` / `policies` contributions, which `document_details` depends on.

## Out of scope

- Cross-document linking (anchors, mentions).
- Search beyond LIKE-on-title. A future cross-module FTS task wires
  FTS5 virtual tables for `items.title` + `document_details.content`
  together.
