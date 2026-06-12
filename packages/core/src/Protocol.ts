/**
 * Protocol
 *
 * The sync protocol's schema-defined messages (ADR-0008). Mutator intents
 * flow up (push); server-computed state patches flow down (pull). The
 * protocol is carrier-agnostic: any transport that can move these messages
 * qualifies (Transport.ts), with the RPC implementation as the default.
 *
 * `Pull(cookie) → patch` is the canonical correctness path: sync must be
 * correct over pull alone. Pokes and streamed patches are optimizations.
 */

import { Effect, Schema } from "effect";
import { ProtocolError } from "./Errors.js";
import type { Subset } from "./Subset.js";
import { SubsetSchema } from "./Subset.js";

// ─── Mutations (upstream) ────────────────────────────────────────────────────

/**
 * One invocation of a mutator: name + args + per-client sequence number.
 * `mutationId` is sequential per client, giving the backend exactly-once,
 * in-order application and giving the client precise acknowledgement.
 */
export interface Mutation {
  readonly clientId: string;
  readonly mutationId: number;
  readonly mutator: string;
  readonly args: unknown;
  /** Client wall-clock at creation; informational only. */
  readonly createdAt: number;
}

export const MutationSchema: Schema.Codec<Mutation> = Schema.Struct({
  clientId: Schema.String,
  mutationId: Schema.Number,
  mutator: Schema.String,
  args: Schema.Unknown,
  createdAt: Schema.Number,
}) as Schema.Codec<Mutation>;

/** Push request: pending mutations in journal order. */
export interface PushRequest {
  readonly clientGroupId: string;
  readonly mutations: ReadonlyArray<Mutation>;
}

export const PushRequestSchema: Schema.Codec<PushRequest> = Schema.Struct({
  clientGroupId: Schema.String,
  mutations: Schema.Array(MutationSchema),
}) as Schema.Codec<PushRequest>;

/**
 * Push response: the highest mutation id the backend has applied, per
 * client. Mutations at or below these ids are acknowledged; effects arrive
 * via the next pull's patch, which is when the optimistic overlay drops.
 */
export interface PushResponse {
  readonly lastMutationIds: Readonly<Record<string, number>>;
}

export const PushResponseSchema: Schema.Codec<PushResponse> = Schema.Struct({
  lastMutationIds: Schema.Record(Schema.String, Schema.Number),
}) as Schema.Codec<PushResponse>;

// ─── Patches (downstream) ────────────────────────────────────────────────────

/**
 * One patch operation. `Put` and `Del` address rows; `Clear` resets the
 * client's view (sent when the server does not recognize the cookie).
 */
export type PatchOp =
  | {
      readonly _tag: "Put";
      readonly collection: string;
      readonly id: string;
      readonly version: string | number;
      readonly value: unknown;
    }
  | { readonly _tag: "Del"; readonly collection: string; readonly id: string }
  | { readonly _tag: "Clear" };

export const PatchOpSchema: Schema.Codec<PatchOp> = Schema.Union([
  Schema.Struct({
    _tag: Schema.tag("Put"),
    collection: Schema.String,
    id: Schema.String,
    version: Schema.Union([Schema.String, Schema.Number]),
    value: Schema.Unknown,
  }),
  Schema.Struct({ _tag: Schema.tag("Del"), collection: Schema.String, id: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("Clear") }),
]) as Schema.Codec<PatchOp>;

/** Pull request: what the client has (cookie) and wants (subsets). */
export interface PullRequest {
  readonly clientGroupId: string;
  /** Cookie from the previous pull; absent on first sync. */
  readonly cookie?: string | undefined;
  readonly subscriptions: ReadonlyArray<Subset>;
}

export const PullRequestSchema: Schema.Codec<PullRequest> = Schema.Struct({
  clientGroupId: Schema.String,
  cookie: Schema.optional(Schema.String),
  subscriptions: Schema.Array(SubsetSchema),
}) as Schema.Codec<PullRequest>;

/** Pull response: patch to the new cookie, plus mutation acknowledgements. */
export interface PullResponse {
  readonly cookie: string;
  readonly patch: ReadonlyArray<PatchOp>;
  readonly lastMutationIds: Readonly<Record<string, number>>;
}

export const PullResponseSchema: Schema.Codec<PullResponse> = Schema.Struct({
  cookie: Schema.String,
  patch: Schema.Array(PatchOpSchema),
  lastMutationIds: Schema.Record(Schema.String, Schema.Number),
}) as Schema.Codec<PullResponse>;

/** A contentless "pull soon" hint. */
export interface Poke {
  readonly reason?: string | undefined;
}

export const PokeSchema: Schema.Codec<Poke> = Schema.Struct({
  reason: Schema.optional(Schema.String),
}) as Schema.Codec<Poke>;

// ─── Decode helpers ──────────────────────────────────────────────────────────

const decodeWith =
  <A>(schema: Schema.Codec<A>, what: string) =>
  (input: unknown): Effect.Effect<A, ProtocolError> =>
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError((cause) => new ProtocolError({ message: `Invalid ${what}`, cause }))
    );

export const decodePushRequest = decodeWith(PushRequestSchema, "push request");
export const decodePullRequest = decodeWith(PullRequestSchema, "pull request");
export const decodePushResponse = decodeWith(PushResponseSchema, "push response");
export const decodePullResponse = decodeWith(PullResponseSchema, "pull response");
export const decodePatchOp = decodeWith(PatchOpSchema, "patch op");
