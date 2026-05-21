# API

> Examples below omit any `BASE_PATH` prefix. When `BASE_PATH=/app` is set,
> the API mounts under `/app/api/...`; with `BASE_PATH` unset (default)
> the API is at `/api/...`.

This document is the narrative API surface — request bodies, response
shapes, access rules. The flat per-route index is generated as
[`api-routes.md`](api-routes.md) (CI fails if it drifts from the Hono
routes table); the tables below are hand-maintained alongside it.

## Response shape

Most JSON endpoints return:

```json
{
  "success": true,
  "data": {}
}
```

Paginated endpoints add `meta`:

```json
{
  "success": true,
  "data": [],
  "meta": { "total": 0, "page": 1, "limit": 20 }
}
```

Errors use the shared error handler:

```json
{
  "success": false,
  "error": { "code": "NOT_FOUND", "message": "Resource not found" }
}
```

## Access levels

| Level         | Meaning                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| Public        | No session required.                                                                                      |
| Setup         | Available before the encrypted database is unlocked.                                                      |
| Authenticated | Requires a valid session cookie.                                                                          |
| Admin         | Requires a valid session and `user.role === "admin"`.                                                     |
| Service Token | Requires a scoped bearer (`SERVICE_TOKEN_METRICS` for `/api/metrics`, `SERVICE_TOKEN_BACKUP` for `/api/backup/export-via-token`). For non-interactive tooling (scrapers, backup). |

Every "Authenticated" / "Admin" route is mounted under `protectedRoutes`,
which itself wraps a `requireUnlocked` guard — they're unreachable until
the database is decrypted.

## System and setup

| Method | Path                                       | Access        | Description                                                                                                                            |
| ------ | ------------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`                              | Public        | **Liveness** probe. Always returns `200 {status:"ok"}`. Use this for `livenessProbe` / Docker `HEALTHCHECK`.                              |
| GET    | `/api/health/ready`                        | Public        | **Readiness** probe. Returns `200 {status:"ready"}` when the DB is unlocked and reachable; `503 {status:"locked"\|"no_db"\|"db_unavailable"}` otherwise. Use this for `readinessProbe` / load-balancer pool membership. |
| GET    | `/api/encryption/status`                   | Public        | Encryption init + lock state. Trimmed payload — no `kdfSalt` / `encryptedDek` / challenge leak.                                          |
| POST   | `/api/encryption/init`                     | Setup         | First-time encrypted database initialization. Gated by bootstrap token (single-use, written to `<data dir>/bootstrap-token.txt`).        |
| POST   | `/api/encryption/unlock-challenge`         | Public, rate-limited | Returns `{challenge, encryptedDek, kdfSalt}` — the bundle the SPA needs to perform an unlock attempt.                              |
| POST   | `/api/encryption/unlock`                   | Public, rate-limited | Unlocks the encrypted database with the challenge response.                                                                       |
| GET    | `/api/system/version`                      | Admin         | Build provenance (commit hash, build time). Same content as `app --version` in the standalone binary.                                    |
| GET    | `/api/system/upload-limits`                | Authenticated | `{ maxFileSize, maxAttachmentsPerResource, totalQuota }`. Frontend reads this to render client-side hints.                              |
| GET    | `/api/metrics`                             | Service Token | Prometheus text exposition. Returns 503 when `SERVICE_TOKEN_METRICS` is unset.                                                                   |

## Account

### Authentication

| Method | Path                                       | Access        | Description                                                       |
| ------ | ------------------------------------------ | ------------- | ----------------------------------------------------------------- |
| GET    | `/api/account/auth/mode`                   | Public        | Reports the active login mode (`oauth` or `single-user`) so the SPA picks the right form. |
| GET    | `/api/account/auth/login`                  | Public        | Starts OAuth login.                                                |
| GET    | `/api/account/auth/callback`               | Public        | Handles OAuth callback and creates a local session.                |
| POST   | `/api/account/auth/login-local`            | Public, rate-limited | Single-user login (`username` + `password`). Active only when `SINGLE_USER_MODE=true`. |
| POST   | `/api/account/auth/logout`                 | Authenticated | Deletes the local session.                                         |
| GET    | `/api/account/auth/logout-url`             | Public        | Returns the configured upstream logout URL.                         |
| POST   | `/api/account/auth/totp/verify`            | Public, rate-limited | Completes the login-time TOTP challenge.                    |

### Current user

| Method | Path                                                | Access        | Description                                                |
| ------ | --------------------------------------------------- | ------------- | ---------------------------------------------------------- |
| GET    | `/api/account/me`                                   | Authenticated | Current user profile with groups.                          |
| GET    | `/api/account/me/groups`                            | Authenticated | Current user's groups.                                     |
| GET    | `/api/account/me/preferences/:key`                  | Authenticated | Reads one current-user preference.                         |
| PUT    | `/api/account/me/preferences/:key`                  | Authenticated | Writes one current-user preference.                        |
| GET    | `/api/account/me/totp`                              | Authenticated | Lists current-user TOTP devices.                            |
| POST   | `/api/account/me/totp`                              | Authenticated | Creates a TOTP setup.                                      |
| POST   | `/api/account/me/totp/:deviceId/confirm`            | Authenticated, rate-limited | Confirms a newly created TOTP device.        |
| DELETE | `/api/account/me/totp/:deviceId`                    | Authenticated | Deletes a current-user TOTP device.                         |
| POST   | `/api/account/me/totp/verify`                       | Authenticated, rate-limited | Verifies a current-user TOTP code for step-up flows. |

### Users and groups

| Method | Path                                       | Access        | Description                                                                                            |
| ------ | ------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------ |
| GET    | `/api/account/visible-users`               | Authenticated | Active user directory exposed to every signed-in caller, for assignment and sharing pickers.            |
| GET    | `/api/account/users`                       | Admin         | Paginated user list.                                                                                    |
| GET    | `/api/account/users/:id`                   | Admin         | User detail.                                                                                            |
| PATCH  | `/api/account/users/:id`                   | Admin         | Updates role, status, or profile fields.                                                                |
| GET    | `/api/account/users/:id/groups`            | Admin         | Groups for a user.                                                                                      |
| GET    | `/api/account/groups`                      | Admin         | Group list.                                                                                             |
| POST   | `/api/account/groups`                      | Admin         | Creates a group.                                                                                        |
| GET    | `/api/account/groups/:id`                  | Admin         | Group detail.                                                                                           |
| PATCH  | `/api/account/groups/:id`                  | Admin         | Updates a group.                                                                                        |
| DELETE | `/api/account/groups/:id`                  | Admin         | Deletes a group.                                                                                        |
| GET    | `/api/account/groups/:id/members`          | Admin         | Group members.                                                                                          |
| POST   | `/api/account/groups/:id/members`          | Admin         | Adds a user to a group.                                                                                 |
| DELETE | `/api/account/groups/:id/members/:userId`  | Admin         | Removes a user from a group.                                                                            |

## Policy (Zanzibar tuples)

All policy routes are admin-only.

| Method | Path                                                            | Description                                                  |
| ------ | --------------------------------------------------------------- | ------------------------------------------------------------ |
| GET    | `/api/policy/tuples`                                            | Lists relation tuples.                                       |
| POST   | `/api/policy/tuples`                                            | Creates a relation tuple.                                    |
| PATCH  | `/api/policy/tuples/:id`                                        | Replaces a tuple's relation (delete + insert).                |
| DELETE | `/api/policy/tuples/:id`                                        | Deletes a relation tuple.                                    |
| POST   | `/api/policy/tuples/batch`                                      | Batch create + delete of relation tuples.                     |
| POST   | `/api/policy/check`                                             | Zanzibar permission check.                                   |
| POST   | `/api/policy/expand`                                            | Expand a relation tree.                                      |
| GET    | `/api/policy/users/:id/access`                                  | Relation tuples where the user is the subject.                |
| GET    | `/api/policy/groups/:id/access`                                 | Relation tuples where the group is the subject.               |
| GET    | `/api/policy/manifest`                                          | Permission manifest (resources, actions, namespaces) — drives the admin UI. |
| GET    | `/api/policy/entities`                                          | Lists users / groups / resource_groups for the policy UI.     |
| GET    | `/api/policy/resource-groups`                                   | Lists resource groups.                                       |
| POST   | `/api/policy/resource-groups`                                   | Creates a resource group.                                    |
| PATCH  | `/api/policy/resource-groups/:id`                               | Renames a resource group.                                    |
| DELETE | `/api/policy/resource-groups/:id`                               | Deletes a resource group.                                    |
| GET    | `/api/policy/resource-groups/:id/members`                       | Lists resource group members.                                |
| POST   | `/api/policy/resource-groups/:id/members`                       | Adds a resource group member.                                |
| DELETE | `/api/policy/resource-groups/:id/members/:tupleId`              | Removes a resource group member.                              |

## Items, files, and content sub-types

Items, the `file` module, and the two shipped sub-types (`issue` /
`document`) form one architectural layer. See [`modules/item.md`](../modules/item.md)
and [`modules/file.md`](../modules/file.md) for the design rationale; the
sub-type routes below are the public API surface.

### Documents

All document routes require authentication. `:id` is the document's
8-char short id.

| Method | Path                                          | Description                                                                                                            |
| ------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/documents`                              | Lists documents visible to the caller (admin: all; user: creator + direct shares + ancestor inheritance via `parent_item`). |
| POST   | `/api/documents`                              | Creates a document. Body accepts `parentId` for nesting.                                                                |
| GET    | `/api/documents/tree`                         | Flat `{ id, title, parentId, updatedAt, childCount }[]`, every visible document; siblings sorted by lowercased title.   |
| GET    | `/api/documents/tags`                         | All tags currently in use across documents.                                                                              |
| GET    | `/api/documents/users`                        | Active users for sharing UI.                                                                                            |
| GET    | `/api/documents/groups`                       | All groups for sharing UI.                                                                                              |
| GET    | `/api/documents/:id`                          | Document detail. Payload includes `version` (optimistic concurrency).                                                   |
| PATCH  | `/api/documents/:id`                          | Update. Body **must** include `version`; mismatch returns 409. Fields: `title`, `content`, `tags`, `parentId`, `commentsLocked`. |
| PATCH  | `/api/documents/:id/move`                     | Re-parent. Body: `{ parentId: short_id \| null }`. Validates target exists, caller can edit it, no cycle.                |
| DELETE | `/api/documents/:id`                          | **Soft delete** of the document and every descendant. Item-attachment references released — async GC reclaims blobs.    |
| GET    | `/api/documents/:id/attachments`              | List attachments (`{ id, filename, mimetype, size, ... }`).                                                              |
| POST   | `/api/documents/:id/attachments`              | Upload. Multipart `file=` field. Editor permission required.                                                             |
| GET    | `/api/documents/:id/attachments/:aid`         | Download. `?inline=true` opts into inline rendering for safe MIME types.                                                  |
| DELETE | `/api/documents/:id/attachments/:aid`         | Release the reference; async GC reclaims the blob when refcount drains.                                                  |
| GET    | `/api/documents/:id/comments`                 | List comments.                                                                                                          |
| POST   | `/api/documents/:id/comments`                 | Add comment. `replyToId` optional. Reply target must belong to the same document.                                        |
| DELETE | `/api/documents/:id/comments/:cid`            | Delete (author or admin). Replies stay readable (`reply_to_id` set NULL). **Detach attachments first** — this route does not cascade-release them.            |
| GET    | `/api/documents/:id/comments/:cid/attachments`            | List the comment's attachments.                                                                       |
| POST   | `/api/documents/:id/comments/:cid/attachments`            | Upload an attachment to the comment. Multipart `file=`. Author-only.                                  |
| GET    | `/api/documents/:id/comments/:cid/attachments/:aid`       | Download. `?inline=true` opts into inline rendering for safe MIME types.                              |
| DELETE | `/api/documents/:id/comments/:cid/attachments/:aid`       | Release the reference (uploader or admin). Async GC reclaims the blob.                                |
| GET    | `/api/documents/:id/shares`                   | List shares + inherited grants (each row carries `inheritedFrom`).                                                       |
| POST   | `/api/documents/:id/shares`                   | Add share. Writes a `(item, X, viewer\|editor, user\|group, target)` policy tuple. Re-sharing updates the role.            |
| DELETE | `/api/documents/:id/shares/:shareId`          | Delete the share — `shareId` is the policy tuple id.                                                                     |

### Issues

All issue routes require authentication. `:id` is the issue's 8-char short id.

| Method | Path                                          | Description                                                                                                |
| ------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| GET    | `/api/issues`                                 | Lists issues (admin: all; user: creator OR assignee). Filters: `q`, `status`, `priority`, `assignee_id`, `creator_id`. |
| POST   | `/api/issues`                                 | Create. Body: `{ title, description?, priority?, assigneeId?, dueDate? }`.                                  |
| GET    | `/api/issues/:id`                             | Detail.                                                                                                     |
| PATCH  | `/api/issues/:id`                             | Update. Assignees can only update `status`.                                                                  |
| DELETE | `/api/issues/:id`                             | **Soft delete** (sets `items.deleted_at`, clears policy tuples).                                              |
| GET    | `/api/issues/:id/attachments`                 | List attachments.                                                                                            |
| POST   | `/api/issues/:id/attachments`                 | Upload (multipart).                                                                                          |
| GET    | `/api/issues/:id/attachments/:aid`            | Download.                                                                                                    |
| DELETE | `/api/issues/:id/attachments/:aid`            | Release attachment reference.                                                                                |
| GET    | `/api/issues/:id/comments`                    | List comments.                                                                                              |
| POST   | `/api/issues/:id/comments`                    | Add comment.                                                                                                |
| DELETE | `/api/issues/:id/comments/:cid`               | Delete comment. **Detach attachments first** — this route does not cascade-release them.                     |
| GET    | `/api/issues/:id/comments/:cid/attachments`         | List the comment's attachments.                                                                  |
| POST   | `/api/issues/:id/comments/:cid/attachments`         | Upload an attachment to the comment. Multipart `file=`. Author-only.                              |
| GET    | `/api/issues/:id/comments/:cid/attachments/:aid`    | Download. `?inline=true` opts into inline rendering for safe MIME types.                           |
| DELETE | `/api/issues/:id/comments/:cid/attachments/:aid`    | Release the reference (uploader or admin). Async GC reclaims the blob.                            |

### Files (low-level)

Uploads are always issued through a parent resource route (e.g.
`POST /api/issues/:id/attachments`) — the consumer route owns the
permission boundary. The two endpoints below are the read surface for
content that has already been uploaded; both require a `ref=<reference id>`
query parameter so the registered permission hook can resolve the consumer
context. The active permission hook for `item_attachment` references
delegates to the `policy` engine.

| Method | Path                                       | Access        | Description                                                                                                |
| ------ | ------------------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------- |
| GET    | `/api/files/:id/metadata?ref=<refId>`      | Authenticated | `{ id, size, mimetype, filename, ownerType, ownerId, createdAt }` if the actor can read the reference's owner. |
| GET    | `/api/files/:id/content?ref=<refId>`       | Authenticated | Streams or 302-presigns. `inline=true` for inline-safe types. Presigning kicks in when the active driver supports it AND `FILE_PRESIGN_ENABLED=true`. |

## Settings

All settings routes require admin access.

| Method | Path                                       | Description                                              |
| ------ | ------------------------------------------ | -------------------------------------------------------- |
| GET    | `/api/settings`                            | Lists settings, with sensitive values masked.            |
| GET    | `/api/settings/:key`                       | Reads one setting.                                       |
| PUT    | `/api/settings/:key`                       | Creates or updates one setting.                          |
| DELETE | `/api/settings/:key`                       | Deletes one setting.                                     |

## Audit

All audit routes require admin access.

| Method | Path                                       | Description                                              |
| ------ | ------------------------------------------ | -------------------------------------------------------- |
| GET    | `/api/audit`                               | Lists audit events.                                      |
| GET    | `/api/audit/:id`                           | Audit event detail.                                      |

## Encryption administration

Admin-only after the full app is unlocked.

| Method | Path                                       | Description                                                                                          |
| ------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| POST   | `/api/encryption/challenge`                | Creates an ephemeral challenge for sensitive encryption operations.                                  |
| GET    | `/api/encryption/meta`                     | Returns encrypted key metadata for admins.                                                            |
| POST   | `/api/encryption/rotate-dek`               | Rotates the data encryption key. **Gated by `ENABLE_EXPERIMENTAL_DEK_ROTATION`** — returns 501 when off. |
| POST   | `/api/encryption/change-master`            | Changes the master public key.                                                                       |

## Backup

| Method | Path                                       | Access        | Description                                                                                            |
| ------ | ------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------ |
| GET    | `/api/backup/modules`                      | Admin         | Lists exportable backup modules (with `name` + `deps`).                                                  |
| POST   | `/api/backup/export`                       | Admin         | Exports selected modules as JSON.                                                                       |
| POST   | `/api/backup/export-via-token`             | Service Token | Same payload as `/backup/export`, gated by `SERVICE_TOKEN_BACKUP` instead of session — for backup tooling.       |
| POST   | `/api/backup/import`                       | Admin         | Imports a JSON backup file.                                                                             |

## Cron jobs

All cron routes require admin access. See [`modules/cron.md`](../modules/cron.md) for action registration, audit codes, and lifecycle.

| Method | Path                                       | Description                                                                                              |
| ------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| GET    | `/api/cron/actions`                        | Lists registered actions, supported cron formats, a human-readable help string, and `schedulerEnabled` (false when the API was started with `CRON_ENABLED=false` — admins can still write jobs; ticks are paused). |
| GET    | `/api/cron/jobs`                           | Cursor-paginated job list. `?deleted=true\|false\|only` toggles soft-deleted visibility; `?cursor` + `?limit` page. |
| POST   | `/api/cron/jobs`                           | Create. Body: `{ name, cron, action, config?, maxConsecutiveFailures? }`. `maxConsecutiveFailures` (integer 0..100, default 3) sets the per-job retry policy — see [`modules/cron.md` § Retry policy](../modules/cron.md#retry-policy). Errors: `INVALID_CRON` / `JOB_NAME_CONFLICT` / `INVALID_ACTION_CONFIG`. |
| DELETE | `/api/cron/jobs/:id`                       | Soft delete (sets `is_deleted=true`, `enabled=false`, detaches from Baker). `:id` accepts nanoid or `name`. |
| GET    | `/api/cron/jobs/:id/logs`                  | Cursor-paginated run history. `?status=running\|success\|failed` filters.                                |
| POST   | `/api/cron/jobs/:id/trigger`               | Manual run. Returns the freshly-written log row. Does not block on overlapping scheduled ticks — see [`modules/cron.md`](../modules/cron.md) for the rationale. |
| POST   | `/api/cron/jobs/:id/pause`                 | Disable: `enabled=false` + `baker.pause(...)`.                                                            |
| POST   | `/api/cron/jobs/:id/resume`                | Re-enable: `enabled=true` + `scheduler.syncJob(...)`.                                                     |

## Implemented module layout

```text
apps/api/src/modules/
  account/
    auth/
    users/
    groups/
  audit/
  backup/
  cron/
  document/        # sub-type of item
  encryption/
  file/            # blob storage; pluggable drivers + content dedupe
  issue/           # sub-type of item
  item/            # base for content sub-types
  policy/
  settings/
  system/
```
