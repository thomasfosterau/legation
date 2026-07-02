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
import { SubsetSchema } from "./Subset.js";

// ─── Mutations (upstream) ────────────────────────────────────────────────────

/**
 * One invocation of a mutator: name + args + per-client sequence number.
 * `mutationId` is sequential per client, giving the backend exactly-once,
 * in-order application and giving the client precise acknowledgement.
 */
export const MutationSchema = Schema.Struct({
  clientId: Schema.String,
  mutationId: Schema.Number,
  mutator: Schema.String,
  args: Schema.Unknown,
  /** Client wall-clock at creation; informational only. */
  createdAt: Schema.Number,
});

/** {@inheritDoc MutationSchema} */
export type Mutation = typeof MutationSchema.Type;

/** Push request: pending mutations in journal order. */
export const PushRequestSchema = Schema.Struct({
  clientGroupId: Schema.String,
  mutations: Schema.Array(MutationSchema),
});

/** {@inheritDoc PushRequestSchema} */
export type PushRequest = typeof PushRequestSchema.Type;

/**
 * Push response: the highest mutation id the backend has applied, per
 * client. Mutations at or below these ids are acknowledged; effects arrive
 * via the next pull's patch, which is when the optimistic overlay drops.
 */
export const PushResponseSchema = Schema.Struct({
  lastMutationIds: Schema.Record(Schema.String, Schema.Number),
});

/** {@inheritDoc PushResponseSchema} */
export type PushResponse = typeof PushResponseSchema.Type;

// ─── Patches (downstream) ────────────────────────────────────────────────────

/**
 * One patch operation. `Put` and `Del` address rows; `Clear` resets the
 * client's view (sent when the server does not recognize the cookie).
 */
export const PatchOpSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.tag("Put"),
    collection: Schema.String,
    id: Schema.String,
    version: Schema.Union([Schema.String, Schema.Number]),
    value: Schema.Unknown,
  }),
  Schema.Struct({ _tag: Schema.tag("Del"), collection: Schema.String, id: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("Clear") }),
]);

/** {@inheritDoc PatchOpSchema} */
export type PatchOp = typeof PatchOpSchema.Type;

/** A named-query subscription: resolved to a Subset server-side (Query.ts). */
export const NamedSubscriptionSchema = Schema.Struct({
  name: Schema.String,
  args: Schema.Unknown,
});

/** {@inheritDoc NamedSubscriptionSchema} */
export type NamedSubscription = typeof NamedSubscriptionSchema.Type;

/** Pull request: what the client has (cookie) and wants (subsets). */
export const PullRequestSchema = Schema.Struct({
  clientGroupId: Schema.String,
  /** Cookie from the previous pull; absent on first sync. */
  cookie: Schema.optional(Schema.String),
  subscriptions: Schema.Array(SubsetSchema),
  /** Named queries the server resolves to subsets (optional). */
  namedSubscriptions: Schema.optional(Schema.Array(NamedSubscriptionSchema)),
});

/** {@inheritDoc PullRequestSchema} */
export type PullRequest = typeof PullRequestSchema.Type;

/** Pull response: patch to the new cookie, plus mutation acknowledgements. */
export const PullResponseSchema = Schema.Struct({
  cookie: Schema.String,
  patch: Schema.Array(PatchOpSchema),
  lastMutationIds: Schema.Record(Schema.String, Schema.Number),
});

/** {@inheritDoc PullResponseSchema} */
export type PullResponse = typeof PullResponseSchema.Type;

/** A contentless "pull soon" hint. */
export const PokeSchema = Schema.Struct({
  reason: Schema.optional(Schema.String),
});

/** {@inheritDoc PokeSchema} */
export type Poke = typeof PokeSchema.Type;

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
