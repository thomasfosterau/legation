/**
 * Errors
 *
 * Tagged errors shared across the sync engine. All errors extend
 * `Data.TaggedError`, so they are yieldable in `Effect.gen` and catchable
 * with `Effect.catchTag` / `Effect.catchTags`.
 */

import { Data } from "effect";

/** A client or server storage operation failed. */
export class StoreError extends Data.TaggedError("StoreError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A protocol message could not be carried (connection lost, send failed). */
export class TransportError extends Data.TaggedError("TransportError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A received frame was not a valid protocol message. */
export class ProtocolError extends Data.TaggedError("ProtocolError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The backend failed to apply mutations or evaluate a subscription. A
 * `BackendError` from a mutator handler is a *transient* failure: the push
 * batch is aborted and the client retries (correct for deadlocks, timeouts,
 * lost connections).
 */
export class BackendError extends Data.TaggedError("BackendError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A mutator was *permanently* rejected by the backend — failed server-side
 * validation, a revoked permission, a violated business rule. Unlike a
 * transient `BackendError`, the backend records the mutation as processed
 * (bumps `lastMutationId` without applying effects, atomically) so it never
 * poisons the queue: mutations behind it still apply, and the client drops the
 * optimistic effect on the next rebase. A mutator handler raises this to opt a
 * failure into the permanent class (Replicache's lastMutationID rule).
 */
export class MutationRejected extends Data.TaggedError("MutationRejected")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

/**
 * The server rejected a request because the client's declared `schemaVersion`
 * is not one this build accepts (#48). Unlike a {@link MutationRejected} (a
 * per-mutation, permanent business verdict) this is a *transport-level* "your
 * build is obsolete" condition: it is raised up front, before any mutation is
 * applied or any patch computed, so the journal is never poisoned — the client
 * retains its pending intents and is told to update. Distinct from a
 * {@link TransportError} so a carrier that can carry the tag lets the client
 * react precisely (the in-memory seam does; the RPC carrier degrades it to a
 * `TransportError`, see RpcTransport.ts).
 */
export class VersionNotSupportedError extends Data.TaggedError("VersionNotSupportedError")<{
  readonly schemaVersion?: string | undefined;
  readonly message: string;
}> {}

/** A subscription or push was refused by auth filters or middleware. */
export class AuthorizationError extends Data.TaggedError("AuthorizationError")<{
  readonly message: string;
  readonly collection?: string | undefined;
}> {}

/** The journal could not append, read, or acknowledge pending mutations. */
export class JournalError extends Data.TaggedError("JournalError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A mutator was missing, its args failed validation, or it failed locally. */
export class MutatorError extends Data.TaggedError("MutatorError")<{
  readonly message: string;
  readonly mutator?: string | undefined;
  readonly cause?: unknown;
}> {}

/** A named query was missing or its args failed validation. */
export class QueryError extends Data.TaggedError("QueryError")<{
  readonly message: string;
  readonly query?: string | undefined;
  readonly cause?: unknown;
}> {}

/**
 * A Node (or Collection) declared a filterable or sortable field its row does
 * not carry, or a filterable attribute whose literal kind can neither be
 * derived from its schema nor was given explicitly (#154, ADR-0028). A static
 * definition bug surfaced at setup time, like {@link DuplicateNameError};
 * thrown by the synchronous `Node.make`.
 */
export class FilterDeclarationError extends Data.TaggedError("FilterDeclarationError")<{
  readonly collection: string;
  readonly field: string;
  readonly message: string;
}> {}

/**
 * A registry (collections, mutators, queries) was built with a duplicate
 * name — a static configuration bug surfaced at setup time. Thrown by the
 * synchronous `registry` builders; tagged so it is still identifiable.
 */
export class DuplicateNameError extends Data.TaggedError("DuplicateNameError")<{
  readonly kind: "collection" | "mutator" | "query" | "relationship";
  readonly name: string;
}> {
  override get message(): string {
    return `Duplicate ${this.kind} name: ${this.name}`;
  }
}

/**
 * A collection declared a relationship pointing at a foreign collection that is
 * not present in the registry — a static configuration bug surfaced at setup
 * time (like {@link DuplicateNameError}). Thrown by the synchronous
 * `Collection.registry` builder.
 */
export class UnknownCollectionError extends Data.TaggedError("UnknownCollectionError")<{
  /** The collection declaring the relationship. */
  readonly from: string;
  /** The relationship name whose `collection` is unknown. */
  readonly relationship: string;
  /** The missing foreign collection the relationship points at. */
  readonly collection: string;
}> {
  override get message(): string {
    return `Relationship "${this.relationship}" on collection "${this.from}" points at unknown collection: ${this.collection}`;
  }
}
