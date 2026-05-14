#!/usr/bin/env bun
// One-shot rebrand helper. Rewrites .env defaults and every package.json
// (top-level + apps/* + packages/*). Optional --scope renames the @app/*
// package scope. Prints manual follow-ups it can't do safely (git remote,
// logo, lockfile regen).
//
// Usage:
//   bun scripts/rebrand.ts \
//     --name myapp --display "My App" \
//     [--scope myorg] [--repo https://github.com/myorg/myapp] \
//     [--description "Internal tools for myorg"] [--dry-run]
/* eslint-disable no-console */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { Glob } from "bun";

const { values: cli } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "name": { type: "string" },
    "display": { type: "string" },
    "scope": { type: "string" },
    "repo": { type: "string" },
    "description": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "help": { type: "boolean", default: false },
  },
  strict: true,
  allowPositionals: false,
});

if (cli.help || (!cli.name && !cli.display && !cli.scope && !cli.repo && !cli.description)) {
  console.log(
    "Usage: bun scripts/rebrand.ts --name <slug> --display \"<Display Name>\" "
    + "[--scope <packageScope>] [--repo <git-url>] [--description <text>] [--dry-run]",
  );
  process.exit(cli.help ? 0 : 1);
}

const APP_NAME = cli.name;
const APP_DISPLAY = cli.display;
const SCOPE = cli.scope?.replace(/^@/, "");
const REPO_URL = cli.repo;
const DESCRIPTION = cli.description;
const DRY_RUN = !!cli["dry-run"];

const RE_NAME = /^[a-z][a-z0-9-]*$/;
if (APP_NAME && !RE_NAME.test(APP_NAME)) {
  console.error(`--name must match /^[a-z][a-z0-9-]*/, got "${APP_NAME}"`);
  process.exit(1);
}
if (SCOPE && !RE_NAME.test(SCOPE)) {
  console.error(`--scope must match /^[a-z][a-z0-9-]*/, got "${SCOPE}"`);
  process.exit(1);
}

const ROOT = resolve(import.meta.dir, "..");

interface Change {
  readonly file: string;
  readonly note: string;
}
const changes: Change[] = [];

function write(file: string, content: string, note: string): void {
  const path = resolve(ROOT, file);
  if (DRY_RUN) {
    changes.push({ file, note: `[dry-run] ${note}` });
    return;
  }
  writeFileSync(path, content);
  changes.push({ file, note });
}

// ─── 1. .env.example + .env ───
function rewriteEnvFile(path: string): boolean {
  let text: string;
  try {
    text = readFileSync(resolve(ROOT, path), "utf-8");
  }
  catch {
    return false;
  }

  let next = text;
  if (APP_NAME !== undefined) {
    next = next.replace(/^#?\s*APP_NAME=.*$/m, `APP_NAME=${APP_NAME}`);
    if (!/^APP_NAME=/m.test(next))
      next += `\nAPP_NAME=${APP_NAME}\n`;

    // Bundled-dex IdP block (commented in .env.example, sometimes
    // uncommented in .env). Rewrite the four URLs / ids that mention
    // the literal `app` slug so a fresh fork pointing at the bundled
    // dex lands on `<name>.localhost` / `dex-<name>.localhost` instead
    // of the template's `app.localhost`. The values stay commented when
    // they started commented; uncommented in .env stay uncommented.
    next = next
      .replace(/dex-app\.localhost/g, `dex-${APP_NAME}.localhost`)
      .replace(/dex-app\.a\.wd\.ds\.cc/g, `dex-${APP_NAME}.a.wd.ds.cc`)
      .replace(/(\bhttp:\/\/)app\.localhost\b/g, `$1${APP_NAME}.localhost`)
      .replace(/(\bhttps:\/\/)app\.a\.wd\.ds\.cc\b/g, `$1${APP_NAME}.a.wd.ds.cc`)
      .replace(/^(#?\s*OAUTH_CLIENT_ID=)app$/m, `$1${APP_NAME}`)
      .replace(/^(#?\s*OAUTH_CLIENT_SECRET=)app-secret$/m, `$1${APP_NAME}-secret`);
  }
  if (APP_DISPLAY !== undefined) {
    next = next.replace(/^#?\s*APP_DISPLAY_NAME=.*$/m, `APP_DISPLAY_NAME=${APP_DISPLAY}`);
    if (!/^APP_DISPLAY_NAME=/m.test(next))
      next += `\nAPP_DISPLAY_NAME=${APP_DISPLAY}\n`;
  }
  if (next !== text)
    write(path, next, "set APP_NAME / APP_DISPLAY_NAME / dex block");
  return true;
}
rewriteEnvFile(".env.example");
rewriteEnvFile(".env");
rewriteEnvFile("examples/compose/.env.example");

// ─── 1b. examples/compose/compose.yml ───
// The reference docker-compose stack hardcodes the slug as the default
// for `${APP_NAME:-app}:local` image name. Rewriting the default keeps
// `docker compose up` ergonomic for a fresh fork even when the operator
// hasn't yet copied .env.example to .env. The other `${APP_NAME:-...}`
// usages flow from the same default so a single replacement suffices.
function rewriteComposeFile(): void {
  if (APP_NAME === undefined)
    return;
  const path = "examples/compose/compose.yml";
  let text: string;
  try {
    text = readFileSync(resolve(ROOT, path), "utf-8");
  }
  catch {
    return;
  }
  // Replace every `${VAR:-app}` default whose VAR is one of the
  // app-slug-bearing knobs. Restrict to the explicit list so we don't
  // accidentally touch unrelated `:-app` defaults that might appear in
  // future additions to the compose file.
  const next = text.replace(
    /\$\{(APP_NAME|APP_DISPLAY_NAME|OAUTH_CLIENT_ID|OAUTH_CLIENT_SECRET):-([^}]+)\}/g,
    (match, key: string, def: string) => {
      let nextDef = def;
      if (key === "APP_NAME" && def === "app")
        nextDef = APP_NAME;
      else if (key === "APP_DISPLAY_NAME" && def === "App" && APP_DISPLAY !== undefined)
        nextDef = APP_DISPLAY;
      else if (key === "OAUTH_CLIENT_ID" && def === "app")
        nextDef = APP_NAME;
      else if (key === "OAUTH_CLIENT_SECRET" && def === "app-secret")
        nextDef = `${APP_NAME}-secret`;
      return nextDef === def ? match : `\${${key}:-${nextDef}}`;
    },
  );
  if (next !== text)
    write(path, next, "rewrite compose APP_NAME / OAUTH_* defaults");
}
rewriteComposeFile();

// ─── 1c. Dockerfile ───
// Only rewrite ENV / LABEL / HEALTHCHECK lines whose literal value is
// `app` / `App` *as a slug*. Structural references — `WORKDIR /app`
// (filesystem path), `useradd app` (system user), `./app` (compiled
// binary name), `mkdir -p /app/...` (image-internal paths) — are NOT
// branding surfaces and stay untouched. The two slug-bearing spots are
// the `APP_NAME=app` / `APP_DISPLAY_NAME=App` ENV defaults a downstream
// fork may add to bake the slug into the image without relying on
// `docker run -e`; this rewriter handles them if present.
function rewriteDockerfile(): void {
  if (APP_NAME === undefined && APP_DISPLAY === undefined)
    return;
  const path = "Dockerfile";
  let text: string;
  try {
    text = readFileSync(resolve(ROOT, path), "utf-8");
  }
  catch {
    return;
  }
  let next = text;
  if (APP_NAME !== undefined) {
    // `ENV APP_NAME=app` — slug ENV default. Match only the exact slug
    // literal so a deployment that already customised it survives.
    next = next.replace(/^(ENV APP_NAME=)app$/m, `$1${APP_NAME}`);
  }
  if (APP_DISPLAY !== undefined) {
    next = next.replace(/^(ENV APP_DISPLAY_NAME=)App$/m, `$1${APP_DISPLAY}`);
    // OCI image title label — keep human-readable. Update in place if
    // present; do not synthesise a new one (Dockerfile shape stays the
    // operator's call).
    next = next.replace(
      /^(LABEL org\.opencontainers\.image\.title=)"App"$/m,
      `$1"${APP_DISPLAY}"`,
    );
  }
  if (next !== text)
    write(path, next, "rewrite APP_NAME / APP_DISPLAY_NAME ENV + OCI title label");
}
rewriteDockerfile();

// ─── 2. package.json files ───
const manifestGlobs = ["package.json", "apps/*/package.json", "packages/*/package.json"];
const manifests: string[] = [];
for (const pattern of manifestGlobs) {
  for await (const f of new Glob(pattern).scan({ cwd: ROOT, absolute: false }))
    manifests.push(f);
}

interface Manifest {
  name?: string;
  description?: string;
  homepage?: string;
  repository?: { type?: string; url?: string; directory?: string };
  [k: string]: unknown;
}

for (const rel of manifests) {
  const path = resolve(ROOT, rel);
  const raw = readFileSync(path, "utf-8");
  const json = JSON.parse(raw) as Manifest;
  const before = JSON.stringify(json);

  if (SCOPE && typeof json.name === "string" && json.name.startsWith("@app/"))
    json.name = json.name.replace(/^@app\//, `@${SCOPE}/`);
  if (SCOPE && json.name === "@app/monorepo")
    json.name = `@${SCOPE}/monorepo`;

  if (DESCRIPTION !== undefined && rel === "package.json")
    json.description = DESCRIPTION;

  if (REPO_URL !== undefined) {
    json.homepage = REPO_URL;
    json.repository = { type: "git", url: `${REPO_URL.replace(/\.git$/, "")}.git`, ...(json.repository?.directory ? { directory: json.repository.directory } : {}) };
  }

  if (JSON.stringify(json) !== before) {
    // Match prevailing 2-space indentation; preserve trailing newline.
    const out = `${JSON.stringify(json, null, 2)}\n`;
    write(rel, out, "rewrite name / homepage / repository.url");
  }
}

// ─── 3. Report ───
if (changes.length === 0) {
  console.log("[rebrand] nothing to do — all targeted surfaces already match the supplied values.");
}
else {
  console.log(`[rebrand] ${DRY_RUN ? "would update" : "updated"} ${changes.length} file(s):`);
  for (const { file, note } of changes)
    console.log(`  ${file}  — ${note}`);
}

console.log("\n[rebrand] manual follow-up:");
console.log("  - git remote set-url origin <your-fork-url>");
console.log("  - Replace apps/web/public/logo.svg with your logo");
console.log("  - Update the inline SVG in apps/web/src/shared/components/logo.tsx");
console.log("  - bun install   # regenerate bun.lock if the package scope changed");
console.log("  - bun run check # verify lint + typecheck + test + build still pass");
