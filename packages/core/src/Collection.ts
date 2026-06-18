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
import { DuplicateNameError } from "./Errors.js";

/** The identifier of one row within a collection. */
export type RowId = string;

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
}): Collection<A, I> => options;

/**
 * A set of collections, by name — what an engine or backend is configured
 * with. Lookups at the protocol boundary are by name, so registries are
 * intentionally string-keyed.
 */
export type CollectionRegistry = ReadonlyMap<string, AnyCollection>;

/** Build a registry from collection definitions. Duplicate names throw. */
export const registry = (collections: ReadonlyArray<AnyCollection>): CollectionRegistry => {
  const map = new Map<string, AnyCollection>();
  for (const collection of collections) {
    if (map.has(collection.name)) {
      throw new DuplicateNameError({ kind: "collection", name: collection.name });
    }
    map.set(collection.name, collection);
  }
  return map;
};
