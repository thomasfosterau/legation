/**
 * Protocol
 *
 * The wire protocol spoken between sync clients and sync servers. All
 * messages are plain serializable objects, so any transport that can move
 * JSON can carry them.
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

import type { SyncKey } from "./SyncKey.js";
import * as Keys from "./SyncKey.js";
import type { Version } from "./Versioned.js";

/**
 * A key filter that can travel over the wire (no predicates).
 */
export type WireKeyFilter =
  | { readonly _tag: "Prefix"; readonly prefix: SyncKey }
  | { readonly _tag: "Exact"; readonly key: SyncKey };

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
 * Messages sent from client to server.
 */
export type ClientMessage =
  | { readonly _tag: "Subscribe"; readonly id: MessageId; readonly filter: WireKeyFilter }
  | { readonly _tag: "Unsubscribe"; readonly id: MessageId; readonly filter: WireKeyFilter }
  | {
      readonly _tag: "Push";
      readonly id: MessageId;
      readonly mutations: ReadonlyArray<PushMutation>;
    }
  | { readonly _tag: "Pull"; readonly id: MessageId; readonly keys: ReadonlyArray<SyncKey> }
  | { readonly _tag: "Ping"; readonly id: MessageId };

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
 * Per-mutation result of a push.
 */
export type PushResult =
  | {
      readonly _tag: "Applied";
      readonly mutationId: string;
      readonly entry: WireEntry;
    }
  | {
      readonly _tag: "Conflict";
      readonly mutationId: string;
      readonly key: SyncKey;
      /** The server's current entry for the key. */
      readonly serverEntry: WireEntry;
    }
  | {
      readonly _tag: "Rejected";
      readonly mutationId: string;
      readonly key: SyncKey;
      readonly reason: string;
    };

/**
 * Messages sent from server to client.
 */
export type ServerMessage =
  // Fan-out notifications (unsolicited)
  | { readonly _tag: "Updated"; readonly entry: WireEntry }
  | { readonly _tag: "Removed"; readonly key: SyncKey; readonly version: Version }
  | { readonly _tag: "Invalidated"; readonly filter: WireKeyFilter }
  // Responses to client requests
  | { readonly _tag: "SubscribeAck"; readonly id: MessageId }
  | { readonly _tag: "UnsubscribeAck"; readonly id: MessageId }
  | {
      readonly _tag: "PushAck";
      readonly id: MessageId;
      readonly results: ReadonlyArray<PushResult>;
    }
  | { readonly _tag: "PullAck"; readonly id: MessageId; readonly entries: ReadonlyArray<WireEntry> }
  | { readonly _tag: "Pong"; readonly id: MessageId }
  | { readonly _tag: "ProtocolFailure"; readonly id: MessageId | null; readonly reason: string };

/**
 * Construct a prefix wire filter.
 */
export const prefixFilter = (prefix: SyncKey): WireKeyFilter => ({ _tag: "Prefix", prefix });

/**
 * Construct an exact wire filter.
 */
export const exactFilter = (key: SyncKey): WireKeyFilter => ({ _tag: "Exact", key });

/**
 * Test whether a key matches a wire filter.
 */
export const matches = (key: SyncKey, filter: WireKeyFilter): boolean =>
  Keys.matches(key, toKeyFilter(filter));
