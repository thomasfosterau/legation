/**
 * JSON:API Types
 *
 * Core type definitions following the JSON:API v1.1 specification
 * https://jsonapi.org/format/
 *
 * The document types are derived from the Effect `Schema` codecs in
 * `schema.ts` (the single source of truth) and re-exported here so consumers
 * keep a stable import path. `JsonApiRequestOptions` has no wire schema (it
 * describes query-string construction, not a decoded document) and stays
 * hand-written.
 */

export type {
  ResourceIdentifier,
  ResourceObject,
  Relationship,
  Links,
  LinkObject,
  JsonApiError,
  JsonApiDocument,
} from "./schema.js";

/**
 * JSON:API Request Options
 */
export interface JsonApiRequestOptions {
  include?: string[];
  fields?: Record<string, string[]>;
  sort?: string[];
  filter?: Record<string, string>;
  page?: {
    number?: number;
    size?: number;
    offset?: number;
    limit?: number;
    [key: string]: number | undefined;
  };
}
