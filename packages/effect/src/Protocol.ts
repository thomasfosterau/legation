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

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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
  /**
   * The client build's schema version (#48). Additive and optional: an old
   * client omits it and still decodes, a new server tolerates its absence. The
   * server's acceptor may reject an unsupported version up front
   * (VersionNotSupportedError) so an obsolete build is told to update.
   */
  schemaVersion: Schema.optional(Schema.String),
});

/** {@inheritDoc PushRequestSchema} */
export type PushRequest = typeof PushRequestSchema.Type;

/**
 * A mutation the backend permanently rejected: its id is acknowledged, but its
 * effects were not applied, and `reason` is the backend's stated cause.
 */
export const RejectedMutationSchema = Schema.Struct({
  clientId: Schema.String,
  mutationId: Schema.Number,
  reason: Schema.String,
});

/** {@inheritDoc RejectedMutationSchema} */
export type RejectedMutation = typeof RejectedMutationSchema.Type;

/**
 * Push response: the highest mutation id the backend has applied, per
 * client. Mutations at or below these ids are acknowledged; effects arrive
 * via the next pull's patch, which is when the optimistic overlay drops.
 */
export const PushResponseSchema = Schema.Struct({
  lastMutationIds: Schema.Record(Schema.String, Schema.Number),
  /**
   * Mutations the backend permanently rejected: their `lastMutationId` is
   * bumped (so they are acknowledged and skipped, never poisoning the queue)
   * but their effects were not applied. Additive and optional, so older clients
   * ignore it; the per-mutation outcome surface (#36) reads it.
   */
  rejected: Schema.optional(Schema.Array(RejectedMutationSchema)),
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
  /** {@inheritDoc PushRequestSchema.schemaVersion} */
  schemaVersion: Schema.optional(Schema.String),
});

/** {@inheritDoc PullRequestSchema} */
export type PullRequest = typeof PullRequestSchema.Type;

/**
 * Pull response: patch to the new cookie, plus mutation acknowledgements.
 *
 * A pull acknowledges every id its `lastMutationIds` covers, and a permanently
 * rejected id is one of them (its bump is what makes it acknowledged). So the
 * response also carries the rejections the watermark covers (#365): the client
 * settles those entries as rejected, not applied, before it acknowledges the
 * rest. The list is additive and optional, like the push response's: an older
 * client ignores it and keeps its previous settlement, and a pull from an older
 * server omits it, which the client reads as none. No protocol version bump
 * is needed, since neither side fails to decode the other's response.
 */
export const PullResponseSchema = Schema.Struct({
  cookie: Schema.String,
  patch: Schema.Array(PatchOpSchema),
  lastMutationIds: Schema.Record(Schema.String, Schema.Number),
  /**
   * The permanently rejected mutations of this client group that
   * `lastMutationIds` covers, each with its reason. Omitted when none.
   */
  rejected: Schema.optional(Schema.Array(RejectedMutationSchema)),
});

/** {@inheritDoc PullResponseSchema} */
export type PullResponse = typeof PullResponseSchema.Type;

/**
 * Read request: a point-in-time batch subset evaluation (ADR-0025) — the
 * server-fallthrough tier. Evaluated under the same auth filters as pull,
 * with **no CVR involvement**: no cookie, no registration, no
 * `lastMutationIds`.
 */
export const ReadRequestSchema = Schema.Struct({
  clientGroupId: Schema.String,
  subsets: Schema.Array(SubsetSchema),
  /** {@inheritDoc PushRequestSchema.schemaVersion} */
  schemaVersion: Schema.optional(Schema.String),
});

/** {@inheritDoc ReadRequestSchema} */
export type ReadRequest = typeof ReadRequestSchema.Type;

/** Read response: the matching rows, point-in-time. */
export const ReadResponseSchema = Schema.Struct({
  rows: Schema.Array(
    Schema.Struct({
      collection: Schema.String,
      id: Schema.String,
      version: Schema.Union([Schema.String, Schema.Number]),
      value: Schema.Unknown,
    })
  ),
});

/** {@inheritDoc ReadResponseSchema} */
export type ReadResponse = typeof ReadResponseSchema.Type;

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

/**
 * Decode an untrusted push request; fails with `ProtocolError` when it doesn't match the schema.
 */
export const decodePushRequest = decodeWith(PushRequestSchema, "push request");
/**
 * Decode an untrusted pull request; fails with `ProtocolError` when it doesn't match the schema.
 */
export const decodePullRequest = decodeWith(PullRequestSchema, "pull request");
/**
 * Decode an untrusted read request; fails with `ProtocolError` when it doesn't match the schema.
 */
export const decodeReadRequest = decodeWith(ReadRequestSchema, "read request");
/** Decode a push response; fails with `ProtocolError` when it doesn't match the schema. */
export const decodePushResponse = decodeWith(PushResponseSchema, "push response");
/** Decode a pull response; fails with `ProtocolError` when it doesn't match the schema. */
export const decodePullResponse = decodeWith(PullResponseSchema, "pull response");
/** Decode one patch operation; fails with `ProtocolError` when it doesn't match the schema. */
export const decodePatchOp = decodeWith(PatchOpSchema, "patch op");
