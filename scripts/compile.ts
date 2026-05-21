#!/usr/bin/env bun
/* eslint-disable no-console */
/**
 * Compile script: builds the frontend, generates an embedded-asset map,
 * embeds drizzle migrations, then compiles the backend into a single
 * standalone binary.
 *
 * Usage:  bun scripts/compile.ts [--target <bun-target>] [--outfile <name>] [--skip-frontend]
 *
 * Examples:
 *   bun scripts/compile.ts
 *   bun scripts/compile.ts --target bun-linux-x64 --outfile app-linux-x64
 *   bun scripts/compile.ts --skip-frontend
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { Glob } from "bun";

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp`;
  try {
    await Bun.write(tmp, content);
    renameSync(tmp, filePath);
  }
  catch (err) {
    try {
      unlinkSync(tmp);
    }
    catch {}
    throw err;
  }
}

const { values: args } = parseArgs({
  options: {
    "target": { type: "string" },
    "outfile": { type: "string" },
    "skip-frontend": { type: "boolean", default: false },
  },
  strict: false,
});

const ROOT = resolve(import.meta.dir, "..");
const OUT_DIR = resolve(ROOT, "dist");
const FRONTEND_DIST = resolve(ROOT, "apps/web/dist");
const DRIZZLE_DIR = resolve(ROOT, "apps/api/drizzle");

const STATIC_FILE = resolve(ROOT, "apps/api/src/shared/static-assets.ts");
const STATIC_BACKUP = `${STATIC_FILE}.bak`;
const MIGRATIONS_FILE = resolve(ROOT, "apps/api/src/db/embedded-migrations.ts");
const MIGRATIONS_BACKUP = `${MIGRATIONS_FILE}.bak`;

const target = (args.target as string | undefined) ?? null;

// URL prefix the SPA is mounted under. Mirrors apps/api/src/config.ts:
// unset / empty means root ("" — SPA at "/"); otherwise normalised to "/<x>".
const RE_SLASH_TRIM = /^\/+|\/+$/g;
const trimmedBase = (process.env.BASE_PATH ?? "").replace(RE_SLASH_TRIM, "");
const URL_PREFIX = trimmedBase ? `/${trimmedBase}` : "";

// Run a command and return stdout, swallowing any spawn error (e.g. the
// binary missing from $PATH inside a minimal Docker build stage where
// `.git` is excluded by `.dockerignore` and git itself isn't installed).
// We deliberately don't bubble the error: every caller has a fallback,
// and the script should compile even when git is unavailable.
function tryRun(cmd: readonly string[]): string {
  try {
    const result = Bun.spawnSync(cmd, { cwd: ROOT });
    return result.stdout.toString().trim();
  }
  catch {
    return "";
  }
}

// `BUILD_COMMIT` lets the Dockerfile inject the source revision via
// `--build-arg` — necessary because the production image excludes `.git`
// (see .dockerignore) and `git rev-parse` would return "unknown". When run
// outside the Docker build (local `bun run compile`, CI release), the env
// var is unset and we fall back to `git rev-parse`, finally to "unknown"
// when neither is available.
const envCommit = (process.env.BUILD_COMMIT ?? "").trim();
const commit = envCommit || tryRun(["git", "rev-parse", "--short", "HEAD"]) || "unknown";

// `BUILD_TIME` must be deterministic so the binary (and its SHA-256) is
// reproducible across builds of the same source. Mirrors the BUILD_COMMIT
// fallback chain: explicit env override (`BUILD_TIME`, or `SOURCE_DATE_EPOCH`
// per the reproducible-builds spec) → the git commit timestamp → wall clock
// only as a last resort when neither is available.
function resolveBuildTime(): string {
  const envBuildTime = (process.env.BUILD_TIME ?? "").trim();
  if (envBuildTime)
    return envBuildTime;

  const epoch = (process.env.SOURCE_DATE_EPOCH ?? "").trim();
  if (epoch && /^\d+$/.test(epoch)) {
    const seconds = Number.parseInt(epoch, 10);
    if (Number.isFinite(seconds))
      return new Date(seconds * 1000).toISOString();
  }

  const commitIso = tryRun(["git", "show", "-s", "--format=%cI", "HEAD"]);
  if (commitIso)
    return new Date(commitIso).toISOString();

  return new Date().toISOString();
}
const buildTime = resolveBuildTime();

// ---------- 0. Recover from interrupted previous run ----------
for (const tmp of [`${STATIC_FILE}.tmp`, `${MIGRATIONS_FILE}.tmp`]) {
  if (existsSync(tmp))
    unlinkSync(tmp);
}
if (existsSync(STATIC_BACKUP)) {
  console.warn("[compile] Found stale static backup — restoring");
  copyFileSync(STATIC_BACKUP, STATIC_FILE);
  unlinkSync(STATIC_BACKUP);
}
if (existsSync(MIGRATIONS_BACKUP)) {
  console.warn("[compile] Found stale migrations backup — restoring");
  copyFileSync(MIGRATIONS_BACKUP, MIGRATIONS_FILE);
  unlinkSync(MIGRATIONS_BACKUP);
}

// ---------- 1. Build frontend ----------
if (args["skip-frontend"]) {
  console.log("[compile] Skipping frontend build (--skip-frontend)");
}
else {
  console.log("[compile] Building frontend...");
  const vite = Bun.spawn(["bun", "run", "--filter", "@app/web", "build"], {
    cwd: ROOT,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const viteCode = await vite.exited;
  if (viteCode !== 0) {
    console.error("[compile] Frontend build failed");
    process.exit(1);
  }
}

// ---------- 2. Scan frontend dist files ----------
console.log("[compile] Scanning apps/web/dist...");
const glob = new Glob("**/*");
const frontendFiles: string[] = [];

for await (const entry of glob.scan({ cwd: FRONTEND_DIST, onlyFiles: true })) {
  frontendFiles.push(entry);
}
frontendFiles.sort();
console.log(`[compile] Found ${frontendFiles.length} frontend assets`);

// ---------- Helper: restore stub files ----------
function restoreStubFiles() {
  for (const [backup, original] of [[STATIC_BACKUP, STATIC_FILE], [MIGRATIONS_BACKUP, MIGRATIONS_FILE]]) {
    if (existsSync(backup)) {
      copyFileSync(backup, original);
      try {
        unlinkSync(backup);
      }
      catch {}
    }
  }
}

function signalHandler() {
  console.warn("\n[compile] Interrupted — restoring stub files");
  restoreStubFiles();
  process.exit(2);
}
process.on("SIGINT", signalHandler);
process.on("SIGTERM", signalHandler);

// ---------- Compute output path ----------
mkdirSync(OUT_DIR, { recursive: true });
const outfile = resolve(OUT_DIR, (args.outfile as string | undefined) ?? "app");

let buildCode = -1;

try {
  // ---------- 3. Generate static-assets.ts ----------
  copyFileSync(STATIC_FILE, STATIC_BACKUP);

  const imports: string[] = [];
  const entries: string[] = [];

  for (let i = 0; i < frontendFiles.length; i++) {
    const file = frontendFiles[i]!;
    const relPath = `../../../web/dist/${file}`;
    const urlPath = `${URL_PREFIX}/${file}`;
    imports.push(`import f${i} from ${JSON.stringify(relPath)} with { type: "file" }`);
    entries.push(`  [${JSON.stringify(urlPath)}, f${i}],`);
  }

  const staticCode = `// Auto-generated by scripts/compile.ts — do not edit
${imports.join("\n")}

export const staticAssets = new Map<string, string>([
${entries.join("\n")}
])
`;

  await atomicWrite(STATIC_FILE, staticCode);
  console.log(`[compile] Generated static-assets.ts (${frontendFiles.length} entries)`);

  // ---------- 4. Embed drizzle migrations ----------
  console.log("[compile] Embedding drizzle migrations...");
  copyFileSync(MIGRATIONS_FILE, MIGRATIONS_BACKUP);

  const migrationFiles: string[] = [];
  const migrationGlob = new Glob("**/*");
  for await (const entry of migrationGlob.scan({ cwd: DRIZZLE_DIR, onlyFiles: true })) {
    migrationFiles.push(entry);
  }
  migrationFiles.sort();

  const migrationEntries: string[] = [];
  for (const file of migrationFiles) {
    const content = readFileSync(resolve(DRIZZLE_DIR, file), "utf-8");
    migrationEntries.push(`  [${JSON.stringify(file)}, ${JSON.stringify(content)}],`);
  }

  const migrationsCode = `// Auto-generated by scripts/compile.ts — do not edit
export const embeddedMigrations = new Map<string, string>([
${migrationEntries.join("\n")}
])
`;

  await atomicWrite(MIGRATIONS_FILE, migrationsCode);
  console.log(`[compile] Generated embedded-migrations.ts (${migrationFiles.length} files)`);

  // ---------- 5. Compile to single binary ----------
  console.log(`[compile] Compiling binary...${target ? ` (target: ${target})` : ""}`);
  console.log(`[compile] Commit: ${commit}`);

  console.log(`[compile] Build time: ${buildTime}`);
  const pkgVersion = await Bun.file(resolve(ROOT, "apps/api/package.json")).json().then((p: { version?: string }) => p.version ?? "0.0.0").catch(() => "0.0.0");

  const compileArgs = [
    "bun",
    "build",
    "src/index.ts",
    "--compile",
    ...(target ? ["--target", target] : []),
    "--define",
    `BUILD_COMMIT=${JSON.stringify(commit)}`,
    "--define",
    `BUILD_TIME=${JSON.stringify(buildTime)}`,
    "--define",
    `BUILD_VERSION=${JSON.stringify(pkgVersion)}`,
    "--outfile",
    outfile,
  ];
  const build = Bun.spawn(compileArgs, {
    cwd: resolve(ROOT, "apps/api"),
    stdio: ["inherit", "inherit", "inherit"],
  });
  buildCode = await build.exited;
}
finally {
  restoreStubFiles();
  process.off("SIGINT", signalHandler);
  process.off("SIGTERM", signalHandler);
}

if (buildCode !== 0) {
  console.error("[compile] Binary compilation failed");
  process.exit(1);
}

console.log(`[compile] Done! Binary: ${outfile}`);
const fileStat = Bun.file(outfile);
console.log(`[compile] Size: ${(fileStat.size / 1024 / 1024).toFixed(1)} MB`);

// ---------- 6. SHA-256 checksum ----------
const hasher = new Bun.CryptoHasher("sha256");
const binaryData = await Bun.file(outfile).arrayBuffer();
hasher.update(new Uint8Array(binaryData));
const sha256 = hasher.digest("hex");
const checksumFile = resolve(OUT_DIR, "checksums.txt");
const binaryName = outfile.split("/").pop() ?? "app";
await atomicWrite(checksumFile, `${sha256}  ${binaryName}\n`);
console.log(`[compile] SHA-256: ${sha256}`);
