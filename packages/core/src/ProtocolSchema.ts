/**
 * ProtocolSchema
 *
 * Effect `Schema` codecs for the wire protocol defined in `Protocol.ts`,
 * plus decode helpers that turn untrusted input (e.g. the output of
 * `JSON.parse` on a received frame) into the hand-written `Protocol` types.
 *
 * `Protocol.ts` remains the source of truth for the protocol's TypeScript
 * types; the schemas in this module are annotated to decode *into* those
 * exact types (`Schema.Codec<Protocol.ClientMessage>` etc.), so a mismatch
 * between a schema and the type it claims to produce is a compile error.
 *
 * All schema failures are mapped to `ProtocolError`, with the underlying
 * `Schema` issue attached as `cause` for diagnostics.
 */

import { Effect, Schema } from "effect";
import { ProtocolError } from "./Errors.js";
import type * as Protocol from "./Protocol.js";
import type * as SyncKey from "./SyncKey.js";

/**
 * Schema for a single `SyncKeyPart`.
 *
 * Parts are recursive: a part can be a primitive (string/number/boolean/
 * null), a nested array of parts, or an object whose values are parts. The
 * recursion is tied off with `Schema.suspend`.
 */
export const SyncKeyPartSchema: Schema.Codec<SyncKey.SyncKeyPart> = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
  Schema.Array(Schema.suspend((): Schema.Codec<SyncKey.SyncKeyPart> => SyncKeyPartSchema)),
  Schema.Record(
    Schema.String,
    Schema.suspend((): Schema.Codec<SyncKey.SyncKeyPart> => SyncKeyPartSchema)
  ),
]) as Schema.Codec<SyncKey.SyncKeyPart>;

/**
 * Schema for a `SyncKey` (an ordered list of `SyncKeyPart`s).
 */
export const SyncKeySchema: Schema.Codec<SyncKey.SyncKey> = Schema.Array(SyncKeyPartSchema);

/**
 * Schema for a `Version` (an opaque string or a numeric version).
 */
export const VersionSchema = Schema.Union([Schema.String, Schema.Number]);

/**
 * Schema for a `WireKeyFilter` (a `Prefix` or `Exact` filter).
 */
export const WireKeyFilterSchema: Schema.Codec<Protocol.WireKeyFilter> = Schema.Union([
  Schema.Struct({ _tag: Schema.tag("Prefix"), prefix: SyncKeySchema }),
  Schema.Struct({ _tag: Schema.tag("Exact"), key: SyncKeySchema }),
]) as Schema.Codec<Protocol.WireKeyFilter>;

/**
 * Schema for a `WireEntry` (one synchronized entry as it travels over the
 * wire). The `value` is arbitrary, so it is `Schema.Unknown`.
 */
export const WireEntrySchema: Schema.Codec<Protocol.WireEntry> = Schema.Struct({
  key: SyncKeySchema,
  value: Schema.Unknown,
  version: VersionSchema,
  updatedAt: Schema.Number,
}) as Schema.Codec<Protocol.WireEntry>;

/**
 * Schema for a `PushMutation`.
 */
export const PushMutationSchema: Schema.Codec<Protocol.PushMutation> = Schema.Struct({
  mutationId: Schema.String,
  key: SyncKeySchema,
  input: Schema.Unknown,
  baseVersion: Schema.optional(VersionSchema),
}) as Schema.Codec<Protocol.PushMutation>;

/**
 * Schema for a `PushResult` (`Applied`, `Conflict`, or `Rejected`).
 */
export const PushResultSchema: Schema.Codec<Protocol.PushResult> = Schema.Union([
  Schema.Struct({
    _tag: Schema.tag("Applied"),
    mutationId: Schema.String,
    entry: WireEntrySchema,
  }),
  Schema.Struct({
    _tag: Schema.tag("Conflict"),
    mutationId: Schema.String,
    key: SyncKeySchema,
    serverEntry: WireEntrySchema,
  }),
  Schema.Struct({
    _tag: Schema.tag("Rejected"),
    mutationId: Schema.String,
    key: SyncKeySchema,
    reason: Schema.String,
  }),
]) as Schema.Codec<Protocol.PushResult>;

/**
 * Schema for a `ClientMessage` (discriminated union on `_tag`).
 */
export const ClientMessageSchema: Schema.Codec<Protocol.ClientMessage> = Schema.Union([
  Schema.Struct({ _tag: Schema.tag("Subscribe"), id: Schema.String, filter: WireKeyFilterSchema }),
  Schema.Struct({
    _tag: Schema.tag("Unsubscribe"),
    id: Schema.String,
    filter: WireKeyFilterSchema,
  }),
  Schema.Struct({
    _tag: Schema.tag("Push"),
    id: Schema.String,
    mutations: Schema.Array(PushMutationSchema),
  }),
  Schema.Struct({ _tag: Schema.tag("Pull"), id: Schema.String, keys: Schema.Array(SyncKeySchema) }),
  Schema.Struct({ _tag: Schema.tag("Ping"), id: Schema.String }),
]) as Schema.Codec<Protocol.ClientMessage>;

/**
 * Schema for a `ServerMessage` (discriminated union on `_tag`).
 */
export const ServerMessageSchema: Schema.Codec<Protocol.ServerMessage> = Schema.Union([
  Schema.Struct({ _tag: Schema.tag("Updated"), entry: WireEntrySchema }),
  Schema.Struct({ _tag: Schema.tag("Removed"), key: SyncKeySchema, version: VersionSchema }),
  Schema.Struct({ _tag: Schema.tag("Invalidated"), filter: WireKeyFilterSchema }),
  Schema.Struct({ _tag: Schema.tag("SubscribeAck"), id: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("UnsubscribeAck"), id: Schema.String }),
  Schema.Struct({
    _tag: Schema.tag("PushAck"),
    id: Schema.String,
    results: Schema.Array(PushResultSchema),
  }),
  Schema.Struct({
    _tag: Schema.tag("PullAck"),
    id: Schema.String,
    entries: Schema.Array(WireEntrySchema),
  }),
  Schema.Struct({ _tag: Schema.tag("Pong"), id: Schema.String }),
  Schema.Struct({
    _tag: Schema.tag("ProtocolFailure"),
    id: Schema.NullOr(Schema.String),
    reason: Schema.String,
  }),
]) as Schema.Codec<Protocol.ServerMessage>;

const decodeClientUnknown = Schema.decodeUnknownEffect(ClientMessageSchema);
const decodeServerUnknown = Schema.decodeUnknownEffect(ServerMessageSchema);
const parseClientUnknown = Schema.decodeUnknownEffect(Schema.fromJsonString(ClientMessageSchema));
const parseServerUnknown = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerMessageSchema));

const toProtocolError =
  (what: string) =>
  (cause: unknown): ProtocolError =>
    new ProtocolError({ message: `Invalid ${what}`, cause });

/**
 * Decode an unknown value (e.g. the output of `JSON.parse`) into a
 * `ClientMessage`. Schema failures become `ProtocolError`.
 */
export const decodeClientMessage = (
  input: unknown
): Effect.Effect<Protocol.ClientMessage, ProtocolError> =>
  decodeClientUnknown(input).pipe(Effect.mapError(toProtocolError("client message")));

/**
 * Decode an unknown value (e.g. the output of `JSON.parse`) into a
 * `ServerMessage`. Schema failures become `ProtocolError`.
 */
export const decodeServerMessage = (
  input: unknown
): Effect.Effect<Protocol.ServerMessage, ProtocolError> =>
  decodeServerUnknown(input).pipe(Effect.mapError(toProtocolError("server message")));

/**
 * Parse a JSON string into a `ClientMessage` (JSON parse followed by schema
 * decode, fused via `Schema.fromJsonString`). Either step's failure becomes
 * a `ProtocolError`.
 */
export const parseClientMessage = (
  text: string
): Effect.Effect<Protocol.ClientMessage, ProtocolError> =>
  parseClientUnknown(text).pipe(Effect.mapError(toProtocolError("client message")));

/**
 * Parse a JSON string into a `ServerMessage` (JSON parse followed by schema
 * decode, fused via `Schema.fromJsonString`). Either step's failure becomes
 * a `ProtocolError`.
 */
export const parseServerMessage = (
  text: string
): Effect.Effect<Protocol.ServerMessage, ProtocolError> =>
  parseServerUnknown(text).pipe(Effect.mapError(toProtocolError("server message")));
