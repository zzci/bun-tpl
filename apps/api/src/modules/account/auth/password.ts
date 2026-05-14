import { Buffer } from "node:buffer";
import { pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * Password hashing for SINGLE_USER_PASSWORD_HASH.
 *
 * `verifyPassword` auto-detects the format by prefix so operators can use
 * whatever tool they already have:
 *
 *   - `$2a$`, `$2b$`, `$2y$`  → bcrypt (htpasswd -B, Apache, nginx, ...)
 *   - `$argon2id$`            → argon2id (Bun.password.hash, argon2 CLI)
 *   - `pbkdf2-sha256$...`     → PBKDF2-HMAC-SHA256 (OpenSSL, Node crypto,
 *                               Python hashlib, ...)
 *
 * `hashPassword` produces the PBKDF2 form (no native dep, fully portable).
 * Stored shape: `pbkdf2-sha256$<iterations>$<saltB64>$<hashB64>`.
 */

const pbkdf2Async = promisify(pbkdf2);

// OWASP 2023+ baseline for PBKDF2-HMAC-SHA256.
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_KEY_BYTES = 32;
const PBKDF2_PREFIX = "pbkdf2-sha256";

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(PBKDF2_SALT_BYTES);
  const hash = await pbkdf2Async(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_BYTES, "sha256");
  return `${PBKDF2_PREFIX}$${PBKDF2_ITERATIONS}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

const RE_BCRYPT = /^\$2[aby]\$/;

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (stored.startsWith("$argon2") || RE_BCRYPT.test(stored)) {
    // Bun.password.verify auto-detects argon2{i,d,id} and bcrypt by prefix.
    try {
      return await Bun.password.verify(password, stored);
    }
    catch {
      return false;
    }
  }
  if (stored.startsWith(`${PBKDF2_PREFIX}$`)) {
    return await verifyPbkdf2(password, stored);
  }
  return false;
}

async function verifyPbkdf2(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4)
    return false;
  const [, itersRaw, saltB64, hashB64] = parts;
  const iters = Number(itersRaw);
  if (!Number.isInteger(iters) || iters < 1 || iters > 10_000_000)
    return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64!, "base64");
    expected = Buffer.from(hashB64!, "base64");
  }
  catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0)
    return false;

  let computed: Buffer;
  try {
    computed = await pbkdf2Async(password, salt, iters, expected.length, "sha256");
  }
  catch {
    return false;
  }
  if (computed.length !== expected.length)
    return false;
  return timingSafeEqual(computed, expected);
}
