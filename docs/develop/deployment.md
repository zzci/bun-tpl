# Deployment

> Examples assume `BASE_PATH=/app`. The app is mounted at root (`/`) by default; set `BASE_PATH` to serve under a URL prefix (e.g. behind a reverse-proxy mount).

The build target is a single Bun executable. Production typically pairs that with a reverse proxy and a persistent volume for the SQLite database and uploaded attachments.

## Build options

```bash
# Single binary (recommended for Linux servers)
bun run compile
# → dist/app  (~80–100 MB; SHA-256 written to dist/checksums.txt)

# Container image
docker build -t myapp .
```

The runtime layer uses `debian:stable-slim` by default — publicly pullable so forks `docker build` without an upstream credential dance. Override via `--build-arg RUNTIME_BASE=...` (e.g. distroless / a hardened internal base). The compiled binary embeds the frontend assets and Drizzle migrations so the runtime layer only needs glibc + the libsql native binding (already copied in) + `curl` for the HEALTHCHECK.

Inject the source revision via `--build-arg BUILD_COMMIT=$(git rev-parse --short HEAD)` so `app --version` and `/api/system/version` report the real hash — `.git` is excluded from the build context, so the build cannot resolve it on its own. CI / release pipelines should always set this.

## Required environment

The complete env reference (every variable, its type, default, and
description) is generated from the zod schema in `apps/api/src/config.ts`
and the comments in `.env.example`. See [`env-reference.md`](../reference/env-reference.md);
CI rejects PRs that leave it out of sync.

Highlights for a production deploy:

| Variable | Why |
|---|---|
| `APP_NAME`, `APP_DISPLAY_NAME` | Branding (see [`forking.md`](forking.md)) |
| `APP_URL` | Production redirect-URI base; forwarded headers are not trusted in prod |
| `CORS_ORIGIN` | Comma-separated allow-list; fail-closed in prod when unset |
| `BASE_PATH` | URL prefix the app is mounted under. Leave unset for root mount; set to the reverse-proxy mount (e.g. `/app`) when serving under a prefix |
| `DB_PATH`, `DB_ENCRYPTION` | Persistent volume for the DB; encryption defaults to off for dev — turn on in prod |
| `OAUTH_*` | OIDC issuer or full endpoint set, plus client id/secret |
| `DEFAULT_ADMIN` | Comma-separated emails that get admin role on first login (no-op if users exist) |
| `LOG_FILE` / `LOG_TO_STDOUT` | Either rotates on disk or hands lines to the runtime |
| `AUDIT_RETENTION_DAYS` | `0` (keep forever) by default; set to a finite value in long-running deployments to bound `audit_events` size |
| `SERVICE_TOKEN_METRICS`, `SERVICE_TOKEN_BACKUP` | Scoped bearers for `/api/metrics` and `/api/backup/export-via-token` |

## Volumes

The container declares `VOLUME /app/data`. Inside that volume the runtime writes:

| Path | Derived from | Holds | Backup priority |
|---|---|---|---|
| `${DB_PATH}` (default `${ROOT_DIR}/data/db/app.db`) | `DB_PATH` (or `ROOT_DIR` when unset) | `app.db`, `app.db-wal`, `app.db-shm`, `meta.db` | Critical |
| `${FILE_STORAGE_LOCAL_ROOT}` (default `${ROOT_DIR}/data/uploads/files/`) | `FILE_STORAGE_LOCAL_ROOT` (or `ROOT_DIR` when unset) | All attachments (documents, issues, …); content-addressable blobs under the `file` module | Critical |
| `${ROOT_DIR}/data/logs/` | `ROOT_DIR` (`LOG_FILE` may override the file path) | Runtime logs | Operational |

**Watch out — the upload and log paths are *not* re-rooted by `DB_PATH`.** Overriding `DB_PATH` to a path outside `ROOT_DIR` does **not** relocate `data/uploads/files/` or `data/logs/` — those continue to write under `${ROOT_DIR}/data/` unless you also set `FILE_STORAGE_LOCAL_ROOT` (or `LOG_FILE`). The two safe operating modes are:

1. **Recommended:** keep `ROOT_DIR=/app/data` (the Dockerfile default) and mount a single persistent volume at `/app/data`. The DB, uploads, and logs all land under it.
2. **Advanced:** if you must split the DB onto a separate disk, set `ROOT_DIR` to the directory you actually mounted **and** set `DB_PATH` to an absolute path on the other volume. Do not assume changing only `DB_PATH` is enough.

## Health checks

The API exposes two distinct probes:

- `GET /<base>/api/health` → `200 {status:"ok"}` whenever the process is alive. Use for **liveness** — restart-on-failure semantics.
- `GET /<base>/api/health/ready` → `200 {status:"ready"}` when the DB is unlocked **and** reachable; `503 {status:"locked"\|"no_db"\|"db_unavailable"}` otherwise. Use for **readiness** — load-balancer pool membership.
- `GET /<base>/api/encryption/status` is still available for richer debug info (returns `{initialized, locked, status, dbError}`) but should **not** be used as a probe — its 200 response doesn't imply ready.

Recommended Kubernetes / docker-compose probes:

```yaml
livenessProbe:
  httpGet:
    path: /app/api/health
    port: 3000
readinessProbe:
  httpGet:
    path: /app/api/health/ready
    port: 3000
  # 200 = ready (db unlocked + reachable); 503 = drain traffic
```

## Reference compose stack (local dev / smoke test)

`examples/compose/` holds a reference docker-compose stack — app + a bundled `dex` IdP + a Caddy proxy — meant for local-development and smoke-test use. It is **not** a production deployable: dex ships with hardcoded test users, the proxy terminates plain HTTP, and the app runs against a self-signed IdP issuer. Treat it as the starting point you adapt for production: real IdP, real TLS, real secrets store.

```bash
cd examples/compose
cp .env.example .env                # populate APP_NAME, secrets, APP_URL, etc.
docker compose up --build
```

Required env (in `.env` next to the compose file): `APP_NAME`, `APP_DISPLAY_NAME`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `APP_URL`. The bootstrap token gating `/api/encryption/init` is auto-generated at every boot and printed to stderr / written to `<data dir>/bootstrap-token.txt` while the system is in setup mode (no `meta.db` yet) — there is nothing to set in `.env`. Strip the `dex` service and replace it with your real IdP for any non-toy deploy.

## Reverse proxy

Mount the app at `BASE_PATH` and pass the host header. Caddy example:

```caddy
your-domain.com {
  reverse_proxy /app/* localhost:3000 {
    header_up Host {host}
    header_up X-Forwarded-Proto {scheme}
  }
  redir /app /app/  # trailing slash
}
```

Set `APP_URL=https://your-domain.com` in the app's env so OAuth callback URLs are stable.

### TLS via Caddy automatic HTTPS

For a public-internet deployment, Caddy will auto-issue a Let's Encrypt certificate when you give it a domain and a contact email:

```caddy
your-domain.com {
  tls you@example.com
  reverse_proxy /app/* app:3000 {
    header_up Host {host}
    header_up X-Forwarded-Proto {scheme}
    header_up X-Forwarded-For {remote_host}
  }
  redir /app /app/  # trailing slash
}
```

The reference `examples/compose/Caddyfile` ships with plain `:80` for local smoke-testing — replace the site block with the form above (and forward 80/443 from the host) before pointing it at a real domain.

## Trust Proxy

`TRUST_PROXY` controls whether the app reads `X-Forwarded-For` (and, as a
fallback, `X-Real-IP`) to determine the client IP used for rate limits,
lockouts, audit logs, and DEK challenge caps.

- **Default (`TRUST_PROXY=false`)** — the app uses the connection peer IP only. Safe everywhere; appropriate when the app is reachable directly or behind a single trusted proxy that does not need to attribute per-client IPs.
- **`TRUST_PROXY=true`** — the app honours the **rightmost** `X-Forwarded-For` entry (the hop closest to our process — the one set by the trusted proxy). `X-Real-IP` is read only when XFF is absent. Set this **only** when every request reaches the app through a proxy that **overwrites** both headers with the verified client IP.

### Mandatory proxy header rewrites

The proxy must **replace** any client-supplied `X-Forwarded-For` /
`X-Real-IP` so an attacker cannot forge a header to bypass per-IP gates.
Reference snippets:

**nginx**

```nginx
location / {
    proxy_pass http://app:3000;
    # `proxy_set_header` overwrites the value rather than appending.
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Host $host;
}
```

**Caddy** — `reverse_proxy` already overwrites these headers by default.

**Traefik** — set `forwardedHeaders.trustedIPs` to the load balancer
subnet and Traefik will drop client-supplied forwarding headers.

### `TRUSTED_PROXY_IPS` allow-list

Defence-in-depth against a misconfigured proxy: set
`TRUSTED_PROXY_IPS` to a comma-separated CIDR list of the immediate
peer addresses you accept forwarding headers from. Requests whose peer
IP is outside the list are still served, but their forwarding headers
are ignored (the connection peer IP is used). Empty (default) preserves
the pre-flag behaviour. Example:

```ini
TRUST_PROXY=true
TRUSTED_PROXY_IPS=10.0.0.0/8,172.16.0.0/12
```

> **Security warning.** If you set `TRUST_PROXY=true` while the API is also reachable directly (port exposed on the host, alternate ingress, etc.) without `TRUSTED_PROXY_IPS`, an attacker can spoof `X-Forwarded-For` to bypass per-IP rate limits and poison audit log attribution. Either keep the API exclusively behind the proxy (no direct exposure), set `TRUSTED_PROXY_IPS` to the proxy subnet, or leave `TRUST_PROXY` at the default.

## Production compose addendum

The reference stack under `examples/compose/` is local-dev grade. For a production deployment, layer the items below on top of it (or maintain a separate `compose.prod.yml`).

### Secrets

Treat the following env vars as secrets and inject them via your platform's secret manager rather than committing them in `.env`:

- `OAUTH_CLIENT_SECRET` — IdP client secret.
- `MASTER_PASSWORD_FILE` — path to a single-use file containing the master password for unattended unlock (see [`operations.md`](operations.md) § Sealed-file unlock). Mount via the platform's secret manager so the file appears at runtime, is read once, and is then deleted by the app. Avoid `MASTER_PASSWORD` in plain env vars — `docker inspect` and process listings expose it.
- `SERVICE_TOKEN_METRICS` / `SERVICE_TOKEN_BACKUP` — bearer tokens for scrape / sidecar callers. Each min 32 chars; rotate independently.

The encryption bootstrap token is **not** an env var — it is generated at every boot, surfaced via stderr and `<data dir>/bootstrap-token.txt`, and consumed once by the setup wizard. Pull it from container logs (`docker compose logs app | grep BOOTSTRAP_TOKEN`) or the on-disk file; both are removed on `/encryption/init` success.

In compose, prefer `secrets:` files over `environment:` for the values that *are* secrets, so they do not show up in `docker inspect`:

```yaml
services:
  app:
    secrets:
      - oauth_client_secret
    environment:
      OAUTH_CLIENT_SECRET_FILE: /run/secrets/oauth_client_secret

secrets:
  oauth_client_secret:
    file: ./secrets/oauth_client_secret
```

(Wire `*_FILE` reading into your entrypoint, or use Docker Swarm / Kubernetes which read secret files natively.)

### Resource limits and lifecycle

```yaml
services:
  app:
    restart: unless-stopped
    mem_limit: 512m
    cpus: "1.0"
    pids_limit: 256
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:3000/app/api/health"]
      interval: 30s
      timeout: 5s
      start_period: 15s
      retries: 3
    depends_on:
      dex:
        condition: service_healthy
```

Pair `restart: unless-stopped` with the in-image `HEALTHCHECK` and use `depends_on: condition: service_healthy` so the app starts only after dependent services pass their checks.

### Database snapshots

Run an at-least-hourly snapshot sidecar — either `litestream` for continuous replication, or a simple `sqlite3 .backup` cron container that writes to a snapshot volume. Example sidecar:

```yaml
services:
  db-snapshot:
    image: alpine:3
    restart: unless-stopped
    volumes:
      - app-data:/app/data:ro
      - app-snapshots:/snapshots
    entrypoint:
      - /bin/sh
      - -c
      - |
        apk add --no-cache sqlite tini
        while true; do
          ts=$(date -u +%Y%m%dT%H%M%SZ)
          sqlite3 /app/data/db/app.db ".backup '/snapshots/app-${ts}.db'"
          find /snapshots -name 'app-*.db' -mtime +7 -delete
          sleep 3600
        done
```

For anything past a single-tenant tool, prefer [litestream](https://litestream.io/) replicating to S3-compatible storage.

### Logs volume

Mount a separate volume for `${ROOT_DIR}/data/logs/` (or set `LOG_FILE` to a path on a dedicated volume) so log retention does not compete with DB snapshots for disk pressure.

## Logging

Two output modes are supported:

- **File (default)** — `LOG_FILE` controls the destination. Pino writes JSON lines. Rotate with logrotate or your platform's log shipper.
- **Stdout** — set `LOG_TO_STDOUT=true` to write JSON lines to stdout instead of a file. **Recommended for container deployments**: the orchestrator (Docker, Kubernetes) collects stdout, attaches metadata, and ships it onward — no rotate-on-disk required.

Logrotate snippet (for the `LOG_FILE` case). The API holds the log fd open
for its process lifetime; the `SIGHUP` handler in
[`apps/api/src/index.ts`](../../apps/api/src/index.ts) calls
`logger.reopen()` so logrotate's `postrotate` is the correct signal
(`copytruncate` would race with pino's async buffer and lose lines):

```
/app/data/logs/app.log {
  hourly
  rotate 168
  size 50M
  compress
  delaycompress
  missingok
  notifempty
  create 0600 app app
  postrotate
      pkill -SIGHUP -x app >/dev/null 2>&1 || true
  endscript
}
```

A ready-to-drop example lives at
[`examples/logrotate.d/app`](../../examples/logrotate.d/app); copy it into
`/etc/logrotate.d/app` and adjust paths/user if needed.

## Operations runbook

Day-2 procedures (master-password rotation, lost-password recovery, snapshot restore, audit-log investigation) live in [`operations.md`](operations.md). Bookmark it before you cut over to production.

## Backup & restore

### Database

The DB is a single SQLite file with WAL. Two viable strategies:

1. **`sqlite3 .backup`** — atomic, doesn't block writers. Run out-of-band via cron; pair with `gpg --encrypt` if the box doesn't host the master password.
2. **[litestream](https://litestream.io/)** — continuous WAL replication to S3-compatible storage. Recommended for anything past a single-tenant tool.

### Application-level export

The `/api/backup/export` admin endpoint produces a JSON dump of selected modules. It requires the master password to prove DEK ownership, and import is **schema-version-locked** — see "Upgrade" below.

### Uploaded files

`${FILE_STORAGE_LOCAL_ROOT}` (default `data/uploads/files/`) is plain filesystem storage. Snapshot it together with the DB; orphaned blobs will eventually be reclaimed by the cleanup job, but mismatched DB+disk states will produce dangling references.

## Upgrade playbook

SQLite migrations are embedded in the binary and run on boot. The risky cases:

| Change | Path |
|---|---|
| Add table / add nullable column | Drop in. Bring up new binary; migration auto-runs. |
| Add NOT NULL column with default | Same — defaults apply during migration. |
| Drop or rename column | Stop traffic, snapshot DB, deploy new binary. Drizzle's "create new table + copy + swap" runs at boot; verify size and row count after. |
| Major schema reshuffle | Use `/api/backup/export` (still on old binary), deploy new binary, `/api/backup/import` to a fresh DB. Skip in-place migration entirely. |

Always run a restore drill (export → import on a scratch DB) before a production upgrade — it's the only way to know the schema-version locked import path is still intact.

### Master-key rotation

`/api/encryption/rotate-dek` is marked **EXPERIMENTAL** and gated behind `ENABLE_EXPERIMENTAL_DEK_ROTATION` (default `false`). With the flag off the route returns **501 Not Implemented**. With the flag on it can still fail under busy WAL with the known `SQLITE_IOERR`; the e2e suite asserts the current 500/`ROTATE_FAILED` contract so a future fix is detected automatically. Until it lands, prefer `/api/encryption/change-master` (changes the master password / re-wraps the DEK without touching ciphertext).

## Disabling encryption

Setting `DB_ENCRYPTION=false` skips the locked/unlocked dance entirely — useful for staging or air-gapped boxes where the OS already encrypts the disk. Once turned off, do not flip back on against a populated DB without going through the export → fresh init → import path.
