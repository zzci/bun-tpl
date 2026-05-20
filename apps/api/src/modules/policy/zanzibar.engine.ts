import type { AppDatabase } from "@/db";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { relationTuples } from "@/modules/policy/schema";
import { getParentRelations, getTupleToUsersetRules } from "./namespace-config";

const MAX_DEPTH = 10;

/**
 * Hard cap on the total number of graph nodes a single top-level resolution
 * (`check` / `listUserResources`) may visit, summed across *all* recursion
 * branches. `MAX_DEPTH` only bounds a single path; a wide permission graph can
 * still fan out into an exponential number of paths within that depth. This
 * shared counter bounds the aggregate work and short-circuits a pathological
 * (or maliciously crafted) graph instead of letting it run unbounded.
 *
 * 5000 is far above what any legitimate graph reaches (real resolutions touch
 * a handful to low-hundreds of nodes) while still capping DoS-shaped inputs.
 */
const MAX_NODE_BUDGET = 5000;

/**
 * Mutable budget threaded through every recursion branch of a single
 * resolution. `spend()` returns false once the cap is hit so callers can
 * short-circuit that branch (treated as "not allowed" — fail closed).
 */
interface NodeBudget {
  remaining: number;
}

function makeBudget(): NodeBudget {
  return { remaining: MAX_NODE_BUDGET };
}

function spend(budget: NodeBudget): boolean {
  if (budget.remaining <= 0)
    return false;
  budget.remaining -= 1;
  return true;
}

export interface CheckResult {
  readonly allowed: boolean;
  readonly resolvedThrough: readonly string[];
}

export interface SubjectNode {
  readonly namespace: string;
  readonly id: string;
  readonly relation?: string;
  readonly children?: readonly SubjectNode[];
}

function formatTuple(ns: string, objId: string, rel: string, subNs: string, subId: string, subRel?: string | null): string {
  const subject = subRel ? `${subNs}:${subId}#${subRel}` : `${subNs}:${subId}`;
  return `${ns}:${objId}#${rel}@${subject}`;
}

function checkKey(ns: string, objId: string, rel: string, subNs: string, subId: string): string {
  return `${ns}:${objId}#${rel}@${subNs}:${subId}`;
}

function expandKey(ns: string, objId: string, rel: string): string {
  return `${ns}:${objId}#${rel}`;
}

export async function check(
  db: AppDatabase,
  namespace: string,
  objectId: string,
  relation: string,
  subjectNs: string,
  subjectId: string,
  depth = 0,
  visited: Set<string> = new Set(),
  budget: NodeBudget = makeBudget(),
): Promise<CheckResult> {
  if (depth > MAX_DEPTH) {
    return { allowed: false, resolvedThrough: [] };
  }

  // Shared global node budget across all recursion branches — bounds
  // pathological permission-graph fan-out. Fail closed when exhausted.
  if (!spend(budget)) {
    return { allowed: false, resolvedThrough: [] };
  }

  const key = checkKey(namespace, objectId, relation, subjectNs, subjectId);
  if (visited.has(key)) {
    return { allowed: false, resolvedThrough: [] };
  }
  visited.add(key);

  // 1. Direct tuple match (subject_relation IS NULL)
  const direct = await db
    .select()
    .from(relationTuples)
    .where(
      and(
        eq(relationTuples.namespace, namespace),
        eq(relationTuples.objectId, objectId),
        eq(relationTuples.relation, relation),
        eq(relationTuples.subjectNamespace, subjectNs),
        eq(relationTuples.subjectId, subjectId),
        isNull(relationTuples.subjectRelation),
      ),
    )
    .get();

  if (direct) {
    return {
      allowed: true,
      resolvedThrough: [formatTuple(namespace, objectId, relation, subjectNs, subjectId)],
    };
  }

  // 2. Userset indirect match — find tuples with subject_relation set.
  // The `subject_relation IS NOT NULL` predicate is pushed into SQL rather
  // than JS-filtering the full result set.
  const usersetTuples = await db
    .select()
    .from(relationTuples)
    .where(
      and(
        eq(relationTuples.namespace, namespace),
        eq(relationTuples.objectId, objectId),
        eq(relationTuples.relation, relation),
        isNotNull(relationTuples.subjectRelation),
      ),
    )
    .all();

  for (const tuple of usersetTuples) {
    const innerResult = await check(
      db,
      tuple.subjectNamespace,
      tuple.subjectId,
      tuple.subjectRelation!,
      subjectNs,
      subjectId,
      depth + 1,
      visited,
      budget,
    );
    if (innerResult.allowed) {
      return {
        allowed: true,
        resolvedThrough: [
          formatTuple(namespace, objectId, relation, tuple.subjectNamespace, tuple.subjectId, tuple.subjectRelation),
          ...innerResult.resolvedThrough,
        ],
      };
    }
  }

  // 3. Computed userset — check parent relations
  const parentRelations = getParentRelations(namespace, relation);
  for (const parentRel of parentRelations) {
    const parentResult = await check(db, namespace, objectId, parentRel, subjectNs, subjectId, depth + 1, visited, budget);
    if (parentResult.allowed) {
      return {
        allowed: true,
        resolvedThrough: parentResult.resolvedThrough,
      };
    }
  }

  // 4. Tuple-to-userset — follow tupleset relation to another object, then check computed_userset there
  const ttuRules = getTupleToUsersetRules(namespace, relation);
  for (const rule of ttuRules) {
    const tuplesetTuples = await db
      .select()
      .from(relationTuples)
      .where(
        and(
          eq(relationTuples.namespace, namespace),
          eq(relationTuples.objectId, objectId),
          eq(relationTuples.relation, rule.tupleset),
        ),
      )
      .all();

    for (const tuple of tuplesetTuples) {
      const innerResult = await check(
        db,
        tuple.subjectNamespace,
        tuple.subjectId,
        rule.computed_userset,
        subjectNs,
        subjectId,
        depth + 1,
        visited,
        budget,
      );
      if (innerResult.allowed) {
        return {
          allowed: true,
          resolvedThrough: [
            formatTuple(namespace, objectId, rule.tupleset, tuple.subjectNamespace, tuple.subjectId, tuple.subjectRelation),
            ...innerResult.resolvedThrough,
          ],
        };
      }
    }
  }

  return { allowed: false, resolvedThrough: [] };
}

export async function expand(
  db: AppDatabase,
  namespace: string,
  objectId: string,
  relation: string,
  depth = 0,
  visited: Set<string> = new Set(),
): Promise<SubjectNode[]> {
  if (depth > MAX_DEPTH)
    return [];

  const key = expandKey(namespace, objectId, relation);
  if (visited.has(key))
    return [];
  visited.add(key);

  const tuples = await db
    .select()
    .from(relationTuples)
    .where(
      and(
        eq(relationTuples.namespace, namespace),
        eq(relationTuples.objectId, objectId),
        eq(relationTuples.relation, relation),
      ),
    )
    .all();

  const nodes: SubjectNode[] = [];

  for (const tuple of tuples) {
    if (tuple.subjectRelation) {
      const children = await expand(db, tuple.subjectNamespace, tuple.subjectId, tuple.subjectRelation, depth + 1, visited);
      nodes.push({
        namespace: tuple.subjectNamespace,
        id: tuple.subjectId,
        relation: tuple.subjectRelation,
        children,
      });
    }
    else {
      nodes.push({
        namespace: tuple.subjectNamespace,
        id: tuple.subjectId,
      });
    }
  }

  // Expand parent relations (computed_userset)
  const parentRelations = getParentRelations(namespace, relation);
  for (const parentRel of parentRelations) {
    const parentNodes = await expand(db, namespace, objectId, parentRel, depth + 1, visited);
    nodes.push(...parentNodes);
  }

  // Expand tuple_to_userset
  const ttuRules = getTupleToUsersetRules(namespace, relation);
  for (const rule of ttuRules) {
    const tuplesetTuples = await db
      .select()
      .from(relationTuples)
      .where(
        and(
          eq(relationTuples.namespace, namespace),
          eq(relationTuples.objectId, objectId),
          eq(relationTuples.relation, rule.tupleset),
        ),
      )
      .all();

    for (const tuple of tuplesetTuples) {
      const children = await expand(db, tuple.subjectNamespace, tuple.subjectId, rule.computed_userset, depth + 1, visited);
      nodes.push({
        namespace: tuple.subjectNamespace,
        id: tuple.subjectId,
        relation: rule.computed_userset,
        children,
      });
    }
  }

  return nodes;
}

export async function listUserResources(
  db: AppDatabase,
  userId: string,
  namespace: string,
  relation: string,
  budget: NodeBudget = makeBudget(),
): Promise<readonly string[]> {
  // Shared global budget across the resource_group recursion below. Fail
  // closed (return what we have) once exhausted.
  if (!spend(budget))
    return [];

  const objectIds = new Set<string>();
  const effectiveRelations = collectEffectiveRelations(namespace, relation);

  // 1. Direct user tuples
  const directTuples = await db
    .select()
    .from(relationTuples)
    .where(
      and(
        eq(relationTuples.namespace, namespace),
        inArray(relationTuples.relation, effectiveRelations),
        eq(relationTuples.subjectNamespace, "user"),
        eq(relationTuples.subjectId, userId),
        isNull(relationTuples.subjectRelation),
      ),
    )
    .all();

  for (const t of directTuples) {
    objectIds.add(t.objectId);
  }

  // 2. Through groups — recursively resolve all group memberships
  const allGroupIds = await resolveUserGroups(db, userId, budget);

  for (const groupId of allGroupIds) {
    const groupResourceTuples = await db
      .select()
      .from(relationTuples)
      .where(
        and(
          eq(relationTuples.namespace, namespace),
          inArray(relationTuples.relation, effectiveRelations),
          eq(relationTuples.subjectNamespace, "group"),
          eq(relationTuples.subjectId, groupId),
          eq(relationTuples.subjectRelation, "member"),
        ),
      )
      .all();

    for (const t of groupResourceTuples) {
      objectIds.add(t.objectId);
    }
  }

  // 3. Through tuple_to_userset (resource groups)
  for (const rel of effectiveRelations) {
    const ttuRules = getTupleToUsersetRules(namespace, rel);
    for (const rule of ttuRules) {
      const rgIds = await listUserResources(db, userId, "resource_group", rule.computed_userset, budget);

      for (const rgId of rgIds) {
        const memberTuples = await db
          .select()
          .from(relationTuples)
          .where(
            and(
              eq(relationTuples.namespace, namespace),
              eq(relationTuples.relation, rule.tupleset),
              eq(relationTuples.subjectNamespace, "resource_group"),
              eq(relationTuples.subjectId, rgId),
            ),
          )
          .all();

        for (const t of memberTuples) {
          objectIds.add(t.objectId);
        }
      }
    }
  }

  return [...objectIds];
}

/**
 * Recursively resolve all groups a user belongs to (handles nested groups).
 */
async function resolveUserGroups(db: AppDatabase, userId: string, budget: NodeBudget): Promise<readonly string[]> {
  const allGroups = new Set<string>();

  // Direct group memberships
  const directGroups = await db
    .select()
    .from(relationTuples)
    .where(
      and(
        eq(relationTuples.namespace, "group"),
        eq(relationTuples.relation, "member"),
        eq(relationTuples.subjectNamespace, "user"),
        eq(relationTuples.subjectId, userId),
        isNull(relationTuples.subjectRelation),
      ),
    )
    .all();

  const queue: string[] = [];
  for (const t of directGroups) {
    allGroups.add(t.objectId);
    queue.push(t.objectId);
  }

  // Resolve nested: groups that include other groups as members
  while (queue.length > 0) {
    if (!spend(budget))
      break;
    const groupId = queue.shift()!;
    const parentGroups = await db
      .select()
      .from(relationTuples)
      .where(
        and(
          eq(relationTuples.namespace, "group"),
          eq(relationTuples.relation, "member"),
          eq(relationTuples.subjectNamespace, "group"),
          eq(relationTuples.subjectId, groupId),
          eq(relationTuples.subjectRelation, "member"),
        ),
      )
      .all();

    for (const t of parentGroups) {
      if (!allGroups.has(t.objectId)) {
        allGroups.add(t.objectId);
        queue.push(t.objectId);
      }
    }
  }

  return [...allGroups];
}

/**
 * Collect all relations that effectively grant the target relation.
 * e.g. for app:viewer → [viewer, manager, admin]
 */
const MAX_EFFECTIVE_RELATIONS = 50;

function collectEffectiveRelations(namespace: string, relation: string): string[] {
  const result = [relation];
  const visited = new Set<string>([relation]);
  const queue = [relation];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const higherRelations = getParentRelations(namespace, current);
    for (const higher of higherRelations) {
      if (!visited.has(higher)) {
        if (result.length >= MAX_EFFECTIVE_RELATIONS) {
          throw new Error(`Effective relations exceeded limit of ${MAX_EFFECTIVE_RELATIONS} for ${namespace}:${relation}`);
        }
        visited.add(higher);
        result.push(higher);
        queue.push(higher);
      }
    }
  }

  return result;
}
