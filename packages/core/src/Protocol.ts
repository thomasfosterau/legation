/**
 * Protocol
 *
 * The wire protocol spoken between sync clients and sync servers. All
 * messages are plain serializable objects, so any transport that can move
 * JSON can carry them.
 *
 * Message unions are `Data.TaggedEnum`s: construct them with the generated
 * constructors (`ClientMessage.Subscribe({...})`), narrow them with
 * `ClientMessage.$is("Subscribe")`, and pattern-match exhaustively with
 * `ClientMessage.$match`. Values decoded from the wire (plain objects) are
 * type-compatible with the same unions.
 *
 * The protocol is deliberately small:
 *
 * - Clients **subscribe** to key filters and receive `Updated` / `Removed` /
 *   `Invalidated` notifications for matching keys.
 * - Clients **push** mutations; the server applies them write-through to
 *   its backing store and reports per-mutation results (including
 *   conflicts).
 * - Clients **pull** the current state of keys (used on reconnect).
 */

import { Data } from "effect";
import type { SyncKey } from "./SyncKey.js";
import * as Keys from "./SyncKey.js";
import type { Version } from "./Versioned.js";

/**
 * A key filter that can travel over the wire (no predicates).
 */
export type WireKeyFilter = Data.TaggedEnum<{
  Prefix: { readonly prefix: SyncKey };
  Exact: { readonly key: SyncKey };
}>;

/**
 * Constructors and matchers for {@link WireKeyFilter}.
 */
export const WireKeyFilter = Data.taggedEnum<WireKeyFilter>();

/**
 * Convert a wire filter into a `KeyFilter`.
 */
export const toKeyFilter = (filter: WireKeyFilter): Keys.KeyFilter => filter;

/**
 * Identifier correlating a request message with its response.
 */
export type MessageId = string;

/**
 * A client-originated mutation to apply on the server.
 */
export interface PushMutation {
  /** Client-side id used to correlate results (e.g. the outbox entry id). */
  readonly mutationId: string;
  readonly key: SyncKey;
  /** The new value (or mutation payload, for command-style mutations). */
  readonly input: unknown;
  /** The version the client last saw for this key, for conflict detection. */
  readonly baseVersion?: Version | undefined;
}

/**
 * One synchronized entry as it travels over the wire.
 */
export interface WireEntry {
  readonly key: SyncKey;
  readonly value: unknown;
  readonly version: Version;
  readonly updatedAt: number;
}

/**
 * Messages sent from client to server.
 */
export type ClientMessage = Data.TaggedEnum<{
  Subscribe: { readonly id: MessageId; readonly filter: WireKeyFilter };
  Unsubscribe: { readonly id: MessageId; readonly filter: WireKeyFilter };
  Push: { readonly id: MessageId; readonly mutations: ReadonlyArray<PushMutation> };
  Pull: { readonly id: MessageId; readonly keys: ReadonlyArray<SyncKey> };
  Ping: { readonly id: MessageId };
}>;

/**
 * Constructors and matchers for {@link ClientMessage}:
 * `ClientMessage.Subscribe({...})`, `ClientMessage.$is("Push")`,
 * `ClientMessage.$match`.
 */
export const ClientMessage = Data.taggedEnum<ClientMessage>();

/**
 * Per-mutation result of a push.
 */
export type PushResult = Data.TaggedEnum<{
  Applied: { readonly mutationId: string; readonly entry: WireEntry };
  Conflict: {
    readonly mutationId: string;
    readonly key: SyncKey;
    /** The server's current entry for the key. */
    readonly serverEntry: WireEntry;
  };
  Rejected: { readonly mutationId: string; readonly key: SyncKey; readonly reason: string };
}>;

/**
 * Constructors and matchers for {@link PushResult}.
 */
export const PushResult = Data.taggedEnum<PushResult>();

/**
 * Messages sent from server to client.
 *
 * `Updated` / `Removed` / `Invalidated` are fan-out notifications
 * (unsolicited); the rest are responses to client requests.
 */
export type ServerMessage = Data.TaggedEnum<{
  Updated: { readonly entry: WireEntry };
  Removed: { readonly key: SyncKey; readonly version: Version };
  Invalidated: { readonly filter: WireKeyFilter };
  SubscribeAck: { readonly id: MessageId };
  UnsubscribeAck: { readonly id: MessageId };
  PushAck: { readonly id: MessageId; readonly results: ReadonlyArray<PushResult> };
  PullAck: { readonly id: MessageId; readonly entries: ReadonlyArray<WireEntry> };
  Pong: { readonly id: MessageId };
  ProtocolFailure: { readonly id: MessageId | null; readonly reason: string };
}>;

/**
 * Constructors and matchers for {@link ServerMessage}:
 * `ServerMessage.Updated({...})`, `ServerMessage.$is("PushAck")`,
 * `ServerMessage.$match`.
 */
export const ServerMessage = Data.taggedEnum<ServerMessage>();

/**
 * Construct a prefix wire filter.
 */
export const prefixFilter = (prefix: SyncKey): WireKeyFilter => WireKeyFilter.Prefix({ prefix });

/**
 * Construct an exact wire filter.
 */
export const exactFilter = (key: SyncKey): WireKeyFilter => WireKeyFilter.Exact({ key });

/**
 * Test whether a key matches a wire filter.
 */
export const matches = (key: SyncKey, filter: WireKeyFilter): boolean =>
  Keys.matches(key, toKeyFilter(filter));
