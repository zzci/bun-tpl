# Examples

Reference deployments and operator-facing artefacts that ship with the
template. Pick the directory that matches your runtime and copy +
adjust — none of these are wired into the application code, they exist
only as starting points.

## `compose/`

Docker Compose stack with Caddy in front of the API and a bundled dex
IdP for OIDC. Run `cp .env.example .env`, rotate the example secrets
(`OAUTH_CLIENT_SECRET`, `DEFAULT_ADMIN`, etc. — production boots will
refuse to start otherwise), then `docker compose up`.

| File | Purpose |
|---|---|
| `compose.yml` | Main stack: API + Caddy + dex. |
| `Caddyfile` | Reverse proxy config; forwards `X-Forwarded-For`, redirects `/` → `/app/`. |
| `dex.yaml` | Static OIDC provider config — replace with a real IdP for production. |
| `backup-sidecar.yml` | Optional cron-backed JSON export sidecar with atomic `.partial → final` rename. |
| `.env.example` | Reference env values; pair with the rotation checklist at the top of the file. |

See [`docs/develop/deployment.md`](../docs/develop/deployment.md) for the production
deployment walkthrough and [`docs/develop/operations.md`](../docs/develop/operations.md)
for day-2 procedures (master-password rotation, restore from snapshot,
known issues).

## `logrotate.d/`

System `logrotate` drop-in for bare-metal deployments that write to
`LOG_FILE` rather than streaming to stdout. The `postrotate` hook
sends the API process `SIGHUP`; `apps/api/src/index.ts` re-opens the
log fd in place so the next write lands in the freshly-rotated file
without restarting the process.

| File | Purpose |
|---|---|
| `app` | Daily rotation, 14-day retention. Copy to `/etc/logrotate.d/<your-app>` and adjust the path / user / pid file to your install layout. |

Container deployments don't need this — keep `LOG_TO_STDOUT=true`
(the Dockerfile default) and let docker / journald / k8s handle log
retention.
