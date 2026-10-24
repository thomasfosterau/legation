/**
 * MirrorProtocol
 *
 * Schema-defined messages between mirrors and the engine host (ADR-0010).
 *
 * A **mirror** is the light half of the split the seam exists for: the
 * engine proper holds the durable replica and runs the sync loop — one per
 * origin — while each client context (a browser tab, an Electron window,
 * an extension, a CLI instance) holds a mirror: an in-memory copy of just
 * the subsets that context registered, hydrated and kept current by host
 * broadcasts, serving reads synchronously and forwarding writes to the
 * host journal. A read-replica + write-proxy of the engine, cheap enough
 * to have one per window; it holds no durable state (a mirror that dies
 * loses nothing — a new one re-registers and rehydrates) and can only
 * answer for registered keys (hence observing auto-registers). Mutations, subset subscriptions, named-query registrations,
 * and relational (`related`) registrations flow mirror → host;
 * acknowledgements, mirror updates (materialized subset rows, already
 * overlay-applied by the engine), and resolved relational updates flow
 * host → mirrors.
 *
 * Registrations carry a `mirrorId` so the host can refcount them across
 * mirrors (tear an engine registration down only when the last mirror
 * leaves) and release everything a departing mirror held via `Disconnect`.
 *
 * Mutator args travel in encoded (wire) form: the mirror validates/encodes
 * against its registry before posting, the host re-validates by decoding
 * (`ClientEngine.mutateEncoded`). Named-query args travel encoded the same
 * way (the host's engine decodes against its query registry).
 */

import type * as ClientEngine from "./ClientEngine.js";
import type * as Coverage from "./Coverage.js";
import * as Hash from "./Hash.js";
import type * as MutationState from "./MutationState.js";
import type * as Related from "./Related.js";
import * as Subset from "./Subset.js";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";

/** Wire codec for one selected edge of a `related` registration. */
export const EdgeSelectSchema = Schema.Struct({
  name: Schema.String,
  first: Schema.optional(Schema.Number),
});

/** Wire codec for one {@link MutationState.MutationState} entry (#116). */
export const MutationStateSchema = Schema.Struct({
  mutationId: Schema.Number,
  mutator: Schema.String,
  args: Schema.Unknown,
  phase: Schema.Literals(["pending", "acknowledged", "rejected", "dropped"]),
  reason: Schema.optional(Schema.String),
  journaledAt: Schema.Number,
  settledAt: Schema.optional(Schema.Number),
});

// ─── Broadcast keys ──────────────────────────────────────────────────────────

/** The broadcast key a named query's results are mirrored under. */
export const namedKey = (name: string, args: unknown): string =>
  `named:${name}:${Hash.contentHash(args)}`;

/**
 * The broadcast key {@link ClientEngine.ClientEngine.mutationStates} is
 * mirrored under (#116) — a singleton, unparameterized registration (unlike
 * subsets/named queries, there is exactly one mutation-state map per engine).
 */
export const MUTATION_STATES_KEY = "mutationStates";

/**
 * The broadcast key a `related` registration's resolved rows are mirrored
 * under. Each edge's window (`first`) is part of the key: reads differing
 * only in window are distinct registrations (ADR-0024).
 */
export const relatedKey = (
  collection: string,
  subset: Subset.Subset,
  edges: ReadonlyArray<string | Related.EdgeSelect>
): string => {
  const parts = edges
    .map((input) => (P.isString(input) ? { name: input } : input))
    .map((select) => (select.first === undefined ? select.name : `${select.name}#${select.first}`));
  return `related:${collection}:${Subset.hash(subset)}:${Arr.sort(parts, Order.String).join("+")}`;
};

// ─── Enhanced form submits (#536) ─────────────────────────────────────────────

/**
 * The reserved mutator name an enhanced form submit's begin travels under
 * (ADR-0030 #215 §4, #536). A mirror asks its host to begin a form mutation
 * with a `Mutate` naming this mutator, its args a {@link FormMutationBegin}.
 * A host that knows it answers `FormMutationBegun` or `FormMutationFailed`
 * and journals nothing. It travels as a `Mutate`, not a tag of its own, so a
 * host that predates it answers too: its engine has no such mutator, so it
 * replies `MutateError` and journals nothing, and the mirror reports that
 * the host is too old instead of waiting on a message the host dropped as
 * foreign traffic. No app mutator may take this name.
 */
export const FORM_MUTATION_MUTATOR = "@thomasfosterau/legation-effect/beginFormMutation";

/** The args of a {@link FORM_MUTATION_MUTATOR} `Mutate`: the form client and the Mutation it runs. */
export interface FormMutationBegin {
  /** The mirror the entry belongs to; its `Disconnect` (or liveness sweep) abandons it. */
  readonly mirrorId: string;
  readonly form: ClientEngine.FormClient;
  readonly mutator: string;
  /** The Mutation's args in encoded (wire) form; the host decodes them. */
  readonly args: unknown;
}

/** Wire codec for {@link FormMutationBegin}. */
export const FormMutationBeginSchema = Schema.Struct({
  mirrorId: Schema.String,
  form: Schema.Struct({ clientId: Schema.String, mutationId: Schema.Number }),
  mutator: Schema.String,
  args: Schema.Unknown,
});

/** Wire codec for {@link ClientEngine.FormRuling}. */
export const FormRulingSchema = Schema.Union([
  Schema.Struct({ phase: Schema.Literal("acknowledged") }),
  Schema.Struct({ phase: Schema.Literal("rejected"), reason: Schema.String }),
]);

// ─── Mirror → host ────────────────────────────────────────────────────────────

/** A message a mirror sends to the host. */
export type MirrorMessage =
  | {
      readonly _tag: "Mutate";
      readonly requestId: number;
      readonly mutator: string;
      readonly args: unknown;
    }
  | { readonly _tag: "Subscribe"; readonly mirrorId: string; readonly subset: Subset.Subset }
  | { readonly _tag: "Unsubscribe"; readonly mirrorId: string; readonly subset: Subset.Subset }
  | {
      readonly _tag: "SubscribeNamed";
      readonly mirrorId: string;
      readonly name: string;
      readonly args: unknown;
    }
  | {
      readonly _tag: "UnsubscribeNamed";
      readonly mirrorId: string;
      readonly name: string;
      readonly args: unknown;
    }
  | {
      readonly _tag: "SubscribeRelated";
      readonly mirrorId: string;
      readonly collection: string;
      readonly subset: Subset.Subset;
      /** The selected edges, each optionally windowed (ADR-0024). */
      readonly edges: ReadonlyArray<Related.EdgeSelect>;
    }
  | {
      readonly _tag: "UnsubscribeRelated";
      readonly mirrorId: string;
      readonly collection: string;
      readonly subset: Subset.Subset;
      readonly edges: ReadonlyArray<Related.EdgeSelect>;
    }
  /**
   * A URL-keyed subscription (ADR-0029 section 2, #159) from a party with
   * no `Client` of its own — a page posting on the channel. The host parses
   * the URL through its `UrlReads`, and registers the read's root window
   * and edge windows under `mirrorId` exactly as a mirror's `Subscribe` and
   * `SubscribeRelated` would: refcounted per party, replayed on `HostReady`
   * by the party, and reclaimed by the liveness sweep unless the party
   * heartbeats. A URL the host cannot parse registers nothing.
   */
  | { readonly _tag: "SubscribeUrl"; readonly mirrorId: string; readonly url: string }
  | { readonly _tag: "UnsubscribeUrl"; readonly mirrorId: string; readonly url: string }
  /** A server-fallthrough read (ADR-0025), answered by `ReadResult`. */
  | {
      readonly _tag: "Read";
      readonly requestId: number;
      readonly subsets: ReadonlyArray<Subset.Subset>;
    }
  /** Register interest in the mutation-state map (#116); see {@link MUTATION_STATES_KEY}. */
  | { readonly _tag: "SubscribeMutationStates"; readonly mirrorId: string }
  | { readonly _tag: "UnsubscribeMutationStates"; readonly mirrorId: string }
  /** A mirror leaving: release every subscription it held. */
  | { readonly _tag: "Disconnect"; readonly mirrorId: string }
  /** Liveness ping: lets the host reclaim subsets from mirrors that crash. */
  | { readonly _tag: "Heartbeat"; readonly mirrorId: string }
  /**
   * End an enhanced form submission begun with a {@link FORM_MUTATION_MUTATOR}
   * `Mutate` (#536): `ruling` settles it on the form action's receipt, and its
   * absence abandons it. `requestId` is the begin's. Answered by
   * `FormMutationEnded`, also when the host no longer holds the entry.
   */
  | {
      readonly _tag: "EndFormMutation";
      readonly mirrorId: string;
      readonly requestId: number;
      readonly ruling?: ClientEngine.FormRuling;
    };

/** Wire codec for {@link MirrorMessage}. */
export const MirrorMessageSchema: Schema.Codec<MirrorMessage> = Schema.Union([
  Schema.Struct({
    _tag: Schema.tag("Mutate"),
    requestId: Schema.Number,
    mutator: Schema.String,
    args: Schema.Unknown,
  }),
  Schema.Struct({
    _tag: Schema.tag("Subscribe"),
    mirrorId: Schema.String,
    subset: Subset.SubsetSchema,
  }),
  Schema.Struct({
    _tag: Schema.tag("Unsubscribe"),
    mirrorId: Schema.String,
    subset: Subset.SubsetSchema,
  }),
  Schema.Struct({
    _tag: Schema.tag("SubscribeNamed"),
    mirrorId: Schema.String,
    name: Schema.String,
    args: Schema.Unknown,
  }),
  Schema.Struct({
    _tag: Schema.tag("UnsubscribeNamed"),
    mirrorId: Schema.String,
    name: Schema.String,
    args: Schema.Unknown,
  }),
  Schema.Struct({
    _tag: Schema.tag("SubscribeRelated"),
    mirrorId: Schema.String,
    collection: Schema.String,
    subset: Subset.SubsetSchema,
    edges: Schema.Array(EdgeSelectSchema),
  }),
  Schema.Struct({
    _tag: Schema.tag("UnsubscribeRelated"),
    mirrorId: Schema.String,
    collection: Schema.String,
    subset: Subset.SubsetSchema,
    edges: Schema.Array(EdgeSelectSchema),
  }),
  Schema.Struct({ _tag: Schema.tag("SubscribeUrl"), mirrorId: Schema.String, url: Schema.String }),
  Schema.Struct({
    _tag: Schema.tag("UnsubscribeUrl"),
    mirrorId: Schema.String,
    url: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.tag("Read"),
    requestId: Schema.Number,
    subsets: Schema.Array(Subset.SubsetSchema),
  }),
  Schema.Struct({ _tag: Schema.tag("SubscribeMutationStates"), mirrorId: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("UnsubscribeMutationStates"), mirrorId: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("Disconnect"), mirrorId: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("Heartbeat"), mirrorId: Schema.String }),
  Schema.Struct({
    _tag: Schema.tag("EndFormMutation"),
    mirrorId: Schema.String,
    requestId: Schema.Number,
    ruling: Schema.optional(FormRulingSchema),
  }),
]) as Schema.Codec<MirrorMessage>;

// ─── Host → mirrors ───────────────────────────────────────────────────────────

/** A row as the host sends it to a mirror. */
export interface MirrorRow {
  readonly id: string;
  readonly value: unknown;
}

/** A resolved relational row on the wire: base row + its resolved names. */
export interface MirrorRelatedRow {
  readonly id: string;
  readonly value: unknown;
  readonly related: Readonly<Record<string, unknown>>;
}

/** A message the host sends to its mirrors. */
export type HostMessage =
  /**
   * Broadcast once when a host starts serving. Mirrors answer by re-posting
   * every registration they hold, so subscriptions survive a host that
   * (re)starts after the mirror — a killed service worker, or a client context
   * that raced the worker's boot.
   */
  | { readonly _tag: "HostReady" }
  | { readonly _tag: "MutateAck"; readonly requestId: number }
  | { readonly _tag: "MutateError"; readonly requestId: number; readonly message: string }
  /**
   * The backend's authoritative outcome for a forwarded mutation, correlated by
   * `requestId`. Sent in addition to `MutateAck` (which still fires on journal),
   * so a mirror can await the backend verdict via `Mirror.mutateWithAck`.
   */
  | {
      readonly _tag: "MutateSettled";
      readonly requestId: number;
      readonly outcome: "applied" | "rejected";
      readonly reason?: string;
    }
  | {
      readonly _tag: "MirrorUpdate";
      /** `Subset.hash` of the subset (or {@link namedKey}) these rows materialize. */
      readonly key: string;
      readonly rows: ReadonlyArray<MirrorRow>;
    }
  | {
      readonly _tag: "RelatedUpdate";
      /** {@link relatedKey} of the registration these resolved rows materialize. */
      readonly key: string;
      readonly rows: ReadonlyArray<MirrorRelatedRow>;
    }
  /** The answer to a `Read` request (ADR-0025), correlated by `requestId`. */
  | {
      readonly _tag: "ReadResult";
      readonly requestId: number;
      readonly rows: ReadonlyArray<{
        readonly collection: string;
        readonly id: string;
        readonly value: unknown;
      }>;
      /** Set instead of rows when the host could not serve the read. */
      readonly error?: string;
    }
  /** The whole mutation-state map, broadcast on every fold (#116). */
  | {
      readonly _tag: "MutationStatesUpdate";
      readonly states: ReadonlyArray<MutationState.MutationState>;
    }
  /**
   * The pulled summaries of the host's registrations (#426): per key (a
   * `Subscribe`'s subset hash, or a `SubscribeRelated`'s {@link relatedKey}),
   * each window the registration holds with whether its rows are in the
   * replica. A mirror answers a covered read locally only when the windows
   * the read's rows link to are pulled (`Coverage.pulledFor`). Sent whenever it
   * changes and on `HostReady`. A mirror that predates it ignores the message
   * (foreign traffic) and judges coverage from its registrations alone, as it
   * did before #426: it answers covered reads locally, so the #422 race (a
   * covered answer before its linked windows are pulled) persists for it until
   * it is upgraded.
   */
  | {
      readonly _tag: "PulledRegistrations";
      readonly registrations: ReadonlyArray<PulledRegistration>;
    }
  /** A {@link FORM_MUTATION_MUTATOR} begin overlaid under its form client (#536). */
  | { readonly _tag: "FormMutationBegun"; readonly requestId: number }
  /**
   * A {@link FORM_MUTATION_MUTATOR} begin the host refused (unknown Mutation,
   * args that do not decode, a store failure): nothing was overlaid. A
   * dedicated tag, so that `MutateError` for a begin means only "this host
   * predates enhanced form submits".
   */
  | { readonly _tag: "FormMutationFailed"; readonly requestId: number; readonly message: string }
  /** The answer to `EndFormMutation`, correlated by the begin's `requestId`. */
  | { readonly _tag: "FormMutationEnded"; readonly requestId: number };

/** One registration's pulled summary, keyed as the host keys it. */
export interface PulledRegistration {
  readonly key: string;
  readonly pulled: Coverage.Pulled;
}

/** Wire codec for {@link HostMessage}. */
export const HostMessageSchema: Schema.Codec<HostMessage> = Schema.Union([
  Schema.Struct({ _tag: Schema.tag("HostReady") }),
  Schema.Struct({ _tag: Schema.tag("MutateAck"), requestId: Schema.Number }),
  Schema.Struct({
    _tag: Schema.tag("MutateError"),
    requestId: Schema.Number,
    message: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.tag("MutateSettled"),
    requestId: Schema.Number,
    outcome: Schema.Literals(["applied", "rejected"]),
    reason: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.tag("MirrorUpdate"),
    key: Schema.String,
    rows: Schema.Array(Schema.Struct({ id: Schema.String, value: Schema.Unknown })),
  }),
  Schema.Struct({
    _tag: Schema.tag("RelatedUpdate"),
    key: Schema.String,
    rows: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        value: Schema.Unknown,
        related: Schema.Record(Schema.String, Schema.Unknown),
      })
    ),
  }),
  Schema.Struct({
    _tag: Schema.tag("ReadResult"),
    requestId: Schema.Number,
    rows: Schema.Array(
      Schema.Struct({
        collection: Schema.String,
        id: Schema.String,
        value: Schema.Unknown,
      })
    ),
    error: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.tag("MutationStatesUpdate"),
    states: Schema.Array(MutationStateSchema),
  }),
  Schema.Struct({
    _tag: Schema.tag("PulledRegistrations"),
    registrations: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        pulled: Schema.Struct({
          windows: Schema.Array(
            Schema.Struct({
              subset: Subset.SubsetSchema,
              // oxlint-disable-next-line effect/require-is-prefix-for-boolean-schema-field -- `pulled` is a wire field of the mirror protocol (and mirrors `Coverage.Window.pulled`); renaming it breaks the protocol.
              pulled: Schema.Boolean,
            })
          ),
        }),
      })
    ),
  }),
  Schema.Struct({ _tag: Schema.tag("FormMutationBegun"), requestId: Schema.Number }),
  Schema.Struct({
    _tag: Schema.tag("FormMutationFailed"),
    requestId: Schema.Number,
    message: Schema.String,
  }),
  Schema.Struct({ _tag: Schema.tag("FormMutationEnded"), requestId: Schema.Number }),
]) as Schema.Codec<HostMessage>;

/** Build a MirrorUpdate from materialized engine rows. */
export const mirrorUpdate = (
  key: string,
  rows: ReadonlyArray<ClientEngine.LocalRow>
): HostMessage => ({
  _tag: "MirrorUpdate",
  key,
  rows: rows.map((row) => ({ id: row.id, value: row.value })),
});

/** Build a RelatedUpdate from resolved relational rows. */
export const relatedUpdate = (
  key: string,
  rows: ReadonlyArray<Related.RelatedRow>
): HostMessage => ({
  _tag: "RelatedUpdate",
  key,
  rows: rows.map((row) => ({ id: row.id, value: row.value, related: row.related })),
});

/** Build a MutationStatesUpdate from the engine's current mutation-state map (#116). */
export const mutationStatesUpdate = (states: MutationState.MutationStateMap): HostMessage => ({
  _tag: "MutationStatesUpdate",
  states: [...HashMap.values(states)],
});

const decodeTab = Schema.decodeUnknownEffect(MirrorMessageSchema);
const decodeHost = Schema.decodeUnknownEffect(HostMessageSchema);

/** Decode an inbound mirror message; `undefined` for foreign traffic. */
export const decodeMirrorMessage = (input: unknown): Effect.Effect<MirrorMessage | undefined> =>
  decodeTab(input).pipe(Effect.orElseSucceed(() => undefined));

/** Decode an inbound host message; `undefined` for foreign traffic. */
export const decodeHostMessage = (input: unknown): Effect.Effect<HostMessage | undefined> =>
  decodeHost(input).pipe(Effect.orElseSucceed(() => undefined));
