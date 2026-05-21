# Architecture

> Examples assume `BASE_PATH=/app`. The app is mounted at root (`/`) by default; set `BASE_PATH` to serve under a URL prefix.

This is a Bun monorepo template that provides an OAuth-backed internal workspace: account management, Zanzibar-style policy tuples, documents, issues, settings, audit logs, optional DB-at-rest encryption, and JSON backup.

This document describes the implemented architecture in the current codebase. Planned integrations should live in separate roadmap or planning documents, not in current-state architecture docs.

In examples below, `${BASE_PATH}` is the configured URL prefix. Empty by default — leave the placeholder as `""` when reading the routes for a root-mounted deploy.

## Runtime Shape

```text
Browser
  |
  | ${BASE_PATH}/*
  v
App server
  |
  | ${BASE_PATH}/api/*
  v
Hono API
  |
  +-- public routes (always on: /health, /encryption/status)
  +-- setup routes (locked-only: /encryption/init, /unlock, /unlock-challenge)
  +-- protected routes guarded by requireUnlocked (unlocked-only business + admin)
  +-- SQLite via Drizzle ORM
```

The outer app serves:

| Mount | Purpose |
|---|---|
| `/` | HTML meta refresh to `${BASE_PATH}/` when `BASE_PATH` is set. Skipped when the app is root-mounted — the SPA already owns `/`. |
| `${BASE_PATH}/api` | Hono API. |
| `${BASE_PATH}/*` | Embedded SPA assets when production assets are present. |

## Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Bun |
| API | Hono |
| Database | SQLite through Drizzle ORM |
| Web | React, Vite, TanStack Router, TanStack Query |
| Styling | Tailwind CSS |
| Build | `scripts/compile.ts` single-binary build |
| Authentication | External OAuth/OIDC provider with authorization code + PKCE |
| Authorization | Local Zanzibar-style relation tuples |

## Repository Layout

```text
apps/
  api/
    src/
      app.ts
      config.ts
      db/
      modules/
      routes/
      shared/
  web/
    src/
      app/
      shared/
packages/
  shared/      # ECIES utilities used by api and web
  tsconfig/    # shared tsconfig
scripts/
tests/
  e2e/         # live e2e harness (dex + API + every module)
docs/
```

## API Module Layout

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

| Module | Responsibility | Details |
|---|---|---|
| `account` | OAuth login, sessions, current user, users, groups, TOTP. | [account.md](modules/account.md) |
| `audit` | Persisted audit events + retention sweep. | [audit.md](modules/audit.md) |
| `backup` | JSON backup export and import (admin + service-token surfaces). | [backup.md](modules/backup.md) |
| `cron` | In-process job scheduler: cron-driven actions with run history. | [cron.md](modules/cron.md) |
| `document` | Documents, attachments, comments, shares; sub-type of `item`. | [document.md](modules/document.md) |
| `encryption` | DB-at-rest encryption setup, unlock, metadata, key rotation. | [encryption.md](modules/encryption.md) |
| `file` | Content-addressable blob storage with pluggable drivers and ref counting. | [file.md](modules/file.md) |
| `issue` | Issues, attachments, comments; sub-type of `item`. | [issue.md](modules/issue.md) |
| `item` | Base primitive for content sub-types (common metadata + comments + permission edges). | [item.md](modules/item.md) |
| `policy` | Zanzibar-style relation tuples, check, expand, resource groups. | [policy.md](modules/policy.md) |
| `settings` | Runtime key/value settings store. | [settings.md](modules/settings.md) |
| `system` | Health probes, build version, Prometheus metrics, upload limits. | [system.md](modules/system.md) |

## Request Flow

```text
Request
  -> request ID (+ propagation for outbound calls)
  -> CORS
  -> app context injection (db, config, logger, encryption)
  -> request logging
  -> CSRF guard
  -> policy middleware (auto-gates routes declared via defineResource.routes)
  -> route group
  -> requireUnlocked for protected routes
  -> authRequired where the module requires a session
  -> adminRequired where the module requires admin privileges
  -> handler
  -> shared error handler
```

## Authentication Flow

```text
Unauthenticated user
  -> GET /app/api/account/auth/login
  -> OAuth authorization endpoint
  -> GET /app/api/account/auth/callback
  -> token exchange with PKCE verifier
  -> local user create/update
  -> session cookie
  -> redirect back to requested page
```

Sessions are stored in SQLite. The browser stores only the HTTP-only session cookie.

### Session token storage

Each session row carries the upstream OAuth `access_token` and `refresh_token` as plain columns. Their protection at rest depends on `DB_ENCRYPTION`:

| `DB_ENCRYPTION` | At-rest protection for session tokens |
|---|---|
| `true` (recommended for production) | libsql encrypts the whole SQLite file with the DEK; rows are unreadable without the master key. |
| `false` (template default — dev convenience) | Tokens live as cleartext SQL strings in `app.db`. Anyone with read access to the file (filesystem, snapshot, leaked backup) gets the tokens. |

For deployments that disable encryption (e.g. local dev, or a single-tenant box where the file is already covered by full-disk encryption) this trade-off is acceptable. If sessions must be defensible even when an attacker can read `app.db`, run with `DB_ENCRYPTION=true` or wrap the columns at the application layer before persisting. Drizzle's `defaultFn` is a reasonable seam.

`DEFAULT_ADMIN` is the bootstrap input: whenever the user table contains no rows with `role=admin`, the next login matching the configured username or email is promoted. Non-admin users may sign up at any time without locking the bootstrap window — the gate is on admin presence, not on user-count zero.

OAuth/OIDC provider configuration is read from environment variables at runtime. The admin settings UI does not own these values, which prevents a bad database setting from breaking login.

## Authorization Model

The policy module stores relation tuples in `relation_tuples` and exposes check and expand operations. Admin users bypass policy checks where the route explicitly uses `adminRequired`.

Tuple example:

```text
document:abc123#viewer@group:dev-team#member
group:dev-team#member@user:user123
```

## Encryption Lifecycle

The app can start in a locked mode. Setup and unlock routes are available before the full protected app is mounted. After unlock, protected routes are mounted and guarded by `requireUnlocked`.

## Data Storage

Runtime data is stored below `ROOT_DIR`:

| Path | Purpose |
|---|---|
| `data/db/app.db` | SQLite database. |
| `data/db/app.pid` | PID lock file. |
| `data/logs/app.log` | Structured JSON logs. |

