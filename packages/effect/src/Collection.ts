/**
 * Collection
 *
 * A collection is a named, schema-typed set of rows keyed by row id — the
 * unit the client materializes locally and queries (CONTEXT.md). The
 * collection definition is shared by client and server: the row `Schema` is
 * the single source of truth for validation, wire serialization, and
 * persistence encoding.
 */

import type { Schema } from "effect";
import { DuplicateNameError, UnknownCollectionError } from "./Errors.js";
import * as FilterPolicy from "./FilterPolicy.js";

/** The identifier of one row within a collection. */
export type RowId = string;

/**
 * A declared relationship from one collection to a foreign collection, by
 * field mapping (ADR-0006, issue #38). The read-side join a `Related` query
 * resolves and an auto-subscription narrows:
 *
 * - `"one"`: the single foreign row whose `foreignField` equals this row's
 *   `localField` value (e.g. `comment.issueId → issues.id`).
 * - `"many"`: the foreign rows whose `foreignField` equals this row's
 *   `localField` value (e.g. `issue.id → comments.issueId`).
 * - `"paginated"`: `"many"` with a declared stable `order` — the shape a
 *   per-parent sync window needs (ADR-0024): windowed reads register one
 *   `(foreignField = parent, order, limit)` subset per parent row.
 *
 * The mapping is deliberately symmetric so both directions declare the same
 * shape; only `kind` and which side holds the key differ.
 */
export interface Relationship {
  readonly name: string;
  readonly kind: "one" | "many" | "paginated";
  /** The foreign collection this relationship resolves against. */
  readonly collection: string;
  /** The local row field holding the join value (`"issueId"`, or `"id"` for `"many"`). */
  readonly localField: string;
  /** The foreign row field the join matches (`"id"` for `"one"`, the FK for `"many"`). */
  readonly foreignField: string;
  /** The declared sort for `"paginated"` — part of the edge's identity (ADR-0022). */
  readonly order?: ReadonlyArray<{ readonly field: string; readonly direction: "asc" | "desc" }>;
}

/**
 * An opaque per-row token the backend changes on every authoritative write.
 * The basis for CVR diffing (ADR-0008).
 */
export type RowVersion = string | number;

/** A row as held by the engine: value plus authoritative version. */
export interface Row<A> {
  readonly id: RowId;
  readonly version: RowVersion;
  readonly value: A;
}

/**
 * A collection definition.
 *
 * `Type` is the decoded row type; `Encoded` is its wire/persistence form.
 */
export interface Collection<A, I = unknown> {
  readonly name: string;
  /** Row codec: decoded type `A`, encoded (JSON-compatible) form `I`. */
  readonly schema: Schema.Codec<A, I>;
  /** Derive the row id from a row value. */
  readonly id: (value: A) => RowId;
  /** Declared relationships to other collections (issue #38). */
  readonly relationships?: ReadonlyArray<Relationship>;
  /**
   * Fields eligible for secondary indexing (issue #113): `eq`/`In` predicates
   * on a declared field resolve via an in-memory hash index, range
   * `Compare`s via an ordered one, instead of a full collection scan. Purely
   * an engine-level acceleration hint — maintained from row deltas, rebuilt
   * on demand; absent (or an engine with `autoIndex` off) means every
   * predicate scans, exactly like before this field existed.
   */
  readonly indexes?: ReadonlyArray<string>;
  /**
   * The **filterable set** (ADR-0028 rule d, #154): the fields a client may
   * filter by, each with its operators and literal kind. Resolved on the
   * Node (`Node.make`'s `filterable` option plus the `id` / `one`-edge key
   * defaults) and carried here so the server enforces it in `authorize`
   * without Node definitions — exactly how `indexes` travels. Absent on a
   * hand-built collection: see {@link filterDeclarationOf} for what is
   * enforced then.
   */
  readonly filterable?: Readonly<Record<string, FilterPolicy.FilterableField>>;
  /** The fields a client may order by (#154); always includes `id`. */
  readonly sortable?: ReadonlyArray<string>;
}

/** A collection definition with the row type erased. */
export type AnyCollection = Collection<any, any>;

/** Extract the row type of a collection. */
export type RowOf<C> = C extends Collection<infer A, any> ? A : never;

/** Define a collection. */
export const make = <A, I>(options: {
  readonly name: string;
  readonly schema: Schema.Codec<A, I>;
  readonly id: (value: A) => RowId;
  readonly relationships?: ReadonlyArray<Relationship>;
  readonly indexes?: ReadonlyArray<string>;
  readonly filterable?: Readonly<Record<string, FilterPolicy.FilterableField>>;
  readonly sortable?: ReadonlyArray<string>;
}): Collection<A, I> => options;

/**
 * The filter declaration `authorize` enforces for a collection (#154): the
 * carried `filterable` / `sortable` (every Node-derived collection has
 * them) overlaid on the key defaults — `id` plus every `"one"`
 * relationship's local key field by at least `eq` / `in`, `id` always
 * sortable — so a hand-built collection keeps the same invariants a node
 * does, and one declaring nothing is closed exactly as an undeclared node
 * would be.
 */
export const filterDeclarationOf = (collection: AnyCollection): FilterPolicy.FilterDeclaration => {
  const keyFields = ["id"];
  for (const relationship of collection.relationships ?? []) {
    if (relationship.kind === "one") keyFields.push(relationship.localField);
  }
  return FilterPolicy.withKeyDefaults(
    keyFields,
    collection.filterable ?? {},
    collection.sortable ?? []
  );
};

/**
 * A set of collections, by name — what an engine or backend is configured
 * with. Lookups at the protocol boundary are by name, so registries are
 * intentionally string-keyed.
 */
export type CollectionRegistry = ReadonlyMap<string, AnyCollection>;

/**
 * Validate one collection's relationships against the built registry: a
 * duplicate relationship name within the collection, or a relationship pointing
 * at a collection not in the registry, throws.
 */
const validateRelationships = (
  collection: AnyCollection,
  map: ReadonlyMap<string, AnyCollection>
): void => {
  const seen = new Set<string>();
  for (const relationship of collection.relationships ?? []) {
    if (seen.has(relationship.name)) {
      throw new DuplicateNameError({ kind: "relationship", name: relationship.name });
    }
    seen.add(relationship.name);
    if (!map.has(relationship.collection)) {
      throw new UnknownCollectionError({
        from: collection.name,
        relationship: relationship.name,
        collection: relationship.collection,
      });
    }
  }
};

/**
 * Build a registry from collection definitions. Duplicate collection names,
 * duplicate relationship names within a collection, and relationships pointing
 * at an unknown collection all throw at build time.
 */
export const registry = (collections: ReadonlyArray<AnyCollection>): CollectionRegistry => {
  const map = new Map<string, AnyCollection>();
  for (const collection of collections) {
    if (map.has(collection.name)) {
      throw new DuplicateNameError({ kind: "collection", name: collection.name });
    }
    map.set(collection.name, collection);
  }
  for (const collection of collections) validateRelationships(collection, map);
  return map;
};

/**
 * The declared relationships of a collection, by name — `undefined` collection
 * or none declared yields an empty map. A convenience for `Related` resolvers
 * that select relationships by name.
 */
export const relationshipsOf = (
  registry: CollectionRegistry,
  collectionName: string
): ReadonlyMap<string, Relationship> => {
  const map = new Map<string, Relationship>();
  for (const relationship of registry.get(collectionName)?.relationships ?? []) {
    map.set(relationship.name, relationship);
  }
  return map;
};
