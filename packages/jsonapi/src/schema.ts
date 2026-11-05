/**
 * JSON:API Schemas
 *
 * Generic codecs for the JSON:API v1.1 document types this loader decodes from
 * arbitrary upstream servers, plus a `decodeDocument` helper that validates
 * untrusted input (e.g. a parsed HTTP response body) into a `JsonApiDocument`.
 *
 * The spec primitives — link objects, the `jsonapi` member, error objects, and
 * free-form `meta` — are adopted from `@thomasfosterau/effect-jsonapi`'s
 * `Document` module (the canonical, spec-compliant definitions) rather than
 * hand-rolled here. What stays local are the *generic, untyped* composites
 * (`ResourceObject`, `Relationship`, `JsonApiDocument`): the library models
 * documents per known `Resource` definition, but a collection loader reads
 * resources whose `type` and attribute shapes it does not know ahead of time,
 * so it needs a resource-agnostic document schema layered over those
 * primitives.
 *
 * JSON:API is an *open* format: documents and most member objects may carry
 * implementation-specific members beyond those the spec names. Effect v4
 * `Schema.Struct` already drops excess properties during decoding rather than
 * rejecting them, so these schemas validate the *shape* of the members we care
 * about while tolerating extra members. Free-form members (`meta`,
 * `attributes`) are modelled as `Document.AnyMeta`
 * (`Schema.Record(Schema.String, Schema.Unknown)`).
 *
 * Schema failures are mapped to the package's `ParseError`, with the
 * underlying `Schema` issue attached as `cause`.
 */

import { Document } from "@thomasfosterau/effect-jsonapi";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ParseError } from "./errors.js";

/** Free-form `meta` / `attributes` object: arbitrary JSON values by key. */
const MetaSchema = Document.AnyMeta;

/**
 * Schema for a JSON:API link object (`{ href, ... }`), adopted from the
 * library's spec-compliant definition.
 */
export const LinkObject = Document.LinkObject;

/** A JSON:API link object. */
export type LinkObject = typeof LinkObject.Type;

/**
 * Schema for a single link value: either a URL string or a link object.
 */
const LinkValue = Document.Link;

/**
 * Schema for a JSON:API `links` object. The spec allows arbitrary link names,
 * so this is a record of link values; `self` / `related` are simply well-known
 * keys within it.
 */
export const Links = Schema.Record(Schema.String, LinkValue);

/** A JSON:API `links` object: arbitrary link names → string | link object. */
export type Links = typeof Links.Type;

/**
 * Schema for a JSON:API resource identifier (`{ type, id, meta? }`).
 */
export const ResourceIdentifier = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  meta: Schema.optional(MetaSchema),
});

/** A JSON:API resource identifier (`{ type, id, meta? }`). */
export type ResourceIdentifier = typeof ResourceIdentifier.Type;

/**
 * Schema for a JSON:API relationship (`{ data?, links?, meta? }`). The
 * `data` member may be a single identifier, an array of identifiers, or
 * `null`.
 */
export const Relationship = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(Schema.Union([ResourceIdentifier, Schema.Array(ResourceIdentifier)]))
  ),
  links: Schema.optional(Links),
  meta: Schema.optional(MetaSchema),
});

/** A JSON:API relationship (`{ data?, links?, meta? }`). */
export type Relationship = typeof Relationship.Type;

/**
 * Schema for a JSON:API resource object (a resource identifier plus
 * optional `attributes`, `relationships`, and `links`).
 */
export const ResourceObject = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  meta: Schema.optional(MetaSchema),
  attributes: Schema.optional(MetaSchema),
  relationships: Schema.optional(Schema.Record(Schema.String, Relationship)),
  links: Schema.optional(Links),
});

/** A JSON:API resource object (identifier + optional attributes/relationships/links). */
export type ResourceObject = typeof ResourceObject.Type;

/**
 * Schema for a JSON:API error object, adopted from the library's
 * spec-compliant definition.
 */
export const JsonApiError = Document.ErrorObject;

/** A JSON:API error object. */
export type JsonApiError = typeof JsonApiError.Type;

/**
 * Schema for a top-level JSON:API document.
 *
 * The `data` member may be a single resource, a collection of resources, a
 * resource identifier (or collection thereof), or `null`. The other
 * top-level members (`errors`, `meta`, `included`, `links`, `jsonapi`) are
 * all optional. The `jsonapi` member reuses the library's `JsonApiObject`.
 */
export const JsonApiDocument = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Union([
        ResourceObject,
        Schema.Array(ResourceObject),
        ResourceIdentifier,
        Schema.Array(ResourceIdentifier),
      ])
    )
  ),
  errors: Schema.optional(Schema.Array(JsonApiError)),
  meta: Schema.optional(MetaSchema),
  included: Schema.optional(Schema.Array(ResourceObject)),
  links: Schema.optional(Links),
  jsonapi: Schema.optional(Document.JsonApiObject),
});

/**
 * A top-level JSON:API document. Derived from {@link JsonApiDocument}
 * so the type and the validator cannot drift.
 */
export type JsonApiDocument = typeof JsonApiDocument.Type;

const decodeJsonApiDocument = Schema.decodeUnknownEffect(JsonApiDocument);

/**
 * Decode an unknown value (e.g. a parsed HTTP response body) into a
 * `JsonApiDocument`. Schema failures become `ParseError`, with the schema
 * issue attached as `cause`.
 */
export const decodeDocument = (input: unknown): Effect.Effect<JsonApiDocument, ParseError> =>
  decodeJsonApiDocument(input).pipe(
    Effect.mapError((cause) => new ParseError({ message: "Invalid JSON:API document", cause }))
  );
