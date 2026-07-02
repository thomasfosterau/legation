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
 *
 * The mapping is deliberately symmetric so both directions declare the same
 * shape; only `kind` and which side holds the key differ.
 */
export interface Relationship {
  readonly name: string;
  readonly kind: "one" | "many";
  /** The foreign collection this relationship resolves against. */
  readonly collection: string;
  /** The local row field holding the join value (`"issueId"`, or `"id"` for `"many"`). */
  readonly localField: string;
  /** The foreign row field the join matches (`"id"` for `"one"`, the FK for `"many"`). */
  readonly foreignField: string;
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
}): Collection<A, I> => options;

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
