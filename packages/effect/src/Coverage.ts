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
 * 2. **Window.** The subscription is unwindowed (neither `limit` nor
 *    `cursor`), or the request asks for a prefix of the identical window:
 *    the same `orderBy`, the same cursor and, when the subscription is
 *    limited, a limit at most the subscription's. A windowed subscription
 *    never covers an unwindowed request, a different sort or a different
 *    cursor. A cursor alone is a window: `Subset.window` applies it
 *    regardless of `limit`, so a cursored subscription holds only the rows
 *    after its cursor in its order.
 * 3. **Predicate.** Both predicates canonicalise to a set of top-level
 *    conjuncts (nested `And` flattened, then sorted structurally; an absent
 *    `where`, `True` and an empty `And` are the empty set). An unwindowed
 *    subscription covers when its set is a subset of the request's: every
 *    row the request wants satisfies the subscription's conjuncts too, so
 *    it is in the replica, and the request's extra conjuncts filter
 *    locally. A windowed subscription holds a window of *its* predicate's
 *    rows and nothing else is promised, so it covers only the same
 *    conjunct set: a narrower request over a window may need rows past the
 *    limit, or place its cursor differently, than what synced (the ADR's
 *    "strict window").
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

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import type * as Collection from "./Collection.js";
import type { LocalRow } from "./ClientEngine.js";
import type * as Node from "./Node.js";
import * as Predicate from "./Predicate.js";
import * as Query from "./Query.js";
import * as Related from "./Related.js";
import * as Subset from "./Subset.js";

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
 * A registration as a ledger holds it: what it covers, and its canonical
 * URL — the subscription identity of ADR-0029 section 2 — when the ledger
 * knows one. A Client's ledger entries and the registrations an
 * `EngineHost` holds on mirrors' behalf are both this shape, so one
 * {@link verdictOf} scans either.
 */
export interface Subscription extends Registration {
  readonly url?: string;
}

/**
 * The outcome of a coverage check, recorded for devtools: which
 * subscription (by registration, subset hash and — when the subscription
 * has a URL form — canonical URL, the identity of ADR-0029 section 2)
 * answered a read locally, or that none did and the read fell through.
 */
export type Verdict =
  | {
      readonly _tag: "Covered";
      readonly by: Registration;
      readonly hash: string;
      readonly url?: string;
    }
  | { readonly _tag: "Uncovered" };

// ─── Structural keys ─────────────────────────────────────────────────────────

/** A literal's key: its type and its value, so `"1"` and `1` never collide. */
const literalKey = (literal: Predicate.Literal): string =>
  literal === null ? "null" : `${typeof literal}:${JSON.stringify(literal)}`;

/** Deduplicate and sort keys (plain string order; only determinism matters). */
const sortedUnique = (keys: ReadonlyArray<string>): ReadonlyArray<string> =>
  Arr.sort(new Set(keys), Order.String);

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
  const first = keys[0];
  if (keys.length === 1 && first !== undefined) return first;
  if (Arr.isReadonlyArrayEmpty(keys) && tag === "And") return "True";
  return `${tag}(${keys.join(",")})`;
};

type Leaf = Extract<
  Predicate.Predicate,
  { _tag: "True" | "Compare" | "In" | "NotIn" | "IsNull" | "InSet" }
>;

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
    case "InSet":
      return `InSet(${literalKey(leaf.field)},${literalKey(leaf.set)})`;
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

/** One top-level conjunct with its structural key (computed once). */
export interface Conjunct {
  readonly key: string;
  readonly predicate: Predicate.Predicate;
}

/**
 * A predicate as its set of top-level conjuncts: nested `And` flattened,
 * `True` members dropped, duplicates removed, sorted by
 * {@link structuralKey}. An absent `where`, `True` and an empty `And` all
 * yield the empty set. `Or`, `Not` and `Exists` members stay whole.
 */
export const canonicalConjuncts = (predicate: Predicate.Predicate): ReadonlyArray<Conjunct> => {
  const byKey = new Map<string, Predicate.Predicate>();
  Arr.forEach(flatten("And", [predicate]), (member) => {
    const key = structuralKey(member);
    if (key !== "True" && !byKey.has(key)) byKey.set(key, member);
  });
  return Arr.sort(
    byKey.entries(),
    Order.mapInput(Order.String, ([key]: readonly [string, Predicate.Predicate]) => key)
  ).map(([key, member]) => ({ key, predicate: member }));
};

const conjunctKeys = (predicate: Predicate.Predicate): ReadonlyArray<string> =>
  canonicalConjuncts(predicate).map((conjunct) => conjunct.key);

/** A request's predicate canonicalised once, for a scan across many subscriptions. */
interface RequestedKeys {
  readonly keys: ReadonlyArray<string>;
  readonly keySet: ReadonlySet<string>;
}

const requestedKeysOf = (predicate: Predicate.Predicate): RequestedKeys => {
  const keys = conjunctKeys(predicate);
  return { keys, keySet: new Set(keys) };
};

const subsumedBy = (subscribed: ReadonlyArray<string>, requested: ReadonlySet<string>): boolean =>
  subscribed.every((key) => requested.has(key));

const sameKeys = (subscribed: ReadonlyArray<string>, requested: ReadonlyArray<string>): boolean =>
  subscribed.length === requested.length &&
  subscribed.every((key, index) => key === requested[index]);

/**
 * Rule 3 for an unwindowed subscription: the subscription's conjunct set is
 * a subset of the request's under structural equality, so every row the
 * request wants is in the replica.
 */
export const subsumes = (
  subscribed: Predicate.Predicate,
  requested: Predicate.Predicate
): boolean => subsumedBy(conjunctKeys(subscribed), new Set(conjunctKeys(requested)));

/** Whether two predicates are the same conjunct set (rule 3 under a windowed subscription). */
export const sameConjuncts = (
  subscribed: Predicate.Predicate,
  requested: Predicate.Predicate
): boolean => sameKeys(conjunctKeys(subscribed), conjunctKeys(requested));

// ─── Windows (rule 2) ────────────────────────────────────────────────────────

/**
 * Whether a subset holds a window rather than the whole predicate: a
 * `limit`, a `cursor`, or both. `Query.plan` emits a cursor without a limit
 * for `{ after }` alone, and `Subset.window` applies it regardless.
 */
export const isWindowed = (subset: Subset.Subset): boolean =>
  subset.limit !== undefined || subset.cursor !== undefined;

const sameOrder = (
  subscribed: ReadonlyArray<Subset.OrderBy>,
  requested: ReadonlyArray<Subset.OrderBy>
): boolean =>
  subscribed.length === requested.length &&
  subscribed.every(
    (term, index) =>
      term.field === requested[index]?.field && term.direction === requested[index]?.direction
  );

/** An unlimited subscription holds every row after its cursor; a limited one a prefix. */
const limitPrefix = (subscribed: number | undefined, requested: number | undefined): boolean =>
  subscribed === undefined || (requested !== undefined && requested <= subscribed);

/**
 * Rule 2: an unwindowed subscription covers any window; a windowed one
 * covers only a prefix of the identical window (same order, same cursor,
 * and a limit at most its own when it has one).
 */
export const coversWindow = (subscribed: Subset.Subset, requested: Subset.Subset): boolean =>
  !isWindowed(subscribed) ||
  (requested.cursor === subscribed.cursor &&
    sameOrder(subscribed.orderBy, requested.orderBy) &&
    limitPrefix(subscribed.limit, requested.limit));

/** Rule 3 as it depends on rule 2, over a request canonicalised once. */
const coversKeys = (subscribed: Subset.Subset, requested: RequestedKeys): boolean =>
  isWindowed(subscribed)
    ? sameKeys(conjunctKeys(subscribed.where), requested.keys)
    : subsumedBy(conjunctKeys(subscribed.where), requested.keySet);

/**
 * Rule 3 as it depends on rule 2: an unwindowed subscription's conjuncts
 * need only be a subset of the request's; a windowed subscription holds a
 * window of *its* predicate's rows, so the conjunct sets must be the same.
 */
export const coversPredicate = (subscribed: Subset.Subset, requested: Subset.Subset): boolean =>
  coversKeys(subscribed, requestedKeysOf(requested.where));

/** Rules 1 to 3: whether a subscribed root window covers a requested one. */
export const covers = (subscribed: Subset.Subset, requested: Subset.Subset): boolean =>
  subscribed.collection === requested.collection &&
  coversWindow(subscribed, requested) &&
  coversPredicate(subscribed, requested);

// ─── Includes (rule 4) ───────────────────────────────────────────────────────

/** One requested edge select against one held select: same edge, window a prefix. */
const coversEdge = (subscribed: Related.EdgeSelect, requested: Related.EdgeSelect): boolean =>
  subscribed.name === requested.name && limitPrefix(subscribed.first, requested.first);

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

// ─── The rule ────────────────────────────────────────────────────────────────

/** A request canonicalised once for a scan: its registration plus its conjunct keys. */
interface CanonicalRequest extends Registration, RequestedKeys {}

const canonical = (requested: Registration): CanonicalRequest => ({
  ...requested,
  ...requestedKeysOf(requested.root.where),
});

/** All four rules against a request canonicalised once. */
const coversCanonical = (subscribed: Registration, requested: CanonicalRequest): boolean =>
  subscribed.root.collection === requested.root.collection &&
  coversWindow(subscribed.root, requested.root) &&
  coversKeys(subscribed.root, requested) &&
  coversEdges(subscribed.edges, requested.edges);

/** All four rules: whether a subscription's registration covers a request's. */
export const coversRegistration = (subscribed: Registration, requested: Registration): boolean =>
  coversCanonical(subscribed, canonical(requested));

/**
 * The first subscription, in iteration order, covering a request — or
 * `undefined` when none does. The request is canonicalised once; each
 * check is then a small structural comparison, O(#subscriptions) in all. A
 * ledger index by collection is the refinement if a real app holds
 * hundreds.
 */
export const covering = <S extends Registration>(
  subscriptions: Iterable<S>,
  requested: Registration
): S | undefined => {
  const request = canonical(requested);
  return Option.getOrUndefined(
    Arr.findFirst(subscriptions, (subscription) => coversCanonical(subscription, request))
  );
};

// ─── Pulled windows (#426) ───────────────────────────────────────────────────

/**
 * One window a registration holds and whether its rows are in the replica:
 * pulled once a pull that started after it was held has applied, or once an
 * already-pulled window covers it (`PullMarks`).
 */
export interface PulledWindow {
  readonly subset: Subset.Subset;
  readonly pulled: boolean;
}

/**
 * What a registration's windows hold in the replica (ADR-0029 section 3,
 * #426): every window it holds, the root included, each with its own mark.
 * Marked per window by `PullMarks`, so a window added later does not move
 * the others, and a read is judged only by the windows its rows link to.
 */
export interface Pulled {
  readonly windows: ReadonlyArray<PulledWindow>;
}

/** A registration none of whose windows is pulled. */
export const NOT_PULLED: Pulled = { windows: [] };

/**
 * A window's identity: its collection, canonical predicate, order, limit and
 * cursor. Unlike `Subset.hash`, key order does not matter, so a window a
 * mirror decoded from a message matches the one a read builds locally.
 */
export const windowKey = (window: Subset.Subset): string =>
  JSON.stringify([
    window.collection,
    structuralKey(window.where),
    window.orderBy.map((term) => [term.field, term.direction]),
    window.limit ?? null,
    window.cursor ?? null,
  ]);

/** The field and the values an unwindowed window pins: `field IN (...)` or `field = value`. */
const pinnedOf = (
  where: Predicate.Predicate
): { readonly field: string; readonly values: ReadonlyArray<string> } | undefined => {
  if (where._tag === "In") return { field: where.field, values: where.values.map(literalKey) };
  if (where._tag === "Compare" && where.op === "eq") {
    return { field: where.field, values: [literalKey(where.value)] };
  }
  return undefined;
};

/** Whether a window is held and pulled exactly (its identity), with no covering: the root's check. */
const heldPulled = (held: ReadonlyArray<PulledWindow>, window: Subset.Subset): boolean => {
  const key = windowKey(window);
  return held.some((entry) => entry.pulled && windowKey(entry.subset) === key);
};

/**
 * Whether the rows of one window are in the replica. A pulled window that
 * covers it under rules 1 to 3 is (the same window, or a prefix of it, or an
 * unwindowed window over its predicate; ADR-0029 section 3). An unwindowed
 * window (`field IN (...)` or `field = value`) is also, when pulled unwindowed
 * windows of its collection pin every one of its values: their rows are the
 * rows it reads.
 */
const windowPulled = (held: ReadonlyArray<PulledWindow>, window: Subset.Subset): boolean => {
  const key = windowKey(window);
  if (
    held.some(
      (entry) => entry.pulled && (windowKey(entry.subset) === key || covers(entry.subset, window))
    )
  ) {
    return true;
  }
  if (isWindowed(window)) return false;
  const wanted = pinnedOf(window.where);
  if (wanted === undefined) return false;
  const have = new Set<string>();
  Arr.forEach(held, (entry) => {
    if (!entry.pulled || isWindowed(entry.subset)) return;
    if (entry.subset.collection !== window.collection) return;
    const pinned = pinnedOf(entry.subset.where);
    if (pinned === undefined || pinned.field !== wanted.field) return;
    Arr.forEach(pinned.values, (value) => {
      have.add(value);
    });
  });
  return wanted.values.every((value) => have.has(value));
};

/**
 * The root rows a caller read once for a request, with the subset they are of. A
 * verdict judged over `rows` is judged over exactly the rows the caller answers from,
 * not a second read that a pull may have moved (#426).
 */
export interface Snapshot {
  readonly subset: Subset.Subset;
  readonly rows: ReadonlyArray<LocalRow>;
}

/**
 * How a coverage check is judged. `snapshot` is used only for the subset it names:
 * any other subset is read through the ledger's own rows, so a snapshot of another
 * collection cannot under-judge a read. An options bag rather than a positional
 * argument, so a caller that passes the check to `Effect.forEach` (which passes an
 * index second) gets no snapshot instead of a wrong one.
 */
export interface JudgeOptions {
  readonly snapshot?: Snapshot | undefined;
}

/**
 * The rows of a snapshot as a {@link RowsOf}: the snapshot's rows for the subset it
 * is of (#426), and `rowsOf` for any other subset.
 */
export const snapshotOf =
  <E>(snapshot: Snapshot, rowsOf: RowsOf<E>): RowsOf<E> =>
  (subset) =>
    Subset.hash(subset) === Subset.hash(snapshot.subset)
      ? Effect.succeed(snapshot.rows)
      : rowsOf(subset);

/**
 * A request as the coverage scan takes it: its registration, plus the edge
 * windows its rows link to (`Related.windowsFor` over the root rows it reads).
 * A read whose rows link to no edge window needs only its root pulled.
 */
export interface Requested extends Registration {
  readonly windows: ReadonlyArray<Subset.Subset>;
}

/** The replica's rows of a subset, as the coverage check reads them. */
export type RowsOf<E> = (subset: Subset.Subset) => Effect.Effect<ReadonlyArray<LocalRow>, E>;

/**
 * A compiled read's request: its registration, and the edge windows its root
 * rows link to, read from the replica through `rowsOf`. Fails with what
 * `rowsOf` fails with; callers judge that as uncovered.
 */
export const requestedOf = <E>(
  registry: Collection.CollectionRegistry,
  plan: Query.Plan,
  rowsOf: RowsOf<E>
): Effect.Effect<Requested, E> => {
  const registration = ofPlan(plan);
  if (Arr.isReadonlyArrayEmpty(registration.edges))
    return Effect.succeed({ ...registration, windows: [] });
  return rowsOf(plan.root).pipe(
    Effect.map((rows) => ({
      ...registration,
      windows: Related.windowsFor(registry, plan.root.collection, registration.edges, rows),
    }))
  );
};

/** A ledger entry as the scan takes it: a subscription with its pulled summary. */
export interface Entry extends Subscription {
  readonly pulled: Pulled;
}

/**
 * Whether a ledger entry's windows cover a request's: its root window is held
 * and pulled, and every edge window the request's rows link to is pulled
 * (`windowPulled`). An edge window the request needs and the entry does not
 * hold is not pulled, so a read is never answered from the replica before the
 * rows it links to have arrived (#426).
 */
export const pulledFor = (entry: Entry, requested: Requested): boolean =>
  heldPulled(entry.pulled.windows, entry.root) &&
  requested.windows.every((window) => windowPulled(entry.pulled.windows, window));

// ─── The verdict ─────────────────────────────────────────────────────────────

/**
 * The verdict of one scan: the first pulled entry, in iteration order,
 * covering the request — named by registration, subset hash and canonical
 * URL when it has one — or `Uncovered`. `Client.coverageOf` and a façade's
 * coverage check over a host's registrations both answer with this.
 */
export const verdictOf = (entries: Iterable<Entry>, requested: Requested): Verdict => {
  const by = covering(
    [...entries].filter((entry) => pulledFor(entry, requested)),
    requested
  );
  return by === undefined
    ? { _tag: "Uncovered" }
    : {
        _tag: "Covered",
        by: { root: by.root, edges: by.edges },
        hash: Subset.hash(by.root),
        ...(by.url === undefined ? {} : { url: by.url }),
      };
};

/**
 * A coverage check in `Client.coverageOf`'s shape over any ledger: the read
 * is compiled against the graph, its root rows read through `rowsOf` (the
 * replica's `query`), and its
 * registration scanned against the entries the ledger holds at that moment. A
 * façade in a service worker builds its check from the host's registrations
 * (`EngineHost.Host.registrations`), where no Client's ledger sees the
 * mirrors' pins. A failed read of the rows is uncovered: the read goes to the
 * server. `options.snapshot`, when given, is judged over for the subset it names (see {@link JudgeOptions}).
 */
export const coverageOf =
  <E>(nodes: Node.NodeRegistry, rowsOf: RowsOf<E>, entries: Effect.Effect<Iterable<Entry>>) =>
  (read: Query.Read, options?: JudgeOptions): Effect.Effect<Verdict> =>
    requestedOf(
      nodes.collections,
      Query.plan(nodes, read),
      options?.snapshot === undefined ? rowsOf : snapshotOf(options.snapshot, rowsOf)
    ).pipe(
      Effect.flatMap((requested) => Effect.map(entries, (held) => verdictOf(held, requested))),
      // oxlint-disable-next-line effect/effect-catchall-default -- `E` is the caller's generic row-read error, so its tags are not known here; any failed read is uncovered by contract.
      Effect.catch(() => Effect.succeed<Verdict>({ _tag: "Uncovered" }))
    );
