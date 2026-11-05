/**
 * Errors
 *
 * Tagged errors shared across the sync engine. All errors extend
 * `Schema.TaggedError`, so they are yieldable in `Effect.gen`, catchable
 * with `Effect.catchTag` / `Effect.catchTags`, and carry a schema.
 */

import * as Schema from "effect/Schema";

/** A client or server storage operation failed. */
export class StoreError extends Schema.TaggedError<StoreError, { readonly brand: unique symbol }>()(
  "StoreError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

/** A protocol message could not be carried (connection lost, send failed). */
export class TransportError extends Schema.TaggedError<
  TransportError,
  { readonly brand: unique symbol }
>()("TransportError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** A received frame was not a valid protocol message. */
export class ProtocolError extends Schema.TaggedError<
  ProtocolError,
  { readonly brand: unique symbol }
>()("ProtocolError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * The backend failed to apply mutations or evaluate a subscription. A
 * `BackendError` from a mutator handler is a *transient* failure: the push
 * batch is aborted and the client retries (correct for deadlocks, timeouts,
 * lost connections).
 */
export class BackendError extends Schema.TaggedError<
  BackendError,
  { readonly brand: unique symbol }
>()("BackendError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * A mutator was *permanently* rejected by the backend — failed server-side
 * validation, a revoked permission, a violated business rule. Unlike a
 * transient `BackendError`, the backend records the mutation as processed
 * (bumps `lastMutationId` without applying effects, atomically) so it never
 * poisons the queue: mutations behind it still apply, and the client drops the
 * optimistic effect on the next rebase. A mutator handler raises this to opt a
 * failure into the permanent class (Replicache's lastMutationID rule).
 */
export class MutationRejected extends Schema.TaggedError<
  MutationRejected,
  { readonly brand: unique symbol }
>()("MutationRejected", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

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
export class VersionNotSupportedError extends Schema.TaggedError<
  VersionNotSupportedError,
  { readonly brand: unique symbol }
>()("VersionNotSupportedError", {
  schemaVersion: Schema.optional(Schema.String),
  message: Schema.String,
}) {}

/** A subscription or push was refused by auth filters or middleware. */
export class AuthorizationError extends Schema.TaggedError<
  AuthorizationError,
  { readonly brand: unique symbol }
>()("AuthorizationError", {
  message: Schema.String,
  collection: Schema.optional(Schema.String),
}) {}

/** The journal could not append, read, or acknowledge pending mutations. */
export class JournalError extends Schema.TaggedError<
  JournalError,
  { readonly brand: unique symbol }
>()("JournalError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** A mutator was missing, its args failed validation, or it failed locally. */
export class MutatorError extends Schema.TaggedError<
  MutatorError,
  { readonly brand: unique symbol }
>()("MutatorError", {
  message: Schema.String,
  mutator: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * A named query was missing or its args failed validation; or a declarative
 * read could not be compiled (an unknown collection or edge) or parsed from
 * a URL. `parameter` names the offending query-string parameter
 * (`filter[age][gt]`, `include`, `page[limit]`) when the error comes from
 * URL parsing (`@thomasfosterau/legation-jsonapi`'s `JsonApiQuery.parseRead`) — the value a
 * JSON:API 400 document carries as `source.parameter`.
 */
export class QueryError extends Schema.TaggedError<QueryError, { readonly brand: unique symbol }>()(
  "QueryError",
  {
    message: Schema.String,
    query: Schema.optional(Schema.String),
    parameter: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  }
) {}

/**
 * A Node (or Collection) declared a filterable or sortable field its row does
 * not carry, or a filterable attribute whose literal kind can neither be
 * derived from its schema nor was given explicitly (#154, ADR-0028). A static
 * definition bug surfaced at setup time, like {@link DuplicateNameError};
 * thrown by the synchronous `Node.make`.
 */
export class FilterDeclarationError extends Schema.TaggedError<
  FilterDeclarationError,
  { readonly brand: unique symbol }
>()("FilterDeclarationError", {
  collection: Schema.String,
  field: Schema.String,
  message: Schema.String,
}) {}

/**
 * A registry (collections, mutators, queries) was built with a duplicate
 * name — a static configuration bug surfaced at setup time. Thrown by the
 * synchronous `registry` builders; tagged so it is still identifiable.
 */
export class DuplicateNameError extends Schema.TaggedError<
  DuplicateNameError,
  { readonly brand: unique symbol }
>()("DuplicateNameError", {
  kind: Schema.Literals(["collection", "mutator", "query", "relationship"]),
  name: Schema.String,
}) {
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
export class UnknownCollectionError extends Schema.TaggedError<
  UnknownCollectionError,
  { readonly brand: unique symbol }
>()("UnknownCollectionError", {
  /** The collection declaring the relationship. */
  from: Schema.String,
  /** The relationship name whose `collection` is unknown. */
  relationship: Schema.String,
  /** The missing foreign collection the relationship points at. */
  collection: Schema.String,
}) {
  override get message(): string {
    return `Relationship "${this.relationship}" on collection "${this.from}" points at unknown collection: ${this.collection}`;
  }
}
