/**
 * Synchronizer Errors
 *
 * Error types for the synchronizer operations
 */

import type { JsonApiError } from "./types.js";

/**
 * Base error for synchronizer operations
 */
export class SyncError {
  readonly _tag = "SyncError";
  constructor(
    readonly message: string,
    readonly cause?: unknown
  ) { }
}

/**
 * Network-related error
 */
export class NetworkError {
  readonly _tag = "NetworkError";
  constructor(
    readonly message: string,
    readonly cause?: unknown
  ) { }
}

/**
 * Parsing error for JSON:API documents
 */
export class ParseError {
  readonly _tag = "ParseError";
  constructor(
    readonly message: string,
    readonly cause?: unknown
  ) { }
}

/**
 * API error containing JSON:API error objects
 */
export class ApiError {
  readonly _tag = "ApiError";
  constructor(
    readonly message: string,
    readonly errors: JsonApiError[]
  ) { }
}

/**
 * Conflict error when data versions mismatch
 */
export class ConflictError {
  readonly _tag = "ConflictError";
  constructor(
    readonly message: string,
    readonly localVersion?: string,
    readonly remoteVersion?: string
  ) { }
}
