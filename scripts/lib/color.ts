// sRGB hex <-> OKLCH (Björn Ottosson's OKLab), for `rebrand --color`.
//
// The SPA derives its palette from `--brand` in CSS, but the favicon
// (apps/web/public/logo.svg) is loaded on its own and cannot read CSS
// variables, so the rebrand script computes its gradient stops here.

export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

// The logo gradient: [lightness, chroma factor] per stop, applied to the
// brand's chroma and hue. Mirrors `--logo-from/via/to` in apps/web/src/index.css.
const LOGO_STEPS: readonly (readonly [number, number])[] = [
  [0.68, 0.78],
  [0.585, 1],
  [0.457, 1.05],
];

/** Normalise `#rgb` / `#rrggbb` (the `#` optional) to lowercase `#rrggbb`, else null. */
export function parseHex(input: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m)
    return null;
  const hex = m[1]!.toLowerCase();
  return `#${hex.length === 3
    ? [...hex].map(ch => ch + ch).join("")
    : hex}`;
}

function toLinear(v: number): number {
  return v <= 0.04045
    ? v / 12.92
    : ((v + 0.055) / 1.055) ** 2.4;
}

function fromLinear(v: number): number {
  return v <= 0.0031308
    ? 12.92 * v
    : 1.055 * v ** (1 / 2.4) - 0.055;
}

export function hexToOklch(hex: string): Oklch {
  const norm = parseHex(hex);
  if (!norm)
    throw new Error(`not a hex colour: ${hex}`);
  const [r, g, b] = [1, 3, 5].map(i => toLinear(Number.parseInt(norm.slice(i, i + 2), 16) / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(A, B);
  const h = c < 1e-6
    ? 0
    : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}

function toLinearRgb({ l: L, c, h }: Oklch): [number, number, number] {
  const A = c * Math.cos((h * Math.PI) / 180);
  const B = c * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function inGamut(rgb: readonly number[]): boolean {
  return rgb.every(v => v >= -1e-4 && v <= 1 + 1e-4);
}

/** OKLCH to `#rrggbb`. Out-of-sRGB colours lose chroma (hue and lightness kept), as browsers map them. */
export function oklchToHex(color: Oklch): string {
  let rgb = toLinearRgb(color);
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = color.c;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(toLinearRgb({ ...color, c: mid })))
        lo = mid;
      else
        hi = mid;
    }
    rgb = toLinearRgb({ ...color, c: lo });
  }
  return `#${rgb.map(v => Math.round(Math.min(1, Math.max(0, fromLinear(Math.min(1, Math.max(0, v))))) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** The favicon gradient's three stops (light to dark) for a brand colour. */
export function logoStops(brandHex: string): string[] {
  const { c, h } = hexToOklch(brandHex);
  return LOGO_STEPS.map(([l, k]) => oklchToHex({ l, c: c * k, h }));
}
