import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * ROOT_DIR resolution:
 * 1. ROOT_DIR env var — explicit override
 * 2. Compiled binary (/$bunfs) — process.cwd()
 * 3. Otherwise — 3 levels up from this file to monorepo root
 */
function detectRootDir(): string {
  if (process.env.ROOT_DIR) {
    return resolve(process.env.ROOT_DIR);
  }

  // import.meta.url is always available (works in Bun, Node, Vite)
  const thisDir = dirname(fileURLToPath(import.meta.url));

  // Compiled binary: Bun virtual filesystem
  if (thisDir.startsWith("/$bunfs")) {
    return process.cwd();
  }

  // Dev or Vite: this file is at apps/api/src/root.ts → go up 3 levels
  return resolve(thisDir, "../../..");
}

export const ROOT_DIR = detectRootDir();
