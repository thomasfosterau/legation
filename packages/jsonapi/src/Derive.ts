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

import { Effect, Schema } from "effect";
import { Collection, Mutator } from "@thomasfosterau/effect-sync-core";
import type { ResourceValue } from "./CollectionLoader.js";
import type { Operation, ResourceMap } from "./Convention.js";

/** Codec for a row value (a JSON:API resource as the engine stores it). */
export const ResourceValueSchema = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  attributes: Schema.Record(Schema.String, Schema.Unknown),
  relationships: Schema.Record(Schema.String, Schema.Unknown),
}) as unknown as Schema.Codec<ResourceValue>;

/** The collection for a resource type: rows keyed by resource id. */
export const collectionFor = (type: string): Collection.Collection<ResourceValue> =>
  Collection.make({
    name: type,
    schema: ResourceValueSchema,
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

/** Update: a partial attribute patch, merged over the current row. */
export const UpdateArgs = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  attributes: Schema.Record(Schema.String, Schema.Unknown),
});

/** Delete: address one row. */
export const DeleteArgs = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
});

const asResourceValue = (value: unknown): ResourceValue | undefined =>
  value as ResourceValue | undefined;

// ─── Derivation ──────────────────────────────────────────────────────────────

/** Which CRUD operation a derived mutator performs, and on what type. */
export interface OperationInfo {
  readonly operation: Operation;
  readonly type: string;
}

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

  for (const resource of resources.values()) {
    const type = resource.type;
    collections.push(collectionFor(type));

    if (resource.create !== undefined) {
      add(type, "create", CreateArgs, (args, writer) =>
        writer.put(type, args.id, {
          type,
          id: args.id,
          attributes: args.attributes,
          relationships: args.relationships ?? {},
        } satisfies ResourceValue)
      );
    }

    if (resource.update !== undefined) {
      add(type, "update", UpdateArgs, (args, writer) =>
        Effect.gen(function* () {
          const current = asResourceValue(yield* writer.get(type, args.id));
          yield* writer.put(type, args.id, {
            type,
            id: args.id,
            attributes: { ...current?.attributes, ...args.attributes },
            relationships: current?.relationships ?? {},
          } satisfies ResourceValue);
        })
      );
    }

    if (resource.delete !== undefined) {
      add(type, "delete", DeleteArgs, (args, writer) => writer.del(type, args.id));
    }
  }

  return {
    collections,
    registry: Mutator.registry(entries),
    operations,
  };
};
