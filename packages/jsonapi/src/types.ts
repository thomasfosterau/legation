/**
 * JSON:API Types
 *
 * Core type definitions following the JSON:API v1.1 specification
 * https://jsonapi.org/format/
 *
 * The document types are derived from the Effect `Schema` codecs in
 * `schema.ts` (the single source of truth, itself built on
 * `@thomasfosterau/effect-jsonapi`'s `Document` primitives) and re-exported
 * here so consumers keep a stable import path. `JsonApiRequestOptions` has no
 * wire schema (it describes query-string construction, not a decoded document)
 * and stays hand-written, but its `sort` and `page` members adopt the
 * library's `Query` vocabulary (`Query.Sort` term shape, `Query.Page`
 * strategies).
 */

import { type Filter, Query } from "@thomasfosterau/effect-jsonapi";
import * as Schema from "effect/Schema";

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
 * A single JSON:API `sort` term: a field and a direction, matching the decoded
 * shape of the library's `Query.Sort` codec.
 */
export interface SortTerm {
  readonly field: string;
  readonly direction: "asc" | "desc";
}

/** The pagination strategies the library models, as a decoded value. */
const PageParamsSchema = Schema.Union([
  Schema.Struct(Query.Page.Offset),
  Schema.Struct(Query.Page.Number),
  Schema.Struct(Query.Page.Cursor),
]);

/**
 * JSON:API `page` parameters: offset/limit, number/size, or cursor/size — the
 * strategies exposed by the library's `Query.Page`.
 */
export type PageParams = typeof PageParamsSchema.Type;

/**
 * JSON:API Request Options. `filter` is a filter-grammar AST (ADR-0028;
 * `Filter.eq("status", "open")`, `Filter.and(...)`, …), encoded exactly
 * through the grammar's canonical `filter[...]` form by
 * `JsonApiQuery.buildQueryString`.
 */
export interface JsonApiRequestOptions {
  include?: ReadonlyArray<string>;
  fields?: Readonly<Record<string, ReadonlyArray<string>>>;
  sort?: ReadonlyArray<SortTerm>;
  filter?: Filter.Node;
  page?: PageParams;
}
