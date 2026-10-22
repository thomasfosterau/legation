/**
 * RoomProtocol
 *
 * The room's wire format, chosen for WebSocket **hibernation**: requests
 * (push/pull/read) travel as stateless HTTP POST JSON — a hibernated room
 * wakes, answers, and may be evicted again — while the WebSocket carries
 * exactly one thing: contentless **poke** frames. No server-side session
 * state survives eviction, so none is kept.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProtocolError } from "@thomasfosterau/legation-effect";
import { Protocol } from "@thomasfosterau/legation-effect/internal";

type Decoder<A> = (input: unknown) => Effect.Effect<A, ProtocolError>;

/** The room's HTTP routes (relative to the room's base path). */
export const routes = {
  push: "/push",
  pull: "/pull",
  read: "/read",
  /** WebSocket upgrade: the poke channel. */
  socket: "/socket",
  /** Shard → room: topics whose leases matched a publish. */
  poke: "/poke",
} as const;

/** The single frame a room socket ever sends. */
export interface PokeFrame {
  readonly type: "poke";
}

/** The single poke frame a room socket sends, as a value to serialize. */
export const pokeFrame: PokeFrame = { type: "poke" };

/** Shard → room poke body: the matched topics. */
export const ShardPokeSchema = Schema.Struct({
  topics: Schema.Array(Schema.String),
});

/** Decode a shard-to-room poke body; fails with `ProtocolError` when it doesn't match. */
export const decodeShardPoke = (input: unknown) =>
  Schema.decodeUnknownEffect(ShardPokeSchema)(input).pipe(
    Effect.mapError((cause) => new ProtocolError({ message: "Invalid shard poke", cause }))
  );

/** Shard registration body: a room's leased topics. */
export const RegisterSchema = Schema.Struct({
  roomId: Schema.String,
  topics: Schema.Array(Schema.String),
  ttlMillis: Schema.Number,
});

/** Decode a room-to-shard register body; fails with `ProtocolError` when it doesn't match. */
export const decodeRegister = (input: unknown) =>
  Schema.decodeUnknownEffect(RegisterSchema)(input).pipe(
    Effect.mapError((cause) => new ProtocolError({ message: "Invalid shard register", cause }))
  );

/** Shard publish body: a write's derived topics. */
export const PublishSchema = Schema.Struct({
  topics: Schema.Array(Schema.String),
});

/** Decode a room-to-shard publish body; fails with `ProtocolError` when it doesn't match. */
export const decodePublish = (input: unknown) =>
  Schema.decodeUnknownEffect(PublishSchema)(input).pipe(
    Effect.mapError((cause) => new ProtocolError({ message: "Invalid shard publish", cause }))
  );

/** Re-exported request decoders — the room's HTTP bodies are the protocol's. */
export const decodePushRequest: Decoder<Protocol.PushRequest> = Protocol.decodePushRequest;
/** The protocol's pull-request decoder. */
export const decodePullRequest: Decoder<Protocol.PullRequest> = Protocol.decodePullRequest;
/** The protocol's read-request decoder. */
export const decodeReadRequest: Decoder<Protocol.ReadRequest> = Protocol.decodeReadRequest;
