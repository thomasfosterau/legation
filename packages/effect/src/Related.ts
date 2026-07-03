/**
 * Related
 *
 * Read-side relationship resolution over the local mirror, resolved via the
 * field mappings a collection declares (`Collection.Relationship`). Once the
 * foreign collections are synced, a declared relationship name resolves to the
 * actual related row value(s) — a client-side join over already-synced data, no
 * extra request (issue #38).
 *
 * This is the protocol-agnostic core of the "relationships / joins" gap. The
 * incremental-join plumbing (base `observe` → target collections → per-collection
 * index → `switchMap` on linkage shift → dedup; auto-subscribe the narrowed
 * foreign subsets + scope teardown) is generic and parameterised by a
 * {@link Strategy}: a `targets` function (which foreign collection + which
 * `foreignField` values to pin) and a `resolveRow` function (how a base row's
 * relationships resolve against the per-collection index). Core supplies the
 * field-mapping strategy ({@link fieldMappingStrategy}); an adapter such as
 * `@legation/jsonapi` supplies its own linkage-based strategy and reuses the
 * same machinery via {@link queryWith}/{@link observeWith}/{@link relatedWith}.
 */

import { Effect, Ref, Scope, Stream } from "effect";
import * as Collection from "./Collection.js";
import type { ClientEngine, LocalRow } from "./ClientEngine.js";
import type * as ClientView from "./ClientView.js";
import * as Predicate from "./Predicate.js";
import * as Subset from "./Subset.js";

/** A resolved relationship: a row value, a list of them, `null`, or `undefined`. */
export type RelatedValue = LocalRow["value"] | ReadonlyArray<LocalRow["value"]> | null | undefined;

/** A base row with its named relationships resolved against the mirror. */
export interface RelatedRow {
  readonly id: string;
  readonly value: unknown;
  readonly related: Record<string, RelatedValue>;
}

/**
 * The foreign rows a set of base rows pin in one collection: the `foreignField`
 * to match on, and the values it must take. Drives both which collection to
 * index and the narrowed subsets an auto-subscription registers — one
 * `foreignField IN (...)` subset, or with a {@link Target.window}, one windowed
 * `foreignField = value` subset **per value** (ADR-0024).
 */
export interface Target {
  readonly field: string;
  readonly ids: ReadonlySet<Predicate.Literal>;
  /**
   * The per-parent sync window a paginated edge declares: each pinned value
   * registers its own `(field = value, orderBy, limit)` subset, so the
   * replica syncs the window instead of the whole dependent collection.
   */
  readonly window?: {
    readonly orderBy: ReadonlyArray<Subset.OrderBy>;
    readonly limit: number;
  };
}

/**
 * One edge of a relational read: the relationship name, plus the read's
 * per-edge window (`first`) for paginated edges. A bare string selects the
 * edge unwindowed.
 */
export interface EdgeSelect {
  readonly name: string;
  readonly first?: number;
}

/** Normalize an edge selection input. */
export const edgeSelect = (input: string | EdgeSelect): EdgeSelect =>
  typeof input === "string" ? { name: input } : input;

/**
 * The per-collection lookup the plumbing maintains: for each targeted
 * collection, its current rows grouped by the pinned `foreignField` value. A
 * `resolveRow` strategy reads related rows out of it by the base row's join key.
 */
export type CollectionIndex = ReadonlyMap<
  string,
  ReadonlyMap<Predicate.Literal, ReadonlyArray<LocalRow>>
>;

/**
 * The resolution strategy the generic plumbing is parameterised by. `targets`
 * decides which foreign rows to pin (per collection, a `foreignField` + its
 * values); `resolveRow` turns the maintained {@link CollectionIndex} into a base
 * row's resolved relationships. Core's {@link fieldMappingStrategy} resolves via
 * declared field mappings; an adapter can supply a different extraction model
 * (e.g. JSON:API linkage) over the same machinery.
 */
export interface Strategy {
  readonly targets: (baseRows: ReadonlyArray<LocalRow>) => ReadonlyMap<string, Target>;
  readonly resolveRow: (index: CollectionIndex, baseRow: LocalRow) => Record<string, RelatedValue>;
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

const fieldOf = (value: unknown, field: string): unknown =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[field]
    : undefined;

/** Group a collection's rows by the value of one field (the pinned join key). */
const groupByField = (
  rows: ReadonlyArray<LocalRow>,
  field: string
): Map<Predicate.Literal, ReadonlyArray<LocalRow>> => {
  const map = new Map<Predicate.Literal, Array<LocalRow>>();
  for (const row of rows) {
    const key = fieldOf(row.value, field) as Predicate.Literal;
    const bucket = map.get(key);
    if (bucket === undefined) map.set(key, [row]);
    else bucket.push(row);
  }
  return map;
};

/** Two resolved relationship values are equal when they share row references. */
const sameRelated = (a: RelatedValue, b: RelatedValue): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((row, i) => row === b[i]);
  }
  return false;
};

/** Two joins are equal when base rows and every resolved relationship match by reference. */
const sameJoin = (a: ReadonlyArray<RelatedRow>, b: ReadonlyArray<RelatedRow>): boolean =>
  a.length === b.length &&
  a.every((row, i) => {
    const other = b[i]!;
    if (row.id !== other.id || row.value !== other.value) return false;
    const names = Object.keys(row.related);
    return (
      names.length === Object.keys(other.related).length &&
      names.every((name) => sameRelated(row.related[name], other.related[name]))
    );
  });

// ─── Field-mapping strategy ──────────────────────────────────────────────────

/**
 * A resolution strategy over declared field mappings: `targets` pins each
 * relationship's foreign collection by its `foreignField` and the base rows'
 * `localField` values; `resolveRow` looks each base row up in the index by its
 * `localField` value, yielding the single foreign row (`"one"`) or the array of
 * them (`"many"`).
 *
 * All relationships pointing at the same collection are expected to share a
 * `foreignField` (the usual case: `"id"` for `"one"`, one FK for `"many"`);
 * `targets` pins the collection by the first relationship's `foreignField`.
 *
 * A `"paginated"` relationship carrying a `first` pins a **windowed** target
 * (its declared order + the read's limit — ADR-0024). When two relationships
 * pin the same collection, the target falls back to the unwindowed superset:
 * sound, merely over-syncs.
 */
/** The per-parent window a selected relationship pins, when it does. */
const windowOf = (
  relationship: Collection.Relationship & { readonly first?: number }
): Target["window"] | undefined =>
  relationship.kind === "paginated" &&
  relationship.first !== undefined &&
  relationship.order !== undefined &&
  relationship.order.length > 0
    ? { orderBy: relationship.order, limit: relationship.first }
    : undefined;

/** Collect the non-null `localField` values a relationship pins. */
const pinIds = (
  ids: Set<Predicate.Literal>,
  baseRows: ReadonlyArray<LocalRow>,
  localField: string
): void => {
  for (const row of baseRows) {
    const value = fieldOf(row.value, localField);
    if (value !== undefined && value !== null) ids.add(value as Predicate.Literal);
  }
};

export const fieldMappingStrategy = (
  relationships: ReadonlyArray<Collection.Relationship & { readonly first?: number }>
): Strategy => ({
  targets: (baseRows) => {
    const entries = new Map<
      string,
      { field: string; ids: Set<Predicate.Literal>; window: Target["window"] | undefined }
    >();
    for (const relationship of relationships) {
      const existing = entries.get(relationship.collection);
      const entry = existing ?? {
        field: relationship.foreignField,
        ids: new Set<Predicate.Literal>(),
        window: windowOf(relationship),
      };
      // A second relationship pinning the same collection: fall back to the
      // unwindowed superset (sound, merely over-syncs).
      if (existing !== undefined) entry.window = undefined;
      pinIds(entry.ids, baseRows, relationship.localField);
      entries.set(relationship.collection, entry);
    }
    const map = new Map<string, Target>();
    for (const [collection, entry] of entries) {
      map.set(collection, {
        field: entry.field,
        ids: entry.ids,
        ...(entry.window === undefined ? {} : { window: entry.window }),
      });
    }
    return map;
  },
  resolveRow: (index, baseRow) => {
    const related: Record<string, RelatedValue> = {};
    for (const relationship of relationships) {
      const key = fieldOf(baseRow.value, relationship.localField) as Predicate.Literal;
      const bucket = index.get(relationship.collection)?.get(key);
      related[relationship.name] =
        relationship.kind === "one"
          ? bucket !== undefined && bucket.length > 0
            ? bucket[0]!.value
            : null
          : (bucket ?? []).map((row) => row.value);
    }
    return related;
  },
});

/** The declared relationships an edge selection picks (unknown names skipped). */
const selectRelationships = (
  registry: Collection.CollectionRegistry,
  collectionName: string,
  edges: ReadonlyArray<string | EdgeSelect>
): ReadonlyArray<Collection.Relationship & { readonly first?: number }> => {
  const all = Collection.relationshipsOf(registry, collectionName);
  const selected: Array<Collection.Relationship & { readonly first?: number }> = [];
  for (const input of edges) {
    const select = edgeSelect(input);
    const relationship = all.get(select.name);
    if (relationship !== undefined) {
      selected.push({
        ...relationship,
        ...(select.first === undefined ? {} : { first: select.first }),
      });
    }
  }
  return selected;
};

// ─── Generic plumbing (strategy-parameterised) ───────────────────────────────

const hydrate = (
  strategy: Strategy,
  base: ReadonlyArray<LocalRow>,
  index: CollectionIndex
): ReadonlyArray<RelatedRow> =>
  base.map((row) => ({ id: row.id, value: row.value, related: strategy.resolveRow(index, row) }));

/** Prime one index entry per targeted collection from the current local view. */
const primeIndex = (
  view: ClientView.Reader,
  targets: ReadonlyMap<string, Target>
): Effect.Effect<Map<string, ReadonlyMap<Predicate.Literal, ReadonlyArray<LocalRow>>>, never> =>
  Effect.gen(function* () {
    const index = new Map<string, ReadonlyMap<Predicate.Literal, ReadonlyArray<LocalRow>>>();
    for (const [collection, target] of targets) {
      const rows = yield* view.query(Subset.make({ collection })).pipe(Effect.orDie);
      index.set(collection, groupByField(rows, target.field));
    }
    return index;
  });

/**
 * Resolve a subset's rows together with their relationships, reading the
 * targeted collections from the engine's local view (one-shot).
 */
export const queryWith = (
  view: ClientView.Reader,
  strategy: Strategy,
  subset: Subset.Subset
): Effect.Effect<ReadonlyArray<RelatedRow>, never> =>
  Effect.gen(function* () {
    const base = yield* view.query(subset).pipe(Effect.orDie);
    const index = yield* primeIndex(view, strategy.targets(base));
    return hydrate(strategy, base, index);
  });

/**
 * Live version of {@link queryWith} as an incrementally-maintained join. The
 * base page is kept current by `engine.observe(subset)`; each targeted
 * collection by its own `engine.observe`, so a write to a related row
 * re-hydrates the join without re-querying the base. When a base change shifts
 * *which* collections are targeted, `switchMap` re-establishes the observers.
 * Per collection the index slice is rebuilt only on that collection's change;
 * changes that don't move the resolved result are deduped away.
 */
export const observeWith = (
  view: ClientView.Reader,
  strategy: Strategy,
  subset: Subset.Subset
): Stream.Stream<ReadonlyArray<RelatedRow>, never> =>
  view.observe(subset).pipe(
    Stream.orDie,
    Stream.switchMap((base) => {
      const targets = strategy.targets(base);
      return Stream.unwrap(
        Effect.gen(function* () {
          const index = yield* primeIndex(view, targets);
          const updates = Stream.mergeAll(
            [...targets].map(([collection, target]) =>
              view.observe(Subset.make({ collection })).pipe(
                Stream.orDie,
                // The observer's initial current-rows emission is NOT dropped:
                // a write landing between `primeIndex` and this subscription
                // would otherwise be swallowed, leaving the join stale until
                // the next foreign write. Rebuilding from an unchanged initial
                // emission re-hydrates to the same join, which `changesWith`
                // dedups away.
                Stream.map((rows) => {
                  index.set(collection, groupByField(rows, target.field));
                  return hydrate(strategy, base, index);
                })
              )
            ),
            { concurrency: "unbounded" }
          );
          return Stream.concat(Stream.succeed(hydrate(strategy, base, index)), updates);
        })
      );
    }),
    Stream.changesWith(sameJoin)
  );

/**
 * The narrowed subsets a base page's targets pin: one `foreignField IN (...)`
 * subset per unwindowed target; for windowed targets, one
 * `(foreignField = value, orderBy, limit)` subset **per pinned value** — the
 * per-parent sync windows of ADR-0024.
 */
const desiredSubsets = (
  strategy: Strategy,
  base: ReadonlyArray<LocalRow>
): ReadonlyArray<Subset.Subset> =>
  [...strategy.targets(base)]
    .filter(([, target]) => target.ids.size > 0)
    .flatMap(([collection, target]) =>
      target.window === undefined
        ? [Subset.make({ collection, where: Predicate.isIn(target.field, [...target.ids]) })]
        : [...target.ids].map((id) =>
            Subset.make({
              collection,
              where: Predicate.eq(target.field, id),
              orderBy: target.window!.orderBy,
              limit: target.window!.limit,
            })
          )
    );

const hasSubset = (list: ReadonlyArray<Subset.Subset>, subset: Subset.Subset): boolean =>
  list.some((other) => Subset.hash(other) === Subset.hash(subset));

/** Diff subscribed vs desired foreign subsets; returns whether anything changed. */
const reconcile = (
  engine: ClientEngine,
  subscribed: Ref.Ref<ReadonlyArray<Subset.Subset>>,
  desired: ReadonlyArray<Subset.Subset>
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const previous = yield* Ref.get(subscribed);
    let changed = false;
    for (const stale of previous) {
      if (!hasSubset(desired, stale)) {
        yield* engine.unsubscribe(stale);
        changed = true;
      }
    }
    for (const next of desired) {
      if (!hasSubset(previous, next)) {
        yield* engine.subscribe(next);
        changed = true;
      }
    }
    yield* Ref.set(subscribed, desired);
    return changed;
  });

/**
 * Auto-subscribing relational read: subscribes the base subset and, from its
 * rows, the narrowed `foreignField IN (...)` subsets of each targeted
 * collection — so the related rows sync without the caller wiring subscriptions.
 * The subscriptions track the live linkage (re-derived on every change) and are
 * torn down when the scope closes. Returns a stream that emits the resolved rows
 * and re-emits on any change.
 */
export const relatedWith = (
  engine: ClientEngine,
  strategy: Strategy,
  subset: Subset.Subset
): Effect.Effect<Stream.Stream<ReadonlyArray<RelatedRow>, never>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const subscribed = yield* Ref.make<ReadonlyArray<Subset.Subset>>([]);
    yield* engine.subscribe(subset);
    yield* Effect.addFinalizer(() =>
      Ref.get(subscribed).pipe(
        Effect.flatMap((subs) =>
          Effect.forEach([subset, ...subs], (s) => engine.unsubscribe(s), { discard: true })
        )
      )
    );
    // Initial base sync so the first relationship derivation sees real rows.
    yield* engine.pull.pipe(Effect.orDie);

    const refresh = Effect.gen(function* () {
      const base = yield* engine.query(subset).pipe(Effect.orDie);
      const changed = yield* reconcile(engine, subscribed, desiredSubsets(strategy, base));
      if (changed) yield* engine.pull.pipe(Effect.orDie);
    });

    // Sync the targeted collections up front so the first join is complete, then
    // keep the subscriptions tracking the live linkage as it changes.
    yield* refresh;
    return observeWith(engine, strategy, subset).pipe(Stream.tap(() => refresh));
  });

// ─── Public API (declared field mappings) ────────────────────────────────────

/** Resolve a subset's declared relationships against the mirror (one-shot). */
export const query = (
  view: ClientView.Reader,
  registry: Collection.CollectionRegistry,
  collectionName: string,
  subset: Subset.Subset,
  edges: ReadonlyArray<string | EdgeSelect>
): Effect.Effect<ReadonlyArray<RelatedRow>, never> =>
  queryWith(
    view,
    fieldMappingStrategy(selectRelationships(registry, collectionName, edges)),
    subset
  );

/** Live, incrementally-maintained join over a subset's declared relationships. */
export const observe = (
  view: ClientView.Reader,
  registry: Collection.CollectionRegistry,
  collectionName: string,
  subset: Subset.Subset,
  edges: ReadonlyArray<string | EdgeSelect>
): Stream.Stream<ReadonlyArray<RelatedRow>, never> =>
  observeWith(
    view,
    fieldMappingStrategy(selectRelationships(registry, collectionName, edges)),
    subset
  );

/**
 * Auto-subscribing relational read over a subset's declared relationships: syncs
 * the base and the narrowed foreign subsets, tracks the live linkage, and tears
 * the subscriptions down when the scope closes.
 */
export const related = (
  engine: ClientEngine,
  registry: Collection.CollectionRegistry,
  collectionName: string,
  subset: Subset.Subset,
  edges: ReadonlyArray<string | EdgeSelect>
): Effect.Effect<Stream.Stream<ReadonlyArray<RelatedRow>, never>, never, Scope.Scope> =>
  relatedWith(
    engine,
    fieldMappingStrategy(selectRelationships(registry, collectionName, edges)),
    subset
  );

/**
 * Rewrite every `Predicate.exists` node over a locally-synced collection to an
 * `In` over its `localField`, materialising the matching `foreignField` values
 * from the engine's local rows — the client-side analogue of the server's
 * `Predicate.resolveExists`. Once the foreign collection is synced, a subset
 * filtered by `Predicate.exists` evaluates correctly on the client.
 */
export const resolveExistsLocally = (
  view: ClientView.Reader,
  predicate: Predicate.Predicate
): Effect.Effect<Predicate.Predicate, never> =>
  Predicate.resolveExists(predicate, (node) =>
    view.query(Subset.make({ collection: node.collection })).pipe(
      Effect.map((rows) =>
        Predicate.existsValues(
          node,
          rows.map((row) => row.value)
        )
      ),
      Effect.orDie
    )
  );
