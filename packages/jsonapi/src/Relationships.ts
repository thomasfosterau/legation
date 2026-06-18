/**
 * Relationships
 *
 * Read-side relationship resolution: a JSON:API resource row carries
 * relationship *linkage* (`{ type, id }` references), and once the referenced
 * collections are synced into the local mirror, a relationship name resolves
 * to the actual related row value(s) — a client-side join over already-synced
 * data, no extra request.
 *
 * This is the read half of the "relationships / joins" gap (audit #10): a
 * `related()` over the local mirror. `observe` re-resolves on every local
 * change, so adding a comment updates the issue's `comments` immediately.
 *
 * The linkage shape is JSON:API's; the resolution is storage-agnostic (it only
 * needs a `(collection, id) → value` lookup).
 */

import { Effect, Ref, Scope, Stream } from "effect";
import { ClientEngine, Predicate, Subset } from "@thomasfosterau/effect-sync-core";
import type { RelationshipRef } from "./CollectionLoader.js";
import type { JsonApiRow } from "./Derive.js";

/** A resolved relationship: a row, a list of rows, `null`, or `undefined`. */
export type RelatedValue = JsonApiRow | ReadonlyArray<JsonApiRow> | null | undefined;

/** A base row with its named relationships resolved against the mirror. */
export interface RelatedRow {
  readonly id: string;
  readonly value: JsonApiRow;
  readonly related: Record<string, RelatedValue>;
}

/** Look up a row by (collection, id) from the local mirror. */
export type Lookup = (collection: string, id: string) => JsonApiRow | undefined;

const refOf = (value: JsonApiRow, name: string): RelationshipRef =>
  (value.relationships?.[name] ?? null) as RelationshipRef;

const isLink = (value: unknown): value is { readonly type: string; readonly id: string } =>
  typeof value === "object" && value !== null && "type" in value && "id" in value;

/** The `{ type, id }` links a row's named relationship points at. */
const linksOf = (
  value: JsonApiRow,
  name: string
): ReadonlyArray<{ readonly type: string; readonly id: string }> => {
  const ref = refOf(value, name);
  if (ref === null || ref === undefined) return [];
  return (Array.isArray(ref) ? ref : [ref]).filter(isLink);
};

/** Resolve one relationship of a row against a lookup (linkage → value[s]). */
export const resolve = (lookup: Lookup, value: JsonApiRow, name: string): RelatedValue => {
  const ref = refOf(value, name);
  if (ref === null || ref === undefined) return ref;
  if (Array.isArray(ref)) {
    const rows: Array<JsonApiRow> = [];
    for (const link of ref) {
      const row = lookup(link.type, link.id);
      if (row !== undefined) rows.push(row);
    }
    return rows;
  }
  return isLink(ref) ? lookup(ref.type, ref.id) : undefined;
};

/** Resolve several named relationships of a row. */
export const hydrate = (
  lookup: Lookup,
  value: JsonApiRow,
  names: ReadonlyArray<string>
): Record<string, RelatedValue> => {
  const related: Record<string, RelatedValue> = {};
  for (const name of names) related[name] = resolve(lookup, value, name);
  return related;
};

/** The (collection → referenced ids) a set of rows' named relationships pin. */
const targetIds = (
  rows: ReadonlyArray<JsonApiRow>,
  names: ReadonlyArray<string>
): Map<string, Set<string>> => {
  const map = new Map<string, Set<string>>();
  for (const value of rows) {
    for (const name of names) {
      for (const link of linksOf(value, name)) {
        const ids = map.get(link.type) ?? new Set<string>();
        ids.add(link.id);
        map.set(link.type, ids);
      }
    }
  }
  return map;
};

/** The collections a set of rows' named relationships point at. */
const targetCollections = (
  rows: ReadonlyArray<JsonApiRow>,
  names: ReadonlyArray<string>
): ReadonlySet<string> => new Set(targetIds(rows, names).keys());

/**
 * Resolve a subset's rows together with their named relationships, reading
 * the referenced collections from the engine's local view.
 */
export const query = (
  engine: ClientEngine.ClientEngine,
  subset: Subset.Subset,
  names: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<RelatedRow>, never, never> =>
  Effect.gen(function* () {
    const base = yield* engine.query(subset).pipe(Effect.orDie);
    const values = base.map((row) => row.value as JsonApiRow);

    const index = new Map<string, Map<string, JsonApiRow>>();
    for (const collection of targetCollections(values, names)) {
      const rows = yield* engine.query(Subset.make({ collection })).pipe(Effect.orDie);
      index.set(collection, new Map(rows.map((row) => [row.id, row.value as JsonApiRow])));
    }
    const lookup: Lookup = (collection, id) => index.get(collection)?.get(id);

    return base.map((row) => {
      const value = row.value as JsonApiRow;
      return { id: row.id, value, related: hydrate(lookup, value, names) };
    });
  });

/** A `(id → row)` index of a referenced collection's local rows. */
const indexOf = (rows: ReadonlyArray<ClientEngine.LocalRow>): Map<string, JsonApiRow> =>
  new Map(rows.map((row) => [row.id, row.value as JsonApiRow]));

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

/**
 * Live version of {@link query} as an incrementally-maintained join. The base
 * page is kept current by `engine.observe(subset)`; each referenced collection
 * by its own `engine.observe`, so a write to a related row re-hydrates the join
 * without re-querying the base. When a base change shifts *which* collections
 * are referenced, `switchMap` re-establishes the referenced observers. Per
 * collection the lookup index is cached and only the changed slice is rebuilt;
 * changes that don't move the resolved result are deduped away.
 */
export const observe = (
  engine: ClientEngine.ClientEngine,
  subset: Subset.Subset,
  names: ReadonlyArray<string>
): Stream.Stream<ReadonlyArray<RelatedRow>, never, never> =>
  engine.observe(subset).pipe(
    Stream.orDie,
    Stream.switchMap((base) => {
      const values = base.map((row) => row.value as JsonApiRow);
      const collections = [...targetCollections(values, names)];
      const hydrateWith = (
        index: ReadonlyMap<string, Map<string, JsonApiRow>>
      ): ReadonlyArray<RelatedRow> => {
        const lookup: Lookup = (collection, id) => index.get(collection)?.get(id);
        return base.map((row, i) => ({
          id: row.id,
          value: values[i]!,
          related: hydrate(lookup, values[i]!, names),
        }));
      };
      return Stream.unwrap(
        Effect.gen(function* () {
          // Prime each referenced collection so the first join is complete.
          const index = new Map<string, Map<string, JsonApiRow>>();
          for (const collection of collections) {
            const rows = yield* engine.query(Subset.make({ collection })).pipe(Effect.orDie);
            index.set(collection, indexOf(rows));
          }
          // Each referenced collection refreshes its own index slice on change,
          // dropping the redundant initial snapshot `observe` re-emits.
          const updates = Stream.mergeAll(
            collections.map((collection) =>
              engine.observe(Subset.make({ collection })).pipe(
                Stream.orDie,
                Stream.drop(1),
                Stream.map((rows) => {
                  index.set(collection, indexOf(rows));
                  return hydrateWith(index);
                })
              )
            ),
            { concurrency: "unbounded" }
          );
          return Stream.concat(Stream.succeed(hydrateWith(index)), updates);
        })
      );
    }),
    Stream.changesWith(sameJoin)
  );

/**
 * Auto-subscribing relational read: subscribes the base subset and, from its
 * rows, the narrowed `id IN (...)` subsets of each referenced collection — so
 * the related rows sync without the caller wiring up subscriptions. The
 * subscriptions track the live linkage (re-derived on every change) and are
 * torn down when the scope closes. Pair with the backend's `includes` config
 * to deliver the related rows in the parent's response (no extra round trip).
 *
 * Returns a stream that emits the resolved rows and re-emits on any change.
 */
export const related = (
  engine: ClientEngine.ClientEngine,
  subset: Subset.Subset,
  names: ReadonlyArray<string>
): Effect.Effect<Stream.Stream<ReadonlyArray<RelatedRow>, never, never>, never, Scope.Scope> =>
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
      const desired = [
        ...targetIds(
          base.map((row) => row.value as JsonApiRow),
          names
        ),
      ]
        .filter(([, ids]) => ids.size > 0)
        .map(([collection, ids]) =>
          Subset.make({ collection, where: Predicate.isIn("id", [...ids]) })
        );

      const previous = yield* Ref.get(subscribed);
      const has = (list: ReadonlyArray<Subset.Subset>, s: Subset.Subset) =>
        list.some((other) => Subset.hash(other) === Subset.hash(s));
      let changed = false;
      for (const stale of previous) {
        if (!has(desired, stale)) {
          yield* engine.unsubscribe(stale);
          changed = true;
        }
      }
      for (const next of desired) {
        if (!has(previous, next)) {
          yield* engine.subscribe(next);
          changed = true;
        }
      }
      yield* Ref.set(subscribed, desired);
      if (changed) yield* engine.pull.pipe(Effect.orDie);
    });

    // Sync the referenced collections up front so the first join is complete,
    // then keep the subscriptions tracking the live linkage as it changes.
    yield* refresh;
    return observe(engine, subset, names).pipe(Stream.tap(() => refresh));
  });
