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
import { Subset } from "./Subset.js";

// ─── Mutations (upstream) ────────────────────────────────────────────────────

/**
 * One invocation of a mutator: name + args + per-client sequence number.
 * `mutationId` is sequential per client, giving the backend exactly-once,
 * in-order application and giving the client precise acknowledgement.
 */
export const Mutation = Schema.Struct({
  clientId: Schema.String,
  mutationId: Schema.Number,
  mutator: Schema.String,
  args: Schema.Unknown,
  /** Client wall-clock at creation; informational only. */
  createdAt: Schema.Number,
});

/** The type {@link Mutation} decodes to. */
export type Mutation = typeof Mutation.Type;

/** Push request: pending mutations in journal order. */
export const PushRequest = Schema.Struct({
  clientGroupId: Schema.String,
  mutations: Schema.Array(Mutation),
  /**
   * The client build's schema version (#48). Additive and optional: an old
   * client omits it and still decodes, a new server tolerates its absence. The
   * server's acceptor may reject an unsupported version up front
   * (VersionNotSupportedError) so an obsolete build is told to update.
   */
  schemaVersion: Schema.optional(Schema.String),
});

/** The type {@link PushRequest} decodes to. */
export type PushRequest = typeof PushRequest.Type;

/**
 * A mutation the backend permanently rejected: its id is acknowledged, but its
 * effects were not applied, and `reason` is the backend's stated cause.
 */
export const RejectedMutation = Schema.Struct({
  clientId: Schema.String,
  mutationId: Schema.Number,
  reason: Schema.String,
});

/** The type {@link RejectedMutation} decodes to. */
export type RejectedMutation = typeof RejectedMutation.Type;

/**
 * Push response: the highest mutation id the backend has applied, per
 * client. Mutations at or below these ids are acknowledged; effects arrive
 * via the next pull's patch, which is when the optimistic overlay drops.
 */
export const PushResponse = Schema.Struct({
  lastMutationIds: Schema.Record(Schema.String, Schema.Number),
  /**
   * Mutations the backend permanently rejected: their `lastMutationId` is
   * bumped (so they are acknowledged and skipped, never poisoning the queue)
   * but their effects were not applied. Additive and optional, so older clients
   * ignore it; the per-mutation outcome surface (#36) reads it.
   */
  rejected: Schema.optional(Schema.Array(RejectedMutation)),
});

/** The type {@link PushResponse} decodes to. */
export type PushResponse = typeof PushResponse.Type;

// ─── Patches (downstream) ────────────────────────────────────────────────────

/**
 * One patch operation. `Put` and `Del` address rows; `Clear` resets the
 * client's view (sent when the server does not recognize the cookie).
 */
export const PatchOp = Schema.Union([
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

/** The type {@link PatchOp} decodes to. */
export type PatchOp = typeof PatchOp.Type;

/** A named-query subscription: resolved to a Subset server-side (Query.ts). */
export const NamedSubscription = Schema.Struct({
  name: Schema.String,
  args: Schema.Unknown,
});

/** The type {@link NamedSubscription} decodes to. */
export type NamedSubscription = typeof NamedSubscription.Type;

/** Pull request: what the client has (cookie) and wants (subsets). */
export const PullRequest = Schema.Struct({
  clientGroupId: Schema.String,
  /** Cookie from the previous pull; absent on first sync. */
  cookie: Schema.optional(Schema.String),
  subscriptions: Schema.Array(Subset),
  /** Named queries the server resolves to subsets (optional). */
  namedSubscriptions: Schema.optional(Schema.Array(NamedSubscription)),
  /** {@inheritDoc PushRequest.schemaVersion} */
  schemaVersion: Schema.optional(Schema.String),
});

/** The type {@link PullRequest} decodes to. */
export type PullRequest = typeof PullRequest.Type;

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
export const PullResponse = Schema.Struct({
  cookie: Schema.String,
  patch: Schema.Array(PatchOp),
  lastMutationIds: Schema.Record(Schema.String, Schema.Number),
  /**
   * The permanently rejected mutations of this client group that
   * `lastMutationIds` covers, each with its reason. Omitted when none.
   */
  rejected: Schema.optional(Schema.Array(RejectedMutation)),
  /**
   * Each subscription's **total** (#210, ADR-0029's #210 amendment): how many
   * rows its subset's `where` matches under the server's auth filter,
   * whatever its window. One entry per `PullRequest.subscriptions` entry, in
   * that order, so a windowed subscription's total is the collection's and
   * not the window's. Named subscriptions get none. Additive and optional:
   * omitted when the backend cannot count (`Backend.evaluateCounted` absent)
   * or the pull middleware changed the number of subscriptions; an older
   * client ignores it.
   */
  totals: Schema.optional(Schema.Array(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))),
});

/** The type {@link PullResponse} decodes to. */
export type PullResponse = typeof PullResponse.Type;

/**
 * Read request: a point-in-time batch subset evaluation (ADR-0025) — the
 * server-fallthrough tier. Evaluated under the same auth filters as pull,
 * with **no CVR involvement**: no cookie, no registration, no
 * `lastMutationIds`.
 */
export const ReadRequest = Schema.Struct({
  clientGroupId: Schema.String,
  subsets: Schema.Array(Subset),
  /** {@inheritDoc PushRequest.schemaVersion} */
  schemaVersion: Schema.optional(Schema.String),
});

/** The type {@link ReadRequest} decodes to. */
export type ReadRequest = typeof ReadRequest.Type;

/** Read response: the matching rows, point-in-time. */
export const ReadResponse = Schema.Struct({
  rows: Schema.Array(
    Schema.Struct({
      collection: Schema.String,
      id: Schema.String,
      version: Schema.Union([Schema.String, Schema.Number]),
      value: Schema.Unknown,
    })
  ),
});

/** The type {@link ReadResponse} decodes to. */
export type ReadResponse = typeof ReadResponse.Type;

/** A contentless "pull soon" hint. */
export const Poke = Schema.Struct({
  reason: Schema.optional(Schema.String),
});

/** The type {@link Poke} decodes to. */
export type Poke = typeof Poke.Type;

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
export const decodePushRequest = decodeWith(PushRequest, "push request");
/**
 * Decode an untrusted pull request; fails with `ProtocolError` when it doesn't match the schema.
 */
export const decodePullRequest = decodeWith(PullRequest, "pull request");
/**
 * Decode an untrusted read request; fails with `ProtocolError` when it doesn't match the schema.
 */
export const decodeReadRequest = decodeWith(ReadRequest, "read request");
/** Decode a push response; fails with `ProtocolError` when it doesn't match the schema. */
export const decodePushResponse = decodeWith(PushResponse, "push response");
/** Decode a pull response; fails with `ProtocolError` when it doesn't match the schema. */
export const decodePullResponse = decodeWith(PullResponse, "pull response");
/** Decode one patch operation; fails with `ProtocolError` when it doesn't match the schema. */
export const decodePatchOp = decodeWith(PatchOp, "patch op");
