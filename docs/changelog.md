# Changelog

Track changes your fork makes on top of this template. Format adapted from
[Keep a Changelog](https://keepachangelog.com/) — group entries under
**Added / Changed / Removed / Fixed / Security**. The `Unreleased` block
holds work since your last tag.

Upstream cuts versioned tags so forks can anchor diffs against a known
template version. The boundary entries below summarise what shipped in
each upstream tag; your fork's `Unreleased` block sits at the top.

## Unreleased

### Changed

- Replaced the single-binary build (`scripts/compile.ts`) with a
  [lode](https://github.com/dotns/lode)-compatible release asset
  (`scripts/package.ts`): a tarball of the bundled `index.js`, SPA `dist/`,
  Drizzle `drizzle/`, and the libsql native binding, plus `manifest.json`
  (schema `lode/v1`) and `checksums.txt`. The app serves the SPA and runs
  migrations from the filesystem (no embedded asset map), detects the packaged
  layout via `ROOT_DIR`, and implements the lode `state.json` readiness/prepare
  handshake; `/api/system/version` now reports a lode upgrade summary.
- `Dockerfile` / `docker-compose.yml` now run the lode supervisor (it downloads,
  verifies, runs, and auto-updates the release asset) instead of baking the app
  into the image. `deploy/lode.toml` is the operator config template.
- `release.yml` builds and uploads the lode asset to a published GitHub Release
  instead of pushing a container image.
- Group membership lives in a dedicated `group_members` table owned by the
  account module instead of `relation_tuples`. The Zanzibar engine reads
  `group:*#member` through `group-members.service` so a deployment can drop
  the policy module while keeping user-group features.
- `POST /api/policy/tuples` (and the batch endpoint) now refuse
  `group:*#member` writes; callers must use
  `POST /api/account/groups/:id/members`.

## v0.1.0 — 2026-05-14

First tagged template release. Subsequent forks should anchor their
`develop/forking.md` Part 2 (Tracking upstream) workflow against
`v0.1.0` or later.

### Added

- Bun monorepo skeleton (`apps/api`, `apps/web`, `packages/shared`,
  `packages/tsconfig`).
- Hono API with per-request DI (config / db / encryption / logger
  threaded through `c.var`).
- React 19 + TanStack Router web app with EN/ZH i18n and file-based
  routes.
- Shipped modules: `account/auth` (OAuth + TOTP), `account/users`,
  `policy` (Zanzibar tuples), `item` (base) + `file` / `document` /
  `issue` (sub-types), `cron`, `backup`, `audit`, `encryption`,
  `settings`, `system`.
- ECIES at-rest encryption with bootstrap-token, master-password
  derived keypair, and admin DEK challenge-response.
- Live e2e harness (dex + API + every module).
- Single-binary build via `scripts/compile.ts`.
- `scripts/rebrand.ts` rewrites manifests + `.env` defaults for forks.
- Doc-drift safeguards: `check:i18n` / `check:env-docs` /
  `check:api-docs`.
- `.github/workflows/ci.yml` + `release.yml`.

### Security

- Sentinel guards refuse production boot with example
  `OAUTH_CLIENT_SECRET=app-secret`, `OAUTH_CLIENT_ID=app`,
  `DEFAULT_ADMIN=admin@example.com`.
- `SERVICE_TOKEN` split into `SERVICE_TOKEN_METRICS` /
  `SERVICE_TOKEN_BACKUP` (independently rotatable).
- CSRF middleware (XHR header + Origin/Referer match), `__Secure-`-
  prefixed session cookies, PKCE + state binding for OAuth.

### Known issues

Tracked separately (lockout persistence, cookie scope vs `BASE_PATH`,
DNS-rebinding guard on the `http-request` cron action, …).
