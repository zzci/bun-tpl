interface ComputedUserset {
  readonly relation: string;
}

interface TupleToUserset {
  readonly tupleset: string;
  readonly computed_userset: string;
}

type RelationRuleEntry
  = | { readonly this: Record<string, never> }
    | { readonly computed_userset: ComputedUserset }
    | { readonly tuple_to_userset: TupleToUserset };

interface RelationRule {
  readonly union: readonly RelationRuleEntry[];
}

export interface NamespaceConfig {
  readonly name: string;
  readonly relations?: Readonly<Record<string, RelationRule>>;
}

const namespaceRegistry = new Map<string, NamespaceConfig>();

const defaultNamespaces: readonly NamespaceConfig[] = [
  { name: "user" },
  {
    name: "group",
    relations: {
      member: { union: [{ this: {} }] },
    },
  },
  {
    name: "resource_group",
    relations: {
      viewer: {
        union: [{ this: {} }, { computed_userset: { relation: "editor" } }],
      },
      editor: {
        union: [{ this: {} }, { computed_userset: { relation: "manager" } }],
      },
      manager: {
        union: [{ this: {} }, { computed_userset: { relation: "admin" } }],
      },
      admin: { union: [{ this: {} }] },
      member: { union: [{ this: {} }] },
    },
  },
  // `item` is the permission namespace for the item base module
  // (`apps/api/src/modules/item/`). Every sub-type that builds on `item`
  // (issue, document, …) writes its access tuples here.
  //
  // Relations:
  // - owner    : creator; full control. Written by ItemService.createItem.
  // - editor   : can modify; implied by owner.
  // - viewer   : can read; implied by editor. Also inherited from any
  //              ancestor `item` reached via the parent_item edge — this is
  //              how document subtree visibility works (a viewer/editor on a
  //              parent item flows down to its descendants).
  // - assignee : current handler (issue assignee); implied by owner. The
  //              relation is here so sub-types can list "items assigned to
  //              me" without each rolling its own indexed column.
  // - approver : current approver in an approval flow (e.g. expense).
  //              Stays narrow (no implicit inheritance) so revoking it on
  //              status transitions is straightforward.
  // - watcher  : notification-only subscriber. No visibility implications;
  //              sub-types decide whether watching also grants read.
  // - parent_item : item → item edge. Only the upward edge is stored
  //                 (`(item, child, parent_item, item, parent)`); the
  //                 downward enumeration is a recursive CTE on tuples.
  {
    name: "item",
    relations: {
      owner: { union: [{ this: {} }] },
      editor: {
        union: [
          { this: {} },
          { computed_userset: { relation: "owner" } },
          { tuple_to_userset: { tupleset: "parent_item", computed_userset: "editor" } },
        ],
      },
      viewer: {
        union: [
          { this: {} },
          { computed_userset: { relation: "editor" } },
          { tuple_to_userset: { tupleset: "parent_item", computed_userset: "viewer" } },
        ],
      },
      assignee: {
        union: [{ this: {} }, { computed_userset: { relation: "owner" } }],
      },
      approver: { union: [{ this: {} }] },
      watcher: { union: [{ this: {} }] },
      parent_item: { union: [{ this: {} }] },
    },
  },
];

export function loadNamespaces(configs?: readonly NamespaceConfig[]): void {
  namespaceRegistry.clear();
  for (const config of configs ?? defaultNamespaces) {
    namespaceRegistry.set(config.name, config);
  }
}

export function getNamespace(name: string): NamespaceConfig | undefined {
  return namespaceRegistry.get(name);
}

export function getAllNamespaces(): ReadonlyMap<string, NamespaceConfig> {
  return namespaceRegistry;
}

/**
 * Get the higher-level relations that imply the given relation.
 * e.g. getParentRelations("app", "viewer") → ["manager"]
 * because viewer's union includes computed_userset{relation: "manager"},
 * meaning having "manager" implies having "viewer".
 */
export function getParentRelations(namespace: string, relation: string): readonly string[] {
  const ns = namespaceRegistry.get(namespace);
  if (!ns?.relations)
    return [];

  const rel = ns.relations[relation];
  if (!rel)
    return [];

  const parents: string[] = [];
  for (const entry of rel.union) {
    if ("computed_userset" in entry) {
      parents.push(entry.computed_userset.relation);
    }
  }
  return parents;
}

export function getTupleToUsersetRules(namespace: string, relation: string): readonly TupleToUserset[] {
  const ns = namespaceRegistry.get(namespace);
  if (!ns?.relations)
    return [];

  const rel = ns.relations[relation];
  if (!rel)
    return [];

  const rules: TupleToUserset[] = [];
  for (const entry of rel.union) {
    if ("tuple_to_userset" in entry) {
      rules.push(entry.tuple_to_userset);
    }
  }
  return rules;
}

export function getValidRelations(namespace: string): readonly string[] {
  const ns = namespaceRegistry.get(namespace);
  if (!ns?.relations)
    return [];
  return Object.keys(ns.relations);
}

// Load defaults on import
loadNamespaces();
