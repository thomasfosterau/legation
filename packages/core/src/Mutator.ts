/**
 * Mutator
 *
 * A mutator is a named, schema-validated write intent defined once and
 * executed twice: optimistically on the client and authoritatively on the
 * backend (ADR-0008). The two implementations may differ — the backend adds
 * validation, permissions, and side effects; conflict resolution IS replay.
 *
 * The mutator *definition* (name + args schema) is shared code. Client
 * handlers receive a local write surface (LocalWriter); backend handlers
 * are supplied by the app inside its own transaction (Backend.ts).
 */

import type { Effect, Schema } from "effect";
import type { RowId } from "./Collection.js";
import type { MutatorError, StoreError } from "./Errors.js";

/** A mutator definition: the shared, serializable contract. */
export interface Mutator<Name extends string, Args, ArgsEncoded = unknown> {
  readonly name: Name;
  readonly args: Schema.Codec<Args, ArgsEncoded>;
}

export type AnyMutator = Mutator<string, any, any>;

/** Define a mutator contract. */
export const make = <const Name extends string, Args, ArgsEncoded>(
  name: Name,
  args: Schema.Codec<Args, ArgsEncoded>
): Mutator<Name, Args, ArgsEncoded> => ({ name, args });

/**
 * The local write surface handed to client-side mutator handlers. Writes
 * apply to the optimistic overlay only; authoritative versions arrive via
 * patches. Handlers must be re-runnable: they execute once optimistically
 * and again on every rebase.
 */
export interface LocalWriter {
  readonly put: (collection: string, id: RowId, value: unknown) => Effect.Effect<void, StoreError>;
  readonly del: (collection: string, id: RowId) => Effect.Effect<void, StoreError>;
  /** Read through confirmed rows + overlay (current local view). */
  readonly get: (collection: string, id: RowId) => Effect.Effect<unknown | undefined, StoreError>;
}

/** A client-side handler for one mutator. */
export type LocalHandler<Args> = (
  args: Args,
  writer: LocalWriter
) => Effect.Effect<void, MutatorError | StoreError>;

/** A set of mutator definitions plus their client-side handlers. */
export interface MutatorRegistry {
  readonly mutators: ReadonlyMap<string, AnyMutator>;
  readonly handlers: ReadonlyMap<string, LocalHandler<any>>;
}

/** Pair mutator definitions with client handlers. Duplicate names throw. */
export const registry = (
  entries: ReadonlyArray<{ readonly mutator: AnyMutator; readonly local: LocalHandler<any> }>
): MutatorRegistry => {
  const mutators = new Map<string, AnyMutator>();
  const handlers = new Map<string, LocalHandler<any>>();
  for (const { mutator, local } of entries) {
    if (mutators.has(mutator.name)) {
      throw new Error(`Duplicate mutator name: ${mutator.name}`);
    }
    mutators.set(mutator.name, mutator);
    handlers.set(mutator.name, local);
  }
  return { mutators, handlers };
};
