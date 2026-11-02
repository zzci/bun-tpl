import type { Context } from "hono";
import { getPlatform } from "@/platform";

const RE_COMMA_SPLIT = /\s*,\s*/;
const RE_BAD_PEER = /^(?:unknown|::)$/i;

interface ClientIpConfig {
  readonly TRUST_PROXY: boolean;
  readonly TRUSTED_PROXY_IPS?: string;
  readonly NODE_ENV?: "development" | "production" | "test";
}

/**
 * Get the real client IP address from a Hono context.
 *
 * Default behaviour (`TRUST_PROXY=false`): forwarding headers are
 * IGNORED to prevent header-spoofing attacks; only the connection peer
 * IP is used: Bun's `c.env.IP.address`, or `CF-Connecting-IP` on
 * Cloudflare, which the edge always overwrites.
 *
 * When `TRUST_PROXY=true` the function resolves the client IP from forwarding
 * headers, in priority order: `CF-Connecting-IP` / `True-Client-IP` (Cloudflare's
 * real-visitor headers — authoritative behind a Cloudflare → proxy chain such
 * as Cloudflare → Traefik → app), then the rightmost entry of
 * `X-Forwarded-For` (the hop closest to our process), then `X-Real-IP` as a
 * last fallback. Cloudflare's headers win because XFF's rightmost entry is the
 * Cloudflare edge IP and `X-Real-IP` is the immediate upstream — neither is the
 * end user.
 *
 * If `TRUSTED_PROXY_IPS` is set (a comma-separated list of IPv4 or IPv6
 * CIDR / IP literals), forwarding headers are accepted only when the
 * immediate peer matches one of those ranges. When the
 * allow-list is empty (default), behaviour splits by environment: in
 * production forwarding headers are IGNORED and the socket peer IP is
 * used (fail closed — an exposed `TRUST_PROXY=true` must not let any
 * direct caller forge a client IP), while in dev/test they are honoured
 * from any peer so local proxy setups stay testable.
 */
export function getClientIp(c: Context, config: ClientIpConfig): string {
  // `c.env.IP.address` is Bun's connection peer. On Cloudflare Workers the
  // edge sets `CF-Connecting-IP` and overwrites any client-supplied value, so
  // it plays the same role there. Anywhere else nothing strips that header,
  // so it never stands in for the peer.
  const peerIp = c.env?.IP?.address
    ?? (getPlatform().name === "workers"
      ? c.req.header("cf-connecting-ip")
      : undefined);

  if (!config.TRUST_PROXY) {
    return peerIp ?? "unknown";
  }

  const proxyAllowList = parseProxyAllowList(config.TRUSTED_PROXY_IPS);

  // Fail closed in production: `TRUST_PROXY=true` with no usable allow-list
  // means any caller reaching the process directly could forge
  // `X-Forwarded-For` and defeat every IP-keyed limiter / spoof audit IPs.
  // Ignore forwarding headers entirely and use the socket peer IP. Dev/test
  // keep the permissive path so local proxy setups stay testable; the boot
  // warning (`isSpoofableProxyConfig`) flags the prod misconfiguration.
  if (config.NODE_ENV === "production" && proxyAllowList.length === 0) {
    return peerIp ?? "unknown";
  }

  // Per-peer gate: when the operator has supplied an allow-list,
  // forwarding headers from an unknown peer are dropped on the floor
  // (returns the peer itself). This stops a misconfigured `TRUST_PROXY`
  // (e.g. exposed to the open internet without a proxy in front of it)
  // from letting any caller forge a client IP. A peer that cannot be
  // resolved cannot be on the list either.
  if (proxyAllowList.length > 0 && (!peerIp || !isAllowedPeer(peerIp, proxyAllowList))) {
    return peerIp ?? "unknown";
  }

  const headers = c.req.header();
  const lowered: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    lowered[key.toLowerCase()] = value;
  }

  // Cloudflare sets `CF-Connecting-IP` (and, on Enterprise, `True-Client-IP`)
  // to the real visitor IP. Behind a Cloudflare → reverse-proxy chain
  // (e.g. Cloudflare → Traefik → app) this is the authoritative client IP:
  // XFF's right-most entry is the Cloudflare *edge* IP and `X-Real-IP` is the
  // immediate upstream, neither of which is the end user. Honoured only on
  // this trusted path (the peer was gated above), so a caller reaching the
  // process directly cannot forge it.
  for (const header of ["cf-connecting-ip", "true-client-ip"] as const) {
    const value = lowered[header]?.trim();
    if (value && !isSentinel(value))
      return value;
  }

  // Prefer XFF (right-most). The rightmost hop is the one our trusted
  // proxy actually controls; intermediate entries are client-supplied
  // and untrustworthy.
  const xff = lowered["x-forwarded-for"];
  if (xff && xff.trim()) {
    const parts = xff.split(RE_COMMA_SPLIT).map(s => s.trim()).filter(Boolean);
    const rightmost = parts.at(-1);
    if (rightmost && !isSentinel(rightmost))
      return rightmost;
  }

  const realIp = lowered["x-real-ip"];
  if (realIp && realIp.trim() && !isSentinel(realIp.trim())) {
    return realIp.trim();
  }

  return peerIp ?? "unknown";
}

/**
 * True when the runtime is in the spoofable configuration: forwarding
 * headers are trusted (`TRUST_PROXY=true`) but no proxy-peer allow-list
 * narrows *which* peers may set them. In this state any client that can
 * reach the process directly can forge its IP and defeat every IP-keyed
 * rate limiter. The app should log a startup warning when this is true
 * (it does not change request behaviour — kept for backward compat).
 */
export function isSpoofableProxyConfig(config?: ClientIpConfig): boolean {
  return Boolean(config?.TRUST_PROXY) && parseProxyAllowList(config?.TRUSTED_PROXY_IPS).length === 0;
}

function isSentinel(v: string): boolean {
  return RE_BAD_PEER.test(v);
}

// IP version tag so an IPv4 peer is never matched against an IPv6 range and
// vice versa (different bit widths share no comparable network space).
type IpVersion = 4 | 6;

interface ParsedIp {
  readonly version: IpVersion;
  readonly bits: bigint;
}

interface ParsedCidr {
  readonly version: IpVersion;
  readonly network: bigint;
  readonly mask: bigint;
}

function parseProxyAllowList(raw: string | undefined): readonly ParsedCidr[] {
  if (!raw)
    return [];
  const out: ParsedCidr[] = [];
  for (const part of raw.split(",").map(s => s.trim()).filter(Boolean)) {
    const parsed = parseCidr(part);
    if (parsed)
      out.push(parsed);
  }
  return out;
}

function parseCidr(entry: string): ParsedCidr | undefined {
  const slash = entry.indexOf("/");
  const ipStr = slash === -1
    ? entry
    : entry.slice(0, slash);
  const ip = parseIp(ipStr);
  if (!ip)
    return undefined;
  const width = ip.version === 4
    ? 32
    : 128;
  const prefix = slash === -1
    ? width
    : Number(entry.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > width)
    return undefined;
  // Top `prefix` bits set: full mask with the low (width - prefix) host bits
  // cleared. BigInt keeps this exact for the 128-bit IPv6 case.
  const full = (1n << BigInt(width)) - 1n;
  const host = (1n << BigInt(width - prefix)) - 1n;
  const mask = full ^ host;
  return { version: ip.version, network: ip.bits & mask, mask };
}

function parseIp(ip: string): ParsedIp | undefined {
  // A `:` marks an IPv6 literal (possibly with an IPv4-mapped tail / zone id).
  if (ip.includes(":"))
    return parseIpv6(ip);
  const bits = ipv4ToBits(ip);
  return bits === undefined
    ? undefined
    : { version: 4, bits };
}

function ipv4ToBits(ip: string): bigint | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4)
    return undefined;
  let acc = 0n;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255)
      return undefined;
    acc = (acc << 8n) | BigInt(n);
  }
  return acc;
}

function parseIpv6(input: string): ParsedIp | undefined {
  // Drop an optional zone id (`fe80::1%eth0`) — irrelevant to range matching.
  const pct = input.indexOf("%");
  const ip = pct === -1
    ? input
    : input.slice(0, pct);

  // `::` (one allowed) compresses a run of zero groups.
  const halves = ip.split("::");
  if (halves.length > 2)
    return undefined;

  const head = parseHextets(halves[0] ?? "");
  if (head === undefined)
    return undefined;
  let groups: number[];
  if (halves.length === 2) {
    const tail = parseHextets(halves[1] ?? "");
    if (tail === undefined)
      return undefined;
    const fill = 8 - head.length - tail.length;
    if (fill < 0)
      return undefined;
    groups = [
      ...head,
      ...Array.from<number>({ length: fill }).fill(0),
      ...tail,
    ];
  }
  else {
    groups = head;
  }
  if (groups.length !== 8)
    return undefined;

  let bits = 0n;
  for (const g of groups)
    bits = (bits << 16n) | BigInt(g);
  return { version: 6, bits };
}

// Parse one half of an IPv6 address into 16-bit groups. An embedded IPv4 tail
// (`::ffff:1.2.3.4`) expands to its two 16-bit halves. Empty segment → [].
function parseHextets(segment: string): number[] | undefined {
  if (segment === "")
    return [];
  const out: number[] = [];
  for (const g of segment.split(":")) {
    if (g.includes(".")) {
      const v4 = ipv4ToBits(g);
      if (v4 === undefined)
        return undefined;
      out.push(Number((v4 >> 16n) & 0xFFFFn), Number(v4 & 0xFFFFn));
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(g))
      return undefined;
    out.push(Number.parseInt(g, 16));
  }
  return out;
}

function isAllowedPeer(peer: string, allowList: readonly ParsedCidr[]): boolean {
  const ip = parseIp(peer);
  if (!ip)
    return false;
  for (const entry of allowList) {
    if (entry.version === ip.version && (ip.bits & entry.mask) === entry.network)
      return true;
  }
  return false;
}
