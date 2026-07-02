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
 * A registry (collections, mutators, queries) was built with a duplicate
 * name — a static configuration bug surfaced at setup time. Thrown by the
 * synchronous `registry` builders; tagged so it is still identifiable.
 */
export class DuplicateNameError extends Data.TaggedError("DuplicateNameError")<{
  readonly kind: "collection" | "mutator" | "query";
  readonly name: string;
}> {
  override get message(): string {
    return `Duplicate ${this.kind} name: ${this.name}`;
  }
}
