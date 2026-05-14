#!/usr/bin/env bun
/**
 * Clean all local temporary files, build artifacts, and caches.
 *
 * Usage:
 *   bun run clean          # standard clean
 *   bun run clean --all    # also remove node_modules, data/uploads, e2e cache
 */
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const args = new Set(process.argv.slice(2));
const all = args.has("--all");

const targets = [
  // Build output
  "dist",
  // Vite cache
  "apps/web/.vite",
  "apps/web/.tanstack",
  // Coverage
  "apps/api/coverage",
  // Turbo cache
  ".turbo",
  // PID lock
  "data/db/app.pid",
  // Logs
  "data/logs",
];

const allTargets = [
  // Node modules
  "node_modules",
  "apps/api/node_modules",
  "apps/web/node_modules",
  "packages/shared/node_modules",
  "packages/tsconfig/node_modules",
  // Test residue: per-test attachment trees and the e2e cache (run dirs +
  // dex binary + JUnit reports).
  "data/uploads",
  "tests/e2e/.cache",
];

let cleaned = 0;

for (const rel of targets) {
  const abs = resolve(ROOT, rel);
  if (existsSync(abs)) {
    rmSync(abs, { recursive: true, force: true });
    console.log(`  removed ${rel}`);
    cleaned++;
  }
}

if (all) {
  for (const rel of allTargets) {
    const abs = resolve(ROOT, rel);
    if (existsSync(abs)) {
      rmSync(abs, { recursive: true, force: true });
      console.log(`  removed ${rel}`);
      cleaned++;
    }
  }
}

if (cleaned === 0) {
  console.log("  nothing to clean");
}
else {
  console.log(`\n  cleaned ${cleaned} items`);
  if (all) {
    console.log("  run 'bun install' to restore dependencies");
  }
}
