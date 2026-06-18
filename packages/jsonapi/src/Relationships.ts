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

import { Effect, Stream } from "effect";
import { ClientEngine, Subset } from "@thomasfosterau/effect-sync-core";
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

/** The collections a set of rows' named relationships point at. */
const targetCollections = (
  rows: ReadonlyArray<JsonApiRow>,
  names: ReadonlyArray<string>
): ReadonlySet<string> => {
  const collections = new Set<string>();
  for (const value of rows) {
    for (const name of names) {
      const ref = refOf(value, name);
      if (ref === null || ref === undefined) continue;
      for (const link of Array.isArray(ref) ? ref : [ref]) {
        if (isLink(link)) collections.add(link.type);
      }
    }
  }
  return collections;
};

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

/**
 * Live version of {@link query}: re-resolves on every local change (a write to
 * the base subset *or* to any referenced collection), like a reactive join.
 */
export const observe = (
  engine: ClientEngine.ClientEngine,
  subset: Subset.Subset,
  names: ReadonlyArray<string>
): Stream.Stream<ReadonlyArray<RelatedRow>, never, never> =>
  engine.observe(subset).pipe(
    Stream.orDie,
    Stream.mapEffect(() => query(engine, subset, names))
  );
