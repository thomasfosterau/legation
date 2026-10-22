/**
 * Relationships
 *
 * Read-side relationship resolution: a JSON:API resource row carries
 * relationship *linkage* (`{ type, id }` references), and once the referenced
 * collections are synced into the local mirror, a relationship name resolves
 * to the actual related row value(s) — a client-side join over already-synced
 * data, no extra request.
 *
 * The incremental-join plumbing (base `observe` → target collections →
 * per-collection index → `switchMap` on linkage shift → dedup; auto-subscribe
 * the narrowed foreign subsets + scope teardown) is the protocol-agnostic core
 * `Related` module. This module supplies JSON:API's linkage-based
 * {@link Related.Strategy} — `targets` derived from `{ type, id }` refs,
 * `resolveRow` via {@link hydrate} over those refs — and reuses the shared
 * machinery, so `query`/`observe`/`related` are thin adapters over it with no
 * behaviour change (audit #10). The linkage extraction stays here; only the
 * generic pipeline is shared.
 */

import * as Effect from "effect/Effect";
import * as P from "effect/Predicate";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ClientEngine, Related, Subset } from "@thomasfosterau/legation-effect/internal";
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
  P.isObjectOrArray(value) && "type" in value && "id" in value;

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

// ─── Delegation to the core `Related` plumbing ───────────────────────────────
//
// JSON:API's relationship model differs from core's declared field mappings: it
// extracts `{ type, id }` linkage from the row value rather than matching a
// `localField`/`foreignField`. That difference is confined to the strategy; the
// incremental-join pipeline is the shared core module.

/**
 * The linkage strategy: `targets` pins each referenced collection by `id` and
 * the linked ids; `resolveRow` reads the referenced rows out of the index by id
 * and hydrates via {@link hydrate}, so resolution is byte-for-byte the previous
 * behaviour.
 */
const linkageStrategy = (names: ReadonlyArray<string>): Related.Strategy => ({
  targets: (baseRows) => {
    const map = new Map<string, { field: string; ids: Set<string> }>();
    for (const row of baseRows) {
      const value = row.value as JsonApiRow;
      for (const name of names) {
        for (const link of linksOf(value, name)) {
          const entry = map.get(link.type) ?? { field: "id", ids: new Set<string>() };
          entry.ids.add(link.id);
          map.set(link.type, entry);
        }
      }
    }
    return map;
  },
  resolveRow: (index, baseRow) => {
    const lookup: Lookup = (collection, id) =>
      index.get(collection)?.get(id)?.[0]?.value as JsonApiRow | undefined;
    return hydrate(lookup, baseRow.value as JsonApiRow, names);
  },
});

/**
 * Resolve a subset's rows together with their named relationships, reading the
 * referenced collections from the engine's local view. Delegates to
 * {@link Related.queryWith} with the linkage strategy.
 */
export const query = (
  engine: ClientEngine.ClientEngine,
  subset: Subset.Subset,
  names: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<RelatedRow>, never, never> =>
  Related.queryWith(engine, linkageStrategy(names), subset) as Effect.Effect<
    ReadonlyArray<RelatedRow>,
    never,
    never
  >;

/**
 * Live version of {@link query} as an incrementally-maintained join. Delegates
 * to {@link Related.observeWith}: a write to a referenced row re-hydrates the
 * join without re-querying the base; a base change that shifts referenced
 * collections re-establishes the observers.
 */
export const observe = (
  engine: ClientEngine.ClientEngine,
  subset: Subset.Subset,
  names: ReadonlyArray<string>
): Stream.Stream<ReadonlyArray<RelatedRow>, never, never> =>
  Related.observeWith(engine, linkageStrategy(names), subset) as Stream.Stream<
    ReadonlyArray<RelatedRow>,
    never,
    never
  >;

/**
 * Auto-subscribing relational read: subscribes the base subset and the narrowed
 * `id IN (...)` subsets of each referenced collection, tracks the live linkage,
 * and tears the subscriptions down when the scope closes. Delegates to
 * {@link Related.relatedWith}. Pair with the backend's `includes` config to
 * deliver the related rows in the parent's response (no extra round trip).
 */
export const related = (
  engine: ClientEngine.ClientEngine,
  subset: Subset.Subset,
  names: ReadonlyArray<string>
): Effect.Effect<Stream.Stream<ReadonlyArray<RelatedRow>, never, never>, never, Scope.Scope> =>
  Related.relatedWith(engine, linkageStrategy(names), subset) as Effect.Effect<
    Stream.Stream<ReadonlyArray<RelatedRow>, never, never>,
    never,
    Scope.Scope
  >;
