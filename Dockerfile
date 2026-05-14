# Runtime base image. Declared at the top of the file (before any `FROM`)
# so the value is a *global* build argument and the runtime stage's
# `FROM ${RUNTIME_BASE}` can resolve it. A `ARG` declared inside a stage
# is local to that stage and cannot be referenced by a later `FROM`.
#
# Public default: `debian:stable-slim` ships with glibc (matches the
# build stage's `bun-linux-x64` target), `curl` is available for the
# HEALTHCHECK, and the image is publicly pullable so forks can `docker
# build` immediately without an upstream credential dance. Override via
# `--build-arg RUNTIME_BASE=...` if you ship a custom base.
ARG RUNTIME_BASE=debian:stable-slim

# ---- Build stage ----
# Tag-pinned (`oven/bun:1`) for ergonomics; release pipelines that
# require reproducible artefacts should override with a digest:
#   docker build --build-arg BUN_IMAGE=oven/bun:1@sha256:<digest> ...
# (and similarly for RUNTIME_BASE above).
ARG BUN_IMAGE=oven/bun:1
FROM ${BUN_IMAGE} AS build
WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json bun.lock bunfig.toml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/tsconfig/package.json packages/tsconfig/
RUN bun install --frozen-lockfile

# Inject the source revision so `app --version` and `/api/system/version`
# show the actual commit. `.git` is excluded by `.dockerignore` (smaller
# image, no leaked history), so `git rev-parse` inside the build is
# always "unknown" — pass the hash via:
#   docker build --build-arg BUILD_COMMIT=$(git rev-parse --short HEAD)
# CI / release pipelines should always set this.
ARG BUILD_COMMIT=unknown
ENV BUILD_COMMIT=${BUILD_COMMIT}

# Copy source and compile
COPY . .
RUN bun scripts/compile.ts --target bun-linux-x64 --outfile app

# Resolve the libsql native module path inside the bun-hoisted store and
# stage it under a deterministic location so the runtime stage can copy
# it without a wildcard. Fail loudly if multiple versions are present.
RUN set -e; \
  count="$(ls -d /app/node_modules/.bun/libsql@*/ 2>/dev/null | wc -l)"; \
  if [ "$count" != "1" ]; then \
    echo "Expected exactly one libsql install, found $count" >&2; \
    ls -d /app/node_modules/.bun/libsql@*/ >&2 || true; \
    exit 1; \
  fi; \
  src="$(ls -d /app/node_modules/.bun/libsql@*/)"; \
  mkdir -p /app/_libsql/@libsql; \
  cp -rL "$src/node_modules/@libsql/linux-x64-gnu" /app/_libsql/@libsql/linux-x64-gnu; \
  cp -rL "$src/node_modules/libsql" /app/_libsql/libsql

# ---- Runtime stage ----
# `RUNTIME_BASE` is declared at the top of this file as a global ARG;
# no in-stage redeclaration is needed (and would shadow the global one).
FROM ${RUNTIME_BASE}

# Runtime deps:
#   - tini   : PID 1 / signal forwarding + zombie reaping. The Bun-compiled
#              binary handles SIGTERM/SIGINT itself, but any subprocess a
#              cron action spawns (shell action, Bun.spawn) would otherwise
#              accumulate as zombies under the binary as PID 1.
#   - ca-certificates : outbound TLS (OIDC discovery, audit egress).
# 0.5 MB on top of the slim base. Drop the apt cache so the layer stays small.
#
# The HEALTHCHECK probe runs `./app healthcheck` (in-process fetch) so
# the runtime image does NOT need curl, which keeps the option to swap
# `RUNTIME_BASE` to a hardened distroless variant open.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Pre-create the app user + writable data dir, then drop privileges so the
# binary never runs as root. UID 1000 keeps the bind-mounted host volume
# usable from typical CI / dev shells without chown gymnastics.
RUN groupadd --system --gid 1000 app \
 && useradd --system --uid 1000 --gid app --no-create-home --shell /usr/sbin/nologin app \
 && mkdir -p /app/data \
 && chown -R app:app /app

WORKDIR /app
COPY --from=build --chown=app:app /app/dist/app ./app
RUN chmod +x ./app

# Native binding that bun --compile cannot embed. The build stage already
# resolved the bun-hoisted path under /app/_libsql so this COPY is
# wildcard-free and reproducible.
COPY --from=build --chown=app:app /app/_libsql/@libsql/linux-x64-gnu ./node_modules/@libsql/linux-x64-gnu
COPY --from=build --chown=app:app /app/_libsql/libsql ./node_modules/libsql

# Persist DB + uploaded attachments + logs across container recreation. Set
# DB_PATH / LOG_FILE / upload paths under /app/data; defaults already do.
VOLUME ["/app/data"]

EXPOSE 3000

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
# Containerised deploys hand stdout/stderr to the runtime (docker logs,
# k8s, journald). Default to stdout so logs survive container churn and
# `LOG_FILE` does not silently grow inside the image filesystem. Operators
# running on bare metal can still set LOG_TO_STDOUT=false to write to disk.
ENV LOG_TO_STDOUT=true
USER app

# In-process healthcheck via `./app healthcheck`. The subcommand reads
# `PORT` / `BASE_PATH` from the environment and probes `/api/health` on
# loopback — no curl required in the image. To probe readiness instead
# of liveness, override CMD with `./app healthcheck ready` (the
# subcommand treats the second positional as the path suffix).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["./app", "healthcheck"]

# Explicit so an orchestrator that overrides Docker's default (rare but
# legal) still sends the signal the app's shutdown handler expects.
STOPSIGNAL SIGTERM

# tini forwards SIGTERM/SIGINT to the app and reaps any zombies its
# subprocesses leave behind. `-g` sends the signal to the entire process
# group, so a shell-action child running in a pipeline also receives it.
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "./app"]
