#!/usr/bin/env bun
/* eslint-disable no-console */
/**
 * Scan the web codebase for unused i18n keys.
 *
 * Heuristic — translation keys can be referenced in many shapes:
 *   - static literal:        t("ns:key.path") / t("key.path")
 *   - dynamic interpolation: t(`ns:prefix.${var}.suffix`)
 *   - via option:            t("key", { ns: "ns" })
 *   - via static data:       staticData: { titleKey: "ns:key.path" }
 *   - via plain prop:        label: "ns:key.path"
 *
 * Strategy:
 *   1. Flatten every locale JSON into the set of fully-qualified keys
 *      (`<ns>:<dot.path>`).
 *   2. Collect all string literals appearing in code that look like
 *      potential keys, plus dynamic-key prefixes captured from template
 *      literals (`prefix.${...}.suffix` → keep `prefix.` as a wildcard
 *      stem). A reference matches a key if either:
 *        - the literal equals the key, or
 *        - the literal equals the key with the leading `<defaultNs>:`
 *          stripped (since `useTranslation("settings")` lets `t("page.title")`
 *          resolve to `settings:page.title`), or
 *        - the key starts with a dynamic stem (the stem itself, plus the
 *          `<ns>:` form).
 *   3. A key is "unused" if no reference matches.
 *
 * Heuristic limits — this isn't a type-checker. False positives:
 *   - keys built entirely from variable concatenation with no static
 *     prefix (very rare; we treat them as covering the whole namespace
 *     they appear in via `useTranslation(ns)`).
 *   - keys referenced only by tests or future routes.
 * Run sanity-check before deleting anything.
 *
 * Usage:  bun scripts/find-unused-i18n.ts [--ns <namespace>]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(import.meta.dir, "..");
const LOCALES_DIR = resolve(ROOT, "apps/web/src/locales");
const CODE_ROOT = resolve(ROOT, "apps/web/src");
const REFERENCE_LANG = "en";

// ── Flatten locale JSON ──────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function flatten(value: unknown, prefix = ""): string[] {
  if (typeof value === "string")
    return [prefix];
  if (!isObject(value))
    return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${k}` : k;
    out.push(...flatten(v, next));
  }
  return out;
}

interface NamespaceKeys {
  readonly ns: string;
  readonly keys: ReadonlySet<string>;
}

function loadNamespaces(lang: string): NamespaceKeys[] {
  const dir = resolve(LOCALES_DIR, lang);
  return readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .map((f) => {
      const ns = f.replace(/\.json$/, "");
      const raw = JSON.parse(readFileSync(resolve(dir, f), "utf-8"));
      return { ns, keys: new Set(flatten(raw)) };
    });
}

// ── Walk code & collect references ───────────────────────────────

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "locales", ".turbo"]);
const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry))
      continue;
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walk(full);
    }
    else if (st.isFile() && CODE_EXTS.has(extname(entry))) {
      yield full;
    }
  }
}

// A "stem" captures the static prefix of a template-literal key:
//   t(`portal:tile.${k}Description`) → stem "portal:tile."
//   t(`denied.${reason}.title`)      → stem "denied."  (default ns + suffix forgotten)
// We over-approximate: any locale key starting with the stem is "matched."
interface CodeReferences {
  readonly literals: ReadonlySet<string>;
  // For each file, the default ns chosen by `useTranslation(...)`, used to
  // resolve unprefixed keys like `t("page.title")` in a `useTranslation("audit")`
  // call to `audit:page.title`.
  readonly defaultNamespaces: ReadonlyMap<string, string[]>;
  readonly stems: ReadonlySet<string>;
  // file → ns array, for resolving unprefixed dynamic stems
  readonly fileToNs: ReadonlyMap<string, string[]>;
  // staticData titleKey values (static strings only)
  readonly titleKeys: ReadonlySet<string>;
}

// Match a `t("...", ...)` / `t(`...`, ...)` call. We don't try to parse
// JS; we just look for the pattern and capture the first argument.
const RE_T_CALL = /\bt\(\s*(["'`])((?:\\.|(?!\1).)*?)\1/g;
const RE_TITLE_KEY = /titleKey\s*:\s*["']([^"']+)["']/g;
// Capture `useTranslation("ns")` or `useTranslation(["a", "b"])`.
const RE_USE_TRANS = /\buseTranslation\(\s*(?:\[([^\]]*)\]|(["'])([^"']+)\2)?\s*\)/g;
// Detect inline `{ ns: "X" }` adjacent to a t() call. We accept any
// occurrence in the file as "the ns X is in scope," which is conservative
// (over-counts) but safe for the unused-key analysis.
const RE_NS_OPTION = /\{\s*ns:\s*["']([^"']+)["']\s*\}/g;
// Match a quoted string literal whose body starts with `<word>:<word>`,
// which is the unmistakable shape of a namespaced i18n key (e.g.
// `"settings:smtp.fieldHost"`). Catches keys stashed in config arrays.
const RE_NS_PREFIXED_LITERAL = /["'`](\w+:[\w.-]+)["'`]/g;

function looksLikeKey(s: string): boolean {
  // Heuristic: keys use identifier-ish characters (letters, digits,
  // dot, colon, hyphen, underscore). Single-segment keys like `"bold"`
  // are valid when paired with `useTranslation("editor")`, so we don't
  // require a dot or colon — just sane characters.
  if (s.length === 0 || s.length > 120)
    return false;
  if (!/^[\w:.-]+$/.test(s))
    return false;
  return /[a-z]/i.test(s);
}

// Pull out the static prefix of a template literal up to the first
// ${...}. Return undefined if there's no `${` (it's just a plain string
// and will be captured by the literal-arg branch instead).
function templatePrefix(arg: string): string | undefined {
  const idx = arg.indexOf("${");
  if (idx < 0)
    return undefined;
  const stem = arg.slice(0, idx);
  if (stem.length === 0)
    return undefined;
  return stem;
}

function collectReferences(): CodeReferences {
  const literals = new Set<string>();
  const stems = new Set<string>();
  const titleKeys = new Set<string>();
  const fileToNs = new Map<string, string[]>();
  const defaultNamespaces = new Map<string, string[]>();

  for (const file of walk(CODE_ROOT)) {
    const src = readFileSync(file, "utf-8");

    // Capture default-ns hints from useTranslation()
    const nsForFile: string[] = [];
    for (const m of src.matchAll(RE_USE_TRANS)) {
      if (m[1]) {
        // useTranslation(["a","b",...])
        for (const part of m[1].split(",")) {
          const cleaned = part.trim().replace(/^['"]|['"]$/g, "");
          if (cleaned)
            nsForFile.push(cleaned);
        }
      }
      else if (m[3]) {
        // useTranslation("ns")
        nsForFile.push(m[3]);
      }
    }
    for (const m of src.matchAll(RE_NS_OPTION)) {
      nsForFile.push(m[1]!);
    }
    fileToNs.set(file, nsForFile);
    if (nsForFile.length > 0)
      defaultNamespaces.set(file, nsForFile);

    // Capture t() calls
    for (const m of src.matchAll(RE_T_CALL)) {
      const quote = m[1]!;
      const arg = m[2]!;
      if (quote === "`") {
        const stem = templatePrefix(arg);
        if (stem) {
          stems.add(stem);
          // Also record stem-with-ns-prefixes from this file's ns scope.
          for (const ns of nsForFile)
            stems.add(`${ns}:${stem}`);
        }
        else if (looksLikeKey(arg)) {
          literals.add(arg);
        }
      }
      else if (looksLikeKey(arg)) {
        literals.add(arg);
      }
    }

    // Capture titleKey static data
    for (const m of src.matchAll(RE_TITLE_KEY)) {
      const k = m[1]!;
      if (looksLikeKey(k))
        titleKeys.add(k);
    }

    // Capture any "ns:key.path" string literal anywhere in the source.
    // Keys often live in static config arrays (e.g. field-label props
    // consumed by a generic component that then calls `t(label)`).
    // The leading `<ns>:` is a strong i18n signal — any namespace name
    // followed by `:` and an identifier path counts.
    for (const m of src.matchAll(RE_NS_PREFIXED_LITERAL)) {
      const k = m[1]!;
      if (looksLikeKey(k))
        literals.add(k);
    }
  }

  return { literals, stems, fileToNs, defaultNamespaces, titleKeys };
}

// ── Match logic ──────────────────────────────────────────────────

function keyIsReferenced(
  ns: string,
  key: string,
  refs: CodeReferences,
): boolean {
  const fq = `${ns}:${key}`;
  if (refs.literals.has(fq) || refs.titleKeys.has(fq))
    return true;
  // Unprefixed literal matches if some file's default ns includes this ns
  if (refs.literals.has(key) || refs.titleKeys.has(key)) {
    for (const nsList of refs.defaultNamespaces.values()) {
      if (nsList.includes(ns))
        return true;
    }
  }
  // Stem matches
  for (const stem of refs.stems) {
    if (fq.startsWith(stem))
      return true;
    if (key.startsWith(stem)) {
      // Stem with no ns prefix — match only if some file's default ns
      // includes this ns. (Conservative: any file is enough.)
      for (const nsList of refs.defaultNamespaces.values()) {
        if (nsList.includes(ns))
          return true;
      }
    }
  }
  return false;
}

// ── Main ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const nsFilter = (() => {
  const idx = args.indexOf("--ns");
  return idx >= 0 ? args[idx + 1] : undefined;
})();

const namespaces = loadNamespaces(REFERENCE_LANG);
const refs = collectReferences();

let totalUnused = 0;
let totalKeys = 0;
for (const { ns, keys } of namespaces) {
  if (nsFilter && ns !== nsFilter)
    continue;
  totalKeys += keys.size;
  const unused = [...keys].filter(k => !keyIsReferenced(ns, k, refs)).sort();
  if (unused.length === 0)
    continue;
  console.log(`\n[${ns}] ${unused.length} unused key(s) of ${keys.size}:`);
  for (const k of unused)
    console.log(`  - ${ns}:${k}`);
  totalUnused += unused.length;
}

console.log(`\n──────────────────────────────────────────`);
console.log(`scanned ${totalKeys} key(s) across ${namespaces.length} namespace(s)`);
console.log(`${totalUnused} potentially unused (heuristic — verify before deleting)`);
