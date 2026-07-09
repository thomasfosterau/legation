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

import { Effect, Fiber, Queue, Ref, Scope, Stream } from "effect";
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

/**
 * Prime one index entry per targeted collection from the current local view:
 * only the pinned `foreignField IN (...)` rows, not the whole collection
 * (issue #113) — exactly what `resolveRow` ever looks up, and an `eq`/`In`
 * lookup the engine's secondary index can resolve without a full scan when
 * `target.field` is indexed. A target with no pinned ids needs no query.
 */
const primeIndex = (
  view: ClientView.Reader,
  targets: ReadonlyMap<string, Target>
): Effect.Effect<Map<string, ReadonlyMap<Predicate.Literal, ReadonlyArray<LocalRow>>>, never> =>
  Effect.gen(function* () {
    const index = new Map<string, ReadonlyMap<Predicate.Literal, ReadonlyArray<LocalRow>>>();
    for (const [collection, target] of targets) {
      const rows =
        target.ids.size === 0
          ? []
          : yield* view
              .query(
                Subset.make({ collection, where: Predicate.isIn(target.field, [...target.ids]) })
              )
              .pipe(Effect.orDie);
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
 * The delta-maintained join engine behind {@link observeWith} (issue #111).
 * Maintains, per targeted foreign collection, an incremental `fk → rows`
 * bucket index — a row put/del touches at most the one or two buckets its old
 * and new key select, never a full re-group (`groupByField` was the O(n)
 * offender) — plus a reverse index from `(collection, key)` to the base row
 * ids that key affects, so a foreign delta re-hydrates only the base rows it
 * actually touches, never the full base page. A base-row delta re-hydrates
 * only that row. Linkage shifts (which collections are targeted) are diffed
 * against the previously targeted set — the same diff-and-release shape as
 * {@link reconcile} — so already-targeted collections' indexes and observers
 * are left running instead of torn down and re-primed.
 *
 * `one`-edge presence transitions (a resolved edge appearing or disappearing)
 * need no special case: they fall out of re-running `resolveRow` for exactly
 * the affected base rows, same as any other bucket change.
 *
 * Pure and Effect-free — it consumes plain row snapshots, not streams or
 * subscriptions — so it can be driven directly by a property test comparing
 * it against {@link hydrateFromScratch} after every prefix of a randomized
 * delta sequence.
 */
export interface JoinEngine {
  /**
   * Apply a new base-page snapshot. `added`/`removed` are the collections the
   * caller must start/stop observing. `result` is the freshly hydrated page,
   * or `undefined` while any newly-targeted collection has not yet delivered
   * its first snapshot (the join isn't fully primed yet).
   */
  readonly applyBase: (rows: ReadonlyArray<LocalRow>) => {
    readonly added: ReadonlyArray<string>;
    readonly removed: ReadonlyArray<string>;
    readonly result: ReadonlyArray<RelatedRow> | undefined;
  };
  /** Apply a new snapshot for one currently-targeted foreign collection. */
  readonly applyForeign: (
    collection: string,
    rows: ReadonlyArray<LocalRow>
  ) => { readonly result: ReadonlyArray<RelatedRow> | undefined };
}

/** One targeted foreign collection's incrementally-maintained state. */
interface ForeignState {
  target: Target;
  /** Last-seen full snapshot, diffed against the next one to find the delta. */
  rowsById: Map<string, LocalRow>;
  /** `fk value → (row id → row)`, updated for only the touched key(s). */
  buckets: Map<Predicate.Literal, Map<string, LocalRow>>;
  /** `fk value → rows`: the {@link CollectionIndex} entry, cached from `buckets`. */
  results: Map<Predicate.Literal, ReadonlyArray<LocalRow>>;
}

/** The per-row key set a base row pins in each targeted collection. */
const rowKeysOf = (
  strategy: Strategy,
  row: LocalRow
): ReadonlyMap<string, ReadonlySet<Predicate.Literal>> => {
  const map = new Map<string, ReadonlySet<Predicate.Literal>>();
  for (const [collection, target] of strategy.targets([row])) map.set(collection, target.ids);
  return map;
};

/** {@inheritDoc JoinEngine} */
export const makeJoinEngine = (strategy: Strategy): JoinEngine => {
  let baseOrder: ReadonlyArray<string> = [];
  const baseRowsById = new Map<string, LocalRow>();
  const baseKeysById = new Map<string, ReadonlyMap<string, ReadonlySet<Predicate.Literal>>>();
  const resolvedById = new Map<string, RelatedRow>();
  const foreignByCollection = new Map<string, ForeignState>();
  const reverseIndex = new Map<string, Map<Predicate.Literal, Set<string>>>();
  // Collections newly targeted whose first snapshot hasn't arrived yet: while
  // non-empty the join is incompletely primed, so `result` stays `undefined`.
  const pendingCollections = new Set<string>();

  const indexView = (): CollectionIndex => {
    const map = new Map<string, ReadonlyMap<Predicate.Literal, ReadonlyArray<LocalRow>>>();
    for (const [collection, state] of foreignByCollection) map.set(collection, state.results);
    return map;
  };

  const hydrateRow = (row: LocalRow): RelatedRow => ({
    id: row.id,
    value: row.value,
    related: strategy.resolveRow(indexView(), row),
  });

  const rehydrateById = (id: string): void => {
    const row = baseRowsById.get(id);
    if (row !== undefined) resolvedById.set(id, hydrateRow(row));
  };

  // Visit every (collection, key) a row's key set touches, skipping
  // collections that aren't (or are no longer) targeted. `indexRow` and
  // `unindexRow` differ only in what they do at each (byKey, key) — this is
  // the shared traversal.
  const forEachIndexed = (
    keys: ReadonlyMap<string, ReadonlySet<Predicate.Literal>>,
    f: (byKey: Map<Predicate.Literal, Set<string>>, key: Predicate.Literal) => void
  ): void => {
    for (const [collection, ids] of keys) {
      const byKey = reverseIndex.get(collection);
      if (byKey === undefined) continue;
      for (const key of ids) f(byKey, key);
    }
  };

  const indexRow = (id: string, keys: ReadonlyMap<string, ReadonlySet<Predicate.Literal>>): void =>
    forEachIndexed(keys, (byKey, key) => {
      const set = byKey.get(key) ?? new Set<string>();
      set.add(id);
      byKey.set(key, set);
    });

  const unindexRow = (
    id: string,
    keys: ReadonlyMap<string, ReadonlySet<Predicate.Literal>>
  ): void =>
    forEachIndexed(keys, (byKey, key) => {
      const set = byKey.get(key);
      if (set === undefined) return;
      set.delete(id);
      if (set.size === 0) byKey.delete(key);
    });

  const addCollection = (collection: string, target: Target): void => {
    foreignByCollection.set(collection, {
      target,
      rowsById: new Map(),
      buckets: new Map(),
      results: new Map(),
    });
    reverseIndex.set(collection, new Map());
    pendingCollections.add(collection);
  };

  const removeCollection = (collection: string): void => {
    foreignByCollection.delete(collection);
    reverseIndex.delete(collection);
    pendingCollections.delete(collection);
  };

  const currentOutput = (): ReadonlyArray<RelatedRow> =>
    baseOrder.map((id) => resolvedById.get(id)!);

  /**
   * Diff the targeted collection set (the `reconcile` pattern, :366-388):
   * start observing newly-targeted collections, stop observing stale ones,
   * leave already-targeted ones (with the same join field) untouched.
   */
  const diffTargets = (
    nextTargets: ReadonlyMap<string, Target>
  ): { readonly added: ReadonlyArray<string>; readonly removed: ReadonlyArray<string> } => {
    const added: Array<string> = [];
    const removed: Array<string> = [];
    for (const [collection, target] of nextTargets) {
      const existing = foreignByCollection.get(collection);
      if (existing === undefined) {
        addCollection(collection, target);
        added.push(collection);
      } else if (existing.target.field !== target.field) {
        // The join key itself changed collection-wide: the maintained buckets
        // no longer mean anything, so re-prime from scratch.
        removeCollection(collection);
        addCollection(collection, target);
        removed.push(collection);
        added.push(collection);
      } else {
        existing.target = target;
      }
    }
    for (const collection of foreignByCollection.keys()) {
      if (!nextTargets.has(collection)) {
        removeCollection(collection);
        removed.push(collection);
      }
    }
    return { added, removed };
  };

  /** Diff the base page against the last snapshot, updating the reverse
   * index and re-hydrating only added/changed rows. */
  const diffBaseRows = (rows: ReadonlyArray<LocalRow>): void => {
    const nextIds = new Set(rows.map((row) => row.id));
    for (const id of baseRowsById.keys()) {
      if (nextIds.has(id)) continue;
      const keys = baseKeysById.get(id);
      if (keys !== undefined) unindexRow(id, keys);
      baseRowsById.delete(id);
      baseKeysById.delete(id);
      resolvedById.delete(id);
    }
    for (const row of rows) {
      const prior = baseRowsById.get(row.id);
      if (prior === row) continue; // reference-stable: nothing to redo
      const keys = rowKeysOf(strategy, row);
      const priorKeys = baseKeysById.get(row.id);
      if (priorKeys !== undefined) unindexRow(row.id, priorKeys);
      indexRow(row.id, keys);
      baseKeysById.set(row.id, keys);
      baseRowsById.set(row.id, row);
      resolvedById.set(row.id, hydrateRow(row));
    }
    baseOrder = rows.map((row) => row.id);
  };

  const applyBase: JoinEngine["applyBase"] = (rows) => {
    const { added, removed } = diffTargets(strategy.targets(rows));
    diffBaseRows(rows);
    return { added, removed, result: pendingCollections.size === 0 ? currentOutput() : undefined };
  };

  /**
   * Diff one foreign collection's new snapshot against its last one: an
   * unchanged row (same reference) is skipped; a changed or new row is
   * (re)placed in its current key's bucket, vacating its prior key's bucket
   * if the key moved; a row present before but not now is removed from its
   * bucket. Returns the keys whose bucket contents changed.
   */
  const diffForeignRows = (
    state: ForeignState,
    rows: ReadonlyArray<LocalRow>
  ): ReadonlySet<Predicate.Literal> => {
    const changedKeys = new Set<Predicate.Literal>();
    const keyOf = (row: LocalRow) => fieldOf(row.value, state.target.field) as Predicate.Literal;
    const putInto = (key: Predicate.Literal, row: LocalRow): void => {
      const bucket = state.buckets.get(key) ?? new Map<string, LocalRow>();
      bucket.set(row.id, row);
      state.buckets.set(key, bucket);
      state.results.set(key, [...bucket.values()]);
      changedKeys.add(key);
    };
    const removeFrom = (key: Predicate.Literal, id: string): void => {
      const bucket = state.buckets.get(key);
      if (bucket === undefined) return;
      bucket.delete(id);
      if (bucket.size === 0) {
        state.buckets.delete(key);
        state.results.delete(key);
      } else {
        state.results.set(key, [...bucket.values()]);
      }
      changedKeys.add(key);
    };

    const nextRowsById = new Map<string, LocalRow>();
    for (const row of rows) {
      nextRowsById.set(row.id, row);
      const prior = state.rowsById.get(row.id);
      if (prior === row) continue; // reference-stable: this row didn't change
      const key = keyOf(row);
      if (prior !== undefined && keyOf(prior) !== key) removeFrom(keyOf(prior), row.id);
      putInto(key, row);
    }
    for (const [id, prior] of state.rowsById) {
      if (!nextRowsById.has(id)) removeFrom(keyOf(prior), id); // deleted
    }
    state.rowsById = nextRowsById;
    return changedKeys;
  };

  /** The base row ids that depend on any of `changedKeys` in `collection`. */
  const affectedByKeys = (
    collection: string,
    changedKeys: ReadonlySet<Predicate.Literal>
  ): ReadonlySet<string> => {
    const affected = new Set<string>();
    const byKey = reverseIndex.get(collection);
    if (byKey === undefined) return affected;
    for (const key of changedKeys) {
      const ids = byKey.get(key);
      if (ids !== undefined) for (const id of ids) affected.add(id);
    }
    return affected;
  };

  const applyForeign: JoinEngine["applyForeign"] = (collection, rows) => {
    const state = foreignByCollection.get(collection);
    // A stale event for a collection this base page no longer targets.
    if (state === undefined) return { result: undefined };

    const changedKeys = diffForeignRows(state, rows);
    // The first snapshot for a newly-targeted collection always primes it,
    // even if it touches no base row yet (e.g. an empty foreign collection).
    const justPrimed = pendingCollections.delete(collection);
    const affected = affectedByKeys(collection, changedKeys);
    for (const id of affected) rehydrateById(id);

    if (pendingCollections.size > 0) return { result: undefined };
    if (affected.size === 0 && !justPrimed) return { result: undefined };
    return { result: currentOutput() };
  };

  return { applyBase, applyForeign };
};

/**
 * Pure from-scratch join: group every targeted collection's given rows by
 * field and hydrate the base page against them — the semantics
 * {@link makeJoinEngine} must match after every incremental step. Exported
 * for the delta-maintenance property test.
 */
export const hydrateFromScratch = (
  strategy: Strategy,
  base: ReadonlyArray<LocalRow>,
  foreignRows: ReadonlyMap<string, ReadonlyArray<LocalRow>>
): ReadonlyArray<RelatedRow> => {
  const targets = strategy.targets(base);
  const index = new Map<string, ReadonlyMap<Predicate.Literal, ReadonlyArray<LocalRow>>>();
  for (const [collection, target] of targets) {
    index.set(collection, groupByField(foreignRows.get(collection) ?? [], target.field));
  }
  return hydrate(strategy, base, index);
};

/** One raw snapshot arriving from the base subset or a targeted foreign collection. */
type JoinEvent =
  | { readonly _tag: "base"; readonly rows: ReadonlyArray<LocalRow> }
  | {
      readonly _tag: "foreign";
      readonly collection: string;
      readonly rows: ReadonlyArray<LocalRow>;
    };

/**
 * Live version of {@link queryWith} as an incrementally-maintained join
 * (issue #111). A {@link makeJoinEngine} consumes the base page and every
 * targeted foreign collection's snapshots as they arrive over `view.observe`
 * and re-hydrates only the base rows a delta actually touches — never a full
 * re-group or a full base re-hydrate. A collection is observed for as long as
 * (and only as long as) the base page targets it: a linkage shift diffs the
 * targeted set and starts/stops just the newly (un)targeted collections'
 * observers, leaving the rest running.
 */
export const observeWith = (
  view: ClientView.Reader,
  strategy: Strategy,
  subset: Subset.Subset
): Stream.Stream<ReadonlyArray<RelatedRow>, never> =>
  Stream.callback<ReadonlyArray<RelatedRow>>((output) =>
    Effect.gen(function* () {
      const engine = makeJoinEngine(strategy);
      const events = yield* Queue.unbounded<JoinEvent>();
      const collectionFibers = new Map<string, Fiber.Fiber<void, never>>();

      const emit = (result: ReadonlyArray<RelatedRow> | undefined) =>
        result === undefined ? Effect.void : Effect.asVoid(Queue.offer(output, result));

      const startCollection = (collection: string) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkScoped(
            Stream.runForEach(
              view.observe(Subset.make({ collection })).pipe(Stream.orDie),
              (rows) => Queue.offer(events, { _tag: "foreign", collection, rows })
            )
          );
          collectionFibers.set(collection, fiber);
        });

      const stopCollection = (collection: string) =>
        Effect.gen(function* () {
          const fiber = collectionFibers.get(collection);
          collectionFibers.delete(collection);
          if (fiber !== undefined) yield* Fiber.interrupt(fiber);
        });

      // The base observer runs for the join's whole lifetime; foreign
      // observers come and go with `applyBase`'s targeted-set diff below.
      yield* Effect.forkScoped(
        Stream.runForEach(view.observe(subset).pipe(Stream.orDie), (rows) =>
          Queue.offer(events, { _tag: "base", rows })
        )
      );

      yield* Effect.forkScoped(
        Effect.forever(
          Queue.take(events).pipe(
            Effect.flatMap((event) =>
              event._tag === "base"
                ? Effect.gen(function* () {
                    const { added, removed, result } = engine.applyBase(event.rows);
                    for (const collection of removed) yield* stopCollection(collection);
                    for (const collection of added) yield* startCollection(collection);
                    yield* emit(result);
                  })
                : emit(engine.applyForeign(event.collection, event.rows).result)
            )
          )
        )
      );
    })
  ).pipe(Stream.changesWith(sameJoin));

/**
 * The narrowed subsets a base page's targets pin: one `foreignField IN (...)`
 * subset per unwindowed target; for windowed targets, one
 * `(foreignField = value, orderBy, limit)` subset **per pinned value** — the
 * per-parent sync windows of ADR-0024.
 */
const desiredSubsets = (
  strategy: Strategy,
  base: ReadonlyArray<LocalRow>
): ReadonlyArray<Subset.Subset> => subsetsForTargets(strategy.targets(base));

/** The narrowed subsets a set of targets pins (see {@link desiredSubsets}). */
const subsetsForTargets = (targets: ReadonlyMap<string, Target>): ReadonlyArray<Subset.Subset> =>
  [...targets]
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

/** A row from an external source, tagged with its collection. */
export interface SourcedRow {
  readonly collection: string;
  readonly id: string;
  readonly value: unknown;
}

/**
 * One-shot relational read over an **external row source** — the
 * server-fallthrough tier (ADR-0025). Fetches the base subset, derives the
 * foreign subsets exactly as the auto-subscribing read would (including
 * ADR-0024's per-parent windows), fetches them in one batch, and assembles
 * the join with the same field-mapping resolution. Nothing is subscribed
 * and nothing enters the replica.
 */
export const queryVia = <E>(
  fetch: (subsets: ReadonlyArray<Subset.Subset>) => Effect.Effect<ReadonlyArray<SourcedRow>, E>,
  registry: Collection.CollectionRegistry,
  collectionName: string,
  subset: Subset.Subset,
  edges: ReadonlyArray<string | EdgeSelect>
): Effect.Effect<ReadonlyArray<RelatedRow>, E> =>
  Effect.gen(function* () {
    const strategy = fieldMappingStrategy(selectRelationships(registry, collectionName, edges));
    const base = (yield* fetch([subset]))
      .filter((row) => row.collection === subset.collection)
      .map(({ id, value }) => ({ id, value }));
    const targets = strategy.targets(base);
    const foreignSubsets = subsetsForTargets(targets);
    const foreign = foreignSubsets.length === 0 ? [] : yield* fetch(foreignSubsets);
    const index = new Map<string, ReadonlyMap<Predicate.Literal, ReadonlyArray<LocalRow>>>();
    for (const [collection, target] of targets) {
      index.set(
        collection,
        groupByField(
          foreign
            .filter((row) => row.collection === collection)
            .map(({ id, value }) => ({ id, value })),
          target.field
        )
      );
    }
    return hydrate(strategy, base, index);
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
