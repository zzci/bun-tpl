# Documentation

A Bun monorepo template that ships an OAuth-backed full-stack workspace:
Hono API, React 19 SPA, SQLite via Drizzle, single-binary build.

The top-level [`../README.md`](../README.md) is the quick-start. This
directory holds the long-form documentation, organised into three buckets:

| Bucket | Audience | Contents |
|---|---|---|
| [`develop/`](develop/) | Template extender / fork owner | Deployment, ops runbook, fork lifecycle, and module-development docs (standards, playbook, recipe, cron-actions, policy-standard). |
| [`reference/`](reference/) | Anyone looking up a fact | HTTP API, env vars, database tables, flat per-route index. The latter two are auto-generated. |
| [`modules/`](modules/) | Anyone needing a module's behaviour | One page per shipped module — what it does, its routes, its tables, its config. |

Plus three top-level documents that don't belong in any of the buckets:

| Topic | File |
|---|---|
| Runtime shape, modules, request flow | [architecture.md](architecture.md) |
| Release / template changelog | [changelog.md](changelog.md) |
| This page | README.md |

## Quick links

**Setting up a fork** → [`develop/forking.md`](develop/forking.md)
**Adding a new module** → [`develop/module/`](develop/module/) (start with
`playbook.md`, reach for `standards.md` when you need the rationale)
**Deploying to production** → [`develop/deployment.md`](develop/deployment.md)
**Day-2 operations** → [`develop/operations.md`](develop/operations.md)
**HTTP surface** → [`reference/api.md`](reference/api.md)
**Env vars** → [`reference/env-reference.md`](reference/env-reference.md)
**Database** → [`reference/database.md`](reference/database.md)
**A specific module** → [`modules/`](modules/)
