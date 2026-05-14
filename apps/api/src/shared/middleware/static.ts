import type { Context } from "hono";
import { staticAssets } from "../static-assets";

// Vite emits hashed filenames for JS/CSS/asset bundles (e.g. `app-d4a91f.js`,
// `style-aa11bb.css`, fonts), which are content-addressed and safe to pin
// for a year. Anything else (index.html, /logo.svg) must revalidate so a
// deploy is picked up immediately. Locale JSONs now ship as hashed JS
// chunks under `assets/` (see apps/web/src/app/i18n.ts) and are covered
// by the same immutable rule.
const HASHED_ASSET_RE = /\.[a-f0-9]{8,}\.(?:js|css|woff2?|ttf|otf|svg|png|jpe?g|gif|ico|webp|map)$/i;
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const REVALIDATE_CACHE = "no-cache";

export function serveStaticAssets(basePath: string) {
  const indexKey = `${basePath}/index.html`;
  return async (c: Context) => {
    const path = new URL(c.req.url).pathname;
    const direct = staticAssets.get(path);
    const asset = direct ?? staticAssets.get(indexKey);
    if (!asset) {
      return c.notFound();
    }
    const file = Bun.file(asset);
    const headers = new Headers();
    headers.set("Cache-Control", direct && HASHED_ASSET_RE.test(path) ? IMMUTABLE_CACHE : REVALIDATE_CACHE);
    // Bun.file infers Content-Type from extension. Forward it so secureHeaders
    // (set on the outer app) and CSP enforcement see the right mime.
    if (file.type) {
      headers.set("Content-Type", file.type);
    }
    return new Response(file, { headers });
  };
}

export function hasStaticAssets(): boolean {
  return staticAssets.size > 0;
}
