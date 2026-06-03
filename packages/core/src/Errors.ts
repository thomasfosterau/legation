/**
 * Errors
 *
 * Tagged error types shared across the sync engine. All errors extend
 * `Data.TaggedError`, so they are yieldable inside `Effect.gen` and can be
 * handled with `Effect.catchTag` / `Effect.catchTags`.
 */

import { Data } from "effect";
import type { SyncKey } from "./SyncKey.js";

/**
 * A cache store operation (get/set/delete/scan) failed.
 */
export class StoreError extends Data.TaggedError("StoreError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A loader (the effect that fetches data for a key) failed in a way the
 * engine itself produced — for example a missing entry that was required.
 */
export class CacheMissError extends Data.TaggedError("CacheMissError")<{
  readonly key: SyncKey;
  readonly message: string;
}> {}

/**
 * A transport-level failure: connection lost, send failed, malformed frame.
 */
export class TransportError extends Data.TaggedError("TransportError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Two versions of the same resource conflict and the configured strategy
 * refused to resolve the conflict automatically.
 */
export class ConflictError extends Data.TaggedError("ConflictError")<{
  readonly key: SyncKey;
  readonly message: string;
  readonly localVersion?: string | number | undefined;
  readonly remoteVersion?: string | number | undefined;
}> {}

/**
 * A mutation could not be applied by the server or backing store.
 */
export class MutationError extends Data.TaggedError("MutationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The outbox rejected an entry or failed to drain.
 */
export class OutboxError extends Data.TaggedError("OutboxError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A sync protocol message could not be interpreted.
 */
export class ProtocolError extends Data.TaggedError("ProtocolError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
