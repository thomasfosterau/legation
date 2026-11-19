/**
 * Derive
 *
 * Turn a discovered JSON:API resource surface (Convention.ts) into the
 * engine's shared model: one `Collection` per resource type, and the three
 * CRUD mutators (create / update / delete) per type that has the matching
 * endpoint. Only the *client* (optimistic) handlers live here — they write
 * the overlay; the authoritative side is JsonApiBackend.ts, which replays
 * the same intents as HTTP calls.
 *
 * Rows are stored as the loader's `ResourceValue` (type, id, attributes,
 * relationship linkage), so the derived collections line up exactly with
 * what `CollectionLoader.documentToRows` produces on the read path.
 */

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Collection, Mutator } from "@thomasfosterau/legation";
import type { RelationshipRef, ResourceValue } from "./CollectionLoader.js";
import type { Operation, ResourceMap } from "./Convention.js";

/**
 * The engine row for a JSON:API resource: attributes flattened to the top
 * level so predicates and orderBy address them directly (e.g.
 * `Predicate.eq("status", "open")`), exactly as JSON:API `filter[status]`
 * does. The keys `id` and `relationships` are reserved.
 */
export interface JsonApiRow {
  readonly id: string;
  readonly relationships: Record<string, RelationshipRef>;
  readonly [field: string]: unknown;
}

/** Flatten a loaded resource into an engine row (attributes at top level). */
export const toRow = (value: ResourceValue): JsonApiRow => ({
  ...value.attributes,
  id: value.id,
  relationships: value.relationships,
});

/** A resource identifier in a row's relationship linkage. */
const Linkage = Schema.Struct({ type: Schema.String, id: Schema.String });

/**
 * A row's checked members: its `id` and its `relationships` linkage (to-one,
 * to-many, or `null` for an empty to-one), with every other field (the
 * flattened attributes) passed through as is.
 */
const Row = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    relationships: Schema.Record(
      Schema.String,
      Schema.NullOr(Schema.Union([Linkage, Schema.Array(Linkage)]))
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);

/**
 * Codec for a row: its `id` and relationship linkage are checked, and the
 * flattened attributes pass through as is. The engine never decodes a stored
 * row through it on read (ADR-0014).
 */
export const RowSchema: Schema.Codec<JsonApiRow> = Row;

/** The collection for a resource type: rows keyed by resource id. */
export const collectionFor = (type: string): Collection.Collection<JsonApiRow> =>
  Collection.make({
    name: type,
    schema: RowSchema,
    id: (value) => value.id,
  });

/** The mutator name for a (type, operation): `"{type}/{operation}"`. */
export const mutatorName = (type: string, operation: Operation): string => `${type}/${operation}`;

// ─── Mutator argument schemas ────────────────────────────────────────────────

/** Create: the full resource to insert (client supplies the id). */
export const CreateArgs = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  attributes: Schema.Record(Schema.String, Schema.Unknown),
  relationships: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

/** The type {@link CreateArgs} decodes to. */
export type CreateArgs = typeof CreateArgs.Type;

/** Update: a partial attribute patch, merged over the current row. */
export const UpdateArgs = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  attributes: Schema.Record(Schema.String, Schema.Unknown),
});

/** The type {@link UpdateArgs} decodes to. */
export type UpdateArgs = typeof UpdateArgs.Type;

/** Delete: address one row. */
export const DeleteArgs = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
});

/** The type {@link DeleteArgs} decodes to. */
export type DeleteArgs = typeof DeleteArgs.Type;

// ─── Derivation ──────────────────────────────────────────────────────────────

/** Which CRUD operation a derived mutator performs, and on what type. */
export interface OperationInfo {
  readonly operation: Operation;
  readonly type: string;
}

/**
 * What {@link derive} produces from a resource map: collections, mutators and their CRUD mapping.
 */
export interface Derived {
  readonly collections: ReadonlyArray<Collection.AnyCollection>;
  /** Mutator definitions + client (optimistic) handlers. */
  readonly registry: Mutator.MutatorRegistry;
  /** Mutator name → CRUD operation + type, for the authoritative backend. */
  readonly operations: ReadonlyMap<string, OperationInfo>;
}

/**
 * Derive collections, CRUD mutators, and operation metadata from a resource
 * map. A mutator is only derived when the resource exposes the corresponding
 * write endpoint (no create endpoint ⇒ no `create` mutator).
 */
export const derive = (resources: ResourceMap): Derived => {
  const collections: Array<Collection.AnyCollection> = [];
  const entries: Array<{
    readonly mutator: Mutator.AnyMutator;
    readonly local: Mutator.LocalHandler<any>;
  }> = [];
  const operations = new Map<string, OperationInfo>();

  const add = (
    type: string,
    operation: Operation,
    args: Schema.Codec<any, any>,
    local: Mutator.LocalHandler<any>
  ) => {
    const name = mutatorName(type, operation);
    entries.push({ mutator: Mutator.make(name, args), local });
    operations.set(name, { operation, type });
  };

  resources.forEach((resource) => {
    const type = resource.type;
    collections.push(collectionFor(type));

    if (Option.isSome(resource.create)) {
      add(type, "create", CreateArgs, (args, writer) =>
        writer.put(
          type,
          args.id,
          toRow({
            type,
            id: args.id,
            attributes: args.attributes,
            relationships: args.relationships ?? {},
          })
        )
      );
    }

    if (Option.isSome(resource.update)) {
      add(type, "update", UpdateArgs, (args, writer) =>
        Effect.gen(function* () {
          const current = Option.map(
            Option.fromUndefinedOr(yield* writer.get(type, args.id)),
            (row) => row as JsonApiRow
          );
          // Flat rows: overlay the new attributes, keep id + relationships.
          yield* writer.put(type, args.id, {
            ...Option.getOrElse(current, (): JsonApiRow => ({ id: args.id, relationships: {} })),
            ...args.attributes,
            id: args.id,
          });
        })
      );
    }

    if (Option.isSome(resource.delete)) {
      add(type, "delete", DeleteArgs, (args, writer) => writer.del(type, args.id));
    }
  });

  return {
    collections,
    registry: Mutator.registry(entries),
    operations,
  };
};
