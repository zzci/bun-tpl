# Changelog

Track changes your fork makes on top of this template. Format adapted from
[Keep a Changelog](https://keepachangelog.com/) — group entries under
**Added / Changed / Removed / Fixed / Security**. The `Unreleased` block
holds work since your last tag.

Upstream cuts versioned tags so forks can anchor diffs against a known
template version. The boundary entries below summarise what shipped in
each upstream tag; your fork's `Unreleased` block sits at the top.

## Unreleased

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
