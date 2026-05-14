import type { ActionExecutor } from "../types";
import { promises as dns } from "node:dns";
import { z } from "zod";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from "./spec";

// Validates the config persisted by the create-job route (already vetted
// by `validateActionConfig` against the action's `inputs[]`). Re-parsing
// at execute time catches a hand-edited DB row or a stale schema before
// the executor reaches `fetch`.
const httpRequestConfigSchema = z.object({
  url: z.string().min(1),
  method: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  timeoutMs: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).optional(),
  expectStatus: z.number().int().min(100).max(599).optional(),
}).passthrough();

type HttpRequestConfig = z.infer<typeof httpRequestConfigSchema>;

function parseConfig(config: Record<string, unknown>): HttpRequestConfig {
  return httpRequestConfigSchema.parse(config);
}

// Cap how much of the response body we read into the result string so
// a 100 MB endpoint can't blow up cron_job_logs.result. Body is only
// surfaced for debugging; status assertions use the prefix.
const MAX_BODY_PREVIEW_BYTES = 2048;

// IPv4 literal regex; captured groups are the four octets.
const RE_IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpLiteral(host: string): boolean {
  if (RE_IPV4.test(host))
    return true;
  // IPv6 literals always contain `:` (and `new URL().hostname` strips
  // the surrounding brackets).
  return host.includes(":");
}

/**
 * Reject loopback / private / link-local / unique-local destinations so a
 * compromised admin session cannot pivot from an `http-request` job into
 * cloud metadata (`169.254.169.254`) or internal services. Operators can
 * opt out per-deployment via `HTTP_ACTION_ALLOW_PRIVATE=true` for
 * legitimate sidecar pings.
 *
 * Hostnames that are not IP literals are not resolved here — DNS rebind
 * defence belongs in the network layer, not the application layer.
 */
export function isPrivateDestination(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "::" || host === "0.0.0.0")
    return true;
  const m = host.match(RE_IPV4);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if ([a, b, Number(m[3]), Number(m[4])].some(n => !Number.isFinite(n) || n < 0 || n > 255))
      return false;
    if (a === 10)
      return true;
    if (a === 127)
      return true;
    if (a === 169 && b === 254)
      return true;
    if (a === 172 && b >= 16 && b <= 31)
      return true;
    if (a === 192 && b === 168)
      return true;
    return false;
  }
  // IPv6 literals are enclosed in brackets in URLs, but `new URL().hostname`
  // strips them; the result still contains `:`. Reject the unique-local /
  // link-local prefixes by string match.
  if (host.includes(":")) {
    if (host.startsWith("fc") || host.startsWith("fd"))
      return true;
    if (host.startsWith("fe80:"))
      return true;
  }
  return false;
}

/**
 * Issue one HTTP request against the configured URL. The returned
 * status string lands in `cron_job_logs.result` (on success) or in the
 * thrown `Error.message` → `cron_job_logs.error` (on failure / wrong
 * status).
 *
 * Use cases: external health pings, webhook fan-out, third-party API
 * keep-alives. NOT a replacement for a real HTTP monitoring tool —
 * there's no retry, no backoff, and no SLO bookkeeping. Pair with the
 * audit + run-history surface for visibility.
 */
export const execute: ActionExecutor = async (ctx, config) => {
  const cfg = parseConfig(config);
  const method = (cfg.method ?? "GET").toUpperCase();
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const expectStatus = cfg.expectStatus;

  // SSRF gate. `ctx.config.HTTP_ACTION_ALLOW_PRIVATE` lets operators opt
  // out for legitimate sidecar / loopback pings; default-deny keeps a
  // compromised admin session from reaching the cloud metadata endpoint
  // or internal-only services.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(cfg.url);
  }
  catch {
    throw new Error(`invalid URL: ${cfg.url}`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`unsupported protocol: ${parsedUrl.protocol}`);
  }
  if (!ctx.config.HTTP_ACTION_ALLOW_PRIVATE) {
    if (isPrivateDestination(parsedUrl.hostname))
      throw new Error(`refused private destination ${parsedUrl.hostname} (set HTTP_ACTION_ALLOW_PRIVATE=true to allow)`);
    // Defence-in-depth against the obvious DNS-rebinding path: resolve
    // the hostname ourselves and refuse if any resolved address falls
    // inside a private range. A determined attacker who controls a
    // sub-second TTL can still race `fetch`'s own resolve; the audit
    // documents this and recommends a network-layer egress filter for
    // production. The DNS lookup also catches IPv6 link-local /
    // unique-local destinations that the hostname-literal check above
    // cannot.
    if (!isIpLiteral(parsedUrl.hostname)) {
      let addrs: readonly { address: string; family: number }[];
      try {
        addrs = await dns.lookup(parsedUrl.hostname, { all: true });
      }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`DNS lookup for ${parsedUrl.hostname} failed: ${msg}`);
      }
      for (const a of addrs) {
        if (isPrivateDestination(a.address))
          throw new Error(`refused destination ${parsedUrl.hostname} (resolves to private ${a.address}; set HTTP_ACTION_ALLOW_PRIVATE=true to allow)`);
      }
    }
  }

  const startedAt = Date.now();
  const init: RequestInit = {
    method,
    signal: AbortSignal.timeout(Math.min(timeoutMs, ctx.config.HTTP_ACTION_TIMEOUT_SECONDS * 1000)),
  };
  if (cfg.headers !== undefined)
    init.headers = cfg.headers;
  if (method !== "GET" && method !== "HEAD" && cfg.body !== undefined)
    init.body = cfg.body;
  let res: Response;
  try {
    res = await fetch(cfg.url, init);
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${method} ${cfg.url} failed: ${msg}`);
  }

  const durationMs = Date.now() - startedAt;
  let bodyPreview = "";
  try {
    const text = await res.text();
    bodyPreview = text.length > MAX_BODY_PREVIEW_BYTES
      ? `${text.slice(0, MAX_BODY_PREVIEW_BYTES)}…(${text.length - MAX_BODY_PREVIEW_BYTES} bytes truncated)`
      : text;
  }
  catch {
    // Body read failures aren't fatal — status is the primary signal.
  }

  const expected = expectStatus ?? null;
  const ok = expected === null ? res.ok : res.status === expected;
  if (!ok) {
    ctx.logger.warn(
      { url: cfg.url, method, status: res.status, durationMs, expected },
      "cron_http_request_unexpected_status",
    );
    throw new Error(
      `${method} ${cfg.url} → ${res.status} (expected ${expected ?? "2xx"}, ${durationMs}ms) body: ${bodyPreview}`,
    );
  }

  ctx.logger.debug(
    { url: cfg.url, method, status: res.status, durationMs },
    "cron_http_request_ok",
  );
  return `${method} ${cfg.url} → ${res.status} (${durationMs}ms)`;
};
