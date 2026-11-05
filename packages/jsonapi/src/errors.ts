/**
 * Synchronizer Errors
 *
 * Tagged error types for the JSON:API adapter. All errors extend
 * `Schema.TaggedError`, so they are yieldable inside `Effect.gen`, usable with
 * `Effect.fail`, and handled with `Effect.catchTag` / `Effect.catchTags`.
 * Because `Schema.TaggedError` extends `Error`, the `message` field is also
 * available as `.message` on instances.
 */

import { Document } from "@thomasfosterau/effect-jsonapi";
import * as Schema from "effect/Schema";

/**
 * Base error for synchronizer operations.
 */
export class SyncError extends Schema.TaggedError<SyncError, { readonly brand: unique symbol }>()(
  "SyncError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

/**
 * Network-related error (connection failure, timeout, etc.).
 */
export class NetworkError extends Schema.TaggedError<
  NetworkError,
  { readonly brand: unique symbol }
>()("NetworkError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * Parsing error for JSON:API documents.
 */
export class ParseError extends Schema.TaggedError<ParseError, { readonly brand: unique symbol }>()(
  "ParseError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

/**
 * API error carrying the JSON:API error objects returned by the server.
 */
export class ApiError extends Schema.TaggedError<ApiError, { readonly brand: unique symbol }>()(
  "ApiError",
  {
    message: Schema.String,
    errors: Schema.Array(Document.ErrorObject),
  }
) {}

/**
 * Conflict error raised when local and remote resource versions mismatch.
 */
export class ConflictError extends Schema.TaggedError<
  ConflictError,
  { readonly brand: unique symbol }
>()("ConflictError", {
  message: Schema.String,
  localVersion: Schema.optional(Schema.String),
  remoteVersion: Schema.optional(Schema.String),
}) {}
