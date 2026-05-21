# Database

The API uses SQLite through Drizzle ORM. Table definitions live in each
module's own `apps/api/src/modules/<name>/schema.ts`;
`apps/api/src/db/schema.ts` is a re-export aggregator only and contains
no table definitions.

The single baseline migration `apps/api/drizzle/0000_*.sql` reflects the
shipped schema. `bun run --filter @app/api db:generate` regenerates it
from the source-of-truth schema files.

## Conventions

| Topic           | Current behavior                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| Database        | SQLite (`libsql` driver, optional at-rest encryption)                                                            |
| ORM             | Drizzle ORM                                                                                                     |
| Time fields     | ISO 8601 strings (`text`)                                                                                       |
| Booleans        | SQLite integer booleans (Drizzle's `integer({ mode: "boolean" })`)                                              |
| ULIDs           | `items.id`, `files.id`, `audit_events.id` — 26-char Crockford base32 with millisecond timestamp prefix          |
| Nanoids         | `items.short_id`, `file_references.id`, `relation_tuples.id`, sub-type IDs — 8 chars from `[0-9a-z]`            |
| Soft delete     | `items.deleted_at` (NULL = live). Hard delete is a future janitor (retention policy).                            |

## Tables

### Account

#### `users`
Local account records created or updated from OAuth userinfo.

Key fields: `id`, `oauth_sub`, `username`, `name`, `email`, `avatar`,
`role`, `status`, `last_login_at`, `created_at`, `updated_at`.
Unique indexes on OAuth subject, username, email.

#### `groups`
Account groups used for membership and policy subjects.

Key fields: `id`, `name`, `description`, `created_at`, `updated_at`.

#### `sessions`
Server-side OAuth sessions.

Key fields: `id`, `user_id`, `access_token`, `refresh_token`,
`expires_at`, `created_at`, `updated_at`.

#### `pkce_challenges`
Temporary OAuth PKCE state. `state`, `code_verifier`, `redirect_uri`, `expires_at`.

#### `user_preferences`
Per-user key/value preferences. Primary key: `(user_id, key)`.

#### `user_totp_devices`
TOTP devices for users. `id`, `user_id`, `name`, `secret`, `verified`,
`last_used_timestep`, `created_at`.

#### `totp_challenges`
Login-time TOTP challenges. `id`, `user_id`, `access_token`,
`refresh_token`, `expires_in`, `redirect_uri`, `expires_at`.

#### `auth_lockouts`
Persisted per-key failure counter + lockout window. `key`, `failures`,
`locked_until` (epoch ms; NULL while tracking but not locked),
`updated_at`. Keyed by purpose: `single-user:<username-lower>` for
single-user login, `totp:<user-id>` for TOTP step-up. Persisted (not
in-memory) so brute-force counters survive restart and replicas.

### Audit

#### `audit_events`
Immutable audit log records.

`id`, `actor_id`, `actor_name`, `action`, `resource_type`, `resource_id`,
`resource_name`, `detail`, `ip`, `user_agent`, `result`, `created_at`.

`detail` is nullable (use when no structured payload makes sense); every
other column is `NOT NULL`.

### Cron

#### `cron_jobs`
Scheduler job definitions. Soft-delete via `is_deleted` so `cron_job_logs`
foreign keys remain valid for retention queries; the cron route layer
filters `is_deleted=false` by default.

| Column | Notes |
| --- | --- |
| `id` | **nanoid** (8 chars). |
| `name` | Required; unique via `idx_cron_jobs_name`. |
| `cron` | Normalised cron expression. See `apps/api/src/modules/cron/cron-format.ts` for the supported grammar. |
| `task_type` | Mirrors the registered action's `category` (e.g. `maintenance`, `network`, `system`, `custom`). Free-form text. |
| `task_config` | JSON text — `{ action: "<name>", ...action-specific }`. |
| `enabled` | Integer boolean. Toggled by pause / resume; flipped to `false` automatically after `max_consecutive_failures` consecutive failures. |
| `is_deleted` | Integer boolean. Soft-delete marker. |
| `max_consecutive_failures` | Integer, default `3`. Per-job auto-pause threshold (see [`modules/cron.md` § Retry policy](../modules/cron.md#retry-policy)). `0` disables auto-pause. |
| `created_at`, `updated_at` | ISO timestamps. |

Indexes: unique `(name)`, `(enabled)`.

#### `cron_job_logs`
One row per run. `id` is a ULID so monotonic ordering matches run
order. Cascade-deletes when the parent job is hard-deleted.

| Column | Notes |
| --- | --- |
| `id` | **ULID**. |
| `job_id` | FK → `cron_jobs.id ON DELETE CASCADE`. |
| `started_at` | ISO timestamp set when the run row is created. |
| `finished_at` | ISO timestamp set when the handler resolves / throws. NULL while the job is in `status="running"`. |
| `duration_ms` | Integer, set alongside `finished_at`. |
| `status` | `'running'` / `'success'` / `'failed'`. |
| `result` | Handler's return string on success. |
| `error` | Error message on failure. |

Indexes: `(job_id)`, `(job_id, started_at)`, `(status)`.

### Settings

#### `settings`
Runtime settings stored by key. `key`, `value`, `updated_by`, `updated_at`.

### Policy (Zanzibar)

#### `relation_tuples`
Zanzibar-style relation tuples — the **single source of truth for every
access relationship** in this codebase (issue assignee, document
viewer / editor, document parent edges, group membership, …).

`id`, `namespace`, `object_id`, `relation`, `subject_namespace`,
`subject_id`, `subject_relation`, `created_by`, `created_at`.

`subject_relation` and `created_by` are nullable (system-issued tuples
have no creator; userset-style tuples leave `subject_relation` empty).

Indexes: `(namespace, object_id, relation)`, `(subject_namespace,
subject_id, subject_relation)`, plus a unique composite on the full
six-tuple key. SQLite treats `NULL` as distinct in `UNIQUE` indexes,
so service code performs a defensive duplicate check before insert.

### Items (the content base)

#### `items`
Universal metadata for every content-style object (issue, document,
future ticket / purchase order / expense / …).

| Column        | Notes                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | **ULID** (26 chars). Timestamp prefix encodes the creation millisecond — sort `id DESC` for newest-first; no separate `created_at` column. |
| `short_id`    | **nanoid** (8 chars). Unique. The id surfaced in URLs / API payloads / audit `resource_id`.                                            |
| `type`        | Opaque sub-type discriminator (`'issue'`, `'document'`, …).                                                                                |
| `title`       | Required.                                                                                                                                |
| `status`      | Opaque text marker; sub-type defines allowed values.                                                                                       |
| `creator_id`  | FK → `users.id ON DELETE CASCADE`.                                                                                                       |
| `version`     | Integer, default 1. Optimistic-concurrency counter — bumped on every update.                                                              |
| `deleted_at`  | Soft-delete timestamp; NULL = live. Read paths must filter on this.                                                                       |
| `updated_at`  | ISO timestamp.                                                                                                                          |

Indexes: `(short_id)` unique, `(type, deleted_at)`, `(creator_id, deleted_at)`, `(type, status, deleted_at)`.

#### `item_comments`
Comments attached to any item, regardless of sub-type. Flat reply
model — a comment either replies to one other comment in the same item,
or is top-level.

| Column        | Notes                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | nanoid PK.                                                                                                                            |
| `item_id`     | FK → `items.id ON DELETE CASCADE`.                                                                                                    |
| `author_id`   | FK → `users.id ON DELETE CASCADE`.                                                                                                    |
| `reply_to_id` | FK → `item_comments.id ON DELETE SET NULL`. Single upward edge — no thread tree.                                                       |
| `content`     | Required text.                                                                                                                         |
| `is_internal` | Boolean; `1` = hidden from viewer-only actors. Replies inherit from their target so threads don't leak across the visibility boundary. |
| `created_at`, `updated_at` | ISO.                                                                                                                       |

### Files

#### `files`
Storage row per stored blob. Content-addressable: `UNIQUE(sha256,
storage_driver)` enables dedupe per backend.

| Column           | Notes                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `id`             | ULID PK.                                                                                                                    |
| `sha256`         | 64-char lowercase hex content key.                                                                                          |
| `size`           | Bytes.                                                                                                                      |
| `mimetype`       | Declared + magic-byte verified at upload.                                                                                    |
| `storage_driver` | `'local'`, `'s3'`, `'azure-blob'`, … (whatever drivers register).                                                            |
| `storage_key`    | Driver-internal address (local driver uses `<ab>/<cd>/<sha>`).                                                                |
| `ref_count`      | Materialised count of `file_references` rows. The async GC sweeper picks rows where `ref_count = 0` for collection.          |
| `uploaded_by`    | FK → `users.id ON DELETE CASCADE`. First uploader; informational only.                                                       |

Indexes: `UNIQUE(sha256, storage_driver)`, `(sha256)`, `(storage_driver)`, partial `(id) WHERE ref_count = 0` for the GC.

#### `file_references`
Reverse table. **Doubles as the attachment registry** for every
consumer — no separate `*_attachments` tables.

| Column        | Notes                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `id`          | nanoid PK. The id surfaced as the external attachment id in URLs.                                                     |
| `file_id`     | FK → `files.id ON DELETE RESTRICT`. Releases go through `FileService`, not raw cascade.                                |
| `owner_type`  | Discriminator: `'item_attachment'` (item-level), `'item_comment_attachment'` (per-comment), … one per consumer module. |
| `owner_id`    | Consumer-side primary key. For `item_attachment` → `items.id`; for `item_comment_attachment` → `item_comments.id`.    |
| `filename`    | Per-reference display filename.                                                                                       |
| `metadata`    | Opaque JSON ('{}' default).                                                                                           |
| `created_by`  | FK → `users.id`.                                                                                                      |
| `created_at`  | ISO.                                                                                                                  |

Indexes: `UNIQUE(owner_type, owner_id, file_id)` — same blob can only
appear once per owner; `(owner_type, owner_id)`, `(file_id)`.

### Content sub-types

#### `issue_details`
Issue-specific fields keyed off `item_id` (1:1 with `items` rows where
`type='issue'`).

| Column        | Notes                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| `item_id`     | PK + FK → `items.id ON DELETE CASCADE`.                                                                              |
| `description` | Long-text description; sub-type-specific (not in `items`).                                                            |
| `priority`    | Enum text: `'low' \| 'medium' \| 'high' \| 'urgent'`. Default `'medium'`.                                              |
| `due_date`    | Nullable ISO date string.                                                                                             |

There is **no `assignee_id` column**. The assignee relationship lives as
a `relation_tuples` row `(item, X, assignee, user, Y)` — single source of
truth across the codebase.

#### `document_details`
Document-specific fields keyed off `item_id`.

| Column            | Notes                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `item_id`         | PK + FK → `items.id ON DELETE CASCADE`.                                                                              |
| `content`         | Long text (≤ 50 000 chars enforced at zod boundary).                                                                  |
| `tags`            | JSON array string. Default `'[]'`.                                                                                    |
| `parent_id`       | Nullable self-FK to `items.id` via `documents → items` (`ON DELETE CASCADE`). **Business hierarchy column** — drives the sidebar tree. |
| `comments_locked` | Boolean. When 1, new comments are rejected.                                                                            |

The **permission edge** for the parent hierarchy is a separate
`relation_tuples` row `(item, X, parent_item, item, Y)` written /
rewritten in lockstep with `parent_id`. The two are read for two
different purposes; neither derives the other. Document sharing is also
expressed as policy tuples (`viewer` / `editor`), not as a dedicated
shares table.

## Schema scope

The current schema covers: accounts (users / groups / sessions / TOTP /
preferences / PKCE state / auth lockouts), audit, settings, Zanzibar
tuples, items + item comments, files + file references, and the two
sub-type detail tables (`issue_details`, `document_details`).

Group membership is **not** a dedicated table — it lives as
`relation_tuples` rows in the `group` namespace, queried via
`policy.listGroupMembersWithJoinedAt`.

A downstream project that needs additional content modules (tickets,
purchase orders, …) builds them on top of `item` — see
[`modules/item.md`](../modules/item.md) "Adding a sub-type" recipe.
