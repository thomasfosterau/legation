/**
 * JSON:API Schemas
 *
 * Effect `Schema` codecs for the JSON:API v1.1 document types defined in
 * `types.ts`, plus a `decodeDocument` helper that validates untrusted input
 * (e.g. a parsed HTTP response body) into a `JsonApiDocument`.
 *
 * JSON:API is an *open* format: documents and most member objects may carry
 * implementation-specific members beyond those the spec names. Effect v4
 * `Schema.Struct` already drops excess properties during decoding rather
 * than rejecting them, so these schemas validate the *shape* of the members
 * we care about while tolerating extra members. Free-form members (`meta`,
 * `attributes`) are modelled as `Schema.Record(Schema.String,
 * Schema.Unknown)`.
 *
 * Schema failures are mapped to the package's `ParseError`, with the
 * underlying `Schema` issue attached as `cause`.
 */

import { Effect, Schema } from "effect";
import { ParseError } from "./errors.js";
import type {
  JsonApiDocument,
  JsonApiError,
  Links,
  Relationship,
  ResourceIdentifier,
  ResourceObject,
} from "./types.js";

/** Free-form `meta` / `attributes` object: arbitrary JSON values by key. */
const MetaSchema = Schema.Record(Schema.String, Schema.Unknown);

/**
 * Schema for a JSON:API link object (`{ href, meta? }`).
 */
const LinkObjectSchema = Schema.Struct({
  href: Schema.String,
  meta: Schema.optional(MetaSchema),
});

/**
 * Schema for a single link value: either a URL string or a link object.
 */
const LinkValueSchema = Schema.Union([Schema.String, LinkObjectSchema]);

/**
 * Schema for a JSON:API `links` object. The spec allows arbitrary link
 * names, so this is a record of link values; `self` / `related` are simply
 * well-known keys within it.
 */
export const LinksSchema: Schema.Codec<Links> = Schema.Record(
  Schema.String,
  LinkValueSchema
) as Schema.Codec<Links>;

/**
 * Schema for a JSON:API resource identifier (`{ type, id, meta? }`).
 */
export const ResourceIdentifierSchema: Schema.Codec<ResourceIdentifier> = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  meta: Schema.optional(MetaSchema),
}) as Schema.Codec<ResourceIdentifier>;

/**
 * Schema for a JSON:API relationship (`{ data?, links?, meta? }`). The
 * `data` member may be a single identifier, an array of identifiers, or
 * `null`.
 */
export const RelationshipSchema: Schema.Codec<Relationship> = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(Schema.Union([ResourceIdentifierSchema, Schema.Array(ResourceIdentifierSchema)]))
  ),
  links: Schema.optional(LinksSchema),
  meta: Schema.optional(MetaSchema),
}) as Schema.Codec<Relationship>;

/**
 * Schema for a JSON:API resource object (a resource identifier plus
 * optional `attributes`, `relationships`, and `links`).
 */
export const ResourceObjectSchema: Schema.Codec<ResourceObject> = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  meta: Schema.optional(MetaSchema),
  attributes: Schema.optional(MetaSchema),
  relationships: Schema.optional(Schema.Record(Schema.String, RelationshipSchema)),
  links: Schema.optional(LinksSchema),
}) as Schema.Codec<ResourceObject>;

/**
 * Schema for a JSON:API error object.
 */
export const JsonApiErrorSchema: Schema.Codec<JsonApiError> = Schema.Struct({
  id: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  source: Schema.optional(
    Schema.Struct({
      pointer: Schema.optional(Schema.String),
      parameter: Schema.optional(Schema.String),
      header: Schema.optional(Schema.String),
    })
  ),
  meta: Schema.optional(MetaSchema),
}) as Schema.Codec<JsonApiError>;

/**
 * Schema for a top-level JSON:API document.
 *
 * The `data` member may be a single resource, a collection of resources, a
 * resource identifier (or collection thereof), or `null`. The other
 * top-level members (`errors`, `meta`, `included`, `links`, `jsonapi`) are
 * all optional.
 */
export const JsonApiDocumentSchema: Schema.Codec<JsonApiDocument> = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Union([
        ResourceObjectSchema,
        Schema.Array(ResourceObjectSchema),
        ResourceIdentifierSchema,
        Schema.Array(ResourceIdentifierSchema),
      ])
    )
  ),
  errors: Schema.optional(Schema.Array(JsonApiErrorSchema)),
  meta: Schema.optional(MetaSchema),
  included: Schema.optional(Schema.Array(ResourceObjectSchema)),
  links: Schema.optional(LinksSchema),
  jsonapi: Schema.optional(
    Schema.Struct({
      version: Schema.optional(Schema.String),
      meta: Schema.optional(MetaSchema),
    })
  ),
  // The decoded shape is structurally equivalent to `JsonApiDocument`, but
  // the nested optional unions don't line up nominally for TypeScript's
  // assignability check, so the cast goes through `unknown`.
}) as unknown as Schema.Codec<JsonApiDocument>;

const decodeDocumentSchema = Schema.decodeUnknownEffect(JsonApiDocumentSchema);

/**
 * Decode an unknown value (e.g. a parsed HTTP response body) into a
 * `JsonApiDocument`. Schema failures become `ParseError`, with the schema
 * issue attached as `cause`.
 */
export const decodeDocument = (input: unknown): Effect.Effect<JsonApiDocument, ParseError> =>
  decodeDocumentSchema(input).pipe(
    Effect.mapError((cause) => new ParseError({ message: "Invalid JSON:API document", cause }))
  );
