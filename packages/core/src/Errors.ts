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

/** The backend failed to apply mutations or evaluate a subscription. */
export class BackendError extends Data.TaggedError("BackendError")<{
  readonly message: string;
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
