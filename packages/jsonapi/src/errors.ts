/**
 * Synchronizer Errors
 *
 * Tagged error types for the JSON:API adapter. All errors extend
 * `Data.TaggedError`, so they are yieldable inside `Effect.gen`, usable with
 * `Effect.fail`, and handled with `Effect.catchTag` / `Effect.catchTags`.
 * Because `Data.TaggedError` extends `Error`, the `message` field is also
 * available as `.message` on instances.
 */

import * as Data from "effect/Data";
import type { JsonApiError } from "./types.js";

/**
 * Base error for synchronizer operations.
 */
export class SyncError extends Data.TaggedError("SyncError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Network-related error (connection failure, timeout, etc.).
 */
export class NetworkError extends Data.TaggedError("NetworkError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Parsing error for JSON:API documents.
 */
export class ParseError extends Data.TaggedError("ParseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * API error carrying the JSON:API error objects returned by the server.
 */
export class ApiError extends Data.TaggedError("ApiError")<{
  readonly message: string;
  readonly errors: ReadonlyArray<JsonApiError>;
}> {}

/**
 * Conflict error raised when local and remote resource versions mismatch.
 */
export class ConflictError extends Data.TaggedError("ConflictError")<{
  readonly message: string;
  readonly localVersion?: string | undefined;
  readonly remoteVersion?: string | undefined;
}> {}
