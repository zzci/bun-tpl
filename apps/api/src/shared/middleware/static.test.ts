import { describe, expect, test } from "bun:test";
import { HASHED_ASSET_RE } from "./static";

describe("HASHED_ASSET_RE", () => {
  test("matches Vite's eight-character URL-safe hashes", () => {
    expect(HASHED_ASSET_RE.test("/assets/index-QJD4sMsb.js")).toBe(true);
    expect(HASHED_ASSET_RE.test("/assets/en-common-a_B-9xYz.js")).toBe(true);
    expect(HASHED_ASSET_RE.test("/assets/index-Dk3l9Q2w.css")).toBe(true);
  });

  test("matches dot-separated hexadecimal hashes", () => {
    expect(HASHED_ASSET_RE.test("/assets/app.d4a91f0c.js")).toBe(true);
  });

  test("leaves unhashed files to revalidate", () => {
    expect(HASHED_ASSET_RE.test("/index.html")).toBe(false);
    expect(HASHED_ASSET_RE.test("/logo.svg")).toBe(false);
    expect(HASHED_ASSET_RE.test("/assets/favicon.ico")).toBe(false);
  });
});
