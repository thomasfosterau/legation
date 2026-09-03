/**
 * Coverage
 *
 * Whether a subscription in a Client's ledger **covers** a read, so the
 * read can be answered from the replica (ADR-0029 section 3, superseding
 * ADR-0025's exact-hash rule). Pure functions over compiled windows: no
 * evaluator runs at coverage time, so the check is syntactic and total and
 * cannot disagree with ADR-0028's semantics. A false negative costs one
 * server round trip; a false positive is impossible by construction.
 *
 * A subscription covers a request iff all of the following hold.
 *
 * 1. **Collection.** The same collection.
 * 2. **Window.** The subscription is unwindowed, or the request asks for a
 *    prefix of the identical window: the same `orderBy`, the same cursor
 *    and a limit at most the subscription's. A windowed subscription never
 *    covers an unwindowed request, a different sort or a different cursor.
 * 3. **Predicate.** Both predicates canonicalise to a set of top-level
 *    conjuncts (nested `And` flattened, then sorted structurally; an absent
 *    `where`, `True` and an empty `And` are the empty set). An unwindowed
 *    subscription covers when its set is a subset of the request's: every
 *    row the request wants satisfies the subscription's conjuncts too, so
 *    it is in the replica, and the request's extra conjuncts filter
 *    locally. A windowed subscription holds the first N rows of *its*
 *    predicate and nothing else is promised, so it covers only the same
 *    conjunct set: a narrower request over a window may need rows past N
 *    that never synced (the ADR's "strict window").
 * 4. **Include.** Every edge the request includes is among the
 *    subscription's edge selects (those are what register the foreign
 *    windows, ADR-0024), and a paginated edge's `first` is at most the
 *    subscription's, or the subscription's select is unwindowed.
 *
 * Structural equality is by {@link structuralKey}: `Compare`, `In`, `NotIn`
 * and `IsNull` nodes agree on operator, field and typed literal, with
 * `In`/`NotIn` lists in canonical order; `Or`, `Not` and `Exists` subtrees
 * compare as whole conjuncts and nothing is inferred through them. Full
 * implication (`lt("price", 10)` under `lt("price", 20)`, an `In` over a
 * superset list) is deliberately not built (ADR-0029 section 3).
 */

import * as Predicate from "./Predicate.js";
import * as Query from "./Query.js";
import type * as Related from "./Related.js";
import type * as Subset from "./Subset.js";

/**
 * What a subscription registers and a request asks for: the root window
 * plus the edge selects that register (or would resolve through) the
 * foreign windows. The unit {@link coversRegistration} compares.
 */
export interface Registration {
  readonly root: Subset.Subset;
  readonly edges: ReadonlyArray<Related.EdgeSelect>;
}

/** The registration a compiled read declares: its root window and edge selects. */
export const ofPlan = (plan: Query.Plan): Registration => ({
  root: plan.root,
  edges: Query.edgeSelects(plan),
});

/**
 * The outcome of a coverage check, recorded for devtools: which
 * subscription (by registration and subset hash) answered a read locally,
 * or that none did and the read fell through.
 */
export type Verdict =
  | { readonly _tag: "Covered"; readonly by: Registration; readonly hash: string }
  | { readonly _tag: "Uncovered" };

// ─── Structural keys ─────────────────────────────────────────────────────────

/** A literal's key: its type and its value, so `"1"` and `1` never collide. */
const literalKey = (literal: Predicate.Literal): string =>
  literal === null ? "null" : `${typeof literal}:${JSON.stringify(literal)}`;

/** Deduplicate and sort keys (plain string order; only determinism matters). */
const sortedUnique = (keys: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(keys)].sort();

type Junction = "And" | "Or";

/** Flatten nested junctions of one kind: `And(a, And(b, c))` is `And(a, b, c)`. */
const flatten = (
  tag: Junction,
  members: ReadonlyArray<Predicate.Predicate>
): ReadonlyArray<Predicate.Predicate> =>
  members.flatMap((member) => (member._tag === tag ? flatten(tag, member.predicates) : [member]));

/**
 * The key of a junction: members flattened, keyed, deduplicated and sorted
 * (commutativity and idempotence are syntactic facts of `And`/`Or`). A
 * single member is the member itself; an empty `And` is `True`.
 */
const junctionKey = (tag: Junction, members: ReadonlyArray<Predicate.Predicate>): string => {
  const keys = sortedUnique(flatten(tag, members).map(structuralKey));
  if (keys.length === 1) return keys[0]!;
  if (keys.length === 0 && tag === "And") return "True";
  return `${tag}(${keys.join(",")})`;
};

type Leaf = Extract<Predicate.Predicate, { _tag: "True" | "Compare" | "In" | "NotIn" | "IsNull" }>;

/** The key of a leaf: operator, field and typed literal(s), lists in canonical order. */
const leafKey = (leaf: Leaf): string => {
  switch (leaf._tag) {
    case "True":
      return "True";
    case "Compare":
      return `Compare(${leaf.op},${JSON.stringify(leaf.field)},${literalKey(leaf.value)})`;
    case "In":
    case "NotIn":
      return `${leaf._tag}(${JSON.stringify(leaf.field)},[${sortedUnique(leaf.values.map(literalKey)).join(",")}])`;
    case "IsNull":
      return `IsNull(${JSON.stringify(leaf.field)},${leaf.negated === true})`;
  }
};

/**
 * A deterministic serialisation of a predicate for structural equality and
 * sorting. Unlike `Subset.hash` (`JSON.stringify`, key-order dependent) it
 * is canonical: junctions are flattened and their members sorted, `In` and
 * `NotIn` lists are sorted and deduplicated, literals carry their type, and
 * `IsNull` with `negated: false` keys as without it. Two predicates with
 * the same key are equal as `WHERE` clauses; the converse is not claimed.
 */
export const structuralKey = (predicate: Predicate.Predicate): string => {
  switch (predicate._tag) {
    case "And":
    case "Or":
      return junctionKey(predicate._tag, predicate.predicates);
    case "Not":
      return `Not(${structuralKey(predicate.predicate)})`;
    case "Exists":
      return `Exists(${JSON.stringify(predicate.collection)},${JSON.stringify(predicate.localField)},${JSON.stringify(predicate.foreignField)},${structuralKey(predicate.where)})`;
    default:
      return leafKey(predicate);
  }
};

// ─── Canonical conjuncts (rule 3) ────────────────────────────────────────────

/**
 * A predicate as its set of top-level conjuncts: nested `And` flattened,
 * `True` members dropped, duplicates removed, sorted by
 * {@link structuralKey}. An absent `where`, `True` and an empty `And` all
 * yield the empty set. `Or`, `Not` and `Exists` members stay whole.
 */
export const canonicalConjuncts = (
  predicate: Predicate.Predicate
): ReadonlyArray<Predicate.Predicate> => {
  const byKey = new Map<string, Predicate.Predicate>();
  for (const member of flatten("And", [predicate])) {
    const key = structuralKey(member);
    if (key !== "True" && !byKey.has(key)) byKey.set(key, member);
  }
  return [...byKey.keys()].sort().map((key) => byKey.get(key)!);
};

const conjunctKeys = (predicate: Predicate.Predicate): ReadonlyArray<string> =>
  canonicalConjuncts(predicate).map(structuralKey);

/**
 * Rule 3 for an unwindowed subscription: the subscription's conjunct set is
 * a subset of the request's under structural equality, so every row the
 * request wants is in the replica.
 */
export const subsumes = (
  subscribed: Predicate.Predicate,
  requested: Predicate.Predicate
): boolean => {
  const held = new Set(conjunctKeys(requested));
  return conjunctKeys(subscribed).every((key) => held.has(key));
};

/** Whether two predicates are the same conjunct set (rule 3 under a windowed subscription). */
export const sameConjuncts = (
  subscribed: Predicate.Predicate,
  requested: Predicate.Predicate
): boolean => {
  const left = conjunctKeys(subscribed);
  const right = conjunctKeys(requested);
  return left.length === right.length && left.every((key, index) => key === right[index]);
};

// ─── Windows (rule 2) ────────────────────────────────────────────────────────

const sameOrder = (
  subscribed: ReadonlyArray<Subset.OrderBy>,
  requested: ReadonlyArray<Subset.OrderBy>
): boolean =>
  subscribed.length === requested.length &&
  subscribed.every(
    (term, index) =>
      term.field === requested[index]!.field && term.direction === requested[index]!.direction
  );

/**
 * Rule 2: an unwindowed subscription covers any window; a windowed one
 * covers only a prefix of the identical window (same order, same cursor,
 * a limit at most its own).
 */
export const coversWindow = (subscribed: Subset.Subset, requested: Subset.Subset): boolean =>
  subscribed.limit === undefined ||
  (requested.limit !== undefined &&
    requested.limit <= subscribed.limit &&
    requested.cursor === subscribed.cursor &&
    sameOrder(subscribed.orderBy, requested.orderBy));

/**
 * Rule 3 as it depends on rule 2: an unwindowed subscription's conjuncts
 * need only be a subset of the request's; a windowed subscription holds a
 * prefix of *its* predicate's rows, so the conjunct sets must be the same.
 */
export const coversPredicate = (subscribed: Subset.Subset, requested: Subset.Subset): boolean =>
  subscribed.limit === undefined
    ? subsumes(subscribed.where, requested.where)
    : sameConjuncts(subscribed.where, requested.where);

/** Rules 1 to 3: whether a subscribed root window covers a requested one. */
export const covers = (subscribed: Subset.Subset, requested: Subset.Subset): boolean =>
  subscribed.collection === requested.collection &&
  coversWindow(subscribed, requested) &&
  coversPredicate(subscribed, requested);

// ─── Includes (rule 4) ───────────────────────────────────────────────────────

/** One requested edge select against one held select: same edge, window a prefix. */
const coversEdge = (subscribed: Related.EdgeSelect, requested: Related.EdgeSelect): boolean =>
  subscribed.name === requested.name &&
  (subscribed.first === undefined ||
    (requested.first !== undefined && requested.first <= subscribed.first));

/**
 * Rule 4: every requested edge is among the subscription's edge selects,
 * and a paginated edge's window is at most the subscription's (or the
 * subscription's select is unwindowed). Edge order is declared by the edge
 * (ADR-0024), so it never differs.
 */
export const coversEdges = (
  subscribed: ReadonlyArray<Related.EdgeSelect>,
  requested: ReadonlyArray<Related.EdgeSelect>
): boolean => requested.every((edge) => subscribed.some((held) => coversEdge(held, edge)));

/** The wider of two selects for one edge: unwindowed beats any window; else the larger. */
const widerEdge = (left: Related.EdgeSelect, right: Related.EdgeSelect): Related.EdgeSelect =>
  left.first === undefined || right.first === undefined
    ? { name: left.name }
    : { name: left.name, first: Math.max(left.first, right.first) };

/**
 * Merge the edge selects a second pin of the same root window declares
 * into those already held, keeping the wider select per edge. The ledger
 * uses it when two subscriptions share a root window.
 */
export const widenEdges = (
  held: ReadonlyArray<Related.EdgeSelect>,
  declared: ReadonlyArray<Related.EdgeSelect>
): ReadonlyArray<Related.EdgeSelect> => {
  const byName = new Map(held.map((edge) => [edge.name, edge] as const));
  for (const edge of declared) {
    const current = byName.get(edge.name);
    byName.set(edge.name, current === undefined ? edge : widerEdge(current, edge));
  }
  return [...byName.values()];
};

// ─── The rule ────────────────────────────────────────────────────────────────

/** All four rules: whether a subscription's registration covers a request's. */
export const coversRegistration = (subscribed: Registration, requested: Registration): boolean =>
  covers(subscribed.root, requested.root) && coversEdges(subscribed.edges, requested.edges);

/**
 * The first subscription covering a request, or `undefined` when none
 * does. O(#subscriptions), each check a small structural comparison; a
 * ledger index by collection is the refinement if a real app holds hundreds.
 */
export const covering = <S extends Registration>(
  subscriptions: Iterable<S>,
  requested: Registration
): S | undefined => {
  for (const subscription of subscriptions) {
    if (coversRegistration(subscription, requested)) return subscription;
  }
  return undefined;
};
