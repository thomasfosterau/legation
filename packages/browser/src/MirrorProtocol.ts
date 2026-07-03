/**
 * MirrorProtocol
 *
 * Schema-defined messages between tab mirrors and the engine host
 * (ADR-0010). Mutations, subset subscriptions, named-query registrations,
 * and relational (`related`) registrations flow tab → host;
 * acknowledgements, mirror updates (materialized subset rows, already
 * overlay-applied by the engine), and resolved relational updates flow
 * host → tabs.
 *
 * Registrations carry a `tabId` so the host can refcount them across tabs
 * (tear an engine registration down only when its last tab leaves) and
 * release everything a departing tab held via `Disconnect`.
 *
 * Mutator args travel in encoded (wire) form: the tab validates/encodes
 * against its registry before posting, the host re-validates by decoding
 * (`ClientEngine.mutateEncoded`). Named-query args travel encoded the same
 * way (the host's engine decodes against its query registry).
 */

import { ClientEngine, Hash, Related, Subset } from "@legation/effect";
import { Effect, Schema } from "effect";

// ─── Broadcast keys ──────────────────────────────────────────────────────────

/** The broadcast key a named query's results are mirrored under. */
export const namedKey = (name: string, args: unknown): string =>
  `named:${name}:${Hash.contentHash(args)}`;

/** The broadcast key a `related` registration's resolved rows are mirrored under. */
export const relatedKey = (
  collection: string,
  subset: Subset.Subset,
  names: ReadonlyArray<string>
): string => `related:${collection}:${Subset.hash(subset)}:${[...names].sort().join("+")}`;

// ─── Tab → host ──────────────────────────────────────────────────────────────

export type TabMessage =
  | {
      readonly _tag: "Mutate";
      readonly requestId: number;
      readonly mutator: string;
      readonly args: unknown;
    }
  | { readonly _tag: "Subscribe"; readonly tabId: string; readonly subset: Subset.Subset }
  | { readonly _tag: "Unsubscribe"; readonly tabId: string; readonly subset: Subset.Subset }
  | {
      readonly _tag: "SubscribeNamed";
      readonly tabId: string;
      readonly name: string;
      readonly args: unknown;
    }
  | {
      readonly _tag: "UnsubscribeNamed";
      readonly tabId: string;
      readonly name: string;
      readonly args: unknown;
    }
  | {
      readonly _tag: "SubscribeRelated";
      readonly tabId: string;
      readonly collection: string;
      readonly subset: Subset.Subset;
      readonly names: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "UnsubscribeRelated";
      readonly tabId: string;
      readonly collection: string;
      readonly subset: Subset.Subset;
      readonly names: ReadonlyArray<string>;
    }
  /** A tab leaving: release every subscription it held. */
  | { readonly _tag: "Disconnect"; readonly tabId: string }
  /** Liveness ping: lets the host reclaim subsets from tabs that crash. */
  | { readonly _tag: "Heartbeat"; readonly tabId: string };

export const TabMessageSchema: Schema.Codec<TabMessage> = Schema.Union([
  Schema.Struct({
    _tag: Schema.tag("Mutate"),
    requestId: Schema.Number,
    mutator: Schema.String,
    args: Schema.Unknown,
  }),
  Schema.Struct({
    _tag: Schema.tag("Subscribe"),
    tabId: Schema.String,
    subset: Subset.SubsetSchema,
  }),
  Schema.Struct({
    _tag: Schema.tag("Unsubscribe"),
    tabId: Schema.String,
    subset: Subset.SubsetSchema,
  }),
  Schema.Struct({
    _tag: Schema.tag("SubscribeNamed"),
    tabId: Schema.String,
    name: Schema.String,
    args: Schema.Unknown,
  }),
  Schema.Struct({
    _tag: Schema.tag("UnsubscribeNamed"),
    tabId: Schema.String,
    name: Schema.String,
    args: Schema.Unknown,
  }),
  Schema.Struct({
    _tag: Schema.tag("SubscribeRelated"),
    tabId: Schema.String,
    collection: Schema.String,
    subset: Subset.SubsetSchema,
    names: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.tag("UnsubscribeRelated"),
    tabId: Schema.String,
    collection: Schema.String,
    subset: Subset.SubsetSchema,
    names: Schema.Array(Schema.String),
  }),
  Schema.Struct({ _tag: Schema.tag("Disconnect"), tabId: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("Heartbeat"), tabId: Schema.String }),
]) as Schema.Codec<TabMessage>;

// ─── Host → tabs ─────────────────────────────────────────────────────────────

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

export type HostMessage =
  /**
   * Broadcast once when a host starts serving. Tabs answer by re-posting
   * every registration they hold, so subscriptions survive a host that
   * (re)starts after the tab — a killed service worker, or a dev-mode tab
   * that raced the worker's boot.
   */
  | { readonly _tag: "HostReady" }
  | { readonly _tag: "MutateAck"; readonly requestId: number }
  | { readonly _tag: "MutateError"; readonly requestId: number; readonly message: string }
  /**
   * The backend's authoritative outcome for a forwarded mutation, correlated by
   * `requestId`. Sent in addition to `MutateAck` (which still fires on journal),
   * so a tab can await the backend verdict via `TabMirror.mutateWithAck`.
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
    };

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

const decodeTab = Schema.decodeUnknownEffect(TabMessageSchema);
const decodeHost = Schema.decodeUnknownEffect(HostMessageSchema);

/** Decode an inbound tab message; `undefined` for foreign traffic. */
export const decodeTabMessage = (input: unknown): Effect.Effect<TabMessage | undefined> =>
  decodeTab(input).pipe(Effect.orElseSucceed(() => undefined));

/** Decode an inbound host message; `undefined` for foreign traffic. */
export const decodeHostMessage = (input: unknown): Effect.Effect<HostMessage | undefined> =>
  decodeHost(input).pipe(Effect.orElseSucceed(() => undefined));
