import type { Context } from "hono";
import { afterEach, describe, expect, test } from "bun:test";
import { __resetPlatformForTests, getPlatform, setPlatform } from "@/platform";
import { getClientIp, isSpoofableProxyConfig } from "./client-ip";

afterEach(() => __resetPlatformForTests());

/** Run under the Workers adapter, where the edge owns CF-Connecting-IP. */
function onWorkers(): void {
  setPlatform({
    ...getPlatform(),
    name: "workers",
  });
}

function ctx(headers: Record<string, string | undefined>, env?: Record<string, unknown>): Context {
  return {
    req: {
      // Mirrors Hono: no argument returns every header, a name returns that
      // one. Several call sites read a single header by name.
      header: (name?: string) => (name === undefined
        ? headers
        : headers[name.toLowerCase()]),
    },
    env,
  } as unknown as Context;
}

describe("getClientIp (default — TRUST_PROXY=false)", () => {
  const cfg = { TRUST_PROXY: false } as const;

  test("ignores X-Forwarded-For", () => {
    expect(
      getClientIp(
        ctx({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" }, {
          IP: { address: "127.0.0.1" },
        }),
        cfg,
      ),
    ).toBe("127.0.0.1");
  });

  test("ignores CF-Connecting-IP", () => {
    expect(
      getClientIp(
        ctx({ "cf-connecting-ip": "198.51.100.7" }, {
          IP: { address: "10.0.0.5" },
        }),
        cfg,
      ),
    ).toBe("10.0.0.5");
  });

  test("ignores True-Client-IP and X-Real-IP", () => {
    expect(
      getClientIp(
        ctx(
          { "true-client-ip": "198.51.100.42", "x-real-ip": "198.51.100.99" },
          {
            IP: { address: "192.0.2.42" },
          },
        ),
        cfg,
      ),
    ).toBe("192.0.2.42");
  });

  test("uses connection peer IP from c.env.IP.address", () => {
    expect(getClientIp(ctx({}, {
      IP: { address: "127.0.0.1" },
    }), cfg)).toBe("127.0.0.1");
  });

  test("returns 'unknown' when neither headers nor peer IP are available", () => {
    expect(getClientIp(ctx({}, {}), cfg)).toBe("unknown");
  });

  test("falls back to CF-Connecting-IP on Workers, which exposes no socket", () => {
    onWorkers();
    expect(getClientIp(ctx({ "cf-connecting-ip": "198.51.100.7" }, {}), cfg)).toBe("198.51.100.7");
  });

  test("ignores CF-Connecting-IP on Bun even when the socket peer is missing", () => {
    // Off Cloudflare nothing strips a client-supplied CF-Connecting-IP, so it
    // must never stand in for the peer.
    expect(getClientIp(ctx({ "cf-connecting-ip": "198.51.100.7" }, {}), cfg)).toBe("unknown");
  });
});

describe("getClientIp (TRUST_PROXY=true)", () => {
  const cfg = { TRUST_PROXY: true } as const;

  test("prefers rightmost X-Forwarded-For over X-Real-IP", () => {
    // The rightmost XFF entry is the hop the trusted proxy actually
    // controls; X-Real-IP is operator-defined and easier to misconfigure,
    // so an XFF value must win when both are present.
    expect(
      getClientIp(
        ctx(
          { "x-real-ip": "198.51.100.7", "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
          {
            IP: { address: "127.0.0.1" },
          },
        ),
        cfg,
      ),
    ).toBe("10.0.0.1");
  });

  test("falls back to rightmost entry of X-Forwarded-For when X-Real-IP is missing", () => {
    expect(
      getClientIp(
        ctx({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" }, {
          IP: { address: "127.0.0.1" },
        }),
        cfg,
      ),
    ).toBe("10.0.0.1");
  });

  test("uses the only XFF entry when there is one", () => {
    expect(
      getClientIp(ctx({ "x-forwarded-for": "192.0.2.1" }, {
        IP: { address: "127.0.0.1" },
      }), cfg),
    ).toBe("192.0.2.1");
  });

  test("normalises mixed-case header keys", () => {
    expect(
      getClientIp(ctx({ "X-Forwarded-For": "192.0.2.1" }, {
        IP: { address: "127.0.0.1" },
      }), cfg),
    ).toBe("192.0.2.1");
  });

  test("falls back to peer IP when no proxy headers are present", () => {
    expect(getClientIp(ctx({}, {
      IP: { address: "127.0.0.1" },
    }), cfg)).toBe("127.0.0.1");
  });

  test("returns 'unknown' when neither headers nor peer IP are available", () => {
    expect(getClientIp(ctx({}, {}), cfg)).toBe("unknown");
  });

  test("ignores a sentinel rightmost XFF entry and falls back to X-Real-IP", () => {
    expect(
      getClientIp(
        ctx(
          { "x-forwarded-for": "203.0.113.5, unknown", "x-real-ip": "198.51.100.7" },
          {
            IP: { address: "127.0.0.1" },
          },
        ),
        cfg,
      ),
    ).toBe("198.51.100.7");
  });

  test("ignores a sentinel X-Real-IP and falls back to peer IP", () => {
    expect(
      getClientIp(ctx({ "x-real-ip": "::" }, {
        IP: { address: "10.0.0.9" },
      }), cfg),
    ).toBe("10.0.0.9");
  });

  test("ignores a whitespace-only XFF header", () => {
    expect(
      getClientIp(ctx({ "x-forwarded-for": "   " }, {
        IP: { address: "10.0.0.9" },
      }), cfg),
    ).toBe("10.0.0.9");
  });

  test("uses CF-Connecting-IP as the peer on Workers, which exposes no socket", () => {
    // Cloudflare Workers: there is no `c.env.IP`, and the edge overwrites
    // CF-Connecting-IP on every request, so it is the trustworthy peer.
    onWorkers();
    expect(getClientIp(ctx({ "cf-connecting-ip": "198.51.100.7" }, {}), { TRUST_PROXY: true })).toBe("198.51.100.7");
  });
});

describe("getClientIp (Cloudflare CF-Connecting-IP / True-Client-IP)", () => {
  test("CF-Connecting-IP wins over XFF/X-Real-IP on the trusted path (CF → Traefik → app)", () => {
    // Peer is Traefik (allow-listed); XFF right-most + X-Real-IP are the
    // Cloudflare edge, CF-Connecting-IP is the real visitor.
    expect(
      getClientIp(
        ctx(
          { "x-forwarded-for": "203.0.113.5, 162.158.1.1", "x-real-ip": "162.158.1.1", "cf-connecting-ip": "203.0.113.5" },
          {
            IP: { address: "172.20.0.2" },
          },
        ),
        { TRUST_PROXY: true, TRUSTED_PROXY_IPS: "172.16.0.0/12" },
      ),
    ).toBe("203.0.113.5");
  });

  test("falls back to True-Client-IP when CF-Connecting-IP is absent", () => {
    expect(
      getClientIp(
        ctx({ "true-client-ip": "198.51.100.7", "x-forwarded-for": "162.158.1.1" }, {
          IP: { address: "10.0.0.2" },
        }),
        { TRUST_PROXY: true, TRUSTED_PROXY_IPS: "10.0.0.0/8" },
      ),
    ).toBe("198.51.100.7");
  });

  test("CF-Connecting-IP from an UNtrusted peer is ignored (anti-spoof)", () => {
    expect(
      getClientIp(
        ctx({ "cf-connecting-ip": "203.0.113.5" }, {
          IP: { address: "8.8.8.8" },
        }),
        { TRUST_PROXY: true, TRUSTED_PROXY_IPS: "172.16.0.0/12" },
      ),
    ).toBe("8.8.8.8");
  });
});

describe("getClientIp (TRUST_PROXY=true with TRUSTED_PROXY_IPS allow-list)", () => {
  test("honours forwarding headers when the peer is inside an allowed CIDR", () => {
    expect(
      getClientIp(
        ctx({ "x-forwarded-for": "203.0.113.5" }, {
          IP: { address: "10.0.0.42" },
        }),
        { TRUST_PROXY: true, TRUSTED_PROXY_IPS: "10.0.0.0/8" },
      ),
    ).toBe("203.0.113.5");
  });

  test("drops forwarding headers and returns the peer when it is NOT allow-listed", () => {
    // A caller hitting the process directly (not via the trusted proxy)
    // must not be able to forge a client IP.
    expect(
      getClientIp(
        ctx({ "x-forwarded-for": "203.0.113.5" }, {
          IP: { address: "8.8.8.8" },
        }),
        { TRUST_PROXY: true, TRUSTED_PROXY_IPS: "10.0.0.0/8" },
      ),
    ).toBe("8.8.8.8");
  });

  test("matches a bare IP literal (implicit /32)", () => {
    expect(
      getClientIp(
        ctx({ "x-forwarded-for": "203.0.113.5" }, {
          IP: { address: "192.0.2.1" },
        }),
        { TRUST_PROXY: true, TRUSTED_PROXY_IPS: "192.0.2.1" },
      ),
    ).toBe("203.0.113.5");
  });

  test("matches a high-bit private CIDR (192.168.0.0/16) — regression for signed-int32 mask", () => {
    // The network address 192.168.0.0 has its top bit set; a signed `&`
    // would store it negative and never match the unsigned peer value.
    expect(
      getClientIp(
        ctx({ "x-forwarded-for": "203.0.113.5" }, {
          IP: { address: "192.168.1.20" },
        }),
        { TRUST_PROXY: true, TRUSTED_PROXY_IPS: "192.168.0.0/16" },
      ),
    ).toBe("203.0.113.5");
  });

  test("matches a high-bit private CIDR (172.16.0.0/12)", () => {
    expect(
      getClientIp(
        ctx({ "x-forwarded-for": "203.0.113.5" }, {
          IP: { address: "172.16.5.5" },
        }),
        { TRUST_PROXY: true, TRUSTED_PROXY_IPS: "172.16.0.0/12" },
      ),
    ).toBe("203.0.113.5");
    // Outside the /12 (172.32.x) must NOT be trusted.
    expect(
      getClientIp(
        ctx({ "x-forwarded-for": "203.0.113.5" }, {
          IP: { address: "172.32.0.1" },
        }),
        { TRUST_PROXY: true, TRUSTED_PROXY_IPS: "172.16.0.0/12" },
      ),
    ).toBe("172.32.0.1");
  });

  test("accepts any of several comma-separated allow-list entries", () => {
    const cfg = { TRUST_PROXY: true, TRUSTED_PROXY_IPS: "192.0.2.1, 10.0.0.0/24" } as const;
    expect(
      getClientIp(ctx({ "x-forwarded-for": "1.1.1.1" }, {
        IP: { address: "10.0.0.7" },
      }), cfg),
    ).toBe("1.1.1.1");
    expect(
      getClientIp(ctx({ "x-forwarded-for": "1.1.1.1" }, {
        IP: { address: "10.0.1.7" },
      }), cfg),
    ).toBe("10.0.1.7");
  });

  test("an unparseable allow-list entry is skipped, others still apply", () => {
    expect(
      getClientIp(
        ctx({ "x-forwarded-for": "1.1.1.1" }, {
          IP: { address: "10.0.0.7" },
        }),
        { TRUST_PROXY: true, TRUSTED_PROXY_IPS: "not-an-ip, 10.0.0.0/8" },
      ),
    ).toBe("1.1.1.1");
  });

  test("a /0 prefix trusts every peer", () => {
    expect(
      getClientIp(
        ctx({ "x-forwarded-for": "1.1.1.1" }, {
          IP: { address: "8.8.8.8" },
        }),
        { TRUST_PROXY: true, TRUSTED_PROXY_IPS: "0.0.0.0/0" },
      ),
    ).toBe("1.1.1.1");
  });

  test("an IPv6 peer is never matched by an IPv4 allow-list (version isolation)", () => {
    // IPv4 and IPv6 share no comparable network space, so an IPv6 peer against
    // an IPv4-only allow-list is dropped and the peer itself is returned.
    expect(
      getClientIp(
        ctx({ "x-forwarded-for": "1.1.1.1" }, {
          IP: { address: "2001:db8::1" },
        }),
        { TRUST_PROXY: true, TRUSTED_PROXY_IPS: "10.0.0.0/8" },
      ),
    ).toBe("2001:db8::1");
  });

  test("honours forwarding headers when an IPv6 peer is inside an allowed IPv6 CIDR", () => {
    expect(
      getClientIp(
        ctx({ "x-forwarded-for": "203.0.113.5" }, {
          IP: { address: "2001:db8::dead:beef" },
        }),
        { TRUST_PROXY: true, TRUSTED_PROXY_IPS: "2001:db8::/32" },
      ),
    ).toBe("203.0.113.5");
  });

  test("drops forwarding headers when an IPv6 peer is OUTSIDE the allowed IPv6 CIDR", () => {
    expect(
      getClientIp(
        ctx({ "x-forwarded-for": "203.0.113.5" }, {
          IP: { address: "2001:dead::1" },
        }),
        { TRUST_PROXY: true, TRUSTED_PROXY_IPS: "2001:db8::/32" },
      ),
    ).toBe("2001:dead::1");
  });

  test("matches a bare IPv6 literal (implicit /128)", () => {
    expect(
      getClientIp(
        ctx({ "x-forwarded-for": "203.0.113.5" }, {
          IP: { address: "2001:db8::1" },
        }),
        { TRUST_PROXY: true, TRUSTED_PROXY_IPS: "2001:db8::1" },
      ),
    ).toBe("203.0.113.5");
  });

  test("an IPv4 peer is never matched by an IPv6 allow-list (version isolation)", () => {
    expect(
      getClientIp(
        ctx({ "x-forwarded-for": "1.1.1.1" }, {
          IP: { address: "10.0.0.7" },
        }),
        { TRUST_PROXY: true, TRUSTED_PROXY_IPS: "2001:db8::/32" },
      ),
    ).toBe("10.0.0.7");
  });

  test("mixes IPv4 and IPv6 entries in one allow-list", () => {
    const cfg = { TRUST_PROXY: true, TRUSTED_PROXY_IPS: "10.0.0.0/8, fd00::/8" } as const;
    expect(
      getClientIp(ctx({ "x-forwarded-for": "1.1.1.1" }, {
        IP: { address: "fd00::42" },
      }), cfg),
    ).toBe("1.1.1.1");
    expect(
      getClientIp(ctx({ "x-forwarded-for": "1.1.1.1" }, {
        IP: { address: "10.5.5.5" },
      }), cfg),
    ).toBe("1.1.1.1");
    expect(
      getClientIp(ctx({ "x-forwarded-for": "1.1.1.1" }, {
        IP: { address: "fe80::1" },
      }), cfg),
    ).toBe("fe80::1");
  });

  test("an all-invalid allow-list collapses to empty → any peer trusted", () => {
    // parseProxyAllowList yields [], so the per-peer gate is skipped and
    // forwarding headers from any peer are honoured (pre-flag behaviour).
    expect(
      getClientIp(
        ctx({ "x-forwarded-for": "1.1.1.1" }, {
          IP: { address: "8.8.8.8" },
        }),
        { TRUST_PROXY: true, TRUSTED_PROXY_IPS: "/99, garbage, 300.0.0.1" },
      ),
    ).toBe("1.1.1.1");
  });
});

describe("getClientIp (production fail-closed — TRUST_PROXY=true, empty allow-list)", () => {
  const prodCfg = { TRUST_PROXY: true, NODE_ENV: "production" } as const;

  test("ignores X-Forwarded-For and returns the socket peer IP", () => {
    // The spoofable case the audit flagged: an exposed process trusting
    // forwarding headers from any peer. In production this must fail closed.
    expect(
      getClientIp(
        ctx({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" }, {
          IP: { address: "8.8.8.8" },
        }),
        prodCfg,
      ),
    ).toBe("8.8.8.8");
  });

  test("ignores X-Real-IP and returns the socket peer IP", () => {
    expect(
      getClientIp(ctx({ "x-real-ip": "203.0.113.5" }, {
        IP: { address: "8.8.8.8" },
      }), prodCfg),
    ).toBe("8.8.8.8");
  });

  test("returns 'unknown' when no socket peer IP is available", () => {
    expect(getClientIp(ctx({ "x-forwarded-for": "203.0.113.5" }, {}), prodCfg)).toBe("unknown");
  });

  test("a forged CF-Connecting-IP on Bun cannot pass the allow-list as the peer", () => {
    expect(
      getClientIp(
        ctx({ "cf-connecting-ip": "10.0.0.1", "x-forwarded-for": "203.0.113.5" }, {}),
        { ...prodCfg, TRUSTED_PROXY_IPS: "10.0.0.0/8" },
      ),
    ).toBe("unknown");
  });

  test("an all-invalid allow-list still fails closed in production", () => {
    expect(
      getClientIp(
        ctx({ "x-forwarded-for": "1.1.1.1" }, {
          IP: { address: "8.8.8.8" },
        }),
        { TRUST_PROXY: true, NODE_ENV: "production", TRUSTED_PROXY_IPS: "garbage, /99" },
      ),
    ).toBe("8.8.8.8");
  });

  test("a valid allow-list is still honoured in production (not over-blocked)", () => {
    expect(
      getClientIp(
        ctx({ "x-forwarded-for": "203.0.113.5" }, {
          IP: { address: "10.0.0.42" },
        }),
        { TRUST_PROXY: true, NODE_ENV: "production", TRUSTED_PROXY_IPS: "10.0.0.0/8" },
      ),
    ).toBe("203.0.113.5");
  });

  test("dev/test stay usable: an empty allow-list still honours X-Forwarded-For", () => {
    expect(
      getClientIp(
        ctx({ "x-forwarded-for": "203.0.113.5" }, {
          IP: { address: "8.8.8.8" },
        }),
        { TRUST_PROXY: true, NODE_ENV: "development" },
      ),
    ).toBe("203.0.113.5");
  });
});

describe("isSpoofableProxyConfig", () => {
  test("false when TRUST_PROXY is off", () => {
    expect(isSpoofableProxyConfig({ TRUST_PROXY: false })).toBe(false);
    expect(isSpoofableProxyConfig(undefined)).toBe(false);
  });

  test("true when TRUST_PROXY is on without an allow-list", () => {
    expect(isSpoofableProxyConfig({ TRUST_PROXY: true })).toBe(true);
    expect(isSpoofableProxyConfig({ TRUST_PROXY: true, TRUSTED_PROXY_IPS: "" })).toBe(true);
  });

  test("true when the allow-list contains only unparseable entries", () => {
    expect(isSpoofableProxyConfig({ TRUST_PROXY: true, TRUSTED_PROXY_IPS: "garbage" })).toBe(true);
  });

  test("false when a valid allow-list narrows trusted peers", () => {
    expect(isSpoofableProxyConfig({ TRUST_PROXY: true, TRUSTED_PROXY_IPS: "10.0.0.0/8" })).toBe(false);
  });
});
