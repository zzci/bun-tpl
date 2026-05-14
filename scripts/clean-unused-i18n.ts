#!/usr/bin/env bun
/* eslint-disable no-console */
/**
 * Drop the unused-i18n-key set (as identified by find-unused-i18n.ts) from
 * every locale's JSON shard. Mirrors the deletion across EN and ZH so
 * check-i18n stays happy, and prunes parent objects that become empty.
 *
 * The unused list lives in this file rather than being re-discovered at
 * runtime: deletion is a destructive op, and pinning the list keeps the
 * change reviewable in a single diff.
 *
 * Usage:  bun scripts/clean-unused-i18n.ts [--dry-run]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(import.meta.dir, "..");
const LOCALES_DIR = resolve(ROOT, "apps/web/src/locales");

const UNUSED: Record<string, readonly string[]> = {
  common: [
    "common.back",
    "common.create",
    "common.no",
    "common.refresh",
    "common.yes",
  ],
  cron: [
    "form.config",
    "form.config.http.body",
    "form.config.http.expectStatus",
    "form.config.http.headers",
    "form.config.http.headersPlaceholder",
    "form.config.http.method",
    "form.config.http.timeout",
    "form.config.http.url",
    "form.config.http.urlPlaceholder",
    "form.config.json",
    "form.config.jsonHint",
    "form.config.shell.command",
    "form.config.shell.commandPlaceholder",
    "form.config.shell.cwd",
    "form.config.shell.timeout",
    "form.config.shell.warning",
    "form.scheduleCustom",
    "logs.error",
    "logs.result",
  ],
  documents: [
    "allTags",
    "attachments.delete",
    "attachments.dragHint",
    "attachments.noAttachments",
    "attachments.orDragHint",
    "col.tags",
    "col.updatedAt",
    "comments.markdownHint",
    "comments.noContent",
    "comments.preview",
    "comments.write",
    "field.content",
    "field.markdownHint",
    "field.tags",
    "permission",
    "selectHint",
    "sharedWithMe",
    "tree.collapse",
    "tree.expand",
    "tree.move",
    "tree.moveConfirm",
    "tree.moveDescription",
    "tree.movePickPlaceholder",
    "tree.moveRoot",
    "tree.moveTitle",
    "tree.rename",
  ],
  editor: [
    "heading",
    "nothingToPreview",
    "preview",
    "write",
  ],
  encryption: [
    "setup.showKey",
  ],
  groups: [
    "manageMembers",
  ],
  issues: [
    "attachments.delete",
    "attachments.dragHint",
    "attachments.invalidType",
    "attachments.noAttachments",
    "attachments.size",
    "attachments.uploadedAt",
    "detailDescription",
    "field.status",
  ],
  policies: [
    "editTuple",
    "groupDescription",
    "groupDescriptionPlaceholder",
    "groupMembers",
    "groupMembersDescription",
    "groupName",
    "groupNamePlaceholder",
    "objectId",
    "objectPlaceholder",
    "resourceGroupsDescription",
    "saving",
    "selectGroupFirst",
    "subjectId",
    "subjectIdPlaceholder",
  ],
  settings: [
    "allSettingsRaw",
    "auth.description",
    "auth.fieldDefaultAdmin",
    "auth.title",
    "col.encrypted",
    "col.key",
    "col.updatedAt",
    "col.value",
    "encrypted",
    "encryption.import.includeUsersHint",
    "general.description",
    "general.fieldOidcLogoutUrl",
    "general.title",
    "noSettings",
    "oauth.description",
    "oauth.fieldAuthorizeUrl",
    "oauth.fieldCallbackUrl",
    "oauth.fieldClientId",
    "oauth.fieldClientSecret",
    "oauth.fieldIssuer",
    "oauth.fieldLogoutUrl",
    "oauth.fieldPkce",
    "oauth.fieldTokenUrl",
    "oauth.fieldUserinfoUrl",
    "oauth.title",
    "plaintext",
    "smtp.testConnection",
    "smtp.testSent",
    "smtp.testing",
    "tabs.general",
  ],
  totp: [
    "addSuccess",
    "deleteSuccess",
    "description",
  ],
  users: [
    "col.role",
  ],
};

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Walk the tree exactly like find-unused-i18n.ts: every string leaf gets
// a dot-joined path. Some locale files store keys with literal dots in
// the JSON key itself (e.g. `"config.http.url": "…"` under `form`); the
// flattened path joins those segments the same way, but the deletion
// target is the literal key, not a nested chain. This walker yields
// (parent, literalKey, flattenedPath) for every leaf so we can match by
// the flattened path and delete by the literal key.
interface Leaf {
  readonly parent: Record<string, unknown>;
  readonly key: string;
  readonly path: string;
  // Ancestor chain (newest-last) used to prune empty parents after deletion.
  readonly trail: readonly { parent: Record<string, unknown>; key: string }[];
}

function* walkLeaves(
  obj: Record<string, unknown>,
  prefix: readonly string[] = [],
  trail: readonly { parent: Record<string, unknown>; key: string }[] = [],
): Generator<Leaf> {
  for (const [k, v] of Object.entries(obj)) {
    const segs = [...prefix, k];
    if (typeof v === "string") {
      yield { parent: obj, key: k, path: segs.join("."), trail };
    }
    else if (isObject(v)) {
      yield* walkLeaves(v, segs, [...trail, { parent: obj, key: k }]);
    }
  }
}

// Delete any leaf whose flattened path is in `targets`. Returns the set
// of paths we matched so callers can warn about missing targets. Also
// prunes parent objects that became empty as a result.
function deleteByFlattenedPath(
  obj: Record<string, unknown>,
  targets: ReadonlySet<string>,
): Set<string> {
  const matched = new Set<string>();
  // Collect first; mutating during iteration would skip siblings.
  const leaves = [...walkLeaves(obj)];
  // Also match prefix paths: if a target is `form.config` and a leaf is
  // `form.config` (an object with descendants), every leaf under that
  // prefix counts as matched too.
  for (const target of targets) {
    const isExactLeaf = leaves.some(l => l.path === target);
    if (isExactLeaf) {
      matched.add(target);
      continue;
    }
    // Treat target as an object-prefix to delete the whole subtree.
    const subtreeLeaves = leaves.filter(l => l.path.startsWith(`${target}.`));
    if (subtreeLeaves.length > 0)
      matched.add(target);
  }

  // Build a per-leaf decision: delete if its path matches a target
  // (exact) or starts with a target-prefix.
  const targetsArr = [...targets];
  for (const leaf of leaves) {
    const exact = targets.has(leaf.path);
    const subtree = !exact && targetsArr.some(t => leaf.path.startsWith(`${t}.`));
    if (exact || subtree)
      delete leaf.parent[leaf.key];
  }
  // Prune empty objects recursively. Bottom-up — a child cleared on this
  // pass may leave its parent empty, so re-run until stable.
  function pruneEmpty(node: Record<string, unknown>): boolean {
    let anyEmpty = false;
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (isObject(v)) {
        if (pruneEmpty(v))
          anyEmpty = true;
        if (Object.keys(v).length === 0) {
          delete node[k];
          anyEmpty = true;
        }
      }
    }
    return anyEmpty;
  }
  while (pruneEmpty(obj)) {
    // re-run until no more empty objects surface
  }
  return matched;
}

const dryRun = process.argv.includes("--dry-run");

const locales = readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

let touched = 0;
let removed = 0;

for (const lang of locales) {
  for (const [ns, paths] of Object.entries(UNUSED)) {
    const file = resolve(LOCALES_DIR, lang, `${ns}.json`);
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(readFileSync(file, "utf-8"));
    }
    catch {
      console.error(`[clean-i18n] cannot read ${lang}/${ns}.json — skipped`);
      continue;
    }
    const before = JSON.stringify(json);
    const targets = new Set(paths);
    const matched = deleteByFlattenedPath(json, targets);
    for (const path of paths) {
      if (!matched.has(path))
        console.warn(`[clean-i18n] ${lang}/${ns}.json: path "${path}" not found (skip)`);
    }
    const after = JSON.stringify(json);
    if (after !== before) {
      touched++;
      removed += matched.size;
      if (!dryRun) {
        writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
      }
    }
  }
}

const totalPaths = Object.values(UNUSED).reduce((n, ps) => n + ps.length, 0);
const verb = dryRun ? "would remove" : "removed";
console.log(`[clean-i18n] ${verb} ${removed} key entries across ${touched} file(s)`);
console.log(`[clean-i18n] target: ${totalPaths} unique key path(s) × ${locales.length} locale(s) = ${totalPaths * locales.length}`);
