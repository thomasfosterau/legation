/**
 * Json
 *
 * JSON text through Schema's JSON codec. Encoding calls `JSON.stringify`, so
 * the text is byte-identical; failures are `SchemaError`s rather than a
 * `TypeError`, a `SyntaxError` or an `undefined` result.
 */

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const JsonText = Schema.fromJsonString(Schema.Unknown);
const encode = Schema.encodeSync(JsonText);
const decode = Schema.decodeSync(Schema.fromJsonString(Schema.Json));

/** A value's JSON text; throws where `JSON.stringify` throws or has no text (`undefined`, a function). */
export const stringify = (value: unknown): string => encode(value);

/** Parses JSON text; throws on malformed input. */
export const parse = (text: string): Schema.Json => decode(text);

/**
 * A value's JSON text for a message: `"undefined"` where JSON has no text,
 * as a template literal renders `JSON.stringify`'s `undefined`.
 */
export const show = (value: unknown): string =>
  Option.getOrElse(Schema.encodeOption(JsonText)(value), () => "undefined");
