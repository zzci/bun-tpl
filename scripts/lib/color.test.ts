// Unit tests for the sRGB hex <-> OKLCH conversions behind `rebrand --color`.

import { describe, expect, test } from "bun:test";
import { hexToOklch, logoStops, oklchToHex, parseHex } from "./color";

describe("parseHex", () => {
  test("accepts #rgb and #rrggbb, any case", () => {
    expect(parseHex("#6366F1")).toBe("#6366f1");
    expect(parseHex("#fff")).toBe("#ffffff");
    expect(parseHex("2563eb")).toBe("#2563eb");
  });

  test("rejects anything else", () => {
    expect(parseHex("#12345")).toBeNull();
    expect(parseHex("blue")).toBeNull();
    expect(parseHex("#ggg")).toBeNull();
  });
});

describe("hexToOklch", () => {
  test("matches the CSS Color 4 reference values", () => {
    // sRGB red is oklch(0.628 0.2577 29.23) in CSS Color 4.
    const { l, c, h } = hexToOklch("#ff0000");
    expect(l).toBeCloseTo(0.628, 3);
    expect(c).toBeCloseTo(0.2577, 3);
    expect(h).toBeCloseTo(29.23, 1);
  });

  test("white has no chroma", () => {
    const { l, c } = hexToOklch("#ffffff");
    expect(l).toBeCloseTo(1, 4);
    expect(c).toBeCloseTo(0, 4);
  });
});

describe("oklchToHex", () => {
  test("round-trips an in-gamut colour", () => {
    for (const hex of [
      "#6366f1",
      "#2563eb",
      "#e11d48",
      "#16a34a",
      "#000000",
    ])
      expect(oklchToHex(hexToOklch(hex))).toBe(hex);
  });

  test("reduces chroma to stay in sRGB instead of clipping the hue", () => {
    // Far outside sRGB; the result keeps the hue and lightness roughly.
    const hex = oklchToHex({ l: 0.6, c: 0.5, h: 264 });
    const back = hexToOklch(hex);
    expect(back.l).toBeCloseTo(0.6, 2);
    expect(Math.abs(back.h - 264)).toBeLessThan(2);
    expect(back.c).toBeLessThan(0.5);
  });
});

describe("logoStops", () => {
  test("keeps the brand hue at three lightness steps", () => {
    const stops = logoStops("#e11d48");
    expect(stops).toHaveLength(3);
    const ls = stops.map(s => hexToOklch(s).l);
    expect(ls[0]).toBeGreaterThan(ls[1]!);
    expect(ls[1]).toBeGreaterThan(ls[2]!);
    for (const s of stops)
      expect(Math.abs(hexToOklch(s).h - hexToOklch("#e11d48").h)).toBeLessThan(3);
  });
});
