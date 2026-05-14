import type { Config } from "./schema";
import { describe, expect, test } from "bun:test";
import { ConfigError } from "./errors";
import { assertProductionNetworkGuards, assertProductionSentinels } from "./sentinels";

function baseProd(overrides: Partial<Config> = {}): Config {
  return {
    NODE_ENV: "production",
    OAUTH_CLIENT_ID: "real-client",
    OAUTH_CLIENT_SECRET: "real-secret",
    DEFAULT_ADMIN: "ops@example.com",
    CORS_ORIGIN: "https://app.example.com",
    ACCESS_URL: "https://app.example.com",
    ...overrides,
  } as unknown as Config;
}

describe("assertProductionSentinels", () => {
  test("no-op outside production", () => {
    expect(() =>
      assertProductionSentinels({
        NODE_ENV: "development",
        OAUTH_CLIENT_SECRET: "app-secret",
        OAUTH_CLIENT_ID: "app",
        DEFAULT_ADMIN: "admin@example.com",
      } as unknown as Config),
    ).not.toThrow();
  });

  test("throws when OAUTH_CLIENT_SECRET still holds the example value", () => {
    expect(() => assertProductionSentinels(baseProd({ OAUTH_CLIENT_SECRET: "app-secret" })))
      .toThrow(ConfigError);
  });

  test("throws when OAUTH_CLIENT_ID still holds the example value", () => {
    expect(() => assertProductionSentinels(baseProd({ OAUTH_CLIENT_ID: "app" })))
      .toThrow(ConfigError);
  });

  test("throws when DEFAULT_ADMIN still holds the example value", () => {
    expect(() => assertProductionSentinels(baseProd({ DEFAULT_ADMIN: "admin@example.com" })))
      .toThrow(ConfigError);
  });

  test("passes when every sentinel has been rotated", () => {
    expect(() => assertProductionSentinels(baseProd())).not.toThrow();
  });
});

describe("assertProductionNetworkGuards", () => {
  test("no-op outside production", () => {
    const data = { NODE_ENV: "development" } as unknown as Config;
    expect(assertProductionNetworkGuards(data, true)).toEqual([]);
  });

  test("requires CORS_ORIGIN when OAuth is in play", () => {
    expect(() => assertProductionNetworkGuards(baseProd({ CORS_ORIGIN: undefined }), true))
      .toThrow(/CORS_ORIGIN/);
  });

  test("does NOT require CORS_ORIGIN in pure single-user mode", () => {
    expect(() => assertProductionNetworkGuards(baseProd({ CORS_ORIGIN: undefined }), false))
      .not
      .toThrow();
  });

  test("requires ACCESS_URL when OAuth is in play", () => {
    expect(() => assertProductionNetworkGuards(baseProd({ ACCESS_URL: undefined }), true))
      .toThrow(/ACCESS_URL/);
  });

  test("warns instead of throwing when ACCESS_URL is missing in single-user mode", () => {
    const warnings = assertProductionNetworkGuards(baseProd({ ACCESS_URL: undefined }), false);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/ACCESS_URL/);
  });

  test("returns no warnings on a healthy production config", () => {
    expect(assertProductionNetworkGuards(baseProd(), true)).toEqual([]);
  });
});
