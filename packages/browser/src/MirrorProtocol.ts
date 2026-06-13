/**
 * MirrorProtocol
 *
 * Schema-defined messages between tab mirrors and the engine host
 * (ADR-0010). Mutations and subscription registrations flow tab → host;
 * acknowledgements and mirror updates (materialized subset rows, already
 * overlay-applied by the engine) flow host → tabs.
 *
 * Subscriptions carry a `tabId` so the host can refcount subsets across
 * tabs (tear an engine subscription down only when its last tab leaves) and
 * release everything a departing tab held via `Disconnect`.
 *
 * Mutator args travel in encoded (wire) form: the tab validates/encodes
 * against its registry before posting, the host re-validates by decoding
 * (`ClientEngine.mutateEncoded`).
 */

import { ClientEngine, Subset } from "@thomasfosterau/effect-sync-core";
import { Effect, Schema } from "effect";

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
  /** A tab leaving: release every subscription it held. */
  | { readonly _tag: "Disconnect"; readonly tabId: string };

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
  Schema.Struct({ _tag: Schema.tag("Disconnect"), tabId: Schema.String }),
]) as Schema.Codec<TabMessage>;

// ─── Host → tabs ─────────────────────────────────────────────────────────────

export interface MirrorRow {
  readonly id: string;
  readonly value: unknown;
}

export type HostMessage =
  | { readonly _tag: "MutateAck"; readonly requestId: number }
  | { readonly _tag: "MutateError"; readonly requestId: number; readonly message: string }
  | {
      readonly _tag: "MirrorUpdate";
      /** `Subset.hash` of the subset these rows materialize. */
      readonly key: string;
      readonly rows: ReadonlyArray<MirrorRow>;
    };

export const HostMessageSchema: Schema.Codec<HostMessage> = Schema.Union([
  Schema.Struct({ _tag: Schema.tag("MutateAck"), requestId: Schema.Number }),
  Schema.Struct({
    _tag: Schema.tag("MutateError"),
    requestId: Schema.Number,
    message: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.tag("MirrorUpdate"),
    key: Schema.String,
    rows: Schema.Array(Schema.Struct({ id: Schema.String, value: Schema.Unknown })),
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

const decodeTab = Schema.decodeUnknownEffect(TabMessageSchema);
const decodeHost = Schema.decodeUnknownEffect(HostMessageSchema);

/** Decode an inbound tab message; `undefined` for foreign traffic. */
export const decodeTabMessage = (input: unknown): Effect.Effect<TabMessage | undefined> =>
  decodeTab(input).pipe(Effect.orElseSucceed(() => undefined));

/** Decode an inbound host message; `undefined` for foreign traffic. */
export const decodeHostMessage = (input: unknown): Effect.Effect<HostMessage | undefined> =>
  decodeHost(input).pipe(Effect.orElseSucceed(() => undefined));
